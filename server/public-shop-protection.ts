import { createHash, randomUUID } from "node:crypto";

const ORDER_LIMIT = 5;
const ORDER_WINDOW_MS = 15 * 60 * 1_000;
const CHALLENGE_LIFETIME_MS = 30 * 60 * 1_000;
const MINIMUM_FORM_AGE_MS = 1_500;
const MAX_CHALLENGES = 10_000;

type Challenge = { ip: string; issuedAt: number };

export type OrderLimitStore = {
  recordAttempt(
    ipHash: string,
    options: { now: number; windowMs: number; orderLimit: number },
  ): Promise<{ count: number; retryAfterSeconds: number }>;
};

type ProtectionOptions = {
  now?: () => number;
  tokenFactory?: () => string;
  orderLimitStore?: OrderLimitStore;
  orderLimit?: number;
  orderWindowMs?: number;
  challengeLifetimeMs?: number;
  minimumFormAgeMs?: number;
  maxChallenges?: number;
};

class PostgresOrderLimitStore implements OrderLimitStore {
  private lastCleanupAt = 0;

  async recordAttempt(
    ipHash: string,
    { windowMs, orderLimit }: { now: number; windowMs: number; orderLimit: number },
  ) {
    const { pool } = await import("./db");
    const cleanupNow = Date.now();
    if (cleanupNow - this.lastCleanupAt >= 60_000) {
      this.lastCleanupAt = cleanupNow;
      await pool.query(
        "DELETE FROM public_shop_order_limits WHERE expires_at <= statement_timestamp()",
      );
    }

    const result = await pool.query<{ count: number; retry_after_seconds: number }>(
      `INSERT INTO public_shop_order_limits (ip_hash, window_started_at, hit_count, expires_at)
       VALUES ($1, statement_timestamp(), 1, statement_timestamp() + ($2 * interval '1 millisecond'))
       ON CONFLICT (ip_hash) DO UPDATE SET
         window_started_at = CASE
           WHEN public_shop_order_limits.expires_at <= statement_timestamp()
             THEN statement_timestamp()
           ELSE public_shop_order_limits.window_started_at
         END,
         hit_count = CASE
           WHEN public_shop_order_limits.expires_at <= statement_timestamp() THEN 1
           ELSE least(public_shop_order_limits.hit_count + 1, $3 + 1)
         END,
         expires_at = CASE
           WHEN public_shop_order_limits.expires_at <= statement_timestamp()
             THEN statement_timestamp() + ($2 * interval '1 millisecond')
           ELSE public_shop_order_limits.expires_at
         END
       RETURNING hit_count AS count,
         greatest(1, ceil(extract(epoch FROM (expires_at - statement_timestamp()))))::integer
           AS retry_after_seconds`,
      [ipHash, windowMs, orderLimit],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Could not record public shop order attempt.");
    return { count: row.count, retryAfterSeconds: row.retry_after_seconds };
  }
}

export type PublicShopCheck =
  | { ok: true }
  | { ok: false; reason: "rate_limited"; retryAfterSeconds: number }
  | { ok: false; reason: "bot_check" };

export class PublicShopProtection {
  private readonly now: () => number;
  private readonly tokenFactory: () => string;
  private readonly orderLimitStore: OrderLimitStore;
  private readonly orderLimit: number;
  private readonly orderWindowMs: number;
  private readonly challengeLifetimeMs: number;
  private readonly minimumFormAgeMs: number;
  private readonly maxChallenges: number;
  private readonly challenges = new Map<string, Challenge>();

  constructor(options: ProtectionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tokenFactory = options.tokenFactory ?? randomUUID;
    this.orderLimitStore = options.orderLimitStore ?? new PostgresOrderLimitStore();
    this.orderLimit = options.orderLimit ?? ORDER_LIMIT;
    this.orderWindowMs = options.orderWindowMs ?? ORDER_WINDOW_MS;
    this.challengeLifetimeMs = options.challengeLifetimeMs ?? CHALLENGE_LIFETIME_MS;
    this.minimumFormAgeMs = options.minimumFormAgeMs ?? MINIMUM_FORM_AGE_MS;
    this.maxChallenges = options.maxChallenges ?? MAX_CHALLENGES;
  }

  issueChallenge(ip: string): string {
    const now = this.now();
    this.pruneExpired(now);
    while (this.challenges.size >= this.maxChallenges) {
      const oldest = this.challenges.keys().next().value;
      if (oldest === undefined) break;
      this.challenges.delete(oldest);
    }
    const token = this.tokenFactory();
    this.challenges.set(token, { ip, issuedAt: now });
    return token;
  }

  async checkSubmission(ip: string, token: unknown, honeypot: unknown): Promise<PublicShopCheck> {
    const now = this.now();
    this.pruneExpired(now);

    const ipHash = createHash("sha256").update(ip).digest("hex");
    const bucket = await this.orderLimitStore.recordAttempt(ipHash, {
      now,
      windowMs: this.orderWindowMs,
      orderLimit: this.orderLimit,
    });
    if (bucket.count > this.orderLimit) {
      return {
        ok: false,
        reason: "rate_limited",
        retryAfterSeconds: bucket.retryAfterSeconds,
      };
    }

    const challenge = typeof token === "string" ? this.challenges.get(token) : undefined;
    if (typeof token === "string") this.challenges.delete(token);
    if (
      typeof honeypot !== "string"
      || honeypot.trim() !== ""
      || !challenge
      || challenge.ip !== ip
      || now - challenge.issuedAt < this.minimumFormAgeMs
      || now - challenge.issuedAt > this.challengeLifetimeMs
    ) {
      return { ok: false, reason: "bot_check" };
    }
    return { ok: true };
  }

  private pruneExpired(now: number) {
    for (const [token, challenge] of this.challenges) {
      if (now - challenge.issuedAt > this.challengeLifetimeMs) this.challenges.delete(token);
    }
  }
}

export const publicShopProtection = new PublicShopProtection();

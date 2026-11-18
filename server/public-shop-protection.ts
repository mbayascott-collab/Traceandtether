import { createHash, randomUUID } from "node:crypto";

const ORDER_LIMIT = 5;
const ORDER_WINDOW_MS = 15 * 60 * 1_000;
const CHALLENGE_LIFETIME_MS = 30 * 60 * 1_000;
const MINIMUM_FORM_AGE_MS = 1_500;
const MAX_CHALLENGES = 10_000;

type Challenge = { ipHash: string; issuedAt: number };

export type ChallengeStore = {
  issue(
    tokenHash: string,
    challenge: Challenge,
    options: { now: number; lifetimeMs: number; maxChallenges: number },
  ): Promise<void>;
  consume(tokenHash: string): Promise<Challenge | undefined>;
};

export type OrderLimitStore = {
  recordAttempt(
    ipHash: string,
    options: { now: number; windowMs: number; orderLimit: number },
  ): Promise<{ count: number; retryAfterSeconds: number }>;
};

type ProtectionOptions = {
  now?: () => number;
  tokenFactory?: () => string;
  challengeStore?: ChallengeStore;
  orderLimitStore?: OrderLimitStore;
  orderLimit?: number;
  orderWindowMs?: number;
  challengeLifetimeMs?: number;
  minimumFormAgeMs?: number;
  maxChallenges?: number;
};

class PostgresChallengeStore implements ChallengeStore {
  private lastCleanupAt = 0;

  async issue(
    tokenHash: string,
    challenge: Challenge,
    { now, lifetimeMs, maxChallenges }: { now: number; lifetimeMs: number; maxChallenges: number },
  ) {
    const { pool } = await import("./db");
    await pool.query(
      `INSERT INTO public_shop_challenges (token_hash, ip_hash, issued_at)
       VALUES ($1, $2, $3)`,
      [tokenHash, challenge.ipHash, challenge.issuedAt],
    );
    if (now - this.lastCleanupAt >= 60_000) {
      await pool.query(
        "DELETE FROM public_shop_challenges WHERE issued_at < $1",
        [now - lifetimeMs],
      );
      await pool.query(
        `DELETE FROM public_shop_challenges
         WHERE token_hash IN (
           SELECT token_hash FROM public_shop_challenges
           ORDER BY id DESC OFFSET $1
         )`,
        [maxChallenges],
      );
      this.lastCleanupAt = now;
    }
  }

  async consume(tokenHash: string): Promise<Challenge | undefined> {
    const { pool } = await import("./db");
    const result = await pool.query<{ ip_hash: string; issued_at: string }>(
      `DELETE FROM public_shop_challenges WHERE token_hash = $1
       RETURNING ip_hash, issued_at`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return { ipHash: row.ip_hash, issuedAt: Number(row.issued_at) };
  }
}

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
  private readonly challengeStore: ChallengeStore;
  private readonly orderLimitStore: OrderLimitStore;
  private readonly orderLimit: number;
  private readonly orderWindowMs: number;
  private readonly challengeLifetimeMs: number;
  private readonly minimumFormAgeMs: number;
  private readonly maxChallenges: number;

  constructor(options: ProtectionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tokenFactory = options.tokenFactory ?? randomUUID;
    this.challengeStore = options.challengeStore ?? new PostgresChallengeStore();
    this.orderLimitStore = options.orderLimitStore ?? new PostgresOrderLimitStore();
    this.orderLimit = options.orderLimit ?? ORDER_LIMIT;
    this.orderWindowMs = options.orderWindowMs ?? ORDER_WINDOW_MS;
    this.challengeLifetimeMs = options.challengeLifetimeMs ?? CHALLENGE_LIFETIME_MS;
    this.minimumFormAgeMs = options.minimumFormAgeMs ?? MINIMUM_FORM_AGE_MS;
    this.maxChallenges = options.maxChallenges ?? MAX_CHALLENGES;
  }

  async issueChallenge(ip: string): Promise<string> {
    const now = this.now();
    const token = this.tokenFactory();
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const ipHash = createHash("sha256").update(ip).digest("hex");
    await this.challengeStore.issue(tokenHash, { ipHash, issuedAt: now }, {
      now,
      lifetimeMs: this.challengeLifetimeMs,
      maxChallenges: this.maxChallenges,
    });
    return token;
  }

  async checkSubmission(ip: string, token: unknown, honeypot: unknown): Promise<PublicShopCheck> {
    const now = this.now();

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

    const tokenHash = typeof token === "string"
      ? createHash("sha256").update(token).digest("hex")
      : undefined;
    const challenge = tokenHash ? await this.challengeStore.consume(tokenHash) : undefined;
    if (
      typeof honeypot !== "string"
      || honeypot.trim() !== ""
      || !challenge
      || challenge.ipHash !== ipHash
      || now - challenge.issuedAt < this.minimumFormAgeMs
      || now - challenge.issuedAt > this.challengeLifetimeMs
    ) {
      return { ok: false, reason: "bot_check" };
    }
    return { ok: true };
  }
}

export const publicShopProtection = new PublicShopProtection();

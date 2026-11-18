import { randomUUID } from "node:crypto";

const ORDER_LIMIT = 5;
const ORDER_WINDOW_MS = 15 * 60 * 1_000;
const CHALLENGE_LIFETIME_MS = 30 * 60 * 1_000;
const MINIMUM_FORM_AGE_MS = 1_500;
const MAX_TRACKED_IPS = 10_000;
const MAX_CHALLENGES = 10_000;

type RateBucket = { startedAt: number; count: number };
type Challenge = { ip: string; issuedAt: number };

type ProtectionOptions = {
  now?: () => number;
  tokenFactory?: () => string;
  orderLimit?: number;
  orderWindowMs?: number;
  challengeLifetimeMs?: number;
  minimumFormAgeMs?: number;
  maxTrackedIps?: number;
  maxChallenges?: number;
};

export type PublicShopCheck =
  | { ok: true }
  | { ok: false; reason: "rate_limited"; retryAfterSeconds: number }
  | { ok: false; reason: "bot_check" };

export class PublicShopProtection {
  private readonly now: () => number;
  private readonly tokenFactory: () => string;
  private readonly orderLimit: number;
  private readonly orderWindowMs: number;
  private readonly challengeLifetimeMs: number;
  private readonly minimumFormAgeMs: number;
  private readonly maxTrackedIps: number;
  private readonly maxChallenges: number;
  private readonly rateBuckets = new Map<string, RateBucket>();
  private readonly challenges = new Map<string, Challenge>();

  constructor(options: ProtectionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tokenFactory = options.tokenFactory ?? randomUUID;
    this.orderLimit = options.orderLimit ?? ORDER_LIMIT;
    this.orderWindowMs = options.orderWindowMs ?? ORDER_WINDOW_MS;
    this.challengeLifetimeMs = options.challengeLifetimeMs ?? CHALLENGE_LIFETIME_MS;
    this.minimumFormAgeMs = options.minimumFormAgeMs ?? MINIMUM_FORM_AGE_MS;
    this.maxTrackedIps = options.maxTrackedIps ?? MAX_TRACKED_IPS;
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

  checkSubmission(ip: string, token: unknown, honeypot: unknown): PublicShopCheck {
    const now = this.now();
    this.pruneExpired(now);

    let bucket = this.rateBuckets.get(ip);
    if (bucket && now - bucket.startedAt >= this.orderWindowMs) {
      this.rateBuckets.delete(ip);
      bucket = undefined;
    }
    if (!bucket && this.rateBuckets.size >= this.maxTrackedIps) {
      return { ok: false, reason: "rate_limited", retryAfterSeconds: 60 };
    }
    if (bucket && bucket.count >= this.orderLimit) {
      const elapsed = now - bucket.startedAt;
      return {
        ok: false,
        reason: "rate_limited",
        retryAfterSeconds: Math.max(1, Math.ceil((this.orderWindowMs - elapsed) / 1_000)),
      };
    }
    if (bucket) bucket.count += 1;
    else this.rateBuckets.set(ip, { startedAt: now, count: 1 });

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
    for (const [ip, bucket] of this.rateBuckets) {
      if (now - bucket.startedAt >= this.orderWindowMs) this.rateBuckets.delete(ip);
    }
  }
}

export const publicShopProtection = new PublicShopProtection();

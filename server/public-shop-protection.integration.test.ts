import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { PublicShopProtection, type ChallengeStore } from "./public-shop-protection";

class MemoryChallengeStore implements ChallengeStore {
  private readonly challenges = new Map<string, { ipHash: string; issuedAt: number }>();

  async issue(
    tokenHash: string,
    challenge: { ipHash: string; issuedAt: number },
  ) {
    this.challenges.set(tokenHash, challenge);
  }

  async consume(tokenHash: string) {
    const challenge = this.challenges.get(tokenHash);
    this.challenges.delete(tokenHash);
    return challenge;
  }
}

test("PostgreSQL public shop order limits stay accurate under concurrent server instances and reset at expiry", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const { pool } = await import("./db");
  const migration = await pool.query<{ table_name: string | null }>(
    "SELECT to_regclass('public.public_shop_order_limits')::text AS table_name",
  );
  if (!migration.rows[0]?.table_name) {
    await pool.end();
    t.skip("requires the public shop order limits database migration");
    return;
  }

  const suffix = randomUUID();
  const ip = `public-shop-limit-${suffix}`;
  const ipHash = createHash("sha256").update(ip).digest("hex");
  const orderLimit = 5;
  const protections = Array.from({ length: 20 }, () => new PublicShopProtection({
    orderLimit,
    orderWindowMs: 60_000,
    minimumFormAgeMs: 0,
    challengeStore: new MemoryChallengeStore(),
  }));

  try {
    const results = await Promise.all(protections.map(async (protection) => {
      const token = await protection.issueChallenge(ip);
      return protection.checkSubmission(ip, token, "");
    }));

    assert.equal(results.filter((result) => result.ok).length, orderLimit);
    const blocked = results.filter((result) => !result.ok);
    assert.equal(blocked.length, protections.length - orderLimit);
    assert.ok(blocked.every((result) => result.reason === "rate_limited"));

    await pool.query(
      "UPDATE public_shop_order_limits SET expires_at = statement_timestamp() WHERE ip_hash = $1",
      [ipHash],
    );

    const afterExpiryProtection = new PublicShopProtection({
      orderLimit,
      orderWindowMs: 60_000,
      minimumFormAgeMs: 0,
      challengeStore: new MemoryChallengeStore(),
    });
    const token = await afterExpiryProtection.issueChallenge(ip);
    assert.deepEqual(await afterExpiryProtection.checkSubmission(ip, token, ""), { ok: true });

    const counter = await pool.query<{ hit_count: number }>(
      "SELECT hit_count FROM public_shop_order_limits WHERE ip_hash = $1",
      [ipHash],
    );
    assert.equal(counter.rows[0]?.hit_count, 1);
  } finally {
    await pool.query("DELETE FROM public_shop_order_limits WHERE ip_hash = $1", [ipHash]);
    await pool.end();
  }
});

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

test("PostgreSQL public shop protection shares challenges and order limits across server instances", {
  skip: !process.env.DATABASE_URL,
}, async (t) => {
  const { pool } = await import("./db");
  const migration = await pool.query<{
    order_limit_table: string | null;
    challenge_table: string | null;
  }>(
    `SELECT to_regclass('public.public_shop_order_limits')::text AS order_limit_table,
            to_regclass('public.public_shop_challenges')::text AS challenge_table`,
  );
  if (!migration.rows[0]?.order_limit_table || !migration.rows[0]?.challenge_table) {
    await pool.end();
    t.skip("requires the public shop order limits and challenges database migrations");
    return;
  }

  const suffix = randomUUID();
  const ip = `public-shop-limit-${suffix}`;
  const ipHash = createHash("sha256").update(ip).digest("hex");
  const challengeIp = `public-shop-challenge-${suffix}`;
  const challengeIpHash = createHash("sha256").update(challengeIp).digest("hex");
  const mismatchIp = `public-shop-challenge-mismatch-${suffix}`;
  const mismatchIpHash = createHash("sha256").update(mismatchIp).digest("hex");
  const expiredIp = `public-shop-challenge-expired-${suffix}`;
  const expiredIpHash = createHash("sha256").update(expiredIp).digest("hex");
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

    let now = Date.now();
    const challengeLifetimeMs = 5_000;
    const createChallengeProtection = () => new PublicShopProtection({
      now: () => now,
      challengeLifetimeMs,
      minimumFormAgeMs: 0,
    });
    const firstServer = createChallengeProtection();
    const secondServer = createChallengeProtection();

    const sharedToken = await firstServer.issueChallenge(challengeIp);
    const sharedTokenHash = createHash("sha256").update(sharedToken).digest("hex");
    const storedChallenge = await pool.query(
      "SELECT token_hash FROM public_shop_challenges WHERE token_hash = $1",
      [sharedTokenHash],
    );
    assert.equal(storedChallenge.rowCount, 1, "issued challenge must be stored in PostgreSQL");

    const concurrentResults = await Promise.all([
      firstServer.checkSubmission(challengeIp, sharedToken, ""),
      secondServer.checkSubmission(challengeIp, sharedToken, ""),
    ]);
    assert.equal(
      concurrentResults.filter((result) => result.ok).length,
      1,
      "exactly one server instance may accept the shared challenge",
    );
    assert.equal(
      concurrentResults.filter((result) => !result.ok && result.reason === "bot_check").length,
      1,
      "the other server instance must reject the already-consumed challenge",
    );

    const mismatchToken = await firstServer.issueChallenge(mismatchIp);
    assert.deepEqual(
      await secondServer.checkSubmission(`different-${mismatchIp}`, mismatchToken, ""),
      { ok: false, reason: "bot_check" },
      "a PostgreSQL-backed challenge must remain bound to its issuing IP",
    );

    const expiredToken = await firstServer.issueChallenge(expiredIp);
    now += challengeLifetimeMs + 1;
    assert.deepEqual(
      await secondServer.checkSubmission(expiredIp, expiredToken, ""),
      { ok: false, reason: "bot_check" },
      "a PostgreSQL-backed challenge must expire across server instances",
    );
  } finally {
    try {
      await pool.query(
        "DELETE FROM public_shop_order_limits WHERE ip_hash = ANY($1::text[])",
        [[ipHash, challengeIpHash, mismatchIpHash, expiredIpHash]],
      );
      await pool.query(
        "DELETE FROM public_shop_challenges WHERE ip_hash = ANY($1::text[])",
        [[challengeIpHash, mismatchIpHash, expiredIpHash]],
      );
    } finally {
      await pool.end();
    }
  }
});

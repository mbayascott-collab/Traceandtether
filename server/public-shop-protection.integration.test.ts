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
  const independentIps = [
    `public-shop-independent-a-${suffix}`,
    `public-shop-independent-b-${suffix}`,
  ];
  const independentIpHashes = independentIps.map((visitorIp) =>
    createHash("sha256").update(visitorIp).digest("hex"));
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

    const attemptsPerVisitor = orderLimit + 2;
    const independentResults = await Promise.all(independentIps.flatMap((visitorIp) =>
      Array.from({ length: attemptsPerVisitor }, async () => {
        const protection = new PublicShopProtection({
          orderLimit,
          orderWindowMs: 60_000,
          minimumFormAgeMs: 0,
          challengeStore: new MemoryChallengeStore(),
        });
        const token = await protection.issueChallenge(visitorIp);
        return { visitorIp, result: await protection.checkSubmission(visitorIp, token, "") };
      })));

    for (const visitorIp of independentIps) {
      const visitorResults = independentResults
        .filter((attempt) => attempt.visitorIp === visitorIp)
        .map((attempt) => attempt.result);
      assert.equal(
        visitorResults.filter((result) => result.ok).length,
        orderLimit,
        `visitor ${visitorIp} must receive its full allowance`,
      );
      assert.equal(
        visitorResults.filter((result) => !result.ok && result.reason === "rate_limited").length,
        attemptsPerVisitor - orderLimit,
        `visitor ${visitorIp} must be limited only after its own allowance`,
      );
    }

    const independentCounters = await pool.query<{ ip_hash: string; hit_count: number }>(
      "SELECT ip_hash, hit_count FROM public_shop_order_limits WHERE ip_hash = ANY($1::text[])",
      [independentIpHashes],
    );
    const counterByIpHash = new Map(
      independentCounters.rows.map((row) => [row.ip_hash, row.hit_count]),
    );
    for (const ipHash of independentIpHashes) {
      assert.equal(
        counterByIpHash.get(ipHash),
        orderLimit + 1,
        "each visitor must have an independent database counter, including its first blocked attempt",
      );
    }

    await pool.query(
      "UPDATE public_shop_order_limits SET expires_at = statement_timestamp() WHERE ip_hash = $1",
      [independentIpHashes[0]],
    );
    const resetProtection = new PublicShopProtection({
      orderLimit,
      orderWindowMs: 60_000,
      minimumFormAgeMs: 0,
      challengeStore: new MemoryChallengeStore(),
    });
    const resetToken = await resetProtection.issueChallenge(independentIps[0]);
    assert.deepEqual(
      await resetProtection.checkSubmission(independentIps[0], resetToken, ""),
      { ok: true },
      "an expired visitor window must grant that visitor a fresh allowance",
    );
    const countersAfterIndependentReset = await pool.query<{ ip_hash: string; hit_count: number }>(
      "SELECT ip_hash, hit_count FROM public_shop_order_limits WHERE ip_hash = ANY($1::text[])",
      [independentIpHashes],
    );
    const countersAfterResetByIpHash = new Map(
      countersAfterIndependentReset.rows.map((row) => [row.ip_hash, row.hit_count]),
    );
    assert.equal(countersAfterResetByIpHash.get(independentIpHashes[0]), 1);
    assert.equal(
      countersAfterResetByIpHash.get(independentIpHashes[1]),
      orderLimit + 1,
      "resetting one visitor's window must not change another visitor's counter",
    );

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
        [[ipHash, challengeIpHash, mismatchIpHash, expiredIpHash, ...independentIpHashes]],
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

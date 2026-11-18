import { sql, type SQL } from "drizzle-orm";

export type PublicShopAttemptOutcome = "accepted" | "blocked";
export type PublicShopAttemptSummary = { accepted: number; blocked: number };

type AttemptCountExecutor = { execute(query: SQL): Promise<unknown> };

export function addPublicShopAttempt(
  counts: PublicShopAttemptSummary,
  outcome: PublicShopAttemptOutcome,
): PublicShopAttemptSummary {
  return {
    accepted: counts.accepted + (outcome === "accepted" ? 1 : 0),
    blocked: counts.blocked + (outcome === "blocked" ? 1 : 0),
  };
}

export function publicShopAttemptDelta(outcome: PublicShopAttemptOutcome): PublicShopAttemptSummary {
  return addPublicShopAttempt({ accepted: 0, blocked: 0 }, outcome);
}

export function publicShopAttemptSummary(row?: {
  acceptedCount: number | null;
  blockedCount: number | null;
}): PublicShopAttemptSummary {
  return {
    accepted: Number(row?.acceptedCount ?? 0),
    blocked: Number(row?.blockedCount ?? 0),
  };
}

export async function recordPublicShopAttempt(
  executor: AttemptCountExecutor,
  outcome: PublicShopAttemptOutcome,
) {
  const delta = publicShopAttemptDelta(outcome);
  await executor.execute(sql`
    INSERT INTO public_shop_order_attempt_counts
      (id, accepted_count, blocked_count)
    VALUES (1, ${delta.accepted}, ${delta.blocked})
    ON CONFLICT (id) DO UPDATE SET
      accepted_count = public_shop_order_attempt_counts.accepted_count + EXCLUDED.accepted_count,
      blocked_count = public_shop_order_attempt_counts.blocked_count + EXCLUDED.blocked_count
  `);
}

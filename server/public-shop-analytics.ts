import { sql, type SQL } from "drizzle-orm";

export type PublicShopBlockReason = "rate_limited" | "bot_check";
export type PublicShopAttemptOutcome = "accepted" | PublicShopBlockReason;
export type PublicShopAttemptSummary = {
  accepted: number;
  blocked: number;
  rateLimited: number;
  botCheck: number;
  unclassifiedBlocked: number;
};
export type PublicShopAttemptDay = PublicShopAttemptSummary & { day: string };
export type PublicShopBlockedSpike = Pick<PublicShopAttemptDay, "day" | "blocked">;

type AttemptCountExecutor = { execute(query: SQL): Promise<unknown> };

// Warn when one UTC day has more than 25 blocked requests, using aggregate totals only.
export const PUBLIC_SHOP_BLOCKED_REQUEST_WARNING_THRESHOLD = 25;

const emptyAttemptSummary = (): PublicShopAttemptSummary => ({
  accepted: 0,
  blocked: 0,
  rateLimited: 0,
  botCheck: 0,
  unclassifiedBlocked: 0,
});

export function isPublicShopAttemptDateRange(from: unknown, to: unknown): from is string {
  const isDate = (value: unknown): value is string => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  return isDate(from) && isDate(to) && from <= to;
}

export function completePublicShopAttemptDays(
  from: string,
  to: string,
  rows: Array<Pick<PublicShopAttemptDay, "day" | "accepted" | "blocked" | "rateLimited" | "botCheck">>,
): PublicShopAttemptDay[] {
  const totalsByDay = new Map(rows.map((row) => [
    row.day,
    publicShopAttemptSummary({
      acceptedCount: row.accepted,
      blockedCount: row.blocked,
      rateLimitedCount: row.rateLimited,
      botCheckCount: row.botCheck,
    }),
  ]));
  const days: PublicShopAttemptDay[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= end) {
    const day = cursor.toISOString().slice(0, 10);
    days.push({ day, ...(totalsByDay.get(day) ?? emptyAttemptSummary()) });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export function findPublicShopBlockedSpikes(days: PublicShopAttemptDay[]): PublicShopBlockedSpike[] {
  return days
    .filter((day) => day.blocked > PUBLIC_SHOP_BLOCKED_REQUEST_WARNING_THRESHOLD)
    .map(({ day, blocked }) => ({ day, blocked }));
}

export function addPublicShopAttempt(
  counts: Pick<PublicShopAttemptSummary, "accepted" | "blocked" | "rateLimited" | "botCheck">,
  outcome: PublicShopAttemptOutcome,
): PublicShopAttemptSummary {
  const accepted = counts.accepted + (outcome === "accepted" ? 1 : 0);
  const blocked = counts.blocked + (outcome !== "accepted" ? 1 : 0);
  const rateLimited = counts.rateLimited + (outcome === "rate_limited" ? 1 : 0);
  const botCheck = counts.botCheck + (outcome === "bot_check" ? 1 : 0);
  return {
    accepted,
    blocked,
    rateLimited,
    botCheck,
    unclassifiedBlocked: Math.max(0, blocked - rateLimited - botCheck),
  };
}

export function publicShopAttemptDelta(outcome: PublicShopAttemptOutcome): PublicShopAttemptSummary {
  return addPublicShopAttempt(emptyAttemptSummary(), outcome);
}

export function publicShopAttemptSummary(row?: {
  acceptedCount: number | null;
  blockedCount: number | null;
  rateLimitedCount?: number | null;
  botCheckCount?: number | null;
}): PublicShopAttemptSummary {
  const accepted = Number(row?.acceptedCount ?? 0);
  const blocked = Number(row?.blockedCount ?? 0);
  const rateLimited = Number(row?.rateLimitedCount ?? 0);
  const botCheck = Number(row?.botCheckCount ?? 0);
  return { accepted, blocked, rateLimited, botCheck, unclassifiedBlocked: Math.max(0, blocked - rateLimited - botCheck) };
}

export async function recordPublicShopAttempt(
  executor: AttemptCountExecutor,
  outcome: PublicShopAttemptOutcome,
) {
  const delta = publicShopAttemptDelta(outcome);
  await executor.execute(sql`
    WITH lifetime AS (
    INSERT INTO public_shop_order_attempt_counts
      (id, accepted_count, blocked_count, rate_limited_count, bot_check_count)
    VALUES (1, ${delta.accepted}, ${delta.blocked}, ${delta.rateLimited}, ${delta.botCheck})
    ON CONFLICT (id) DO UPDATE SET
      accepted_count = public_shop_order_attempt_counts.accepted_count + EXCLUDED.accepted_count,
      blocked_count = public_shop_order_attempt_counts.blocked_count + EXCLUDED.blocked_count,
      rate_limited_count = public_shop_order_attempt_counts.rate_limited_count + EXCLUDED.rate_limited_count,
      bot_check_count = public_shop_order_attempt_counts.bot_check_count + EXCLUDED.bot_check_count
    )
    INSERT INTO public_shop_order_attempt_daily_counts
      (day, accepted_count, blocked_count, rate_limited_count, bot_check_count)
    VALUES ((statement_timestamp() AT TIME ZONE 'UTC')::date, ${delta.accepted}, ${delta.blocked}, ${delta.rateLimited}, ${delta.botCheck})
    ON CONFLICT (day) DO UPDATE SET
      accepted_count = public_shop_order_attempt_daily_counts.accepted_count + EXCLUDED.accepted_count,
      blocked_count = public_shop_order_attempt_daily_counts.blocked_count + EXCLUDED.blocked_count,
      rate_limited_count = public_shop_order_attempt_daily_counts.rate_limited_count + EXCLUDED.rate_limited_count,
      bot_check_count = public_shop_order_attempt_daily_counts.bot_check_count + EXCLUDED.bot_check_count
  `);
}

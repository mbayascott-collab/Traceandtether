import { sql, type SQL } from "drizzle-orm";

export type PublicShopAttemptOutcome = "accepted" | "blocked";
export type PublicShopAttemptSummary = { accepted: number; blocked: number };
export type PublicShopAttemptDay = PublicShopAttemptSummary & { day: string };

type AttemptCountExecutor = { execute(query: SQL): Promise<unknown> };

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
  rows: PublicShopAttemptDay[],
): PublicShopAttemptDay[] {
  const totalsByDay = new Map(rows.map(({ day, accepted, blocked }) => [day, { accepted, blocked }]));
  const days: PublicShopAttemptDay[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= end) {
    const day = cursor.toISOString().slice(0, 10);
    days.push({ day, ...(totalsByDay.get(day) ?? { accepted: 0, blocked: 0 }) });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

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
    WITH lifetime AS (
    INSERT INTO public_shop_order_attempt_counts
      (id, accepted_count, blocked_count)
    VALUES (1, ${delta.accepted}, ${delta.blocked})
    ON CONFLICT (id) DO UPDATE SET
      accepted_count = public_shop_order_attempt_counts.accepted_count + EXCLUDED.accepted_count,
      blocked_count = public_shop_order_attempt_counts.blocked_count + EXCLUDED.blocked_count
    )
    INSERT INTO public_shop_order_attempt_daily_counts
      (day, accepted_count, blocked_count)
    VALUES ((statement_timestamp() AT TIME ZONE 'UTC')::date, ${delta.accepted}, ${delta.blocked})
    ON CONFLICT (day) DO UPDATE SET
      accepted_count = public_shop_order_attempt_daily_counts.accepted_count + EXCLUDED.accepted_count,
      blocked_count = public_shop_order_attempt_daily_counts.blocked_count + EXCLUDED.blocked_count
  `);
}

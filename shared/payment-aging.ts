export type PaymentAgingBucket = "not_due" | "1_30_days" | "31_60_days" | "over_60_days";

export function paymentAging(dueDate: string, asOfDate: string) {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const asOf = Date.parse(`${asOfDate}T00:00:00Z`);
  if (!Number.isFinite(due) || !Number.isFinite(asOf)) {
    throw new Error("Aging dates must be valid calendar dates.");
  }
  const overdueDays = Math.floor((asOf - due) / 86_400_000);
  const bucket: PaymentAgingBucket = overdueDays <= 0
    ? "not_due"
    : overdueDays <= 30
      ? "1_30_days"
      : overdueDays <= 60
        ? "31_60_days"
        : "over_60_days";
  return { overdueDays: Math.max(0, overdueDays), agingBucket: bucket };
}

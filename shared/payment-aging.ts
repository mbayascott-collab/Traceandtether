export type PaymentAgingBucket = "not_due" | "1_30_days" | "31_60_days" | "over_60_days";

export function paymentDueDate(sourceDate: string, paymentTermDays: number | null) {
  if (paymentTermDays === null) return sourceDate;
  if (!Number.isInteger(paymentTermDays) || paymentTermDays < 0) {
    throw new Error("Payment-term days must be a non-negative whole number.");
  }
  const date = new Date(`${sourceDate}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== sourceDate) {
    throw new Error("The payment source date must be a valid calendar date.");
  }
  date.setUTCDate(date.getUTCDate() + paymentTermDays);
  return date.toISOString().slice(0, 10);
}

export function effectivePaymentDueDate(savedDueDate: string | null, sourceDate: string, paymentTermDays: number | null) {
  return savedDueDate ?? paymentDueDate(sourceDate, paymentTermDays);
}

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

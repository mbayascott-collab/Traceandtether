function todayInZambia(now: Date): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Africa/Lusaka", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).reduce<Record<string, string>>((values, part) => {
    if (part.type !== "literal") values[part.type] = part.value;
    return values;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isCustomerQuoteExpired(validUntil: string | null, now = new Date()): boolean {
  return Boolean(validUntil && validUntil < todayInZambia(now));
}

export function requiresCustomerQuoteExpiryConfirmation(
  validUntil: string | null,
  confirmation: unknown,
  now = new Date(),
): boolean {
  return isCustomerQuoteExpired(validUntil, now) && confirmation !== true;
}

import type { CustomerGroupRules } from "./marketing-validation";

export type CustomerHistoryStats = {
  fulfilledOrders: number;
  lifetimeSalesZmw: string;
  lastOrderDate: string | null;
};

function toCents(value: string) {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

export function matchesCustomerGroup(
  rules: CustomerGroupRules,
  stats: CustomerHistoryStats,
  today = new Date().toISOString().slice(0, 10),
) {
  if (rules.minimumFulfilledOrders !== undefined && stats.fulfilledOrders < rules.minimumFulfilledOrders) return false;
  if (rules.maximumFulfilledOrders !== undefined && stats.fulfilledOrders > rules.maximumFulfilledOrders) return false;
  if (rules.minimumLifetimeSalesZmw !== undefined
    && toCents(stats.lifetimeSalesZmw) < toCents(rules.minimumLifetimeSalesZmw)) return false;
  if (rules.noOrderInLastDays !== undefined) {
    const cutoff = new Date(`${today}T00:00:00.000Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - rules.noOrderInLastDays);
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    if (stats.lastOrderDate !== null && stats.lastOrderDate > cutoffDate) return false;
  }
  return true;
}

function csvCell(value: string | null) {
  const text = value ?? "";
  const safe = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function customerGroupContactsCsv(
  members: Array<{ name: string; email: string | null; phone: string | null }>,
) {
  const rows = [
    ["Name", "Email", "Phone"],
    ...members.map(({ name, email, phone }) => [name, email, phone]),
  ];
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export type LandedCostLine = {
  lineId: number;
  quantityOrdered: number;
  unitPrice: string;
};

export type LandedCostExpense = {
  expenseId: number;
  amount: string;
  exchangeRateToZmw: string;
  basis: "value" | "quantity";
};

export type LandedCostAllocation = {
  expenseId: number;
  lineId: number;
  amountZmw: string;
};

const RATE_SCALE = 100_000_000n;

function minorUnits(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function rateUnits(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * RATE_SCALE + BigInt(fraction.padEnd(8, "0"));
}

function roundedDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function money(value: bigint): string {
  return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}

function allocatedCents(total: bigint, weights: bigint[], ids: number[]): bigint[] {
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0n);
  if (weightTotal <= 0n) throw new Error("Cannot allocate an expense without positive line weights.");
  const shares = weights.map((weight) => ({
    amount: (total * weight) / weightTotal,
    remainder: (total * weight) % weightTotal,
  }));
  let remaining = total - shares.reduce((sum, share) => sum + share.amount, 0n);
  const order = shares.map((share, index) => ({ ...share, index }))
    .sort((a, b) => a.remainder === b.remainder
      ? ids[a.index] - ids[b.index]
      : a.remainder > b.remainder ? -1 : 1);
  for (let index = 0; remaining > 0n; index++, remaining--) {
    shares[order[index % order.length].index].amount++;
  }
  return shares.map((share) => share.amount);
}

export function allocateLandedCosts(
  lines: LandedCostLine[],
  expenses: LandedCostExpense[],
  orderExchangeRateToZmw: string,
) {
  if (!lines.length) return { allocations: [] as LandedCostAllocation[], lines: [] };
  const allocatedByLine = new Map(lines.map((line) => [line.lineId, 0n]));
  const allocations: LandedCostAllocation[] = [];

  for (const expense of expenses) {
    let weights = lines.map((line) => expense.basis === "quantity"
      ? BigInt(line.quantityOrdered)
      : minorUnits(line.unitPrice) * BigInt(line.quantityOrdered));
    if (weights.every((weight) => weight === 0n)) {
      weights = lines.map((line) => BigInt(line.quantityOrdered));
    }
    const totalCents = roundedDivide(minorUnits(expense.amount) * rateUnits(expense.exchangeRateToZmw), RATE_SCALE);
    const shares = allocatedCents(totalCents, weights, lines.map((line) => line.lineId));
    shares.forEach((share, index) => {
      allocatedByLine.set(lines[index].lineId, (allocatedByLine.get(lines[index].lineId) ?? 0n) + share);
      allocations.push({ expenseId: expense.expenseId, lineId: lines[index].lineId, amountZmw: money(share) });
    });
  }

  const calculatedLines = lines.map((line) => {
    const baseUnitCents = roundedDivide(minorUnits(line.unitPrice) * rateUnits(orderExchangeRateToZmw), RATE_SCALE);
    const expenseCents = allocatedByLine.get(line.lineId) ?? 0n;
    const perUnitExpenseCents = roundedDivide(expenseCents, BigInt(line.quantityOrdered));
    return {
      lineId: line.lineId,
      allocatedExpensesZmw: money(expenseCents),
      purchaseUnitCostZmw: money(baseUnitCents),
      landedUnitCostZmw: money(baseUnitCents + perUnitExpenseCents),
    };
  });
  return { allocations, lines: calculatedLines };
}

export type ProductProfitability = {
  estimatedGrossProfitZmw: string | null;
  estimatedGrossMarginPercent: string | null;
};

export function toMinorUnits(amount: string | null | undefined): bigint | null {
  if (amount === null || amount === undefined || amount.trim() === "") return null;
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
  if (!match) return null;
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2]);
  const fraction = BigInt((match[3] ?? "").padEnd(2, "0"));
  return sign * (whole * 100n + fraction);
}

function fromMinorUnits(amount: bigint): string {
  const sign = amount < 0n ? "-" : "";
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

function roundedDivide(numerator: bigint, denominator: bigint): bigint {
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  return sign * ((absolute + denominator / 2n) / denominator);
}

export function calculateProductProfitability(
  sellingPriceZmw: string | null | undefined,
  estimatedLandedCostZmw: string | null | undefined,
): ProductProfitability {
  const selling = toMinorUnits(sellingPriceZmw);
  const cost = toMinorUnits(estimatedLandedCostZmw);
  if (selling === null || cost === null) {
    return { estimatedGrossProfitZmw: null, estimatedGrossMarginPercent: null };
  }

  const profit = selling - cost;
  if (selling <= 0n) {
    return {
      estimatedGrossProfitZmw: fromMinorUnits(profit),
      estimatedGrossMarginPercent: null,
    };
  }

  // Keep two decimal places in the displayed percentage without floating-point math.
  const marginHundredths = roundedDivide(profit * 10_000n, selling);
  const sign = marginHundredths < 0n ? "-" : "";
  const absoluteMargin = marginHundredths < 0n ? -marginHundredths : marginHundredths;

  return {
    estimatedGrossProfitZmw: fromMinorUnits(profit),
    estimatedGrossMarginPercent: `${sign}${absoluteMargin / 100n}.${String(
      absoluteMargin % 100n,
    ).padStart(2, "0")}`,
  };
}

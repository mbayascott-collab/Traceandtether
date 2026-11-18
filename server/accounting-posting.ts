import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { allocateLandedCosts } from "../shared/landed-cost";
import {
  accountingAccounts, inventoryMovements, journalEntries, journalLines,
  products, purchaseOrderLines, purchaseOrders, shipmentLines,
} from "../shared/schema";
import { importExpensesForPurchaseOrder } from "./import-expense-allocation";

export const accounts = [
  { code: "1000", name: "Cash and bank (previously combined)", type: "asset" as const, systemKey: "cash_bank" },
  { code: "1010", name: "Cash on hand", type: "asset" as const, systemKey: "cash_on_hand" },
  { code: "1020", name: "Bank account", type: "asset" as const, systemKey: "bank_account" },
  { code: "1030", name: "Mobile money", type: "asset" as const, systemKey: "mobile_money" },
  { code: "1040", name: "Other funds", type: "asset" as const, systemKey: "other_funds" },
  { code: "1100", name: "Inventory", type: "asset" as const, systemKey: "inventory" },
  { code: "1150", name: "Landed cost clearing", type: "asset" as const, systemKey: "landed_cost_clearing" },
  { code: "1200", name: "Accounts receivable", type: "asset" as const, systemKey: "accounts_receivable" },
  { code: "2100", name: "Accounts payable", type: "liability" as const, systemKey: "accounts_payable" },
  { code: "2200", name: "Business loans payable", type: "liability" as const, systemKey: "business_loans_payable" },
  { code: "3000", name: "Owner equity", type: "equity" as const, systemKey: "owner_equity" },
  { code: "3050", name: "Owner withdrawals", type: "equity" as const, systemKey: "owner_withdrawals" },
  { code: "3100", name: "Opening balance equity", type: "equity" as const, systemKey: "opening_balance_equity" },
  { code: "4100", name: "Sales revenue", type: "income" as const, systemKey: "sales_revenue" },
  { code: "5100", name: "Cost of goods sold", type: "expense" as const, systemKey: "cost_of_goods_sold" },
  { code: "6100", name: "Inventory adjustments", type: "expense" as const, systemKey: "inventory_adjustments" },
  { code: "6200", name: "Marketing expenses", type: "expense" as const, systemKey: "marketing_expense" },
  { code: "6300", name: "Rent expense", type: "expense" as const, systemKey: "rent_expense" },
  { code: "6400", name: "Office supplies expense", type: "expense" as const, systemKey: "office_supplies_expense" },
  { code: "6500", name: "Utilities expense", type: "expense" as const, systemKey: "utilities_expense" },
  { code: "6600", name: "Transport expense", type: "expense" as const, systemKey: "transport_expense" },
  { code: "6700", name: "Repairs and maintenance", type: "expense" as const, systemKey: "repairs_expense" },
  { code: "6900", name: "Other operating expenses", type: "expense" as const, systemKey: "other_operating_expense" },
];

export type PostingLine = {
  accountKey: string;
  debitZmw?: string;
  creditZmw?: string;
  productId?: number | null;
  description?: string | null;
};

export function cents(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}

export function formatCents(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

export function calculatePurchaseReceiptPosting(input: {
  productId: number;
  quantity: number;
  unitPrice: string;
  exchangeRateToZmw: string;
  quantityOrdered: number;
  quantityPreviouslyStocked: number;
  allocatedExpensesZmw: string;
}) {
  const roundDiv = (numerator: bigint, denominator: bigint) => (numerator + denominator / 2n) / denominator;
  const [fxWhole, fxFraction = ""] = input.exchangeRateToZmw.split(".");
  const fxRate = BigInt(fxWhole) * 100_000_000n + BigInt(fxFraction.padEnd(8, "0").slice(0, 8));
  const purchaseUnitCents = roundDiv(cents(input.unitPrice) * fxRate, 100_000_000n);
  const goodsCost = purchaseUnitCents * BigInt(input.quantity);
  const allocatedExpenseCents = cents(input.allocatedExpensesZmw);
  const allocatedThrough = (stockedQuantity: number) => roundDiv(
    allocatedExpenseCents * BigInt(stockedQuantity),
    BigInt(input.quantityOrdered),
  );
  const landedCost = allocatedThrough(input.quantityPreviouslyStocked + input.quantity)
    - allocatedThrough(input.quantityPreviouslyStocked);
  const inventoryCost = goodsCost + landedCost;
  const lines: PostingLine[] = [
    { accountKey: "inventory", productId: input.productId, debitZmw: formatCents(inventoryCost), description: "Received inventory" },
    ...(goodsCost > 0n ? [{ accountKey: "accounts_payable", creditZmw: formatCents(goodsCost), description: "Supplier goods cost" }] : []),
    ...(landedCost > 0n ? [{ accountKey: "landed_cost_clearing", creditZmw: formatCents(landedCost), description: "Allocated import costs" }] : []),
  ];
  return { goodsCost, landedCost, inventoryCost, lines };
}

export function buildDeliveryCostTotals(
  deliveries: { deliveryId: number; orderId: number; deliveryDate: string; productId: number }[],
  costLines: { deliveryId: number; productId: number | null; debitZmw: string }[],
  inRange: (date: string) => boolean,
) {
  const costByDeliveryProduct = new Map<string, bigint>();
  for (const line of costLines) {
    if (line.productId == null) continue;
    const key = `${line.deliveryId}:${line.productId}`;
    costByDeliveryProduct.set(key, (costByDeliveryProduct.get(key) ?? 0n) + cents(line.debitZmw));
  }
  const productCostByOrder = new Map<number, bigint>();
  const ordersMissingCost = new Set<number>();
  for (const delivery of deliveries) {
    if (!inRange(delivery.deliveryDate)) continue;
    const productCost = costByDeliveryProduct.get(`${delivery.deliveryId}:${delivery.productId}`) ?? 0n;
    if (productCost > 0n) {
      productCostByOrder.set(delivery.orderId, (productCostByOrder.get(delivery.orderId) ?? 0n) + productCost);
    } else {
      ordersMissingCost.add(delivery.orderId);
    }
  }
  return { productCostByOrder, ordersMissingCost };
}

/**
 * Allocate each product's posted landed-cost COGS adjustment across its
 * deliveries in proportion to their original recorded delivery costs. The
 * product-level journal has no order link, so this pooled allocation keeps
 * the source accounting entry intact while assigning every cent exactly once.
 */
export function allocateLandedCostAdjustmentsByOrder(
  deliveries: { deliveryId: number; orderId: number; productId: number }[],
  deliveryCostLines: { deliveryId: number; productId: number | null; debitZmw: string }[],
  adjustmentLines: { productId: number | null; debitZmw: string; creditZmw: string }[],
) {
  const deliveryByKey = new Map<string, { deliveryId: number; orderId: number; productId: number }>();
  for (const delivery of deliveries) {
    deliveryByKey.set(`${delivery.deliveryId}:${delivery.productId}`, delivery);
  }

  const weightsByProduct = new Map<number, Map<string, bigint>>();
  for (const line of deliveryCostLines) {
    if (line.productId === null) continue;
    const key = `${line.deliveryId}:${line.productId}`;
    if (!deliveryByKey.has(key)) continue;
    const productWeights = weightsByProduct.get(line.productId) ?? new Map<string, bigint>();
    productWeights.set(key, (productWeights.get(key) ?? 0n) + cents(line.debitZmw));
    weightsByProduct.set(line.productId, productWeights);
  }

  const adjustmentsByProduct = new Map<number, bigint>();
  for (const line of adjustmentLines) {
    if (line.productId === null) continue;
    adjustmentsByProduct.set(
      line.productId,
      (adjustmentsByProduct.get(line.productId) ?? 0n) + cents(line.debitZmw) - cents(line.creditZmw),
    );
  }

  const adjustmentByOrder = new Map<number, bigint>();
  for (const [productId, adjustment] of adjustmentsByProduct) {
    if (adjustment === 0n) continue;
    const weights = weightsByProduct.get(productId);
    if (!weights) continue;
    const eligible = [...weights.entries()].filter(([, weight]) => weight > 0n);
    const totalWeight = eligible.reduce((total, [, weight]) => total + weight, 0n);
    if (totalWeight <= 0n) continue;

    const amount = adjustment < 0n ? -adjustment : adjustment;
    const allocations = eligible.map(([key, weight]) => {
      const numerator = amount * weight;
      const delivery = deliveryByKey.get(key)!;
      return {
        orderId: delivery.orderId,
        deliveryId: delivery.deliveryId,
        amount: numerator / totalWeight,
        remainder: numerator % totalWeight,
      };
    });
    let remaining = amount - allocations.reduce((total, allocation) => total + allocation.amount, 0n);
    allocations.sort((a, b) => {
      if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
      return a.deliveryId - b.deliveryId;
    });
    for (const allocation of allocations) {
      const extraCent = remaining > 0n ? 1n : 0n;
      const signedAmount = (adjustment < 0n ? -1n : 1n) * (allocation.amount + extraCent);
      adjustmentByOrder.set(
        allocation.orderId,
        (adjustmentByOrder.get(allocation.orderId) ?? 0n) + signedAmount,
      );
      remaining -= extraCent;
    }
  }
  return adjustmentByOrder;
}

export function weightedAverageUnitCostCents(inventoryValueCents: bigint, onHand: number): bigint {
  if (!Number.isSafeInteger(onHand) || onHand <= 0) return 0n;
  return (inventoryValueCents + BigInt(Math.floor(onHand / 2))) / BigInt(onHand);
}

export function allocateInventoryValueByLocationCents(
  inventoryValueCents: bigint,
  locations: { locationId: number | null; onHand: number }[],
): Map<number | null, bigint> {
  const values = new Map<number | null, bigint>(locations.map(({ locationId }) => [locationId, 0n]));
  const stockedLocations = locations.filter(({ onHand }) => Number.isSafeInteger(onHand) && onHand > 0);
  if (!stockedLocations.length) {
    values.set(null, inventoryValueCents);
    return values;
  }

  const totalQuantity = stockedLocations.reduce((total, location) => total + BigInt(location.onHand), 0n);
  const absoluteValue = inventoryValueCents < 0n ? -inventoryValueCents : inventoryValueCents;
  const sign = inventoryValueCents < 0n ? -1n : 1n;
  const allocations = stockedLocations.map(({ locationId, onHand }) => {
    const numerator = absoluteValue * BigInt(onHand);
    const value = numerator / totalQuantity;
    return { locationId, value, remainder: numerator % totalQuantity };
  });
  let remainingCents = absoluteValue - allocations.reduce((total, allocation) => total + allocation.value, 0n);
  allocations.sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    if (a.locationId === null) return b.locationId === null ? 0 : 1;
    if (b.locationId === null) return -1;
    return a.locationId - b.locationId;
  });
  for (const allocation of allocations) {
    const extraCent = remainingCents > 0n ? 1n : 0n;
    values.set(allocation.locationId, sign * (allocation.value + extraCent));
    remainingCents -= extraCent;
  }
  return values;
}

function roundedDivide(numerator: bigint, denominator: bigint) {
  return (numerator + denominator / 2n) / denominator;
}

export type LandedCostAdjustmentLine = {
  lineId: number;
  productId: number;
  productName: string;
  stockedQuantity: number;
  onHand: number;
  averageUnitCostZmw: string;
  adjustmentZmw: string;
  inventoryZmw: string;
  cogsZmw: string;
};

export type LandedCostAdjustmentPreview = {
  clearingBalanceZmw: string;
  adjustmentAvailableZmw: string;
  unpostedClearingZmw: string;
  canPost: boolean;
  hasNegativeLine: boolean;
  lines: LandedCostAdjustmentLine[];
};

/**
 * Estimate the share of a product's pooled, weighted-average inventory value
 * that remains on hand relative to all posted receipt units.
 */
export function splitLandedCostCorrection(input: {
  amountCents: bigint;
  inventoryValueCents: bigint;
  onHand: number;
  totalReceiptQuantity: number;
}) {
  const averageUnitCost = weightedAverageUnitCostCents(input.inventoryValueCents, input.onHand);
  const receiptValue = averageUnitCost * BigInt(Math.max(0, input.totalReceiptQuantity));
  const availableInventoryValue = input.onHand > 0 && input.inventoryValueCents > 0n
    ? input.inventoryValueCents < receiptValue ? input.inventoryValueCents : receiptValue
    : 0n;
  const inventoryCents = receiptValue > 0n
    ? roundedDivide(input.amountCents * availableInventoryValue, receiptValue)
    : 0n;
  return {
    averageUnitCostCents: averageUnitCost,
    inventoryCents: inventoryCents < input.amountCents ? inventoryCents : input.amountCents,
    cogsCents: input.amountCents - (inventoryCents < input.amountCents ? inventoryCents : input.amountCents),
  };
}

/**
 * Build a live preview from source expenses, posted receipts, existing journal
 * entries, and current weighted-average stock values. Call inside a transaction
 * when the preview will be posted so that the related rows can be locked first.
 */
export async function landedCostAdjustmentPreview(tx: any, purchaseOrderId: number): Promise<LandedCostAdjustmentPreview | null> {
  const [order] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, purchaseOrderId)).limit(1);
  if (!order) return null;
  const orderLines = await tx.select({ line: purchaseOrderLines, productName: products.name })
    .from(purchaseOrderLines)
    .innerJoin(products, eq(purchaseOrderLines.productId, products.id))
    .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId));
  const expenses = await importExpensesForPurchaseOrder(tx, purchaseOrderId);
  const rows = orderLines.map((row: any) => ({ ...row.line, productName: row.productName }));
  const allocation = allocateLandedCosts(
    rows.map((line: any) => ({ lineId: line.id, quantityOrdered: line.quantityOrdered, unitPrice: line.unitPrice })),
    expenses.map((expense: any) => ({
      expenseId: expense.id, amount: expense.amount,
      exchangeRateToZmw: expense.exchangeRateToZmw, basis: expense.basis,
      lineAllocations: expense.lineAllocations,
    })),
    order.exchangeRateToZmw,
  );
  const allocationByLine = new Map<number, bigint>(
    allocation.lines.map((line) => [line.lineId, cents(line.allocatedExpensesZmw)]),
  );

  const accountsByKey = await ensureAccountingAccounts(tx);
  const clearingAccount = accountsByKey.get("landed_cost_clearing");
  const inventoryAccount = accountsByKey.get("inventory");
  const cogsAccount = accountsByKey.get("cost_of_goods_sold");
  if (!clearingAccount || !inventoryAccount || !cogsAccount) throw new Error("Landed-cost accounting accounts are unavailable.");

  const lineIds = rows.map((line: any) => line.id);
  const productIds: number[] = [...new Set<number>(rows.map((line: any) => Number(line.productId)))];
  const receipts = lineIds.length
    ? await tx.select({
      id: shipmentLines.id, purchaseOrderLineId: shipmentLines.purchaseOrderLineId,
      quantity: shipmentLines.quantityStocked,
    }).from(shipmentLines)
      .innerJoin(purchaseOrderLines, eq(shipmentLines.purchaseOrderLineId, purchaseOrderLines.id))
      .where(inArray(purchaseOrderLines.id, lineIds))
    : [];
  const stockedByLine = new Map<number, number>();
  const shipmentLineToOrderLine = new Map<number, number>();
  receipts.forEach((receipt: any) => {
    stockedByLine.set(receipt.purchaseOrderLineId, (stockedByLine.get(receipt.purchaseOrderLineId) ?? 0) + receipt.quantity);
    shipmentLineToOrderLine.set(receipt.id, receipt.purchaseOrderLineId);
  });

  const actualClearingByLine = new Map<number, bigint>();
  const actualReceiptClearing = await tx.select({
    shipmentLineId: journalEntries.shipmentLineId,
    movementSourceKey: inventoryMovements.sourceKey,
    creditZmw: journalLines.creditZmw,
  }).from(journalEntries)
    .leftJoin(inventoryMovements, eq(journalEntries.sourceId, inventoryMovements.id))
    .innerJoin(journalLines, eq(journalLines.journalEntryId, journalEntries.id))
    .where(and(
      eq(journalEntries.sourceType, "stock_receipt"),
      eq(journalLines.accountId, clearingAccount.id),
      gt(journalLines.creditZmw, "0"),
    ));
  for (const row of actualReceiptClearing) {
    const legacyShipmentLineId = Number(row.movementSourceKey?.match(/^shipment-line-(\d+)-to-\d+$/)?.[1]);
    const shipmentLineId = row.shipmentLineId ?? (
      Number.isSafeInteger(legacyShipmentLineId) ? legacyShipmentLineId : null
    );
    if (shipmentLineId === null) continue;
    const orderLineId = shipmentLineToOrderLine.get(shipmentLineId);
    if (orderLineId === undefined) continue;
    actualClearingByLine.set(orderLineId, (actualClearingByLine.get(orderLineId) ?? 0n) + cents(row.creditZmw));
  }

  const priorAdjustmentRows = await tx.select({
    systemKey: accountingAccounts.systemKey, productId: journalLines.productId,
    debitZmw: journalLines.debitZmw, creditZmw: journalLines.creditZmw,
  }).from(journalEntries)
    .innerJoin(journalLines, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(accountingAccounts, eq(journalLines.accountId, accountingAccounts.id))
    .where(and(
      eq(journalEntries.sourceType, "landed_cost_adjustment"),
      eq(journalEntries.sourceId, purchaseOrderId),
    ));
  let priorClearingCredits = 0n;
  const priorAdjustmentByProduct = new Map<number, bigint>();
  priorAdjustmentRows.forEach((row: any) => {
    if (row.systemKey === "landed_cost_clearing") priorClearingCredits += cents(row.creditZmw);
    if (row.productId !== null && ["inventory", "cost_of_goods_sold"].includes(row.systemKey) && cents(row.debitZmw) > 0n) {
      priorAdjustmentByProduct.set(row.productId, (priorAdjustmentByProduct.get(row.productId) ?? 0n) + cents(row.debitZmw));
    }
  });

  const inventoryLines = productIds.length
    ? await tx.select({
      productId: journalLines.productId, debitZmw: journalLines.debitZmw, creditZmw: journalLines.creditZmw,
    }).from(journalLines).where(and(eq(journalLines.accountId, inventoryAccount.id), inArray(journalLines.productId, productIds)))
    : [];
  const inventoryValueByProduct = new Map<number, bigint>();
  inventoryLines.forEach((row: any) => {
    if (row.productId !== null) inventoryValueByProduct.set(
      row.productId,
      (inventoryValueByProduct.get(row.productId) ?? 0n) + cents(row.debitZmw) - cents(row.creditZmw),
    );
  });
  const movementRows = productIds.length
    ? await tx.select({
      productId: inventoryMovements.productId, quantityDelta: inventoryMovements.quantityDelta,
      kind: inventoryMovements.kind,
    }).from(inventoryMovements).where(inArray(inventoryMovements.productId, productIds))
    : [];
  const onHandByProduct = new Map<number, number>();
  const receiptQuantityByProduct = new Map<number, number>();
  movementRows.forEach((row: any) => {
    onHandByProduct.set(row.productId, (onHandByProduct.get(row.productId) ?? 0) + row.quantityDelta);
    if (row.kind === "stock_receipt") receiptQuantityByProduct.set(
      row.productId, (receiptQuantityByProduct.get(row.productId) ?? 0) + row.quantityDelta,
    );
  });

  const corrections = rows.map((line: any) => {
    const stockedQuantity = stockedByLine.get(line.id) ?? 0;
    const expectedPosted = line.quantityOrdered > 0
      ? roundedDivide((allocationByLine.get(line.id) ?? 0n) * BigInt(stockedQuantity), BigInt(line.quantityOrdered))
      : 0n;
    const adjustmentCents = expectedPosted
      - (actualClearingByLine.get(line.id) ?? 0n)
      - (priorAdjustmentByProduct.get(line.productId) ?? 0n);
    const onHand = onHandByProduct.get(line.productId) ?? 0;
    const inventoryValue = inventoryValueByProduct.get(line.productId) ?? 0n;
    const split = splitLandedCostCorrection({
      amountCents: adjustmentCents > 0n ? adjustmentCents : 0n,
      inventoryValueCents: inventoryValue,
      onHand,
      totalReceiptQuantity: receiptQuantityByProduct.get(line.productId) ?? 0,
    });
    return {
      lineId: line.id, productId: line.productId, productName: line.productName,
      stockedQuantity, onHand, averageUnitCostZmw: formatCents(split.averageUnitCostCents),
      adjustmentCents, inventoryCents: split.inventoryCents, cogsCents: split.cogsCents,
    };
  });
  const hasNegativeLine = corrections.some((line: any) => line.adjustmentCents < 0n);
  const adjustmentCents = corrections.reduce((total: bigint, line: any) =>
    total + (line.adjustmentCents > 0n ? line.adjustmentCents : 0n), 0n);
  const totalExpenseCents = allocation.lines.reduce((total, line) =>
    total + cents(line.allocatedExpensesZmw), 0n);
  const receiptClearingCents = [...actualClearingByLine.values()].reduce((total, value) => total + value, 0n);
  const clearingBalanceCents = totalExpenseCents - receiptClearingCents - priorClearingCredits;
  const unpostedCents = clearingBalanceCents - adjustmentCents;

  return {
    clearingBalanceZmw: formatCents(clearingBalanceCents),
    adjustmentAvailableZmw: formatCents(adjustmentCents),
    unpostedClearingZmw: formatCents(unpostedCents),
    canPost: adjustmentCents > 0n && !hasNegativeLine,
    hasNegativeLine,
    lines: corrections.map((line: any) => ({
      lineId: line.lineId, productId: line.productId, productName: line.productName,
      stockedQuantity: line.stockedQuantity, onHand: line.onHand,
      averageUnitCostZmw: line.averageUnitCostZmw,
      adjustmentZmw: formatCents(line.adjustmentCents),
      inventoryZmw: formatCents(line.inventoryCents),
      cogsZmw: formatCents(line.cogsCents),
    })),
  };
}

export function journalLinesAreBalanced(lines: PostingLine[]) {
  const debit = lines.reduce((sum, line) => sum + cents(line.debitZmw ?? "0.00"), 0n);
  const credit = lines.reduce((sum, line) => sum + cents(line.creditZmw ?? "0.00"), 0n);
  return debit > 0n && debit === credit;
}

export function cashAccountKeyForMethod(method: "cash" | "bank_transfer" | "mobile_money" | "other") {
  switch (method) {
    case "cash": return "cash_on_hand";
    case "bank_transfer": return "bank_account";
    case "mobile_money": return "mobile_money";
    case "other": return "other_funds";
  }
}

export function operatingExpenseAccountKey(category: string) {
  const accountByCategory: Record<string, string> = {
    rent: "rent_expense",
    office_supplies: "office_supplies_expense",
    utilities: "utilities_expense",
    transport: "transport_expense",
    repairs: "repairs_expense",
    other: "other_operating_expense",
  };
  return accountByCategory[category] ?? accountByCategory.other;
}

export function ownerFundAccountKey(kind: "owner_contribution" | "business_loan" | "owner_withdrawal") {
  switch (kind) {
    case "owner_contribution": return "owner_equity";
    case "business_loan": return "business_loans_payable";
    case "owner_withdrawal": return "owner_withdrawals";
  }
}

export function buildOwnerFundLines(
  kind: "owner_contribution" | "business_loan" | "owner_withdrawal",
  method: "cash" | "bank_transfer" | "mobile_money" | "other",
  amountZmw: string,
  accountName: string,
  notes?: string,
): PostingLine[] {
  const cashAccountKey = cashAccountKeyForMethod(method);
  const fundAccountKey = ownerFundAccountKey(kind);
  const isWithdrawal = kind === "owner_withdrawal";
  return isWithdrawal
    ? [
      { accountKey: fundAccountKey, debitZmw: amountZmw, description: "Owner funds withdrawn" },
      { accountKey: cashAccountKey, creditZmw: amountZmw, description: `Paid from ${accountName}${notes ? ` · ${notes.slice(0, 190)}` : ""}` },
    ]
    : [
      { accountKey: cashAccountKey, debitZmw: amountZmw, description: `Received into ${accountName}${notes ? ` · ${notes.slice(0, 190)}` : ""}` },
      {
        accountKey: fundAccountKey, creditZmw: amountZmw,
        description: kind === "owner_contribution" ? "Owner funds added" : "Loan principal received",
      },
    ];
}

export function openingBalanceDuplicateMessage(isReplacement: boolean): string {
  return isReplacement
    ? "This reversal has already been replaced or is not a valid opening-balance correction."
    : "Opening balances have already been recorded. Reverse the active entry before replacing it.";
}

export function buildOpeningBalanceLines(input: {
  cashOnHandZmw: string;
  bankZmw: string;
  mobileMoneyZmw: string;
  otherFundsZmw: string;
  receivablesZmw: string;
  payablesZmw: string;
  loansPayableZmw: string;
  ownerEquityZmw: string;
}): PostingLine[] {
  const lines: PostingLine[] = [];
  const debits = [
    ["cash_on_hand", input.cashOnHandZmw, "Opening cash on hand"],
    ["bank_account", input.bankZmw, "Opening bank balance"],
    ["mobile_money", input.mobileMoneyZmw, "Opening mobile money balance"],
    ["other_funds", input.otherFundsZmw, "Other opening funds"],
    ["accounts_receivable", input.receivablesZmw, "Opening customer balances owed"],
  ] as const;
  const credits = [
    ["accounts_payable", input.payablesZmw, "Opening supplier balances owed"],
    ["business_loans_payable", input.loansPayableZmw, "Opening business loans"],
    ["owner_equity", input.ownerEquityZmw, "Opening owner funds"],
  ] as const;
  let debitTotal = 0n;
  let creditTotal = 0n;

  for (const [accountKey, amount, description] of debits) {
    const value = cents(amount);
    if (value > 0n) {
      debitTotal += value;
      lines.push({ accountKey, debitZmw: formatCents(value), description });
    }
  }
  for (const [accountKey, amount, description] of credits) {
    const value = cents(amount);
    if (value > 0n) {
      creditTotal += value;
      lines.push({ accountKey, creditZmw: formatCents(value), description });
    }
  }

  const difference = debitTotal - creditTotal;
  if (difference > 0n) {
    lines.push({
      accountKey: "opening_balance_equity",
      creditZmw: formatCents(difference),
      description: "Balancing amount for opening assets and liabilities",
    });
  } else if (difference < 0n) {
    lines.push({
      accountKey: "opening_balance_equity",
      debitZmw: formatCents(-difference),
      description: "Balancing amount for opening assets and liabilities",
    });
  }
  return lines;
}

export function buildOpeningStockLines(productId: number, totalValueZmw: string): PostingLine[] {
  return [
    {
      accountKey: "inventory",
      productId,
      debitZmw: totalValueZmw,
      description: "Reviewed value of existing stock",
    },
    {
      accountKey: "opening_balance_equity",
      creditZmw: totalValueZmw,
      description: "Existing stock opening balance",
    },
  ];
}

export function reversePostingLines(lines: PostingLine[]): PostingLine[] {
  return lines.map((line) => ({
    accountKey: line.accountKey,
    productId: line.productId ?? null,
    debitZmw: line.creditZmw ?? "0.00",
    creditZmw: line.debitZmw ?? "0.00",
    description: line.description ?? null,
  }));
}

export async function ensureAccountingAccounts(tx: any) {
  await tx.insert(accountingAccounts).values(accounts).onConflictDoNothing();
  const rows = await tx.select().from(accountingAccounts);
  return new Map<string, typeof accountingAccounts.$inferSelect>(
    rows.filter((row: typeof accountingAccounts.$inferSelect) => row.systemKey !== null)
      .map((row: typeof accountingAccounts.$inferSelect) => [row.systemKey!, row]),
  );
}

export async function postJournal(tx: any, input: {
  sourceKey: string; sourceType: string; sourceId: number; shipmentLineId?: number;
  memo: string; entryDate?: string; lines: PostingLine[];
}) {
  const [existing] = await tx.select().from(journalEntries).where(eq(journalEntries.sourceKey, input.sourceKey)).limit(1);
  if (existing) return existing;
  if (!journalLinesAreBalanced(input.lines)) throw new Error("Journal entry must have equal, positive debits and credits.");
  const accountMap = await ensureAccountingAccounts(tx);
  const inserted = await tx.insert(journalEntries).values({
    entryNumber: `JE-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    sourceKey: input.sourceKey, sourceType: input.sourceType, sourceId: input.sourceId,
    shipmentLineId: input.shipmentLineId ?? null,
    memo: input.memo, entryDate: input.entryDate ?? new Date().toISOString().slice(0, 10),
  }).returning();
  const entry = inserted[0] as typeof journalEntries.$inferSelect;
  await tx.insert(journalLines).values(input.lines.map((line) => {
    const account = accountMap.get(line.accountKey);
    if (!account) throw new Error(`Accounting account ${line.accountKey} is missing.`);
    return {
      journalEntryId: entry.id, accountId: account.id, productId: line.productId ?? null,
      description: line.description ?? null, debitZmw: line.debitZmw ?? "0.00", creditZmw: line.creditZmw ?? "0.00",
    };
  }));
  return entry;
}

export async function accountBalance(tx: any, accountKey: string, productId?: number) {
  const accountMap = await ensureAccountingAccounts(tx);
  const account = accountMap.get(accountKey);
  if (!account) return 0n;
  const result = await tx.execute(sql`
    select coalesce(sum(${journalLines.debitZmw}::numeric - ${journalLines.creditZmw}::numeric), 0)::text as balance
    from ${journalLines}
    where ${journalLines.accountId} = ${account.id}
    ${productId === undefined ? sql`` : sql`and ${journalLines.productId} = ${productId}`}
  `);
  const value = result.rows?.[0]?.balance ?? "0";
  const [whole, fraction = ""] = String(value).split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}

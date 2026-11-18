import { eq, inArray } from "drizzle-orm";
import { allocateLandedCosts } from "../shared/landed-cost";
import { importExpenses, purchaseOrderLines, purchaseOrders, shipmentPurchaseOrders } from "../shared/schema";

type PurchaseOrderImportExpense = typeof importExpenses.$inferSelect & {
  lineAllocations?: { lineId: number; amountZmw: string }[];
};

/**
 * Return the direct purchase-order expenses plus the exact line shares of any
 * shared shipment expenses that apply to this order.
 */
export async function importExpensesForPurchaseOrder(tx: any, purchaseOrderId: number) {
  const [directExpenses, orderShipments] = await Promise.all([
    tx.select().from(importExpenses).where(eq(importExpenses.purchaseOrderId, purchaseOrderId)),
    tx.select({ shipmentId: shipmentPurchaseOrders.shipmentId })
      .from(shipmentPurchaseOrders)
      .where(eq(shipmentPurchaseOrders.purchaseOrderId, purchaseOrderId)),
  ]);
  const shipmentIds = [...new Set<number>(orderShipments.map((row: { shipmentId: number }) => row.shipmentId))];
  if (!shipmentIds.length) return directExpenses as PurchaseOrderImportExpense[];

  const [sharedExpenses, shipmentOrders] = await Promise.all([
    tx.select().from(importExpenses).where(inArray(importExpenses.shipmentId, shipmentIds)),
    tx.select().from(shipmentPurchaseOrders).where(inArray(shipmentPurchaseOrders.shipmentId, shipmentIds)),
  ]);
  const linkedOrderIds = [...new Set<number>(shipmentOrders.map((row: { purchaseOrderId: number }) => row.purchaseOrderId))];
  const allLines = linkedOrderIds.length
    ? await tx.select({ line: purchaseOrderLines, exchangeRateToZmw: purchaseOrders.exchangeRateToZmw })
      .from(purchaseOrderLines)
      .innerJoin(purchaseOrders, eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id))
      .where(inArray(purchaseOrderLines.purchaseOrderId, linkedOrderIds))
    : [];
  const selectedLines = allLines.filter((row: { line: typeof purchaseOrderLines.$inferSelect }) => row.line.purchaseOrderId === purchaseOrderId);
  const selectedLineIds = new Set<number>(selectedLines.map((row: { line: typeof purchaseOrderLines.$inferSelect }) => row.line.id));
  const orderIdsByShipment = new Map<number, number[]>();
  for (const link of shipmentOrders) {
    orderIdsByShipment.set(link.shipmentId, [...(orderIdsByShipment.get(link.shipmentId) ?? []), link.purchaseOrderId]);
  }

  const sharedForOrder = sharedExpenses.flatMap((expense: typeof importExpenses.$inferSelect) => {
    const targetShipmentId = expense.shipmentId;
    if (targetShipmentId === null) return [];
    const shipmentLineRows = allLines.filter((row: { line: typeof purchaseOrderLines.$inferSelect }) =>
      (orderIdsByShipment.get(targetShipmentId) ?? []).includes(row.line.purchaseOrderId));
    if (!shipmentLineRows.length) return [];
    const allocation = allocateLandedCosts(
      shipmentLineRows.map((row: { line: typeof purchaseOrderLines.$inferSelect; exchangeRateToZmw: string }) => ({
        lineId: row.line.id, quantityOrdered: row.line.quantityOrdered, unitPrice: row.line.unitPrice,
        valueExchangeRateToZmw: row.exchangeRateToZmw,
      })),
      [{
        expenseId: expense.id, amount: expense.amount,
        exchangeRateToZmw: expense.exchangeRateToZmw, basis: expense.basis,
      }],
      "1",
    );
    const lineAllocations = allocation.allocations
      .filter((item) => selectedLineIds.has(item.lineId));
    return lineAllocations.length
      ? [{ ...expense, lineAllocations } as PurchaseOrderImportExpense]
      : [];
  });

  return [...directExpenses, ...sharedForOrder] as PurchaseOrderImportExpense[];
}

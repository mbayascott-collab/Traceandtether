import type { SalesDelivery, SalesOrder } from "./api";

export interface SalesInvoiceDocumentLine {
  id: number;
  productName: string;
  sku: string;
  quantity: number;
  unitPriceZmw: string;
  lineTotalZmw: string;
}

export function salesInvoiceDocument(order: SalesOrder, delivery: SalesDelivery | null) {
  return {
    invoiceRef: delivery
      ? `INV-${delivery.deliveryNumber.replace(/^DN-/, "")}`
      : `INV-${order.orderNumber.replace(/^SO-/, "")}`,
    date: delivery?.deliveryDate ?? order.fulfilledAt ?? order.orderDate,
    lines: (delivery
      ? delivery.lines.map((line) => ({
        id: line.salesOrderLineId,
        productName: line.productName,
        sku: line.sku,
        quantity: line.quantity,
        unitPriceZmw: line.unitPriceZmw,
        lineTotalZmw: line.lineTotalZmw,
      }))
      : order.lines.map((line) => ({
        id: line.id,
        productName: line.productName,
        sku: line.sku,
        quantity: line.quantity,
        unitPriceZmw: line.unitPriceZmw,
        lineTotalZmw: line.lineTotalZmw,
      }))) satisfies SalesInvoiceDocumentLine[],
    totalZmw: delivery?.totalZmw ?? order.totalZmw,
  };
}

import { z } from "zod";
import { toMinorUnits } from "../shared/money";

const nullableText = (maxLength: number) =>
  z.preprocess(
    (value) => (value === "" || value === undefined ? null : value),
    z.string().trim().max(maxLength).nullable(),
  );

const nullableMoney = z.preprocess(
  (value) => {
    if (value === "" || value === undefined || value === null) return null;
    return typeof value === "string" ? value.trim() : String(value);
  },
  z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/, "Enter a non-negative amount with up to two decimals.").nullable(),
);

const nullableCategoryId = z.preprocess(
  (value) => {
    if (value === "" || value === undefined || value === null) return null;
    return typeof value === "string" ? Number(value) : value;
  },
  z.number().int().positive().nullable(),
);

const nonNegativeInteger = z.preprocess(
  (value) => (typeof value === "string" && value.trim() !== "" ? Number(value) : value),
  z.number().int().min(0).max(1_000_000),
);

export const productInputSchema = z
  .object({
    sku: z.string().trim().min(1).max(60).transform((value) => value.toUpperCase()),
    name: z.string().trim().min(1).max(160),
    description: nullableText(5_000),
    imageUrl: nullableText(1_000).refine((value) => {
      if (value === null) return true;
      try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:";
      } catch {
        return false;
      }
    }, "Enter a valid image link beginning with http:// or https://."),
    brand: nullableText(100),
    categoryId: nullableCategoryId,
    supplierName: nullableText(160),
    supplierProductCode: nullableText(100),
    purchaseCurrency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, "Use a three-letter currency code."),
    purchasePrice: nullableMoney,
    estimatedLandedCostZmw: nullableMoney,
    sellingPriceZmw: nullableMoney,
    reorderThreshold: nonNegativeInteger,
    unit: z.string().trim().min(1).max(32),
    status: z.enum(["draft", "active", "inactive"]),
  })
  .strict()
  .superRefine((product, context) => {
    if (product.status === "active") {
      const sellingPrice = toMinorUnits(product.sellingPriceZmw);
      if (sellingPrice === null || sellingPrice <= 0n) {
        context.addIssue({
          code: "custom",
          path: ["sellingPriceZmw"],
          message: "An active product must have a selling price above ZMW 0.00.",
        });
      }
    }
  });

export const categoryInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: nullableText(500),
    status: z.enum(["active", "inactive"]).optional(),
  })
  .strict();

export const supplierInputSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    country: nullableText(80),
    contactName: nullableText(120),
    email: nullableText(254).refine((value) => value === null || z.string().email().safeParse(value).success, "Enter a valid email address."),
    phone: nullableText(60),
    website: nullableText(300).refine((value) => value === null || z.string().url().safeParse(value).success, "Enter a website including https://."),
    paymentTerms: nullableText(300),
    defaultLeadTimeDays: nonNegativeInteger,
    notes: nullableText(5_000),
    status: z.enum(["active", "inactive"]),
  })
  .strict();

const positiveInteger = z.preprocess(
  (value) => (typeof value === "string" && value.trim() !== "" ? Number(value) : value),
  z.number().int().min(1).max(1_000_000),
);

export const supplierQuoteInputSchema = z
  .object({
    supplierId: positiveInteger,
    productId: positiveInteger,
    quoteReference: nullableText(100),
    supplierProductCode: nullableText(100),
    unitPrice: z.preprocess(
      (value) => typeof value === "string" ? value.trim() : String(value ?? ""),
      z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/, "Enter a non-negative price with up to two decimals."),
    ),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Use a three-letter currency code."),
    minimumOrderQuantity: positiveInteger,
    leadTimeDays: nonNegativeInteger,
    validUntil: z.preprocess(
      (value) => value === "" || value === undefined ? null : value,
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
        const parsed = new Date(`${value}T00:00:00.000Z`);
        return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
      }, "Enter a real calendar date.").nullable(),
    ),
    paymentTerms: nullableText(300),
    shippingTerms: nullableText(120),
    notes: nullableText(5_000),
    status: z.enum(["received", "accepted", "rejected"]),
  })
  .strict();

const validDate = z.preprocess(
  (value) => value === "" || value === undefined ? null : value,
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Enter a real calendar date.").nullable(),
);

const positiveRate = z.string().trim().regex(/^\d{1,10}(?:\.\d{1,8})?$/, "Enter a positive exchange rate with up to eight decimals.")
  .refine((value) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, "0")) > 0n;
  }, "Exchange rate must be greater than zero.");

const nonnegativeAmount = z.string().trim().regex(/^\d{1,12}(?:\.\d{1,2})?$/, "Enter a non-negative amount with up to two decimals.");

const purchaseOrderLineSchema = z.object({
  productId: positiveInteger,
  quantityOrdered: positiveInteger,
  unitPrice: nonnegativeAmount,
}).strict();

export const purchaseOrderInputSchema = z.object({
  supplierId: positiveInteger,
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  exchangeRateToZmw: positiveRate,
  expectedAt: validDate,
  notes: nullableText(5_000),
  lines: z.array(purchaseOrderLineSchema).min(1).max(100),
}).strict().superRefine((order, context) => {
  const productIds = order.lines.map((line) => line.productId);
  if (new Set(productIds).size !== productIds.length) {
    context.addIssue({ code: "custom", path: ["lines"], message: "Each product can appear only once per order." });
  }
});

export const purchaseOrderUpdateSchema = z.object({
  status: z.enum(["ordered", "cancelled"]),
  expectedAt: validDate,
  notes: nullableText(5_000),
}).strict();

export const shipmentInputSchema = z.object({
  purchaseOrderIds: z.array(positiveInteger).min(1).max(100),
  shipmentReference: nullableText(100),
  carrier: nullableText(120),
  trackingNumber: nullableText(120),
  shippedAt: validDate,
  expectedAt: validDate,
  notes: nullableText(5_000),
  lines: z.array(z.object({
    purchaseOrderLineId: positiveInteger,
    quantityShipped: positiveInteger,
  }).strict()).min(1).max(100),
}).strict().superRefine((shipment, context) => {
  const lineIds = shipment.lines.map((line) => line.purchaseOrderLineId);
  if (new Set(shipment.purchaseOrderIds).size !== shipment.purchaseOrderIds.length) {
    context.addIssue({ code: "custom", path: ["purchaseOrderIds"], message: "Each purchase order can only be added once." });
  }
  if (new Set(lineIds).size !== lineIds.length) {
    context.addIssue({ code: "custom", path: ["lines"], message: "Each order line can appear only once per shipment." });
  }
});

export const shipmentReceiptSchema = z.object({
  lines: z.array(z.object({
    shipmentLineId: positiveInteger,
    quantityReceived: z.number().int().min(0).max(1_000_000),
  }).strict()).min(1).max(100),
}).strict();

export const importExpenseInputSchema = z.object({
  purchaseOrderId: positiveInteger,
  category: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(240),
  amount: z.string().trim().regex(/^\d{1,12}(?:\.\d{1,2})?$/).refine((value) => toMinorUnits(value)! > 0n),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  exchangeRateToZmw: positiveRate,
  basis: z.enum(["value", "quantity"]),
  incurredAt: validDate,
  reference: nullableText(120),
  notes: nullableText(5_000),
}).strict();

export const inventoryReservationInputSchema = z.object({
  productId: positiveInteger,
  locationId: positiveInteger.optional(),
  quantity: positiveInteger,
  reference: nullableText(120),
  reason: z.string().trim().min(1).max(500),
}).strict();

export const inventoryAdjustmentInputSchema = z.object({
  productId: positiveInteger,
  locationId: positiveInteger.optional(),
  quantityDelta: z.coerce.number().int().min(-1_000_000).max(1_000_000).refine((value) => value !== 0),
  reference: nullableText(120),
  reason: z.string().trim().min(1).max(500),
}).strict();

export const openingStockInputSchema = z.object({
  productId: positiveInteger,
  locationId: positiveInteger.optional(),
  quantity: positiveInteger,
  unitCostZmw: z.string().trim().regex(/^\d{1,10}(?:\.\d{1,2})?$/, "Enter a unit cost in ZMW with up to two decimals.")
    .refine((value) => toMinorUnits(value)! > 0n, "Unit cost must be greater than ZMW 0.00."),
  effectiveAt: validDate,
  memo: z.preprocess(
    (value) => value === "" || value === undefined ? null : value,
    z.string().trim().min(3).max(500).nullable(),
  ),
  reference: nullableText(120),
}).strict().superRefine((input, context) => {
  if (toMinorUnits(input.unitCostZmw)! * BigInt(input.quantity) > 99_999_999_999_999n) {
    context.addIssue({ code: "custom", path: ["unitCostZmw"], message: "Total opening value is too large." });
  }
});

export const customerInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  contactPerson: nullableText(120),
  contactPersonPhone: nullableText(60),
  email: z.preprocess((value) => value === "" || value === undefined ? null : value,
    z.string().trim().email().max(254).nullable()),
  phone: nullableText(60),
  address: nullableText(5_000),
  notes: nullableText(5_000),
  status: z.enum(["active", "inactive"]),
}).strict();

export const salesOrderInputSchema = z.object({
  customerId: positiveInteger,
  deliveryAddress: nullableText(5_000),
  notes: nullableText(5_000),
  lines: z.array(z.object({
    productId: positiveInteger,
    quantity: positiveInteger,
    unitPriceZmw: z.string().trim().regex(/^\d{1,12}(?:\.\d{1,2})?$/),
  }).strict()).min(1).max(100),
}).strict().superRefine((order, context) => {
  const ids = order.lines.map((line) => line.productId);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["lines"], message: "Each product can appear only once per order." });
});

export const salesDeliveryInputSchema = z.object({
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Enter a real delivery date."),
  lines: z.array(z.object({
    salesOrderLineId: positiveInteger,
    quantity: positiveInteger,
  }).strict()).min(1).max(100),
}).strict().superRefine((delivery, context) => {
  const lineIds = delivery.lines.map((line) => line.salesOrderLineId);
  if (new Set(lineIds).size !== lineIds.length) {
    context.addIssue({ code: "custom", path: ["lines"], message: "Each order line can appear only once in a delivery." });
  }
});

export const customerQuoteInputSchema = z.object({
  customerId: positiveInteger,
  validUntil: validDate,
  deliveryAddress: nullableText(5_000),
  notes: nullableText(5_000),
  status: z.enum(["draft", "sent", "accepted", "rejected"]),
  lines: z.array(z.object({
    productId: positiveInteger,
    quantity: positiveInteger,
    unitPriceZmw: nonnegativeAmount,
  }).strict()).min(1).max(100),
}).strict().superRefine((quote, context) => {
  const ids = quote.lines.map((line) => line.productId);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["lines"], message: "Each product can appear only once per quote." });
});

export const publicShopOrderInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  phone: z.string().trim().min(5).max(60),
  email: z.preprocess((value) => value === "" || value === undefined ? null : value, z.string().trim().email().max(254).nullable()),
  address: z.string().trim().max(5_000).optional().default(""),
  notes: z.string().trim().max(1_000).optional().default(""),
  trackingCode: z.string().uuid().optional(),
  lines: z.array(z.object({
    productId: positiveInteger,
    quantity: z.number().int().min(1).max(99),
  }).strict()).min(1).max(20),
}).strict().superRefine((order, context) => {
  if (new Set(order.lines.map((line) => line.productId)).size !== order.lines.length) {
    context.addIssue({ code: "custom", path: ["lines"], message: "Each product can appear only once per order." });
  }
});

export type ProductInput = z.infer<typeof productInputSchema>;
export type CategoryInput = z.infer<typeof categoryInputSchema>;
export type SupplierInput = z.infer<typeof supplierInputSchema>;
export type SupplierQuoteInput = z.infer<typeof supplierQuoteInputSchema>;

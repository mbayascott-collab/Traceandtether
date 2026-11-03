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

export type ProductInput = z.infer<typeof productInputSchema>;
export type CategoryInput = z.infer<typeof categoryInputSchema>;
export type SupplierInput = z.infer<typeof supplierInputSchema>;
export type SupplierQuoteInput = z.infer<typeof supplierQuoteInputSchema>;

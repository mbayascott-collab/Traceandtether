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

export type ProductInput = z.infer<typeof productInputSchema>;
export type CategoryInput = z.infer<typeof categoryInputSchema>;

import { z } from "zod";
import { toMinorUnits } from "../shared/money";

export const paymentInputSchema = z.object({
  direction: z.enum(["customer_receipt", "supplier_payment"]),
  orderId: z.preprocess((value) => typeof value === "string" ? Number(value) : value, z.number().int().positive()),
  amountZmw: z.string().trim().regex(/^\d{1,12}(?:\.\d{1,2})?$/, "Enter an amount with up to two decimal places.")
    .refine((value) => (toMinorUnits(value) ?? 0n) > 0n, "Payment must be greater than ZMW 0.00."),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid payment date.")
    .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, "Enter a valid payment date."),
  method: z.enum(["cash", "bank_transfer", "mobile_money", "other"]),
  reference: z.preprocess((value) => value === "" || value === undefined ? null : value, z.string().trim().max(120).nullable()),
  notes: z.preprocess((value) => value === "" || value === undefined ? null : value, z.string().trim().max(1000).nullable()),
}).strict();

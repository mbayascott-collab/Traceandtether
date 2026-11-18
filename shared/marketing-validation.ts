import { z } from "zod";

const optionalText = (max: number) => z.preprocess(
  (value) => value === "" || value === undefined ? null : value,
  z.string().trim().max(max).nullable(),
);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}).nullable().optional();

export const campaignSchema = z.object({
  customerGroupId: z.number().int().positive().nullable().optional(),
  name: z.string().trim().min(1).max(180),
  objective: optionalText(5_000),
  channel: optionalText(80),
  status: z.enum(["draft", "active", "paused", "completed", "cancelled"]),
  startsOn: day,
  endsOn: day,
  budgetZmw: z.preprocess((value) => value === "" || value === undefined ? null : value,
    z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/).nullable()),
  notes: optionalText(5_000),
}).strict().refine((value) => !value.startsOn || !value.endsOn || value.endsOn >= value.startsOn, {
  message: "End date must be on or after the start date.",
  path: ["endsOn"],
});

export const contentSchema = z.object({
  campaignId: z.number().int().positive().nullable().optional(),
  title: z.string().trim().min(1).max(180),
  platform: z.string().trim().min(1).max(80),
  contentType: z.string().trim().min(1).max(80),
  status: z.enum(["planned", "in_progress", "ready", "published", "cancelled"]),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
  caption: optionalText(10_000),
  publishedUrl: z.preprocess((value) => value === "" || value === undefined ? null : value,
    z.string().trim().url().max(2_000).nullable()),
  notes: optionalText(5_000),
}).strict();

export const marketingExpenseSchema = z.object({
  campaignId: z.number().int().positive().nullable().optional(),
  category: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(240),
  amount: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/).refine((value) => Number(value) > 0),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).transform((value) => value.toUpperCase()),
  exchangeRateToZmw: z.string().regex(/^\d{1,10}(?:\.\d{1,8})?$/).refine((value) => Number(value) > 0),
  expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paid: z.boolean().default(false),
  reference: optionalText(120),
  notes: optionalText(5_000),
}).strict();

export const customerGroupSchema = z.object({
  name: z.string().trim().min(1).max(120),
  rules: z.object({
    minimumFulfilledOrders: z.number().int().min(1).max(100_000).optional(),
    maximumFulfilledOrders: z.number().int().min(0).max(100_000).optional(),
    noOrderInLastDays: z.number().int().min(1).max(3_650).optional(),
    minimumLifetimeSalesZmw: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/).optional(),
  }).strict().refine((rules) => Object.keys(rules).length > 0, {
    message: "Choose at least one customer group rule.",
  }).refine((rules) => rules.minimumFulfilledOrders === undefined
    || rules.maximumFulfilledOrders === undefined
    || rules.minimumFulfilledOrders <= rules.maximumFulfilledOrders, {
    message: "Minimum orders cannot exceed maximum orders.",
    path: ["maximumFulfilledOrders"],
  }),
}).strict();

export type CustomerGroupRules = z.infer<typeof customerGroupSchema>["rules"];

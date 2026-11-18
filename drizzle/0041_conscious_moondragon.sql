ALTER TABLE "customers" ADD COLUMN "payment_term_days" integer;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "payment_term_days" integer;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_payment_term_days_nonnegative" CHECK ("customers"."payment_term_days" is null or "customers"."payment_term_days" >= 0);--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_payment_term_days_nonnegative" CHECK ("suppliers"."payment_term_days" is null or "suppliers"."payment_term_days" >= 0);
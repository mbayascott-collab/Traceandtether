CREATE TYPE "public"."payment_direction" AS ENUM('customer_receipt', 'supplier_payment');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'bank_transfer', 'mobile_money', 'other');--> statement-breakpoint
CREATE TABLE "business_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"payment_number" varchar(40) NOT NULL,
	"direction" "payment_direction" NOT NULL,
	"sales_order_id" integer,
	"purchase_order_id" integer,
	"amount_zmw" numeric(14, 2) NOT NULL,
	"payment_date" date NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" varchar(120),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_payments_positive_amount" CHECK ("business_payments"."amount_zmw" > 0),
	CONSTRAINT "business_payments_order_matches_direction" CHECK (("business_payments"."direction" = 'customer_receipt' and "business_payments"."sales_order_id" is not null and "business_payments"."purchase_order_id" is null) or ("business_payments"."direction" = 'supplier_payment' and "business_payments"."purchase_order_id" is not null and "business_payments"."sales_order_id" is null))
);
--> statement-breakpoint
ALTER TABLE "business_payments" ADD CONSTRAINT "business_payments_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_payments" ADD CONSTRAINT "business_payments_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_payments_number_unique" ON "business_payments" USING btree ("payment_number");--> statement-breakpoint
CREATE INDEX "business_payments_sales_order_idx" ON "business_payments" USING btree ("sales_order_id");--> statement-breakpoint
CREATE INDEX "business_payments_purchase_order_idx" ON "business_payments" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "business_payments_date_idx" ON "business_payments" USING btree ("payment_date");
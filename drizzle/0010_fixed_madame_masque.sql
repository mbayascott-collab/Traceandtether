CREATE TYPE "public"."customer_quote_status" AS ENUM('draft', 'sent', 'accepted', 'rejected', 'converted');--> statement-breakpoint
CREATE TABLE "customer_quote_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_quote_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_zmw" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_quote_lines_quantity_positive" CHECK ("customer_quote_lines"."quantity" > 0),
	CONSTRAINT "customer_quote_lines_price_nonnegative" CHECK ("customer_quote_lines"."unit_price_zmw" >= 0)
);
--> statement-breakpoint
CREATE TABLE "customer_quotes" (
	"id" serial PRIMARY KEY NOT NULL,
	"quote_number" varchar(40) NOT NULL,
	"customer_id" integer NOT NULL,
	"status" "customer_quote_status" DEFAULT 'draft' NOT NULL,
	"valid_until" date,
	"delivery_address" text,
	"notes" text,
	"sales_order_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_quotes_conversion_state" CHECK (("customer_quotes"."status" = 'converted') = ("customer_quotes"."sales_order_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "customer_quote_lines" ADD CONSTRAINT "customer_quote_lines_customer_quote_id_customer_quotes_id_fk" FOREIGN KEY ("customer_quote_id") REFERENCES "public"."customer_quotes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_quote_lines" ADD CONSTRAINT "customer_quote_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_quotes" ADD CONSTRAINT "customer_quotes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_quotes" ADD CONSTRAINT "customer_quotes_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_quote_lines_product_unique" ON "customer_quote_lines" USING btree ("customer_quote_id","product_id");--> statement-breakpoint
CREATE INDEX "customer_quote_lines_quote_idx" ON "customer_quote_lines" USING btree ("customer_quote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_quotes_number_unique" ON "customer_quotes" USING btree ("quote_number");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_quotes_sales_order_unique" ON "customer_quotes" USING btree ("sales_order_id");--> statement-breakpoint
CREATE INDEX "customer_quotes_customer_idx" ON "customer_quotes" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_quotes_status_idx" ON "customer_quotes" USING btree ("status");
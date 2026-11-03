CREATE TYPE "public"."supplier_quote_status" AS ENUM('received', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."supplier_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TABLE "supplier_quotes" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"quote_reference" varchar(100),
	"supplier_product_code" varchar(100),
	"unit_price" numeric(14, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"minimum_order_quantity" integer DEFAULT 1 NOT NULL,
	"lead_time_days" integer DEFAULT 0 NOT NULL,
	"valid_until" date,
	"payment_terms" varchar(300),
	"shipping_terms" varchar(120),
	"notes" text,
	"status" "supplier_quote_status" DEFAULT 'received' NOT NULL,
	"quoted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_quotes_price_nonnegative" CHECK ("supplier_quotes"."unit_price" >= 0),
	CONSTRAINT "supplier_quotes_moq_positive" CHECK ("supplier_quotes"."minimum_order_quantity" > 0),
	CONSTRAINT "supplier_quotes_lead_time_nonnegative" CHECK ("supplier_quotes"."lead_time_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(160) NOT NULL,
	"country" varchar(80),
	"contact_name" varchar(120),
	"email" varchar(254),
	"phone" varchar(60),
	"website" varchar(300),
	"payment_terms" varchar(300),
	"default_lead_time_days" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"status" "supplier_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_lead_time_nonnegative" CHECK ("suppliers"."default_lead_time_days" >= 0)
);
--> statement-breakpoint
ALTER TABLE "supplier_quotes" ADD CONSTRAINT "supplier_quotes_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_quotes" ADD CONSTRAINT "supplier_quotes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_quotes_product_idx" ON "supplier_quotes" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "supplier_quotes_supplier_idx" ON "supplier_quotes" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_quotes_status_idx" ON "supplier_quotes" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_quotes_reference_unique" ON "supplier_quotes" USING btree ("supplier_id","product_id","quote_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_name_lower_unique" ON "suppliers" USING btree (lower("name"));
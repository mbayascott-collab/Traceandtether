CREATE TYPE "public"."allocation_basis" AS ENUM('value', 'quantity');--> statement-breakpoint
CREATE TYPE "public"."purchase_order_status" AS ENUM('ordered', 'partially_received', 'received', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('in_transit', 'partially_received', 'received', 'cancelled');--> statement-breakpoint
CREATE TABLE "import_expenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"purchase_order_id" integer NOT NULL,
	"category" varchar(80) NOT NULL,
	"description" varchar(240) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"exchange_rate_to_zmw" numeric(18, 8) NOT NULL,
	"basis" "allocation_basis" DEFAULT 'value' NOT NULL,
	"incurred_at" date DEFAULT now() NOT NULL,
	"reference" varchar(120),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_expenses_amount_positive" CHECK ("import_expenses"."amount" > 0),
	CONSTRAINT "import_expenses_fx_positive" CHECK ("import_expenses"."exchange_rate_to_zmw" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"purchase_order_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"quantity_ordered" integer NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_lines_quantity_positive" CHECK ("purchase_order_lines"."quantity_ordered" > 0),
	CONSTRAINT "purchase_order_lines_price_nonnegative" CHECK ("purchase_order_lines"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_number" varchar(40) NOT NULL,
	"supplier_id" integer NOT NULL,
	"status" "purchase_order_status" DEFAULT 'ordered' NOT NULL,
	"currency" varchar(3) NOT NULL,
	"exchange_rate_to_zmw" numeric(18, 8) NOT NULL,
	"ordered_at" date DEFAULT now() NOT NULL,
	"expected_at" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_fx_positive" CHECK ("purchase_orders"."exchange_rate_to_zmw" > 0)
);
--> statement-breakpoint
CREATE TABLE "shipment_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"shipment_id" integer NOT NULL,
	"purchase_order_line_id" integer NOT NULL,
	"quantity_shipped" integer NOT NULL,
	"quantity_received" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "shipment_lines_shipped_positive" CHECK ("shipment_lines"."quantity_shipped" > 0),
	CONSTRAINT "shipment_lines_received_range" CHECK ("shipment_lines"."quantity_received" >= 0 and "shipment_lines"."quantity_received" <= "shipment_lines"."quantity_shipped")
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" serial PRIMARY KEY NOT NULL,
	"purchase_order_id" integer NOT NULL,
	"shipment_reference" varchar(100),
	"carrier" varchar(120),
	"tracking_number" varchar(120),
	"status" "shipment_status" DEFAULT 'in_transit' NOT NULL,
	"shipped_at" date,
	"expected_at" date,
	"received_at" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_expenses" ADD CONSTRAINT "import_expenses_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_lines" ADD CONSTRAINT "shipment_lines_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_lines" ADD CONSTRAINT "shipment_lines_purchase_order_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_expenses_order_idx" ON "import_expenses" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_lines_product_unique" ON "purchase_order_lines" USING btree ("purchase_order_id","product_id");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_order_idx" ON "purchase_order_lines" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_number_unique" ON "purchase_orders" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_idx" ON "purchase_orders" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "shipment_lines_shipment_idx" ON "shipment_lines" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "shipment_lines_order_line_idx" ON "shipment_lines" USING btree ("purchase_order_line_id");--> statement-breakpoint
CREATE INDEX "shipments_order_idx" ON "shipments" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_reference_per_order_unique" ON "shipments" USING btree ("purchase_order_id","shipment_reference");
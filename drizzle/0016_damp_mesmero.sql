ALTER TYPE "public"."sales_order_status" ADD VALUE 'partially_fulfilled' BEFORE 'fulfilled';--> statement-breakpoint
CREATE TABLE "sales_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"delivery_number" varchar(40) NOT NULL,
	"sales_order_id" integer NOT NULL,
	"delivery_date" date DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_delivery_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"delivery_id" integer NOT NULL,
	"sales_order_line_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_delivery_lines_quantity_positive" CHECK ("sales_delivery_lines"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "sales_deliveries" ADD CONSTRAINT "sales_deliveries_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_delivery_lines" ADD CONSTRAINT "sales_delivery_lines_delivery_id_sales_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."sales_deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_delivery_lines" ADD CONSTRAINT "sales_delivery_lines_sales_order_line_id_sales_order_lines_id_fk" FOREIGN KEY ("sales_order_line_id") REFERENCES "public"."sales_order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_deliveries_number_unique" ON "sales_deliveries" USING btree ("delivery_number");--> statement-breakpoint
CREATE INDEX "sales_deliveries_order_date_idx" ON "sales_deliveries" USING btree ("sales_order_id","delivery_date");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_delivery_lines_delivery_order_line_unique" ON "sales_delivery_lines" USING btree ("delivery_id","sales_order_line_id");--> statement-breakpoint
CREATE INDEX "sales_delivery_lines_order_line_idx" ON "sales_delivery_lines" USING btree ("sales_order_line_id");
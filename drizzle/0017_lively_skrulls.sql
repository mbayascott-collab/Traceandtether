CREATE TABLE "shipment_purchase_orders" (
	"shipment_id" integer NOT NULL,
	"purchase_order_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shipment_purchase_orders" ADD CONSTRAINT "shipment_purchase_orders_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_purchase_orders" ADD CONSTRAINT "shipment_purchase_orders_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
INSERT INTO "shipment_purchase_orders" ("shipment_id", "purchase_order_id")
SELECT "id", "purchase_order_id" FROM "shipments"
ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_purchase_orders_pair_unique" ON "shipment_purchase_orders" USING btree ("shipment_id","purchase_order_id");--> statement-breakpoint
CREATE INDEX "shipment_purchase_orders_order_idx" ON "shipment_purchase_orders" USING btree ("purchase_order_id");
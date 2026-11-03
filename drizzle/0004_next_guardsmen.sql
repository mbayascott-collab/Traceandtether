CREATE TYPE "public"."inventory_movement_kind" AS ENUM('stock_receipt', 'adjustment', 'reservation_fulfillment');--> statement-breakpoint
CREATE TYPE "public"."inventory_reservation_status" AS ENUM('active', 'released', 'fulfilled');--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"kind" "inventory_movement_kind" NOT NULL,
	"quantity_delta" integer NOT NULL,
	"reason" varchar(500) NOT NULL,
	"reference" varchar(120),
	"source_key" varchar(160),
	"reservation_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movements_delta_nonzero" CHECK ("inventory_movements"."quantity_delta" <> 0),
	CONSTRAINT "inventory_movements_reason_nonempty" CHECK (length(trim("inventory_movements"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_reservations" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"quantity" integer NOT NULL,
	"status" "inventory_reservation_status" DEFAULT 'active' NOT NULL,
	"reference" varchar(120),
	"reason" varchar(500) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_reservations_quantity_positive" CHECK ("inventory_reservations"."quantity" > 0),
	CONSTRAINT "inventory_reservations_reason_nonempty" CHECK (length(trim("inventory_reservations"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "shipment_lines" ADD COLUMN "quantity_stocked" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_reservation_id_inventory_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."inventory_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_movements_product_created_idx" ON "inventory_movements" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_movements_source_key_unique" ON "inventory_movements" USING btree ("source_key");--> statement-breakpoint
CREATE INDEX "inventory_reservations_product_status_idx" ON "inventory_reservations" USING btree ("product_id","status");--> statement-breakpoint
ALTER TABLE "shipment_lines" ADD CONSTRAINT "shipment_lines_stocked_range" CHECK ("shipment_lines"."quantity_stocked" >= 0 and "shipment_lines"."quantity_stocked" <= "shipment_lines"."quantity_received");
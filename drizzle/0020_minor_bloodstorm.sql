ALTER TYPE "public"."inventory_movement_kind" ADD VALUE 'stock_return';--> statement-breakpoint
ALTER TYPE "public"."inventory_movement_kind" ADD VALUE 'stock_damage';--> statement-breakpoint
ALTER TYPE "public"."inventory_movement_kind" ADD VALUE 'stock_transfer_in';--> statement-breakpoint
ALTER TYPE "public"."inventory_movement_kind" ADD VALUE 'stock_transfer_out';--> statement-breakpoint
CREATE TABLE "inventory_locations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(120) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD COLUMN "location_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_locations_name_lower_unique" ON "inventory_locations" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_location_id_inventory_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."inventory_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
INSERT INTO "inventory_locations" ("name") VALUES ('Main') ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "inventory_movements" SET "location_id" = (SELECT "id" FROM "inventory_locations" WHERE lower("name") = 'main' LIMIT 1) WHERE "location_id" IS NULL;
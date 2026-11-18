CREATE TABLE "inventory_movement_evidence" (
	"id" serial PRIMARY KEY NOT NULL,
	"movement_id" integer NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"mime_type" varchar(80) NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movement_evidence_file_name_nonempty" CHECK (length(trim("inventory_movement_evidence"."file_name")) > 0),
	CONSTRAINT "inventory_movement_evidence_data_nonempty" CHECK (octet_length("inventory_movement_evidence"."data") > 0)
);
--> statement-breakpoint
ALTER TABLE "inventory_movement_evidence" ADD CONSTRAINT "inventory_movement_evidence_movement_id_inventory_movements_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."inventory_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_movement_evidence_movement_idx" ON "inventory_movement_evidence" USING btree ("movement_id");
--> statement-breakpoint
CREATE FUNCTION prevent_inventory_movement_evidence_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Opening stock evidence cannot be changed or deleted';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER inventory_movement_evidence_immutable
  BEFORE UPDATE OR DELETE ON "inventory_movement_evidence"
  FOR EACH ROW EXECUTE FUNCTION prevent_inventory_movement_evidence_mutation();
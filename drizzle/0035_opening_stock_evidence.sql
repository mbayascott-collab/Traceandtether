ALTER TABLE "inventory_movements"
  ADD COLUMN "evidence_file_name" varchar(255),
  ADD COLUMN "evidence_mime_type" varchar(80),
  ADD COLUMN "evidence_data" bytea;
--> statement-breakpoint
ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_evidence_complete"
  CHECK (
    ("evidence_file_name" IS NULL AND "evidence_mime_type" IS NULL AND "evidence_data" IS NULL)
    OR
    ("evidence_file_name" IS NOT NULL AND "evidence_mime_type" IS NOT NULL AND "evidence_data" IS NOT NULL)
  );

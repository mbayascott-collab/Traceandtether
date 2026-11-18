ALTER TABLE "journal_entries" ADD COLUMN "shipment_line_id" integer;--> statement-breakpoint
UPDATE "journal_entries" AS entry
SET "shipment_line_id" = receipt.id
FROM "inventory_movements" AS movement
INNER JOIN "shipment_lines" AS receipt
  ON receipt.id::text = substring(movement.source_key from '^shipment-line-([0-9]+)-to-[0-9]+$')
WHERE entry.source_type = 'stock_receipt'
  AND entry.source_id = movement.id
  AND entry.shipment_line_id IS NULL;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_shipment_line_id_shipment_lines_id_fk" FOREIGN KEY ("shipment_line_id") REFERENCES "public"."shipment_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_entries_shipment_line_idx" ON "journal_entries" USING btree ("shipment_line_id");--> statement-breakpoint
CREATE TABLE "sales_delivery_receipts" (
	"id" serial PRIMARY KEY NOT NULL,
	"delivery_id" integer NOT NULL,
	"received_by" varchar(120) NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"proof_file_name" varchar(255),
	"proof_mime_type" varchar(80),
	"proof_data" "bytea",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_delivery_receipts_proof_complete" CHECK (("sales_delivery_receipts"."proof_file_name" is null and "sales_delivery_receipts"."proof_mime_type" is null and "sales_delivery_receipts"."proof_data" is null) or ("sales_delivery_receipts"."proof_file_name" is not null and "sales_delivery_receipts"."proof_mime_type" is not null and "sales_delivery_receipts"."proof_data" is not null))
);
--> statement-breakpoint
ALTER TABLE "sales_delivery_receipts" ADD CONSTRAINT "sales_delivery_receipts_delivery_id_sales_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."sales_deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_delivery_receipts_delivery_unique" ON "sales_delivery_receipts" USING btree ("delivery_id");
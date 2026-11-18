CREATE TABLE "sales_delivery_receipt_proofs" (
	"id" serial PRIMARY KEY NOT NULL,
	"delivery_id" integer NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"mime_type" varchar(80) NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_delivery_receipt_proofs" ADD CONSTRAINT "sales_delivery_receipt_proofs_delivery_id_sales_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."sales_deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_delivery_receipt_proofs_delivery_idx" ON "sales_delivery_receipt_proofs" USING btree ("delivery_id");
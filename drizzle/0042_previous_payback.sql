CREATE TABLE "payment_statement_import_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"line_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_statement_import_batches_positive_line_count" CHECK ("payment_statement_import_batches"."line_count" > 0)
);
--> statement-breakpoint
ALTER TABLE "payment_statement_lines" ADD COLUMN "import_batch_id" integer;--> statement-breakpoint
ALTER TABLE "payment_statement_import_batches" ADD CONSTRAINT "payment_statement_import_batches_account_id_accounting_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounting_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_statement_import_batches_account_created_idx" ON "payment_statement_import_batches" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_statement_import_batches_fingerprint_idx" ON "payment_statement_import_batches" USING btree ("account_id","fingerprint");--> statement-breakpoint
ALTER TABLE "payment_statement_lines" ADD CONSTRAINT "payment_statement_lines_import_batch_id_payment_statement_import_batches_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."payment_statement_import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_statement_lines_import_batch_idx" ON "payment_statement_lines" USING btree ("import_batch_id");
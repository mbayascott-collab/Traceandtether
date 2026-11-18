CREATE TYPE "public"."statement_flow" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TABLE "payment_statement_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"transaction_date" date NOT NULL,
	"flow" "statement_flow" NOT NULL,
	"amount_zmw" numeric(14, 2) NOT NULL,
	"description" varchar(240) DEFAULT '' NOT NULL,
	"reference" varchar(120),
	"matched_payment_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_statement_lines_positive_amount" CHECK ("payment_statement_lines"."amount_zmw" > 0)
);
--> statement-breakpoint
ALTER TABLE "payment_statement_lines" ADD CONSTRAINT "payment_statement_lines_account_id_accounting_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounting_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_statement_lines" ADD CONSTRAINT "payment_statement_lines_matched_payment_id_business_payments_id_fk" FOREIGN KEY ("matched_payment_id") REFERENCES "public"."business_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_statement_lines_account_date_idx" ON "payment_statement_lines" USING btree ("account_id","transaction_date");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_statement_lines_matched_payment_unique" ON "payment_statement_lines" USING btree ("matched_payment_id");
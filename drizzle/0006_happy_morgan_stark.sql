CREATE TYPE "public"."accounting_account_type" AS ENUM('asset', 'liability', 'equity', 'income', 'expense');--> statement-breakpoint
CREATE TABLE "accounting_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(12) NOT NULL,
	"name" varchar(120) NOT NULL,
	"type" "accounting_account_type" NOT NULL,
	"system_key" varchar(60),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"entry_number" varchar(40) NOT NULL,
	"source_key" varchar(180),
	"source_type" varchar(40) NOT NULL,
	"source_id" integer,
	"memo" varchar(500) NOT NULL,
	"entry_date" date DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"journal_entry_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"product_id" integer,
	"description" varchar(240),
	"debit_zmw" numeric(14, 2) DEFAULT '0' NOT NULL,
	"credit_zmw" numeric(14, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_lines_one_sided" CHECK (("journal_lines"."debit_zmw" > 0 and "journal_lines"."credit_zmw" = 0) or ("journal_lines"."credit_zmw" > 0 and "journal_lines"."debit_zmw" = 0))
);
--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_accounting_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounting_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_accounts_code_unique" ON "accounting_accounts" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_accounts_system_key_unique" ON "accounting_accounts" USING btree ("system_key");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_number_unique" ON "journal_entries" USING btree ("entry_number");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_source_key_unique" ON "journal_entries" USING btree ("source_key");--> statement-breakpoint
CREATE INDEX "journal_entries_date_idx" ON "journal_entries" USING btree ("entry_date");--> statement-breakpoint
CREATE INDEX "journal_lines_entry_idx" ON "journal_lines" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "journal_lines_account_product_idx" ON "journal_lines" USING btree ("account_id","product_id");
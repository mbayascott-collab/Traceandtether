CREATE TABLE "accounting_corrections" (
	"id" serial PRIMARY KEY NOT NULL,
	"record_type" varchar(32) NOT NULL,
	"record_id" integer NOT NULL,
	"previous_correction_id" integer,
	"reversal_entry_id" integer,
	"replacement_entry_id" integer,
	"category" varchar(40),
	"kind" varchar(40),
	"description" varchar(240),
	"amount_zmw" numeric(14, 2) NOT NULL,
	"effective_date" date NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" varchar(120),
	"notes" text,
	"reason" varchar(450) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_corrections_record_type" CHECK ("accounting_corrections"."record_type" in ('business_expense', 'owner_fund_transaction')),
	CONSTRAINT "accounting_corrections_positive_amount" CHECK ("accounting_corrections"."amount_zmw" > 0)
);
--> statement-breakpoint
ALTER TABLE "accounting_corrections" ADD CONSTRAINT "accounting_corrections_previous_correction_id_accounting_corrections_id_fk" FOREIGN KEY ("previous_correction_id") REFERENCES "public"."accounting_corrections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_corrections" ADD CONSTRAINT "accounting_corrections_reversal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_corrections" ADD CONSTRAINT "accounting_corrections_replacement_entry_id_journal_entries_id_fk" FOREIGN KEY ("replacement_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounting_corrections_source_idx" ON "accounting_corrections" USING btree ("record_type","record_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_corrections_reversal_entry_unique" ON "accounting_corrections" USING btree ("reversal_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_corrections_replacement_entry_unique" ON "accounting_corrections" USING btree ("replacement_entry_id");
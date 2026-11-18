CREATE TABLE "owner_fund_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" varchar(40) NOT NULL,
	"account_id" integer NOT NULL,
	"amount_zmw" numeric(14, 2) NOT NULL,
	"transaction_date" date NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" varchar(120),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_fund_transactions_positive_amount" CHECK ("owner_fund_transactions"."amount_zmw" > 0),
	CONSTRAINT "owner_fund_transactions_kind" CHECK ("owner_fund_transactions"."kind" in ('owner_contribution', 'business_loan', 'owner_withdrawal'))
);
--> statement-breakpoint
ALTER TABLE "owner_fund_transactions" ADD CONSTRAINT "owner_fund_transactions_account_id_accounting_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounting_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "owner_fund_transactions_date_idx" ON "owner_fund_transactions" USING btree ("transaction_date");
--> statement-breakpoint
DO $$
DECLARE
  legacy RECORD;
  transaction_id integer;
BEGIN
  FOR legacy IN
    SELECT
      entry.id AS entry_id,
      entry.source_type AS kind,
      entry.entry_date AS transaction_date,
      entry.memo,
      fund_account.id AS account_id,
      cash_account.system_key AS cash_account_key,
      CASE
        WHEN entry.source_type = 'owner_withdrawal' THEN (
          SELECT sum(line.debit_zmw)
          FROM journal_lines AS line
          WHERE line.journal_entry_id = entry.id AND line.account_id = fund_account.id
        )
        ELSE (
          SELECT sum(line.credit_zmw)
          FROM journal_lines AS line
          WHERE line.journal_entry_id = entry.id AND line.account_id = fund_account.id
        )
      END AS amount_zmw
    FROM journal_entries AS entry
    JOIN accounting_accounts AS fund_account
      ON fund_account.system_key = CASE entry.source_type
        WHEN 'owner_contribution' THEN 'owner_equity'
        WHEN 'business_loan' THEN 'business_loans_payable'
        WHEN 'owner_withdrawal' THEN 'owner_withdrawals'
      END
    JOIN journal_lines AS cash_line ON cash_line.journal_entry_id = entry.id
    JOIN accounting_accounts AS cash_account ON cash_account.id = cash_line.account_id
      AND cash_account.system_key IN ('cash_on_hand', 'bank_account', 'mobile_money', 'other_funds')
    WHERE entry.source_type IN ('owner_contribution', 'business_loan', 'owner_withdrawal')
      AND entry.source_id IS NULL
  LOOP
    INSERT INTO owner_fund_transactions (
      kind, account_id, amount_zmw, transaction_date, method, reference
    ) VALUES (
      legacy.kind,
      legacy.account_id,
      legacy.amount_zmw,
      legacy.transaction_date,
      CASE legacy.cash_account_key
        WHEN 'cash_on_hand' THEN 'cash'::payment_method
        WHEN 'bank_account' THEN 'bank_transfer'::payment_method
        WHEN 'mobile_money' THEN 'mobile_money'::payment_method
        ELSE 'other'::payment_method
      END,
      nullif(substring(legacy.memo from ' · (.*)$'), '')
    ) RETURNING id INTO transaction_id;
    UPDATE journal_entries SET source_id = transaction_id WHERE id = legacy.entry_id;
  END LOOP;
END $$;
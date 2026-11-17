CREATE TABLE "business_expenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"category" varchar(40) NOT NULL,
	"description" varchar(240) NOT NULL,
	"amount_zmw" numeric(14, 2) NOT NULL,
	"expense_date" date NOT NULL,
	"method" "payment_method" NOT NULL,
	"reference" varchar(120),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_expenses_positive_amount" CHECK ("business_expenses"."amount_zmw" > 0)
);
--> statement-breakpoint
CREATE INDEX "business_expenses_date_idx" ON "business_expenses" USING btree ("expense_date");
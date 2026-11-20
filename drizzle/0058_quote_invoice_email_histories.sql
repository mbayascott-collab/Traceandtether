CREATE TABLE "customer_quote_email_attempts" (
  "id" serial PRIMARY KEY NOT NULL,
  "customer_quote_id" integer NOT NULL,
  "attempt_number" integer NOT NULL,
  "attempted_at" timestamp with time zone NOT NULL,
  "recipient_email" varchar(254) NOT NULL,
  "status" varchar(16) DEFAULT 'sending' NOT NULL,
  "sent_at" timestamp with time zone,
  "provider_message_id" varchar(255),
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customer_quote_email_attempts_customer_quote_id_customer_quotes_id_fk"
    FOREIGN KEY ("customer_quote_id") REFERENCES "public"."customer_quotes"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "customer_quote_email_attempts_status"
    CHECK ("customer_quote_email_attempts"."status" in ('sending', 'sent', 'delivered', 'bounced', 'failed', 'ambiguous'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "customer_quote_email_attempts_number_unique"
  ON "customer_quote_email_attempts" USING btree ("customer_quote_id", "attempt_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "customer_quote_email_attempts_message_unique"
  ON "customer_quote_email_attempts" USING btree ("provider_message_id");
--> statement-breakpoint
CREATE INDEX "customer_quote_email_attempts_quote_idx"
  ON "customer_quote_email_attempts" USING btree ("customer_quote_id", "attempted_at");
--> statement-breakpoint
CREATE TABLE "sales_delivery_invoice_email_attempts" (
  "id" serial PRIMARY KEY NOT NULL,
  "delivery_id" integer NOT NULL,
  "attempt_number" integer NOT NULL,
  "attempted_at" timestamp with time zone NOT NULL,
  "recipient_email" varchar(254) NOT NULL,
  "status" varchar(16) DEFAULT 'sending' NOT NULL,
  "sent_at" timestamp with time zone,
  "provider_message_id" varchar(255),
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sales_delivery_invoice_email_attempts_delivery_id_sales_deliveries_id_fk"
    FOREIGN KEY ("delivery_id") REFERENCES "public"."sales_deliveries"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "sales_delivery_invoice_email_attempts_status"
    CHECK ("sales_delivery_invoice_email_attempts"."status" in ('sending', 'sent', 'failed', 'ambiguous'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sales_delivery_invoice_email_attempts_number_unique"
  ON "sales_delivery_invoice_email_attempts" USING btree ("delivery_id", "attempt_number");
--> statement-breakpoint
CREATE INDEX "sales_delivery_invoice_email_attempts_delivery_idx"
  ON "sales_delivery_invoice_email_attempts" USING btree ("delivery_id", "attempted_at");
--> statement-breakpoint
CREATE TABLE "unmatched_customer_quote_email_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "provider" varchar(32) NOT NULL,
  "provider_event_id" varchar(255) NOT NULL,
  "provider_message_id" varchar(255) NOT NULL,
  "outcome" varchar(16) NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "error" text,
  "reviewed_at" timestamp with time zone,
  "reviewed_by" varchar(255),
  CONSTRAINT "unmatched_customer_quote_email_events_outcome"
    CHECK ("unmatched_customer_quote_email_events"."outcome" in ('delivered', 'bounced', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "unmatched_customer_quote_email_events_provider_event_unique"
  ON "unmatched_customer_quote_email_events" USING btree ("provider", "provider_event_id");
--> statement-breakpoint
CREATE INDEX "unmatched_customer_quote_email_events_reviewed_idx"
  ON "unmatched_customer_quote_email_events" USING btree ("reviewed_at", "received_at");
--> statement-breakpoint
ALTER TABLE "customer_quotes" DROP CONSTRAINT "customer_quotes_email_send_status";
--> statement-breakpoint
ALTER TABLE "customer_quotes" ADD CONSTRAINT "customer_quotes_email_send_status"
  CHECK ("customer_quotes"."email_send_status" in ('not_sent', 'sending', 'sent', 'delivered', 'bounced', 'failed', 'ambiguous'));

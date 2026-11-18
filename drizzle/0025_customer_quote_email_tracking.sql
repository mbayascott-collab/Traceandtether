ALTER TABLE "customer_quotes" ADD COLUMN "email_send_status" varchar(16) DEFAULT 'not_sent' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_quotes" ADD COLUMN "email_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_quotes" ADD COLUMN "email_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_quotes" ADD COLUMN "email_send_error" text;--> statement-breakpoint
ALTER TABLE "customer_quotes" ADD CONSTRAINT "customer_quotes_email_send_status" CHECK ("customer_quotes"."email_send_status" in ('not_sent', 'sent', 'failed'));
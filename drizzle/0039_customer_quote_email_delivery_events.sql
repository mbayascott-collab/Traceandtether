CREATE TABLE "customer_quote_email_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_event_id" varchar(255) NOT NULL,
	"customer_quote_id" integer NOT NULL,
	"provider_message_id" varchar(255) NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_quote_email_events_outcome" CHECK ("customer_quote_email_events"."outcome" in ('delivered', 'bounced', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "customer_quotes" DROP CONSTRAINT "customer_quotes_email_send_status";--> statement-breakpoint
ALTER TABLE "customer_quotes" ADD COLUMN "email_provider_message_id" varchar(255);--> statement-breakpoint
ALTER TABLE "customer_quotes" ADD COLUMN "email_delivery_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_quote_email_events" ADD CONSTRAINT "customer_quote_email_events_customer_quote_id_customer_quotes_id_fk" FOREIGN KEY ("customer_quote_id") REFERENCES "public"."customer_quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_quote_email_events_provider_event_unique" ON "customer_quote_email_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "customer_quote_email_events_quote_idx" ON "customer_quote_email_events" USING btree ("customer_quote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_quotes_email_provider_message_unique" ON "customer_quotes" USING btree ("email_provider_message_id");--> statement-breakpoint
ALTER TABLE "customer_quotes" ADD CONSTRAINT "customer_quotes_email_send_status" CHECK ("customer_quotes"."email_send_status" in ('not_sent', 'sending', 'sent', 'delivered', 'bounced', 'failed'));
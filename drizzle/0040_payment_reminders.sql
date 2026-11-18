CREATE TABLE "payment_reminders" (
	"id" serial PRIMARY KEY NOT NULL,
	"sales_order_id" integer NOT NULL,
	"recipient_email" varchar(254) NOT NULL,
	"outstanding_zmw" numeric(14, 2) NOT NULL,
	"due_date" date NOT NULL,
	"note" varchar(1000) DEFAULT '' NOT NULL,
	"status" varchar(16) NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"send_error" text,
	"provider_message_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_reminders_positive_outstanding" CHECK ("payment_reminders"."outstanding_zmw" > 0),
	CONSTRAINT "payment_reminders_status" CHECK ("payment_reminders"."status" in ('sending', 'sent', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "payment_reminders" ADD CONSTRAINT "payment_reminders_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_reminders_order_created_idx" ON "payment_reminders" USING btree ("sales_order_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_reminders_provider_message_unique" ON "payment_reminders" USING btree ("provider_message_id");
CREATE TYPE "public"."marketing_campaign_status" AS ENUM('draft', 'active', 'paused', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."marketing_content_status" AS ENUM('planned', 'in_progress', 'ready', 'published', 'cancelled');--> statement-breakpoint
CREATE TABLE "marketing_campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(180) NOT NULL,
	"objective" text,
	"channel" varchar(80),
	"status" "marketing_campaign_status" DEFAULT 'draft' NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"budget_zmw" numeric(14, 2),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_campaigns_budget_nonnegative" CHECK ("marketing_campaigns"."budget_zmw" is null or "marketing_campaigns"."budget_zmw" >= 0),
	CONSTRAINT "marketing_campaigns_date_order" CHECK ("marketing_campaigns"."starts_on" is null or "marketing_campaigns"."ends_on" is null or "marketing_campaigns"."ends_on" >= "marketing_campaigns"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "marketing_content_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" integer,
	"title" varchar(180) NOT NULL,
	"platform" varchar(80) NOT NULL,
	"content_type" varchar(80) NOT NULL,
	"status" "marketing_content_status" DEFAULT 'planned' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"caption" text,
	"published_url" varchar(2000),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketing_expenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" integer,
	"category" varchar(80) NOT NULL,
	"description" varchar(240) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"exchange_rate_to_zmw" numeric(18, 8) NOT NULL,
	"expense_date" date DEFAULT now() NOT NULL,
	"reference" varchar(120),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_expenses_amount_positive" CHECK ("marketing_expenses"."amount" > 0),
	CONSTRAINT "marketing_expenses_fx_positive" CHECK ("marketing_expenses"."exchange_rate_to_zmw" > 0)
);
--> statement-breakpoint
ALTER TABLE "marketing_content_items" ADD CONSTRAINT "marketing_content_items_campaign_id_marketing_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."marketing_campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_expenses" ADD CONSTRAINT "marketing_expenses_campaign_id_marketing_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."marketing_campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "marketing_campaigns_status_idx" ON "marketing_campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "marketing_content_campaign_idx" ON "marketing_content_items" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "marketing_content_schedule_idx" ON "marketing_content_items" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "marketing_expenses_campaign_idx" ON "marketing_expenses" USING btree ("campaign_id");
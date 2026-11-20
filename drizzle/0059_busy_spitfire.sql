CREATE TABLE "marketing_campaign_audience_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" integer NOT NULL,
	"source_group_id" integer,
	"group_name" varchar(120) NOT NULL,
	"rules" jsonb NOT NULL,
	"members" jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "marketing_campaign_audience_snapshots" ADD CONSTRAINT "marketing_campaign_audience_snapshots_campaign_id_marketing_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."marketing_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_campaign_audience_snapshots_campaign_unique" ON "marketing_campaign_audience_snapshots" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "marketing_campaign_audience_snapshots_group_idx" ON "marketing_campaign_audience_snapshots" USING btree ("source_group_id");
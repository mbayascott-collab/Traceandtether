ALTER TABLE "marketing_attributions" ADD COLUMN "source" varchar(20) DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD COLUMN "tracking_code" varchar(36) DEFAULT gen_random_uuid()::text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_campaigns_tracking_code_unique" ON "marketing_campaigns" USING btree ("tracking_code");--> statement-breakpoint
ALTER TABLE "marketing_attributions" ADD CONSTRAINT "marketing_attributions_source_valid" CHECK ("marketing_attributions"."source" in ('manual', 'campaign_link'));
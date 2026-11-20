ALTER TABLE "marketing_campaigns" ADD COLUMN "audience_snapshot_enabled_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "marketing_campaigns"
SET "audience_snapshot_enabled_at" = now()
WHERE "status" = 'active'
  AND "customer_group_id" IS NOT NULL
  AND "starts_on" > (now() AT TIME ZONE 'Africa/Lusaka')::date;
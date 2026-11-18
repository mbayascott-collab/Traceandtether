ALTER TABLE "public_shop_order_attempt_daily_counts" ADD COLUMN "rate_limited_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "public_shop_order_attempt_daily_counts" ADD COLUMN "bot_check_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "public_shop_order_attempt_daily_counts" ADD CONSTRAINT "public_shop_order_attempt_daily_counts_rate_limited_nonnegative" CHECK ("public_shop_order_attempt_daily_counts"."rate_limited_count" >= 0);--> statement-breakpoint
ALTER TABLE "public_shop_order_attempt_daily_counts" ADD CONSTRAINT "public_shop_order_attempt_daily_counts_bot_check_nonnegative" CHECK ("public_shop_order_attempt_daily_counts"."bot_check_count" >= 0);--> statement-breakpoint
ALTER TABLE "public_shop_order_attempt_counts" ADD COLUMN "rate_limited_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "public_shop_order_attempt_counts" ADD COLUMN "bot_check_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "public_shop_order_attempt_counts" ADD CONSTRAINT "public_shop_order_attempt_counts_rate_limited_nonnegative" CHECK ("public_shop_order_attempt_counts"."rate_limited_count" >= 0);--> statement-breakpoint
ALTER TABLE "public_shop_order_attempt_counts" ADD CONSTRAINT "public_shop_order_attempt_counts_bot_check_nonnegative" CHECK ("public_shop_order_attempt_counts"."bot_check_count" >= 0);
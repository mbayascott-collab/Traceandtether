CREATE TABLE "public_shop_order_attempt_daily_counts" (
  "day" date PRIMARY KEY NOT NULL,
  "accepted_count" integer DEFAULT 0 NOT NULL,
  "blocked_count" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "public_shop_order_attempt_daily_counts_accepted_nonnegative" CHECK ("public_shop_order_attempt_daily_counts"."accepted_count" >= 0),
  CONSTRAINT "public_shop_order_attempt_daily_counts_blocked_nonnegative" CHECK ("public_shop_order_attempt_daily_counts"."blocked_count" >= 0)
);

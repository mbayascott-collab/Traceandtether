CREATE TABLE "public_shop_order_attempt_counts" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"accepted_count" integer DEFAULT 0 NOT NULL,
	"blocked_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "public_shop_order_attempt_counts_singleton" CHECK ("public_shop_order_attempt_counts"."id" = 1),
	CONSTRAINT "public_shop_order_attempt_counts_accepted_nonnegative" CHECK ("public_shop_order_attempt_counts"."accepted_count" >= 0),
	CONSTRAINT "public_shop_order_attempt_counts_blocked_nonnegative" CHECK ("public_shop_order_attempt_counts"."blocked_count" >= 0)
);

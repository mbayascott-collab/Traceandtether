CREATE TABLE "public_shop_order_limits" (
	"ip_hash" varchar(64) PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"hit_count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "public_shop_order_limits_hit_count_positive" CHECK ("public_shop_order_limits"."hit_count" > 0)
);
--> statement-breakpoint
CREATE INDEX "public_shop_order_limits_expires_at_idx" ON "public_shop_order_limits" USING btree ("expires_at");
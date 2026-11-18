CREATE TABLE "public_shop_challenges" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"ip_hash" varchar(64) NOT NULL,
	"issued_at" bigint NOT NULL,
	CONSTRAINT "public_shop_challenges_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE INDEX "public_shop_challenges_issued_at_idx" ON "public_shop_challenges" USING btree ("issued_at");
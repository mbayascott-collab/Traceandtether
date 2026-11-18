CREATE TABLE "business_audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity_type" varchar(48) NOT NULL,
	"entity_id" integer NOT NULL,
	"record_label" varchar(240) NOT NULL,
	"actor_clerk_user_id" varchar(255),
	"actor_email" varchar(320) NOT NULL,
	"action" varchar(16) NOT NULL,
	"changed_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "business_audit_logs_created_idx" ON "business_audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "business_audit_logs_entity_idx" ON "business_audit_logs" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
INSERT INTO "business_audit_logs" (
  "entity_type", "entity_id", "record_label", "actor_clerk_user_id", "actor_email", "action", "changed_fields", "created_at"
)
SELECT
  'product',
  audit."product_id",
  coalesce(product."name", 'Product #' || audit."product_id"::text),
  audit."actor_clerk_user_id",
  coalesce(app_user."email", 'Unknown account'),
  audit."action",
  audit."changed_fields",
  audit."created_at"
FROM "product_audit_logs" audit
LEFT JOIN "products" product ON product."id" = audit."product_id"
LEFT JOIN "app_users" app_user ON app_user."clerk_user_id" = audit."actor_clerk_user_id";
CREATE TYPE "public"."app_role" AS ENUM('owner', 'manager', 'sales', 'inventory', 'marketing', 'accountant', 'reviewer');--> statement-breakpoint
CREATE TYPE "public"."category_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('draft', 'active', 'inactive');--> statement-breakpoint
CREATE TABLE "app_users" (
	"clerk_user_id" varchar(255) PRIMARY KEY NOT NULL,
	"email" varchar(320) NOT NULL,
	"role" "app_role" DEFAULT 'reviewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"actor_clerk_user_id" varchar(255) NOT NULL,
	"action" varchar(16) NOT NULL,
	"changed_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"description" varchar(500),
	"status" "category_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"sku" varchar(60) NOT NULL,
	"name" varchar(160) NOT NULL,
	"description" text,
	"brand" varchar(100),
	"category_id" integer,
	"supplier_name" varchar(160),
	"supplier_product_code" varchar(100),
	"purchase_currency" varchar(3) DEFAULT 'CNY' NOT NULL,
	"purchase_price" numeric(14, 2),
	"estimated_landed_cost_zmw" numeric(14, 2),
	"selling_price_zmw" numeric(14, 2),
	"reorder_threshold" integer DEFAULT 0 NOT NULL,
	"unit" varchar(32) DEFAULT 'unit' NOT NULL,
	"status" "product_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_purchase_price_nonnegative" CHECK ("products"."purchase_price" is null or "products"."purchase_price" >= 0),
	CONSTRAINT "products_landed_cost_nonnegative" CHECK ("products"."estimated_landed_cost_zmw" is null or "products"."estimated_landed_cost_zmw" >= 0),
	CONSTRAINT "products_selling_price_nonnegative" CHECK ("products"."selling_price_zmw" is null or "products"."selling_price_zmw" >= 0),
	CONSTRAINT "products_reorder_threshold_nonnegative" CHECK ("products"."reorder_threshold" >= 0)
);
--> statement-breakpoint
ALTER TABLE "product_audit_logs" ADD CONSTRAINT "product_audit_logs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_categories_name_lower_unique" ON "product_categories" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "products_sku_lower_unique" ON "products" USING btree (lower("sku"));
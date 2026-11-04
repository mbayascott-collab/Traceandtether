CREATE TABLE "app_user_access" (
	"email" varchar(320) PRIMARY KEY NOT NULL,
	"display_name" varchar(120),
	"role" "app_role" DEFAULT 'manager' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_clerk_user_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

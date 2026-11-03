CREATE TABLE "marketing_attributions" (
	"id" serial PRIMARY KEY NOT NULL,
	"sales_order_id" integer NOT NULL,
	"campaign_id" integer NOT NULL,
	"attributed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "marketing_attributions" ADD CONSTRAINT "marketing_attributions_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_attributions" ADD CONSTRAINT "marketing_attributions_campaign_id_marketing_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."marketing_campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_attributions_order_unique" ON "marketing_attributions" USING btree ("sales_order_id");--> statement-breakpoint
CREATE INDEX "marketing_attributions_campaign_idx" ON "marketing_attributions" USING btree ("campaign_id");
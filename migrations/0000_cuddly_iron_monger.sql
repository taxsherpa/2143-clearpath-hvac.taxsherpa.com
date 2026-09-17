CREATE TYPE "public"."clearpath_category" AS ENUM('revenue', 'fulfillment', 'cac', 'systems', 'people', 'owners_pay', 'taxes');--> statement-breakpoint
CREATE TYPE "public"."confidence_level" AS ENUM('high', 'medium', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."rule_scope" AS ENUM('vendor', 'account', 'memo_substring');--> statement-breakpoint
CREATE TYPE "public"."rule_target" AS ENUM('category', 'split');--> statement-breakpoint
CREATE TYPE "public"."upload_status" AS ENUM('parsed', 'mapped', 'exported', 'deleted');--> statement-breakpoint
CREATE TABLE "line_splits" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_id" varchar NOT NULL,
	"clearpath_category" "clearpath_category" NOT NULL,
	"amount_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lines" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upload_id" varchar NOT NULL,
	"src_account" text NOT NULL,
	"vendor" text,
	"memo" text,
	"amount_cents" integer NOT NULL,
	"src_date" timestamp NOT NULL,
	"premap_category" "clearpath_category" NOT NULL,
	"premap_confidence" "confidence_level" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upload_id" varchar NOT NULL,
	"rollup_json" jsonb NOT NULL,
	"benchmarks_json" jsonb NOT NULL,
	"pdf_path" text,
	"csv_path" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"scope" "rule_scope" NOT NULL,
	"scope_value" text NOT NULL,
	"target" "rule_target" NOT NULL,
	"payload" jsonb NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"original_filename" text NOT NULL,
	"month_start" timestamp NOT NULL,
	"status" "upload_status" DEFAULT 'parsed' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "line_splits" ADD CONSTRAINT "line_splits_line_id_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lines" ADD CONSTRAINT "lines_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_upload_id_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
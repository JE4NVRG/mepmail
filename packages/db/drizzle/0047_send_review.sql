CREATE TYPE "public"."send_review_reason" AS ENUM('impersonation', 'payment_risk');--> statement-breakpoint
ALTER TYPE "public"."team_flag_reason" ADD VALUE 'review';--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "send_review_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "send_review_reason" "send_review_reason";--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "send_review_note" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "send_review_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "send_review_cleared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "send_review_cleared_by" text;

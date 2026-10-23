CREATE TABLE IF NOT EXISTS "purchase_rate_limits" (
  "bucket" text PRIMARY KEY,
  "window_start" timestamptz NOT NULL,
  "count" integer NOT NULL
);

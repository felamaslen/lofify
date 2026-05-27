CREATE TABLE "PlaybackCacheAccess" (
  "entryDir" text PRIMARY KEY NOT NULL,
  "lastAccess" timestamp with time zone DEFAULT now() NOT NULL,
  "sizeBytes" bigint DEFAULT 0 NOT NULL
);

CREATE INDEX "PlaybackCacheAccess_lastAccess_idx" ON "PlaybackCacheAccess" USING btree ("lastAccess");

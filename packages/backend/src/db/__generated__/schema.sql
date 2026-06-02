-- AUTO-GENERATED FILE. DO NOT EDIT.
-- Intermediary DB schema used for generating migrations and checking drift.
-- The Drizzle schema is the source of truth.
CREATE TABLE "ArtistSynonyms" (
  "artist" text NOT NULL,
  "synonym" text NOT NULL,
  CONSTRAINT "ArtistSynonyms_artist_synonym_pk" PRIMARY KEY ("artist", "synonym")
);

CREATE TABLE "PlaybackCacheAccess" (
  "entryDir" text PRIMARY KEY NOT NULL,
  "lastAccess" timestamp with time zone DEFAULT now() NOT NULL,
  "sizeBytes" bigint DEFAULT 0 NOT NULL
);

CREATE TABLE "Tracks" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  "scannedAt" timestamp with time zone DEFAULT now() NOT NULL,
  "title" text,
  "trackNumber" integer,
  "discNumber" integer,
  "artist" text,
  "album" text,
  "year" text,
  "titleOverride" text,
  "trackNumberOverride" integer,
  "discNumberOverride" integer,
  "artistOverride" text,
  "albumOverride" text,
  "yearOverride" text,
  "format" text NOT NULL,
  "codec" text NOT NULL,
  "codecProfile" text,
  "bitRate" integer,
  "sampleRate" integer NOT NULL,
  "bitDepth" integer,
  "channels" integer,
  "isLossless" boolean NOT NULL,
  "file" text NOT NULL,
  "sizeBytes" bigint NOT NULL,
  "durationSeconds" integer NOT NULL,
  "sourceMtime" timestamp with time zone NOT NULL,
  "trackIdDeduplicated" uuid,
  "priority" smallint,
  CONSTRAINT "Tracks_dedup_pairing_ck" CHECK (
    ("Tracks"."trackIdDeduplicated" IS NULL) = ("Tracks"."priority" IS NULL)
  )
);

ALTER TABLE "Tracks"
ADD CONSTRAINT "Tracks_trackIdDeduplicated_Tracks_id_fk" FOREIGN KEY ("trackIdDeduplicated") REFERENCES "public"."Tracks" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE INDEX "ArtistSynonyms_synonym_idx" ON "ArtistSynonyms" USING btree ("synonym");

CREATE INDEX "PlaybackCacheAccess_lastAccess_idx" ON "PlaybackCacheAccess" USING btree ("lastAccess");

CREATE INDEX "Tracks_artist_idx" ON "Tracks" USING btree ("artist");

CREATE INDEX "Tracks_album_idx" ON "Tracks" USING btree ("album");

CREATE UNIQUE INDEX "Tracks_file_unq" ON "Tracks" USING btree ("file");

CREATE UNIQUE INDEX "Tracks_dedup_priority_unq" ON "Tracks" USING btree ("trackIdDeduplicated", "priority");

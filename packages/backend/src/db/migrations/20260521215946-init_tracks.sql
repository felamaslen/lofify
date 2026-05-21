CREATE TABLE "public"."Tracks" (
  "id" uuid NOT NULL DEFAULT uuidv7(),
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "scannedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "title" text,
  "trackNumber" integer,
  "discNumber" integer,
  "artist" text,
  "album" text,
  "year" text,
  "format" text NOT NULL,
  "codec" text NOT NULL,
  "bitRate" integer,
  "sampleRate" integer NOT NULL,
  "isLossless" boolean NOT NULL,
  "file" text NOT NULL,
  "sizeBytes" bigint NOT NULL,
  "durationSeconds" integer NOT NULL
);

CREATE INDEX "Tracks_album_idx" ON public."Tracks" USING btree (album);

CREATE INDEX "Tracks_artist_idx" ON public."Tracks" USING btree (artist);

CREATE UNIQUE INDEX "Tracks_file_unq" ON public."Tracks" USING btree (file);

CREATE UNIQUE INDEX "Tracks_pkey" ON public."Tracks" USING btree (id);

ALTER TABLE "public"."Tracks"
ADD CONSTRAINT "Tracks_pkey" PRIMARY KEY USING index "Tracks_pkey";

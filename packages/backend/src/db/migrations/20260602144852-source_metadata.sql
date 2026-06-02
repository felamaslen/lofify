ALTER TABLE "public"."Tracks"
ADD COLUMN "bitDepth" integer;

ALTER TABLE "public"."Tracks"
ADD COLUMN "channels" integer;

ALTER TABLE "public"."Tracks"
ADD COLUMN "codecProfile" text;

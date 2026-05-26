ALTER TABLE "public"."Tracks"
ADD COLUMN "albumOverride" text;

ALTER TABLE "public"."Tracks"
ADD COLUMN "artistOverride" text;

ALTER TABLE "public"."Tracks"
ADD COLUMN "discNumberOverride" integer;

ALTER TABLE "public"."Tracks"
ADD COLUMN "titleOverride" text;

ALTER TABLE "public"."Tracks"
ADD COLUMN "trackNumberOverride" integer;

ALTER TABLE "public"."Tracks"
ADD COLUMN "yearOverride" text;

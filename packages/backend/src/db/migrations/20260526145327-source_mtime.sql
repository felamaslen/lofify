ALTER TABLE "public"."Tracks"
ADD COLUMN "sourceMtime" timestamp with time zone NOT NULL DEFAULT now();

ALTER TABLE "public"."Tracks"
ALTER COLUMN "sourceMtime" DROP DEFAULT;

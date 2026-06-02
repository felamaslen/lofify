ALTER TABLE "public"."Tracks"
ADD COLUMN "priority" smallint;

ALTER TABLE "public"."Tracks"
ADD COLUMN "trackIdDeduplicated" uuid;

CREATE UNIQUE INDEX "Tracks_dedup_priority_unq" ON public."Tracks" USING btree ("trackIdDeduplicated", priority);

ALTER TABLE "public"."Tracks"
ADD CONSTRAINT "Tracks_dedup_pairing_ck" CHECK (
  (
    ("trackIdDeduplicated" IS NULL) = (priority IS NULL)
  )
) NOT valid;

ALTER TABLE "public"."Tracks" validate CONSTRAINT "Tracks_dedup_pairing_ck";

ALTER TABLE "public"."Tracks"
ADD CONSTRAINT "Tracks_trackIdDeduplicated_Tracks_id_fk" FOREIGN KEY ("trackIdDeduplicated") REFERENCES "Tracks" (id) NOT valid;

ALTER TABLE "public"."Tracks" validate CONSTRAINT "Tracks_trackIdDeduplicated_Tracks_id_fk";

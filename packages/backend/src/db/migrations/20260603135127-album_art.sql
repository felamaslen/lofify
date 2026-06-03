CREATE TABLE "public"."AlbumArt" (
  "id" uuid NOT NULL DEFAULT uuidv7(),
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "albumArtist" text NOT NULL,
  "album" text NOT NULL,
  "file" text,
  "status" text NOT NULL DEFAULT 'PENDING'::text,
  "error" text
);

ALTER TABLE "public"."Tracks"
ADD COLUMN "albumArtId" uuid;

CREATE UNIQUE INDEX "AlbumArt_albumArtist_album_unq" ON public."AlbumArt" USING btree ("albumArtist", album);

CREATE UNIQUE INDEX "AlbumArt_pkey" ON public."AlbumArt" USING btree (id);

ALTER TABLE "public"."AlbumArt"
ADD CONSTRAINT "AlbumArt_pkey" PRIMARY KEY USING index "AlbumArt_pkey";

ALTER TABLE "public"."AlbumArt"
ADD CONSTRAINT "AlbumArt_status_ck" CHECK (
  (
    status = ANY (
      ARRAY[
        'PENDING'::text,
        'IN_PROGRESS'::text,
        'SUCCEEDED'::text,
        'FAILED'::text
      ]
    )
  )
) NOT valid;

ALTER TABLE "public"."AlbumArt" validate CONSTRAINT "AlbumArt_status_ck";

ALTER TABLE "public"."Tracks"
ADD CONSTRAINT "Tracks_albumArtId_AlbumArt_id_fk" FOREIGN KEY ("albumArtId") REFERENCES "AlbumArt" (id) ON DELETE SET NULL NOT valid;

ALTER TABLE "public"."Tracks" validate CONSTRAINT "Tracks_albumArtId_AlbumArt_id_fk";

SET
  check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.notify_album_art_pending () RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      PERFORM pg_notify('album_art_pending', NEW.id::text);
      RETURN NEW;
    END;
    $function$;

CREATE TRIGGER "AlbumArt_pending_notify"
AFTER INSERT OR UPDATE OF status ON public."AlbumArt" FOR EACH ROW WHEN ((new.status = 'PENDING'::text))
EXECUTE FUNCTION notify_album_art_pending ();

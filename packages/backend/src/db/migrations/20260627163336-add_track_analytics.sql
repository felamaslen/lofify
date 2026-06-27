CREATE TABLE "public"."TrackAnalytics" (
  "id" uuid NOT NULL DEFAULT uuidv7(),
  "trackId" uuid NOT NULL,
  "clientIp" text NOT NULL,
  "playTimeSeconds" integer NOT NULL,
  "requestedMode" text NOT NULL,
  "outputCodec" text NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "TrackAnalytics_pkey" ON public."TrackAnalytics" USING btree (id);

CREATE INDEX "TrackAnalytics_trackId_idx" ON public."TrackAnalytics" USING btree ("trackId");

ALTER TABLE "public"."TrackAnalytics"
ADD CONSTRAINT "TrackAnalytics_pkey" PRIMARY KEY USING index "TrackAnalytics_pkey";

ALTER TABLE "public"."TrackAnalytics"
ADD CONSTRAINT "TrackAnalytics_trackId_Tracks_id_fk" FOREIGN KEY ("trackId") REFERENCES "Tracks" (id) ON DELETE CASCADE NOT valid;

ALTER TABLE "public"."TrackAnalytics" validate CONSTRAINT "TrackAnalytics_trackId_Tracks_id_fk";

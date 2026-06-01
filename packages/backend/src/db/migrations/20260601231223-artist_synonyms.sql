CREATE TABLE "public"."ArtistSynonyms" ("artist" text NOT NULL, "synonym" text NOT NULL);

CREATE UNIQUE INDEX "ArtistSynonyms_artist_synonym_pk" ON public."ArtistSynonyms" USING btree (artist, synonym);

CREATE INDEX "ArtistSynonyms_synonym_idx" ON public."ArtistSynonyms" USING btree (synonym);

ALTER TABLE "public"."ArtistSynonyms"
ADD CONSTRAINT "ArtistSynonyms_artist_synonym_pk" PRIMARY KEY USING index "ArtistSynonyms_artist_synonym_pk";

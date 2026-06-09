CREATE TABLE "public"."ScanErrors" (
  "id" uuid NOT NULL DEFAULT uuidv7(),
  "file" text NOT NULL,
  "message" text NOT NULL,
  "stack" text NOT NULL,
  "attemptedAt" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "ScanErrors_file_unq" ON public."ScanErrors" USING btree (file);

CREATE UNIQUE INDEX "ScanErrors_pkey" ON public."ScanErrors" USING btree (id);

ALTER TABLE "public"."ScanErrors"
ADD CONSTRAINT "ScanErrors_pkey" PRIMARY KEY USING index "ScanErrors_pkey";

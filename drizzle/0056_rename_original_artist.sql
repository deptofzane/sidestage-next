-- Rename only: the column holds user-entered data, so this must never
-- become DROP + ADD. drizzle-kit could not tell a rename from a
-- drop/add without a prompt, so this migration is written by hand.
ALTER TABLE "conversations" RENAME COLUMN "original_band" TO "original_artist";

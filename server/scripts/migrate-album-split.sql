-- Phase 3 data migration for the metadata table: split `album` into
-- (album_date, album_name) and copy `file_date` into `capture_time`.
--
-- Prerequisite: schema migration v8 has run, which rebuilt the metadata
-- FTS5 table to include the new columns (album_date, album_name, capture_time).
-- The old columns (album, file_date) still exist alongside the new ones;
-- they get populated for back-compat and as a safety net.
--
-- The collections.apply_folder_pattern conversion is handled manually
-- (see README / phase 3 notes). For a single collection this is a one-line
-- UPDATE and easier to do by hand than to generalize for arbitrary patterns:
--   UPDATE collections SET apply_folder_pattern = '{{yyyy}}/{{yyyy}}-{{mm}}-{{dd}} {{album}}' WHERE collection_id = <id>;
--
-- Run with the server stopped, against the same DB the server uses.

-- ---------------------------------------------------------------------------
-- Step 1 (preview): see how a sample row will be split.
-- For a 'yyyy/yyyy-mm-dd' folder layout (FOLDER_ALBUM):
--   '2021/2021-01-01 New Year'                 -> ('2021-01-01', 'New Year')
--   '2021/2021-01-01 New Year/WhatsApp Images' -> ('2021-01-01', 'New Year/WhatsApp Images')
--   '2021/2021-01-01'                          -> ('2021-01-01', '')
--   '2021/2021-01-01 TBD'                      -> ('2021-01-01', 'TBD')
-- For a 'yyyy-mm-dd' folder layout (VIRTUAL_ALBUM or simple FOLDER_ALBUM):
--   '2021-01-01' -> ('2021-01-01', '')
-- ---------------------------------------------------------------------------
SELECT
  uuid,
  album AS old_album,
  CASE
    WHEN instr(album, '/') > 0
      THEN substr(album, instr(album, '/') + 1, 10)
    ELSE substr(album, 1, 10)
  END AS new_album_date,
  CASE
    WHEN instr(album, '/') > 0
      THEN trim(substr(album, instr(album, '/') + 12))
    ELSE trim(substr(album, 12))
  END AS new_album_name,
  file_date AS old_file_date,
  file_date AS new_capture_time
FROM metadata
LIMIT 50;

-- ---------------------------------------------------------------------------
-- Step 2 (apply): populate album_date, album_name, capture_time for every row.
-- Wrap in a transaction so you can rollback if a sample post-check looks off.
-- ---------------------------------------------------------------------------
BEGIN;

UPDATE metadata
SET
  album_date = CASE
    WHEN instr(album, '/') > 0
      THEN substr(album, instr(album, '/') + 1, 10)
    ELSE substr(album, 1, 10)
  END,
  album_name = CASE
    WHEN instr(album, '/') > 0
      THEN trim(substr(album, instr(album, '/') + 12))
    ELSE trim(substr(album, 12))
  END,
  capture_time = file_date
WHERE album_date IS NULL OR album_name IS NULL OR capture_time IS NULL;

-- ---------------------------------------------------------------------------
-- Step 3 (verify): spot-check that:
--   - album_date looks like a YYYY-MM-DD
--   - album_name is empty, descriptive, or 'TBD'-ish
--   - capture_time matches what file_date held
-- ---------------------------------------------------------------------------
SELECT
  album,
  album_date,
  album_name,
  file_date,
  capture_time
FROM metadata
LIMIT 50;

-- Counts that should all equal the number of metadata rows after the update:
SELECT
  count(*) AS total_rows,
  count(album_date) AS rows_with_album_date,
  count(album_name) AS rows_with_album_name,
  count(capture_time) AS rows_with_capture_time
FROM metadata;

-- Close the metadata transaction. If you're running this interactively and
-- the verify SELECTs above look wrong, replace this with `ROLLBACK;`.
COMMIT;

-- ---------------------------------------------------------------------------
-- Step 4 (apply): convert collections.apply_folder_pattern to the moustache
-- form. Unconditional - assumes every collection here uses the standard
-- 'yyyy/yyyy-mm-dd' layout. Edit per-row if any collection differs.
-- ---------------------------------------------------------------------------
UPDATE collections
SET apply_folder_pattern = '{{yyyy}}/{{yyyy}}-{{mm}}-{{dd}} {{album}}';

SELECT collection_id, collection_name, apply_folder_pattern FROM collections;

-- ---------------------------------------------------------------------------
-- NOTES on running this file:
-- - Running statement-by-statement (interactive sqlite3) is recommended so
--   you can inspect each step's verify SELECTs before continuing.
-- - Piping the whole file (sqlite3 db.sqlite < migrate-album-split.sql)
--   commits the metadata transaction automatically (the COMMIT above is a
--   real statement, not a comment), and the collections UPDATE runs in
--   auto-commit mode.
-- ---------------------------------------------------------------------------


-- One-off backfill for the timeline-view migration.
--
-- Rewrites file_date for rows where the original EXIF capture date was missing
-- or invalid (so file_date had been set from FileModifyDate, which doesn't
-- represent capture time for files like WhatsApp-forwarded images).
--
-- Strategy: derive the date from the album path's date prefix
--   (yyyy/yyyy-mm-dd ... or yyyy-mm-dd ... etc.), set file_date to that day at
--   00:00:00. Falls back to 1970-01-01 if no parseable date prefix is found.
--
-- Run with the server stopped, against the same DB the server uses.
-- It does NOT walk up nested folders; it only inspects the second segment of
-- the album path. For your typical 'yyyy/yyyy-mm-dd <name>' layout that's the
-- date folder. Nested cases like 'yyyy/yyyy-mm-dd <name>/WhatsApp Images' are
-- still covered because the second segment is still the date folder.

-- ---------------------------------------------------------------------------
-- Step 1 (preview): inspect a sample of rows that will be touched.
-- ---------------------------------------------------------------------------
SELECT uuid, album, datetime_original, create_date, file_date
FROM metadata
WHERE (datetime_original IS NULL
       OR datetime(datetime_original) IS NULL
       OR datetime_original LIKE '0000%')
  AND (create_date IS NULL
       OR datetime(create_date) IS NULL
       OR create_date LIKE '0000%')
LIMIT 50;

-- ---------------------------------------------------------------------------
-- Step 2 (preview): see the date that would be derived from each album path.
-- Verify that 'derived_date' looks like a real YYYY-MM-DD before continuing.
-- ---------------------------------------------------------------------------
SELECT
  uuid,
  album,
  file_date AS old_file_date,
  CASE
    WHEN instr(album, '/') > 0
      THEN substr(album, instr(album, '/') + 1, 10)
    ELSE substr(album, 1, 10)
  END AS derived_date
FROM metadata
WHERE (datetime_original IS NULL
       OR datetime(datetime_original) IS NULL
       OR datetime_original LIKE '0000%')
  AND (create_date IS NULL
       OR datetime(create_date) IS NULL
       OR create_date LIKE '0000%')
LIMIT 50;

-- ---------------------------------------------------------------------------
-- Step 3 (apply): wrap in a transaction so you can roll back if results look
-- wrong. Inspect via SELECT before COMMIT.
-- ---------------------------------------------------------------------------
BEGIN;

UPDATE metadata
SET file_date =
  COALESCE(
    date(
      CASE
        WHEN instr(album, '/') > 0
          THEN substr(album, instr(album, '/') + 1, 10)
        ELSE substr(album, 1, 10)
      END
    ),
    '1970-01-01'
  ) || ' 00:00:00'
WHERE (datetime_original IS NULL
       OR datetime(datetime_original) IS NULL
       OR datetime_original LIKE '0000%')
  AND (create_date IS NULL
       OR datetime(create_date) IS NULL
       OR create_date LIKE '0000%');

-- Spot-check the results before committing:
--   SELECT uuid, album, file_date FROM metadata
--   WHERE substr(file_date, 12) = '00:00:00' LIMIT 50;
--
-- If the dates look right:
--   COMMIT;
-- If something is off:
--   ROLLBACK;

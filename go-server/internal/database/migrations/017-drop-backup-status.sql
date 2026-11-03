-- The backup helper feature was never ported from the retired Node.js server
-- to go-server. Drop the now-unused backup_status table.
DROP TABLE IF EXISTS backup_status;

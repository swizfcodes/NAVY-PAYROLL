-- Migration: add_token_to_db
-- Created: 2026-01-23T13:37:47.968Z

-- UP
-- Add your schema changes here
SET @column_exists = (
  SELECT COUNT(*) 
  FROM information_schema.columns 
  WHERE table_schema = DATABASE() 
  AND table_name = 'users' 
  AND column_name = 'token'
);

SET @sql = IF(
  @column_exists = 0 AND EXISTS(
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = DATABASE() 
    AND table_name = 'users'
  ),
  'ALTER TABLE users ADD COLUMN token TEXT AFTER password',
  'SELECT "Skipped: users table missing or token column already exists" AS message'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- DOWN
-- Add rollback logic here (reverse of UP)
SET @column_exists = (
  SELECT COUNT(*) 
  FROM information_schema.columns 
  WHERE table_schema = DATABASE() 
  AND table_name = 'users' 
  AND column_name = 'token'
);

SET @sql = IF(
  @column_exists > 0,
  'ALTER TABLE users DROP COLUMN token',
  'SELECT "Skipped: token column does not exist" AS message'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
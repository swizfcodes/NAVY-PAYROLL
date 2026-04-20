-- Migration: batchName_init
-- Created: 2026-04-15

-- =========================
-- UP
-- =========================

-- 1. Add column ONLY if it does not exist
SET @col_exists = (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_NAME = 'py_payded'
    AND COLUMN_NAME = 'batchName'
    AND TABLE_SCHEMA = DATABASE()
);

SET @sql = IF(
  @col_exists = 0,
  'ALTER TABLE py_payded ADD COLUMN batchName VARCHAR(255) NULL;',
  'SELECT "Column batchName already exists";'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- 2. Create index ONLY if it does not exist
SET @idx_exists = (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_NAME = 'py_payded'
    AND INDEX_NAME = 'idx_py_payded_batchName'
    AND TABLE_SCHEMA = DATABASE()
);

SET @sql = IF(
  @idx_exists = 0,
  'CREATE INDEX idx_py_payded_batchName ON py_payded (batchName);',
  'SELECT "Index already exists";'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- =========================
-- DOWN (Rollback)
-- =========================

-- 1. Drop index ONLY if it exists
SET @idx_exists = (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_NAME = 'py_payded'
    AND INDEX_NAME = 'idx_py_payded_batchName'
    AND TABLE_SCHEMA = DATABASE()
);

SET @sql = IF(
  @idx_exists > 0,
  'DROP INDEX idx_py_payded_batchName ON py_payded;',
  'SELECT "Index does not exist";'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- 2. Drop column ONLY if it exists
SET @col_exists = (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_NAME = 'py_payded'
    AND COLUMN_NAME = 'batchName'
    AND TABLE_SCHEMA = DATABASE()
);

SET @sql = IF(
  @col_exists > 0,
  'ALTER TABLE py_payded DROP COLUMN batchName;',
  'SELECT "Column does not exist";'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
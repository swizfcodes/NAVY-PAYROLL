-- @scope: master   (hicaddata (officers) only)
-- Migration: ef_documents_drop_cloudinary_columns
--
-- NOT RUN BY migrate:up WHILE IT SITS IN config/sql/pending/.
--
-- Drops every column that held a Cloudinary photo address:
--   ef_documents.url, ef_documents.cloudinary_id
--   ef_personalinfos.mypassporturl, mynokpassporturl, myalternatenokpassporturl
--   ef_personalinfoshist.mypassporturl, mynokpassporturl, myalternatenokpassporturl
-- (each one only if it still exists).
--
-- When `node scripts/migrate-documents-to-local.js --verify` reports that the
-- Cloudinary columns can be dropped:
--   1. Back up the database and the photo storage folder.
--   2. Move this file into config/sql/migrations/ under a new timestamp, e.g.
--        config/sql/migrations/20261201_090000_ef_documents_drop_cloudinary_columns.sql
--   3. npm run migrate:up officers
--
-- Safety check: the migration stops with "Photos still only on Cloudinary"
-- while any ef_documents row has a url but no file_key, and drops nothing
-- (only the check procedure is left behind; the next run replaces it).
--
-- No DELIMITER lines: the migrator sends each procedure as one statement.

-- UP
DROP PROCEDURE IF EXISTS ef_cloudinary_drop_gate;
DROP PROCEDURE IF EXISTS ef_cloudinary_drop_col;

CREATE PROCEDURE ef_cloudinary_drop_gate()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'ef_documents'
      AND COLUMN_NAME = 'file_key'
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'ef_documents.file_key missing: run 20261118_100000_ef_documents_local_storage first';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'ef_documents'
      AND COLUMN_NAME = 'url'
  ) THEN
    SET @ef_cloudinary_pending = 0;
    PREPARE ef_gate_stmt FROM
      'SELECT COUNT(*) INTO @ef_cloudinary_pending FROM ef_documents WHERE file_key IS NULL AND CHAR_LENGTH(TRIM(url)) > 0';
    EXECUTE ef_gate_stmt;
    DEALLOCATE PREPARE ef_gate_stmt;
    IF @ef_cloudinary_pending > 0 THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Photos still only on Cloudinary: run node scripts/migrate-documents-to-local.js --apply';
    END IF;
  END IF;
END;

CALL ef_cloudinary_drop_gate();

CREATE PROCEDURE ef_cloudinary_drop_col(IN tbl VARCHAR(64), IN col VARCHAR(64))
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = tbl
      AND COLUMN_NAME = col
  ) THEN
    SET @ef_drop_ddl = CONCAT('ALTER TABLE `', tbl, '` DROP COLUMN `', col, '`');
    PREPARE ef_drop_stmt FROM @ef_drop_ddl;
    EXECUTE ef_drop_stmt;
    DEALLOCATE PREPARE ef_drop_stmt;
  END IF;
END;

CALL ef_cloudinary_drop_col('ef_documents', 'cloudinary_id');
CALL ef_cloudinary_drop_col('ef_documents', 'url');
CALL ef_cloudinary_drop_col('ef_personalinfos', 'mypassporturl');
CALL ef_cloudinary_drop_col('ef_personalinfos', 'mynokpassporturl');
CALL ef_cloudinary_drop_col('ef_personalinfos', 'myalternatenokpassporturl');
CALL ef_cloudinary_drop_col('ef_personalinfoshist', 'mypassporturl');
CALL ef_cloudinary_drop_col('ef_personalinfoshist', 'mynokpassporturl');
CALL ef_cloudinary_drop_col('ef_personalinfoshist', 'myalternatenokpassporturl');

DROP PROCEDURE IF EXISTS ef_cloudinary_drop_gate;
DROP PROCEDURE IF EXISTS ef_cloudinary_drop_col;

-- DOWN
-- Puts the ef_documents columns back, empty. The addresses are not restored,
-- and the ef_personalinfos / ef_personalinfoshist columns are not re-added.
ALTER TABLE ef_documents
  ADD COLUMN cloudinary_id VARCHAR(300) COLLATE utf8mb4_unicode_ci NULL
    COMMENT 'Cloudinary public_id (no longer used)' AFTER file_ext,
  ADD COLUMN url VARCHAR(500) COLLATE utf8mb4_unicode_ci NULL
    COMMENT 'Cloudinary delivery URL (no longer used)' AFTER cloudinary_id;

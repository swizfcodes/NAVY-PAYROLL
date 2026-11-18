-- @scope: master   (hicaddata (officers) only)
-- Migration: ef_documents_local_storage
-- Created: 2026-11-18T10:00:00.000Z
--
-- Emolument photos move from Cloudinary to a folder on the server
-- (DOCUMENT_STORAGE_DIR, default storage/emolument). A row now points at its
-- file with a 32-character hex key instead of a Cloudinary URL + public_id:
--
--   <folder>/<doc type>/<SERVICE NO>_<DOC TYPE>_<file_key>.<file_ext>
--
-- url and cloudinary_id stay until scripts/migrate-documents-to-local.js has
-- copied every photo; config/sql/pending/ef_documents_drop_cloudinary_columns.sql
-- drops them afterwards.

-- UP
ALTER TABLE ef_documents
  ADD COLUMN file_key CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL
    COMMENT 'Random hex key of the stored photo file' AFTER doc_type,
  ADD COLUMN file_ext VARCHAR(4) CHARACTER SET ascii COLLATE ascii_bin NULL
    COMMENT 'Stored file extension: jpg, png, webp or gif' AFTER file_key,
  ADD UNIQUE KEY uq_docs_file_key (file_key);

-- DOWN
-- Files already in the storage folder are kept, but rows lose their keys.
ALTER TABLE ef_documents
  DROP INDEX uq_docs_file_key,
  DROP COLUMN file_ext,
  DROP COLUMN file_key;

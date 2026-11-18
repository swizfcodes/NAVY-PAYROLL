/**
 * FILE: router/user-dashboard/emolument/documents/documents.repository.js
 *
 * All SQL for document/photo management.
 *
 * ef_documents has one row per personnel per doc_type:
 *   PASSPORT          → personnel's own passport photo
 *   NOK_PASSPORT      → primary next-of-kin passport photo
 *   ALT_NOK_PASSPORT  → alternate next-of-kin passport photo
 *
 * The photo itself is a file in the local storage folder (documents.storage.js).
 * The row holds only file_key (32 hex characters) and file_ext.
 *
 * The old Cloudinary columns (url, cloudinary_id) are never written here and
 * only read as a fallback for rows scripts/migrate-documents-to-local.js has
 * not copied yet. Rows are read with SELECT * so nothing breaks once those
 * columns are dropped.
 */

"use strict";

const pool = require("../../../../config/db");
const config = require("../../../../config");
const storage = require("./documents.storage");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// ─────────────────────────────────────────────────────────────
// SHAPE — what every caller gets for one photo
//   url: /documents/file/<file_key> for photos in the local folder,
//        or the old Cloudinary address until the copy script reaches the row
// ─────────────────────────────────────────────────────────────

function toDocument(row) {
  if (!row) return null;
  const fileKey = row.file_key || null;
  return {
    doc_type: row.doc_type,
    file_key: fileKey,
    url: fileKey ? storage.publicUrl(fileKey) : row.url || null,
    uploaded_at: row.uploaded_at ?? null,
    uploaded_by: row.uploaded_by ?? null,
  };
}

// ─────────────────────────────────────────────────────────────
// GET — documents for a service number
// ─────────────────────────────────────────────────────────────

async function getDocuments(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT * FROM ef_documents
     WHERE service_no = ?
     ORDER BY doc_type ASC`,
    [serviceNo],
  );
  return rows.map(toDocument);
}

// { PASSPORT: {...}, NOK_PASSPORT: {...}, ALT_NOK_PASSPORT: {...} } — only the
// types the person has. Used by the form, DO, FO and CPO views and snapshots.
async function getDocumentMap(serviceNo) {
  const out = {};
  for (const doc of await getDocuments(serviceNo)) out[doc.doc_type] = doc;
  return out;
}

// Full row (including file_ext) for replacing or deleting a photo.
async function getDocumentRow(serviceNo, docType) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT * FROM ef_documents
     WHERE service_no = ? AND doc_type = ?
     LIMIT 1`,
    [serviceNo, docType],
  );
  return rows[0] || null;
}

async function getDocumentByKey(fileKey) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT service_no, doc_type, file_key, file_ext
     FROM ef_documents
     WHERE file_key = ?
     LIMIT 1`,
    [fileKey],
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────
// UPSERT — save or replace a document record
// ─────────────────────────────────────────────────────────────

async function upsertDocument(serviceNo, docType, fileKey, fileExt, uploadedBy) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `INSERT INTO ef_documents
       (service_no, doc_type, file_key, file_ext, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       file_key    = VALUES(file_key),
       file_ext    = VALUES(file_ext),
       uploaded_by = VALUES(uploaded_by),
       uploaded_at = NOW()`,
    [serviceNo, docType, fileKey, fileExt, uploadedBy],
  );
  return result.affectedRows > 0;
}

// ─────────────────────────────────────────────────────────────
// DELETE — remove document record from DB
// The stored file is removed by the service once this succeeds.
// ─────────────────────────────────────────────────────────────

async function deleteDocument(serviceNo, docType) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `DELETE FROM ef_documents
     WHERE service_no = ? AND doc_type = ?`,
    [serviceNo, docType],
  );
  return result.affectedRows > 0;
}

// ─────────────────────────────────────────────────────────────
// BATCH — documents for everyone on a ship
// Used by admin/reporting views
// ─────────────────────────────────────────────────────────────

async function getDocumentsByShip(ship) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT d.*, p.Surname, p.OtherName, p.Rank
     FROM ef_documents d
     JOIN ef_personalinfos p ON p.serviceNumber = d.service_no
     WHERE p.ship = ?
     ORDER BY p.Surname ASC, d.doc_type ASC`,
    [ship],
  );
  return rows.map((r) => ({
    service_no: r.service_no,
    Surname: r.Surname,
    OtherName: r.OtherName,
    Rank: r.Rank,
    ...toDocument(r),
  }));
}

// ─────────────────────────────────────────────────────────────
// MISSING DOCUMENTS — find personnel missing specific doc types
// ─────────────────────────────────────────────────────────────

async function getMissingDocuments(ship, docType) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT p.serviceNumber, p.Surname, p.OtherName, p.Rank, p.payrollclass
     FROM ef_personalinfos p
     WHERE p.ship = ?
       AND p.serviceNumber NOT IN (
         SELECT d.service_no FROM ef_documents d
         WHERE d.doc_type = ?
       )
     ORDER BY p.Surname ASC`,
    [ship, docType],
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────
// AUDIT
// ─────────────────────────────────────────────────────────────

async function insertAuditLog({
  tableName,
  action,
  recordKey,
  oldValues,
  newValues,
  performedBy,
  ipAddress,
}) {
  pool.useDatabase(DB());
  await pool.query(
    `INSERT INTO ef_audit_logs
       (table_name, action, record_key, old_values, new_values, performed_by, ip_address, performed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      tableName,
      action,
      recordKey,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      performedBy,
      ipAddress || null,
    ],
  );
}

module.exports = {
  toDocument,
  getDocuments,
  getDocumentMap,
  getDocumentRow,
  getDocumentByKey,
  upsertDocument,
  deleteDocument,
  getDocumentsByShip,
  getMissingDocuments,
  insertAuditLog,
};

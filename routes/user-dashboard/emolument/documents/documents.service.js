/**
 * FILE: router/user-dashboard/emolument/documents/documents.service.js
 *
 * Business logic for document/photo management.
 *
 * Photos are files in the local storage folder (see documents.storage.js);
 * ef_documents keeps only a 32-character hex file_key and the file extension.
 *
 * Upload flow:
 *   1. Frontend sends the file as multipart to POST /documents/upload/:doc_type
 *   2. The bytes are checked (JPEG, PNG or WebP), turned upright, scaled to fit
 *      600×800 and saved as JPEG under a new file key
 *   3. ef_documents is upserted with the new key
 *   4. The file of the replaced photo, if any, is removed
 *
 * Delete flow:
 *   1. Delete the DB record
 *   2. Remove the stored file
 *
 * Viewing: GET /documents/file/:file_key streams the photo to any logged-in
 * user. Keys are random, and only reach the browser through endpoints that
 * already check who may see the form.
 *
 * Personnel can only upload their own documents.
 * EMOL_ADMIN can upload for any service number.
 */

"use strict";

const repo = require("./documents.repository");
const storage = require("./documents.storage");
const { VALID_DOC_TYPES } = require("../emolument.constants");

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function validateDocType(docType) {
  if (!VALID_DOC_TYPES.includes(docType)) {
    return {
      valid: false,
      message: `doc_type must be one of: ${VALID_DOC_TYPES.join(", ")}.`,
    };
  }
  return { valid: true };
}

// What the audit log records about a stored photo. `url` only appears for rows
// that still pointed at Cloudinary.
function auditValues(row) {
  if (!row) return null;
  const values = { file_key: row.file_key || null, file_ext: row.file_ext || null };
  if (!row.file_key && row.url) values.url = row.url;
  return values;
}

async function removeStoredFile(row, context) {
  try {
    await storage.removeFile(row);
  } catch (err) {
    console.error(`⚠️  Could not remove stored photo (${context}):`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// GET DOCUMENTS — fetch all docs for own service number
// ─────────────────────────────────────────────────────────────

async function getMyDocuments(serviceNo) {
  const docs = await repo.getDocuments(serviceNo);

  // Structure as { PASSPORT: {...}, NOK_PASSPORT: {...}, ALT_NOK_PASSPORT: {...} }
  const out = {};
  VALID_DOC_TYPES.forEach((t) => {
    out[t] = null;
  });
  docs.forEach((d) => {
    out[d.doc_type] = d;
  });

  return { success: true, data: out };
}

// ─────────────────────────────────────────────────────────────
// UPLOAD — save a photo to the storage folder and record its key
//
// targetServiceNo: the personnel whose document this is
//   - must equal performedBy unless performer is EMOL_ADMIN
//
// fileBuffer: the uploaded file's bytes (multer memory storage)
// docType:    one of VALID_DOC_TYPES
// ─────────────────────────────────────────────────────────────

async function uploadDocument(
  targetServiceNo,
  docType,
  fileBuffer,
  performedBy,
  isAdmin,
  ip,
) {
  // Scope check — personnel can only upload their own documents
  if (!isAdmin && targetServiceNo !== performedBy) {
    return {
      success: false,
      code: 403,
      message: "You can only upload your own documents.",
    };
  }

  const typeCheck = validateDocType(docType);
  if (!typeCheck.valid) {
    return { success: false, code: 400, message: typeCheck.message };
  }

  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
    return { success: false, code: 400, message: "No file data provided." };
  }

  let prepared;
  try {
    prepared = await storage.prepareUpload(fileBuffer);
  } catch (err) {
    console.warn(`⚠️  Unreadable image for ${targetServiceNo}:${docType}:`, err.message);
    return {
      success: false,
      code: 400,
      message: "The file could not be read as an image.",
    };
  }
  if (!prepared) {
    return {
      success: false,
      code: 400,
      message: "Only JPEG, PNG or WebP images are accepted.",
    };
  }

  const existing = await repo.getDocumentRow(targetServiceNo, docType);

  let saved;
  try {
    saved = await storage.saveFile({
      serviceNo: targetServiceNo,
      docType,
      buffer: prepared.buffer,
      ext: prepared.ext,
    });
  } catch (err) {
    console.error("❌ Photo storage error:", err.message);
    return {
      success: false,
      code: 500,
      message: "The photo could not be saved on the server.",
    };
  }

  const savedRow = {
    service_no: targetServiceNo,
    doc_type: docType,
    file_key: saved.fileKey,
    file_ext: saved.ext,
  };

  let recorded = false;
  let dbError = null;
  try {
    recorded = await repo.upsertDocument(
      targetServiceNo,
      docType,
      saved.fileKey,
      saved.ext,
      performedBy,
    );
  } catch (err) {
    dbError = err;
  }

  if (!recorded) {
    await removeStoredFile(savedRow, "upload not recorded");
    if (dbError?.code === "ER_NO_REFERENCED_ROW_2") {
      return {
        success: false,
        code: 404,
        message: `No personnel record found for ${targetServiceNo}.`,
      };
    }
    console.error(
      `⚠️  Photo saved but DB write failed for ${targetServiceNo}:${docType}`,
      dbError?.message || "",
    );
    return {
      success: false,
      code: 500,
      message:
        "The photo could not be recorded in the database. Contact administrator.",
    };
  }

  // The row now points at the new file; the replaced one is no longer used.
  if (existing?.file_key) {
    await removeStoredFile(existing, `replaced ${targetServiceNo}:${docType}`);
  }

  await repo.insertAuditLog({
    tableName: "ef_documents",
    action: "INSERT",
    recordKey: `${targetServiceNo}:${docType}`,
    oldValues: auditValues(existing),
    newValues: auditValues(savedRow),
    performedBy,
    ipAddress: ip,
  });

  return {
    success: true,
    message: `Document uploaded successfully.`,
    data: {
      serviceNo: targetServiceNo,
      docType,
      fileKey: saved.fileKey,
      url: storage.publicUrl(saved.fileKey),
      format: saved.ext,
      bytes: saved.bytes,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// DELETE — remove DB record then the stored file
// ─────────────────────────────────────────────────────────────

async function deleteDocument(
  targetServiceNo,
  docType,
  performedBy,
  isAdmin,
  ip,
) {
  if (!isAdmin && targetServiceNo !== performedBy) {
    return {
      success: false,
      code: 403,
      message: "You can only delete your own documents.",
    };
  }

  const typeCheck = validateDocType(docType);
  if (!typeCheck.valid) {
    return { success: false, code: 400, message: typeCheck.message };
  }

  const existing = await repo.getDocumentRow(targetServiceNo, docType);
  if (!existing) {
    return { success: false, code: 404, message: "Document not found." };
  }

  const removed = await repo.deleteDocument(targetServiceNo, docType);

  // Only drop the file once no row points at it.
  if (removed && existing.file_key) {
    await removeStoredFile(existing, `deleted ${targetServiceNo}:${docType}`);
  }

  await repo.insertAuditLog({
    tableName: "ef_documents",
    action: "DELETE",
    recordKey: `${targetServiceNo}:${docType}`,
    oldValues: auditValues(existing),
    newValues: null,
    performedBy,
    ipAddress: ip,
  });

  return {
    success: removed,
    message: removed
      ? "Document deleted successfully."
      : "Document could not be deleted from database.",
    data: { serviceNo: targetServiceNo, docType },
  };
}

// ─────────────────────────────────────────────────────────────
// ADMIN — get all documents for a ship
// ─────────────────────────────────────────────────────────────

async function getShipDocuments(ship) {
  if (!ship)
    return { success: false, code: 400, message: "Ship name is required." };

  const rows = await repo.getDocumentsByShip(ship);

  // Group by service number
  const byPerson = {};
  for (const row of rows) {
    if (!byPerson[row.service_no]) {
      byPerson[row.service_no] = {
        serviceNo: row.service_no,
        surname: row.Surname,
        otherName: row.OtherName,
        rank: row.Rank,
        documents: {},
      };
    }
    byPerson[row.service_no].documents[row.doc_type] = {
      url: row.url,
      fileKey: row.file_key,
      uploadedAt: row.uploaded_at,
    };
  }

  return {
    success: true,
    data: Object.values(byPerson),
  };
}

// ─────────────────────────────────────────────────────────────
// ADMIN — find personnel missing a specific document type
// ─────────────────────────────────────────────────────────────

async function getMissingDocuments(ship, docType) {
  if (!ship)
    return { success: false, code: 400, message: "Ship name is required." };

  const typeCheck = validateDocType(docType);
  if (!typeCheck.valid)
    return { success: false, code: 400, message: typeCheck.message };

  const rows = await repo.getMissingDocuments(ship, docType);
  return {
    success: true,
    data: {
      ship,
      docType,
      missing: rows,
      count: rows.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// VIEW URL — where the browser loads one photo from
// ─────────────────────────────────────────────────────────────

async function getViewUrl(targetServiceNo, docType, performedBy, isAdmin) {
  if (!isAdmin && targetServiceNo !== performedBy) {
    return { success: false, code: 403, message: "Access denied." };
  }

  const typeCheck = validateDocType(docType);
  if (!typeCheck.valid)
    return { success: false, code: 400, message: typeCheck.message };

  const doc = repo.toDocument(await repo.getDocumentRow(targetServiceNo, docType));
  if (!doc?.url)
    return { success: false, code: 404, message: "Document not found." };

  return { success: true, data: { url: doc.url, docType } };
}

// ─────────────────────────────────────────────────────────────
// FILE — the stored photo for a file key
// ─────────────────────────────────────────────────────────────

async function getFile(fileKey) {
  const notFound = { success: false, code: 404, message: "Photo not found." };
  if (!storage.isFileKey(fileKey)) return notFound;

  const row = await repo.getDocumentByKey(fileKey);
  if (!row) return notFound;

  const filePath = await storage.resolveFile(row);
  if (!filePath) {
    console.error(
      `⚠️  Photo file missing on disk for ${row.service_no}:${row.doc_type} (${fileKey}) under ${storage.STORAGE_ROOT}`,
    );
    return notFound;
  }

  return {
    success: true,
    data: { path: filePath, ext: row.file_ext, mime: storage.mimeFor(row.file_ext) },
  };
}

// data: URL of a stored photo, for PDF rendering. null when there is none.
async function readAsDataUrl(doc) {
  if (!doc?.file_key) return null;
  try {
    const file = await getFile(doc.file_key);
    if (!file.success) return null;
    return await storage.readAsDataUrl(file.data.path, file.data.ext);
  } catch (err) {
    console.error("⚠️  Could not read stored photo:", err.message);
    return null;
  }
}

module.exports = {
  getMyDocuments,
  uploadDocument,
  deleteDocument,
  getShipDocuments,
  getMissingDocuments,
  getViewUrl,
  getFile,
  readAsDataUrl,
};

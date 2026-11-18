/**
 * FILE: routes/user-dashboard/emolument/documents/documents.storage.js
 *
 * Where emolument photos live on disk.
 *
 *   <root>/<doc type>/<SERVICE NO>_<DOC TYPE>_<file key>.<ext>
 *   e.g. storage/emolument/passport/NN12345_PASSPORT_9f3ac1d27b0e44c1a6f2d8e90b13c5e7.jpg
 *
 * <root> is DOCUMENT_STORAGE_DIR (a relative path is taken from the app folder),
 * by default storage/emolument inside the app folder.
 *
 * ef_documents keeps only the file key (32 hex characters) and the extension.
 * The service number and type in the file name are there for people browsing
 * the folder. Every upload gets a new key, so a replaced photo is never served
 * from a browser cache and the old file can be removed once the row points at
 * the new one.
 */

"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

let sharp = null;
try {
  sharp = require("sharp");
} catch (err) {
  console.warn(
    `⚠️  sharp could not be loaded (${err.message}) — photos will be stored as uploaded, without resizing.`,
  );
}

const APP_ROOT = path.resolve(__dirname, "../../../..");
const STORAGE_ROOT = path.resolve(
  APP_ROOT,
  process.env.DOCUMENT_STORAGE_DIR || "storage/emolument",
);

const MIME_BY_EXT = Object.freeze({
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
});

// Formats a person may upload. Copied photos may also be GIF (stored as they were).
const UPLOAD_FORMATS = Object.freeze(["jpg", "png", "webp"]);

// Same limits the Cloudinary upload transformation used.
const MAX_WIDTH = 600;
const MAX_HEIGHT = 800;
const JPEG_QUALITY = 82;

const KEY_PATTERN = /^[0-9a-f]{32}$/;
const DOC_TYPE_PATTERN = /^[A-Z_]+$/;
const STORED_NAME_PATTERN = /_([0-9a-f]{32})\.(jpg|png|webp|gif)$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ─────────────────────────────────────────────────────────────
// KEYS, NAMES, PATHS
// ─────────────────────────────────────────────────────────────

function newFileKey() {
  return crypto.randomBytes(16).toString("hex");
}

function isFileKey(value) {
  return typeof value === "string" && KEY_PATTERN.test(value);
}

function mimeFor(ext) {
  return MIME_BY_EXT[ext] || null;
}

function publicUrl(fileKey) {
  return `/documents/file/${fileKey}`;
}

// Windows and Linux safe: anything other than letters, digits and "-" becomes "_".
function safeServiceNo(serviceNo) {
  return String(serviceNo).trim().replace(/[^A-Za-z0-9-]/g, "_");
}

function folderFor(docType) {
  if (!DOC_TYPE_PATTERN.test(String(docType))) {
    throw new Error(`Invalid document type for storage: ${docType}`);
  }
  return path.join(STORAGE_ROOT, String(docType).toLowerCase());
}

function fileNameFor(serviceNo, docType, fileKey, ext) {
  return `${safeServiceNo(serviceNo)}_${docType}_${fileKey}.${ext}`;
}

function filePathFor(serviceNo, docType, fileKey, ext) {
  return path.join(folderFor(docType), fileNameFor(serviceNo, docType, fileKey, ext));
}

// ─────────────────────────────────────────────────────────────
// IMAGE HANDLING
// ─────────────────────────────────────────────────────────────

// What the bytes actually are. The mimetype the browser sends is not trusted.
function detectFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  const head = buffer.toString("ascii", 0, 6);
  if (head === "GIF87a" || head === "GIF89a") return "gif";
  return null;
}

// New uploads: turn upright, fit inside 600×800, re-encode as JPEG.
// Re-encoding also drops EXIF data such as the GPS position phones record.
// Returns null when the file is not an accepted image type; throws when the
// bytes claim to be an image but cannot be decoded.
async function prepareUpload(buffer) {
  const format = detectFormat(buffer);
  if (!UPLOAD_FORMATS.includes(format)) return null;
  if (!sharp) return { buffer, ext: format };

  const out = await sharp(buffer, { failOn: "error" })
    .rotate()
    .resize(MAX_WIDTH, MAX_HEIGHT, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
  return { buffer: out, ext: "jpg" };
}

// Photos copied from Cloudinary or older systems: kept byte for byte when they
// are JPEG, PNG, WebP or GIF; anything else sharp can read is converted to JPEG.
// Returns null when the bytes are not an image.
async function prepareCopied(buffer) {
  const format = detectFormat(buffer);
  if (format) return { buffer, ext: format, converted: false };
  if (!sharp) return null;
  try {
    const out = await sharp(buffer, { failOn: "error" })
      .rotate()
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();
    return { buffer: out, ext: "jpg", converted: true };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// FILES
// ─────────────────────────────────────────────────────────────

async function isFile(p) {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

// Writes the photo under a new key. The file appears under its final name only
// once it is completely written.
async function saveFile({ serviceNo, docType, buffer, ext }) {
  if (!mimeFor(ext)) throw new Error(`Unsupported file extension: ${ext}`);
  const fileKey = newFileKey();
  const dir = folderFor(docType);
  await fsp.mkdir(dir, { recursive: true });

  const finalPath = path.join(dir, fileNameFor(serviceNo, docType, fileKey, ext));
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  await fsp.writeFile(tmpPath, buffer, { flag: "wx" });
  try {
    await fsp.rename(tmpPath, finalPath);
  } catch (err) {
    await fsp.rm(tmpPath, { force: true });
    throw err;
  }
  return { fileKey, ext, path: finalPath, bytes: buffer.length };
}

// Absolute path of the stored photo for an ef_documents row, or null.
// ef_documents cascades service-number changes, so a file saved under an
// earlier service number is found by its key and renamed to the current one.
async function resolveFile(row) {
  if (!row || !isFileKey(row.file_key) || !mimeFor(row.file_ext)) return null;
  if (!DOC_TYPE_PATTERN.test(String(row.doc_type))) return null;

  const expected = filePathFor(row.service_no, row.doc_type, row.file_key, row.file_ext);
  if (await isFile(expected)) return expected;

  const dir = folderFor(row.doc_type);
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const suffix = `_${row.file_key}.${row.file_ext}`;
  const found = names.find((n) => n.endsWith(suffix));
  if (!found) return null;

  const foundPath = path.join(dir, found);
  try {
    await fsp.rename(foundPath, expected);
    return expected;
  } catch {
    return foundPath;
  }
}

// Removes the stored photo for a row. A file that is already gone is not an error.
async function removeFile(row) {
  const p = await resolveFile(row);
  if (p) await fsp.rm(p, { force: true });
  return Boolean(p);
}

async function readAsDataUrl(filePath, ext) {
  const data = await fsp.readFile(filePath);
  return `data:${mimeFor(ext) || "application/octet-stream"};base64,${data.toString("base64")}`;
}

// Every stored photo on disk: [{ docType, fileKey, ext, name, path }].
// Used by the copy script to spot files no row points at.
async function listStoredFiles(docTypes) {
  const out = [];
  for (const docType of docTypes) {
    const dir = folderFor(docType);
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = name.match(STORED_NAME_PATTERN);
      if (m) out.push({ docType, fileKey: m[1], ext: m[2], name, path: path.join(dir, name) });
    }
  }
  return out;
}

module.exports = {
  STORAGE_ROOT,
  MIME_BY_EXT,
  UPLOAD_FORMATS,
  sharpAvailable: Boolean(sharp),
  newFileKey,
  isFileKey,
  mimeFor,
  publicUrl,
  safeServiceNo,
  folderFor,
  fileNameFor,
  filePathFor,
  detectFormat,
  prepareUpload,
  prepareCopied,
  saveFile,
  resolveFile,
  removeFile,
  readAsDataUrl,
  listStoredFiles,
};

// Copy emolument photos from Cloudinary (or any older public address) into the
// local photo folder, and record each file's key in ef_documents.
//
//   node scripts/migrate-documents-to-local.js            dry run: what would be copied
//   node scripts/migrate-documents-to-local.js --apply    copy the photos
//   node scripts/migrate-documents-to-local.js --snapshots           dry run for confirmed-form snapshots
//   node scripts/migrate-documents-to-local.js --snapshots --apply   point snapshot photos at the stored files
//   node scripts/migrate-documents-to-local.js --verify   check the files, and say whether
//                                                         the Cloudinary columns can be dropped
//
// Options
//   --limit N           stop after N photos (try a small batch first)
//   --concurrency N     downloads at a time (default 4)
//   --include-legacy    with --apply: also copy photos that exist only in the old
//                       ef_personalinfos columns (mypassporturl, mynokpassporturl,
//                       myalternatenokpassporturl). Photos someone deleted in the
//                       app are left out.
//   --forget-missing    with --apply: delete the ef_documents rows whose photo no
//                       longer exists (HTTP 404/410, or no web address at all), so
//                       the Cloudinary columns can be dropped. Each one is written
//                       to ef_audit_logs.
//
// Snapshots: ef_emolument_forms.snapshot keeps each confirmed form's photos as
// Cloudinary links. --snapshots replaces every such link with the person's stored
// photo of that type (file_key + /documents/file/<key>) — the image Cloudinary was
// serving at that address, since uploads overwrote it in place. Links for people
// with no stored photo of that type are left as they are and listed in the CSV.
// updated_at of the form rows is not changed.
//
// Photos are downloaded from their public addresses exactly as stored (JPEG, PNG,
// WebP and GIF are kept byte for byte), so no Cloudinary keys are needed.
// Reads the usual MYSQL_* settings (officers database) and DOCUMENT_STORAGE_DIR.
// Safe to stop (Ctrl+C) and run again: rows that already have a file_key are skipped.
// Every photo that was not copied is listed in a CSV under logs/.
//
// Order: npm run migrate:up officers → deploy the app → --apply → --snapshots --apply
//        → --verify → config/sql/pending/ef_documents_drop_cloudinary_columns.sql

"use strict";

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const config = require("../config");
const storage = require("../routes/user-dashboard/emolument/documents/documents.storage");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const n = parseInt(args[i + 1], 10);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`${name} needs a whole number above 0.`);
    process.exit(2);
  }
  return n;
};

const APPLY = flag("--apply");
const MODE = flag("--verify")
  ? "verify"
  : flag("--snapshots")
    ? APPLY ? "snapshots" : "snapshots dry-run"
    : APPLY ? "apply" : "dry-run";
const LIMIT = option("--limit", null);
const CONCURRENCY = option("--concurrency", 4);
const INCLUDE_LEGACY = flag("--include-legacy");
const FORGET_MISSING = flag("--forget-missing");

const DOC_TYPES = ["PASSPORT", "NOK_PASSPORT", "ALT_NOK_PASSPORT"];
// Keys a snapshot's documents object may use for each photo type.
const SNAPSHOT_TYPE_KEYS = {
  PASSPORT: "PASSPORT",
  NOK_PASSPORT: "NOK_PASSPORT",
  ALT_NOK_PASSPORT: "ALT_NOK_PASSPORT",
  passport: "PASSPORT",
  nokPassport: "NOK_PASSPORT",
  altNokPassport: "ALT_NOK_PASSPORT",
};
const LEGACY_COLUMNS = {
  mypassporturl: "PASSPORT",
  mynokpassporturl: "NOK_PASSPORT",
  myalternatenokpassporturl: "ALT_NOK_PASSPORT",
};
const SYSTEM_USER = "SYSTEM_MIGRATION";
const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 30000;
const ATTEMPTS = 3;
const LOG_DIR = path.resolve(__dirname, "..", "logs");

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log("\nStopping after the photos in progress (Ctrl+C again to quit now)…");
});

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isWebAddress = (url) => /^https?:\/\/\S+$/i.test(String(url || "").trim());
const isCloudinary = (url) => /(^|\.)cloudinary\.com\//i.test(String(url || ""));

function countBy(items, key) {
  const out = {};
  for (const item of items) out[item[key]] = (out[item[key]] || 0) + 1;
  return out;
}

function byTypeText(items) {
  const counts = countBy(items, "doc_type");
  return DOC_TYPES.map((t) => `${t} ${counts[t] || 0}`).join(", ");
}

function csvCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(prefix, header, rows) {
  if (!rows.length) return null;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(LOG_DIR, `${prefix}-${stamp}.csv`);
  const lines = [header.join(",")].concat(rows.map((r) => header.map((h) => csvCell(r[h])).join(",")));
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

async function columnExists(db, table, column) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return rows.length > 0;
}

// Fetches a photo. 404/410 mean it is gone for good; network errors, 429 and
// 5xx are retried.
async function download(url) {
  let lastError = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url.trim(), {
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 404 || res.status === 410) {
        await res.body?.cancel();
        return { kind: "missing", detail: `HTTP ${res.status}` };
      }
      if (res.ok) {
        const declared = parseInt(res.headers.get("content-length") || "0", 10);
        if (declared > MAX_BYTES) {
          await res.body?.cancel();
          return { kind: "failed", detail: `larger than ${MAX_BYTES / 1048576} MB` };
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length > MAX_BYTES) {
          return { kind: "failed", detail: `larger than ${MAX_BYTES / 1048576} MB` };
        }
        return { kind: "ok", buffer };
      }
      await res.body?.cancel();
      lastError = `HTTP ${res.status}`;
      if (res.status !== 429 && res.status < 500) return { kind: "failed", detail: lastError };
    } catch (err) {
      lastError = err.name === "TimeoutError" ? "timed out" : err.cause?.code || err.message;
    }
    if (attempt < ATTEMPTS) await sleep(attempt * 2000);
  }
  return { kind: "failed", detail: lastError };
}

async function auditForgotten(db, item, reason) {
  await db.query(
    `INSERT INTO ef_audit_logs
       (table_name, action, record_key, old_values, new_values, performed_by, performed_at)
     VALUES ('ef_documents', 'DELETE', ?, ?, NULL, ?, NOW())`,
    [`${item.service_no}:${item.doc_type}`, JSON.stringify({ url: item.url, reason }), SYSTEM_USER],
  );
}

// ─────────────────────────────────────────────────────────────
// WHAT IS LEFT TO COPY
// ─────────────────────────────────────────────────────────────

async function pendingRows(db, hasUrlColumn) {
  if (!hasUrlColumn) return [];
  const [rows] = await db.query(
    `SELECT id, service_no, doc_type, url
     FROM ef_documents
     WHERE file_key IS NULL AND CHAR_LENGTH(TRIM(url)) > 0
     ORDER BY id`,
  );
  return rows;
}

// Photos only in the old ef_personalinfos columns: no ef_documents row of that
// type, and never deleted through the app (ef_audit_logs).
async function legacyOnlyRows(db) {
  const out = [];
  for (const [column, docType] of Object.entries(LEGACY_COLUMNS)) {
    if (!(await columnExists(db, "ef_personalinfos", column))) continue;
    const [rows] = await db.query(
      `SELECT p.serviceNumber AS service_no, p.\`${column}\` AS url
       FROM ef_personalinfos p
       WHERE CHAR_LENGTH(TRIM(p.\`${column}\`)) > 0
         AND NOT EXISTS (
           SELECT 1 FROM ef_documents d
           WHERE d.service_no = p.serviceNumber AND d.doc_type = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM ef_audit_logs a
           WHERE a.table_name = 'ef_documents' AND a.action = 'DELETE'
             AND a.record_key = CONCAT(p.serviceNumber, ':', ?)
         )
       ORDER BY p.serviceNumber`,
      [docType, docType],
    );
    for (const r of rows) out.push({ ...r, doc_type: docType, legacy: true });
  }
  return out;
}

async function legacyColumnsPresent(db) {
  const present = [];
  for (const column of Object.keys(LEGACY_COLUMNS)) {
    if (await columnExists(db, "ef_personalinfos", column)) present.push(column);
  }
  return present;
}

// ─────────────────────────────────────────────────────────────
// DRY RUN
// ─────────────────────────────────────────────────────────────

async function dryRun(db, hasUrlColumn) {
  const pending = await pendingRows(db, hasUrlColumn);
  const [[{ copied }]] = await db.query(
    "SELECT COUNT(*) AS copied FROM ef_documents WHERE file_key IS NOT NULL",
  );
  const legacyCols = await legacyColumnsPresent(db);
  const legacy = legacyCols.length ? await legacyOnlyRows(db) : [];

  const cloud = pending.filter((r) => isCloudinary(r.url)).length;
  const notWeb = pending.filter((r) => !isWebAddress(r.url)).length;

  console.log(`Photos already in the folder:       ${copied}`);
  console.log(`Photos still to copy:               ${pending.length}  (${byTypeText(pending)})`);
  console.log(`  on Cloudinary:                    ${cloud}`);
  console.log(`  on another web address:           ${pending.length - cloud - notWeb}`);
  console.log(`  not a web address (cannot copy):  ${notWeb}`);
  if (legacyCols.length) {
    console.log(`Only in old ef_personalinfos columns: ${legacy.length}  (${byTypeText(legacy)})`);
    if (legacy.length) console.log("  copy these too with --apply --include-legacy");
  }
  if (pending.length) {
    console.log("\nExamples:");
    pending.slice(0, 5).forEach((r) => console.log(`  ${r.service_no} ${r.doc_type}: ${r.url}`));
  }
  console.log("\nNothing was changed. Run with --apply to copy.");
}

// ─────────────────────────────────────────────────────────────
// APPLY
// ─────────────────────────────────────────────────────────────

async function copyOne(db, item) {
  const record = (result, detail = "") => ({
    service_no: item.service_no,
    doc_type: item.doc_type,
    source: item.legacy ? "ef_personalinfos" : "ef_documents",
    url: item.url,
    result,
    detail,
  });

  const forget = async (reason) => {
    if (!FORGET_MISSING || item.legacy) return record("missing", reason);
    const [res] = await db.query(
      "DELETE FROM ef_documents WHERE id = ? AND file_key IS NULL",
      [item.id],
    );
    if (!res.affectedRows) return record("skipped", "row changed while copying");
    await auditForgotten(db, item, reason);
    return record("forgotten", reason);
  };

  if (!isWebAddress(item.url)) return forget("not a web address");

  const got = await download(item.url);
  if (got.kind === "missing") return forget(got.detail);
  if (got.kind !== "ok") return record("failed", got.detail);

  const prepared = await storage.prepareCopied(got.buffer);
  if (!prepared) return record("failed", "not an image");

  const saved = await storage.saveFile({
    serviceNo: item.service_no,
    docType: item.doc_type,
    buffer: prepared.buffer,
    ext: prepared.ext,
  });
  const savedRow = {
    service_no: item.service_no,
    doc_type: item.doc_type,
    file_key: saved.fileKey,
    file_ext: saved.ext,
  };

  try {
    const [res] = item.legacy
      ? await db.query(
          `INSERT IGNORE INTO ef_documents
             (service_no, doc_type, file_key, file_ext, uploaded_by, uploaded_at)
           VALUES (?, ?, ?, ?, ?, NOW())`,
          [item.service_no, item.doc_type, saved.fileKey, saved.ext, SYSTEM_USER],
        )
      : await db.query(
          // Only if nobody uploaded a new photo for this row in the meantime.
          "UPDATE ef_documents SET file_key = ?, file_ext = ? WHERE id = ? AND file_key IS NULL",
          [saved.fileKey, saved.ext, item.id],
        );
    if (!res.affectedRows) {
      await storage.removeFile(savedRow);
      return record("skipped", "a new photo was uploaded while copying");
    }
  } catch (err) {
    await storage.removeFile(savedRow).catch(() => {});
    return record("failed", `database: ${err.message}`);
  }

  return record("copied", prepared.converted ? `converted to jpg (${saved.bytes} bytes)` : `${saved.ext}, ${saved.bytes} bytes`);
}

async function apply(db, hasUrlColumn) {
  let items = await pendingRows(db, hasUrlColumn);
  if (INCLUDE_LEGACY) items = items.concat(await legacyOnlyRows(db));
  if (LIMIT) items = items.slice(0, LIMIT);

  if (!items.length) {
    console.log("Nothing to copy.");
    return 0;
  }
  console.log(`Copying ${items.length} photo(s), ${CONCURRENCY} at a time…\n`);

  const results = [];
  const counts = {};
  let next = 0;
  let lastReport = Date.now();
  const started = Date.now();

  const report = (force) => {
    if (!force && results.length % 100 !== 0 && Date.now() - lastReport < 15000) return;
    lastReport = Date.now();
    const parts = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ");
    console.log(`  ${results.length}/${items.length}  (${parts})`);
  };

  async function worker() {
    while (!stopping && next < items.length) {
      const item = items[next++];
      let r;
      try {
        r = await copyOne(db, item);
      } catch (err) {
        r = { service_no: item.service_no, doc_type: item.doc_type, url: item.url, result: "failed", detail: err.message };
      }
      results.push(r);
      counts[r.result] = (counts[r.result] || 0) + 1;
      report(false);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  report(true);

  const notCopied = results.filter((r) => r.result !== "copied");
  const csv = writeCsv("document-copy", ["service_no", "doc_type", "source", "result", "detail", "url"], notCopied);
  const secs = Math.round((Date.now() - started) / 1000);

  console.log(`\nDone in ${secs}s. Folder: ${storage.STORAGE_ROOT}`);
  console.log(`  copied:    ${counts.copied || 0}`);
  console.log(`  missing:   ${counts.missing || 0}${counts.missing && !FORGET_MISSING ? "  (gone at the source; --forget-missing removes these rows)" : ""}`);
  if (counts.forgotten) console.log(`  forgotten: ${counts.forgotten}  (rows deleted, recorded in ef_audit_logs)`);
  console.log(`  failed:    ${counts.failed || 0}${counts.failed ? "  (reasons in the CSV; running again retries them)" : ""}`);
  if (counts.skipped) console.log(`  skipped:   ${counts.skipped}  (changed in the app while copying)`);
  if (stopping) console.log(`  not started: ${items.length - results.length}  (stopped; run again to continue)`);
  if (csv) console.log(`\nPhotos not copied are listed in ${csv}`);
  return counts.failed ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────
// SNAPSHOTS — confirmed forms' photo links → stored files
// ─────────────────────────────────────────────────────────────

// ef_documents and ef_emolument_forms both follow ef_personalinfos (case-
// insensitive collation), so compare service numbers the way MySQL does.
const personKey = (serviceNo, docType) => `${String(serviceNo).trim().toUpperCase()}|${docType}`;

async function storedPhotos(db) {
  const [rows] = await db.query(
    `SELECT service_no, doc_type, file_key, uploaded_at, uploaded_by
     FROM ef_documents WHERE file_key IS NOT NULL`,
  );
  return new Map(rows.map((r) => [personKey(r.service_no, r.doc_type), r]));
}

// JSON columns arrive parsed from MySQL and as text from MariaDB.
// undefined means the stored text is not valid JSON.
function parseSnapshot(value) {
  if (value == null || typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

// Points each old-style photo entry at the person's stored photo of that type.
// Entries that are null or already have a file_key are left alone.
function relinkSnapshot(snapshot, serviceNo, photos) {
  const result = { relinked: 0, unmatched: [] };
  const docs = snapshot?.documents;
  if (!docs || typeof docs !== "object") return result;

  for (const [key, entry] of Object.entries(docs)) {
    if (!entry || typeof entry !== "object" || entry.file_key) continue;
    if (!entry.url && !entry.cloudinary_id) continue;
    const docType = SNAPSHOT_TYPE_KEYS[entry.doc_type] || SNAPSHOT_TYPE_KEYS[key];
    const photo = docType && photos.get(personKey(serviceNo, docType));
    if (!photo) {
      result.unmatched.push({ doc_type: docType || key, detail: entry.url || entry.cloudinary_id });
      continue;
    }
    docs[key] = {
      doc_type: docType,
      file_key: photo.file_key,
      url: storage.publicUrl(photo.file_key),
      uploaded_at: photo.uploaded_at,
      uploaded_by: photo.uploaded_by,
    };
    result.relinked++;
  }
  return result;
}

// Walks every snapshot in id order. With write = true each changed snapshot is
// saved, unless the form row changed since it was read.
async function scanSnapshots(db, write) {
  const photos = await storedPhotos(db);
  const stats = { forms: 0, formsToChange: 0, entries: 0, saved: 0, skipped: 0, malformed: [], unmatched: [] };
  let lastId = 0;

  while (!stopping) {
    const [rows] = await db.query(
      `SELECT id, service_no, status, updated_at, snapshot
       FROM ef_emolument_forms
       WHERE snapshot IS NOT NULL AND id > ?
       ORDER BY id
       LIMIT 200`,
      [lastId],
    );
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;

    for (const row of rows) {
      if (stopping || (write && LIMIT && stats.saved >= LIMIT)) break;
      stats.forms++;
      const snapshot = parseSnapshot(row.snapshot);
      if (snapshot === undefined) {
        stats.malformed.push({ form_id: row.id, service_no: row.service_no });
        continue;
      }
      const r = relinkSnapshot(snapshot, row.service_no, photos);
      r.unmatched.forEach((u) => stats.unmatched.push({ form_id: row.id, service_no: row.service_no, ...u }));
      if (!r.relinked) continue;

      stats.formsToChange++;
      stats.entries += r.relinked;
      if (!write) continue;

      const [res] = await db.query(
        `UPDATE ef_emolument_forms
         SET snapshot = ?, updated_at = updated_at
         WHERE id = ? AND status = ? AND updated_at <=> ?`,
        [JSON.stringify(snapshot), row.id, row.status, row.updated_at],
      );
      if (res.affectedRows) stats.saved++;
      else stats.skipped++;
    }
    if (write && LIMIT && stats.saved >= LIMIT) break;
  }
  return stats;
}

async function snapshots(db, write) {
  const stats = await scanSnapshots(db, write);
  console.log(`Snapshots read:                       ${stats.forms}`);
  console.log(`  with old photo links to replace:    ${stats.formsToChange}  (${stats.entries} photo link(s))`);
  console.log(`  links with no stored photo to use:  ${stats.unmatched.length}`);
  if (stats.malformed.length) console.log(`  not valid JSON (left alone):        ${stats.malformed.length}`);
  if (write) {
    console.log(`  saved:                              ${stats.saved}`);
    if (stats.skipped) console.log(`  skipped (form changed meanwhile):   ${stats.skipped}  (run again)`);
  }
  if (stopping) console.log("  stopped early; run again to continue");

  const csv = writeCsv(
    "document-snapshots",
    ["problem", "form_id", "service_no", "doc_type", "detail"],
    [
      ...stats.unmatched.map((u) => ({ problem: "no stored photo", ...u })),
      ...stats.malformed.map((m) => ({ problem: "snapshot is not valid JSON", ...m })),
    ],
  );
  if (csv) console.log(`\nDetails: ${csv}`);
  if (!write) console.log("\nNothing was changed. Run with --snapshots --apply to save.");
  return stats.skipped ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────
// VERIFY
// ─────────────────────────────────────────────────────────────

async function verify(db, hasUrlColumn) {
  const [rows] = await db.query(
    "SELECT service_no, doc_type, file_key, file_ext FROM ef_documents WHERE file_key IS NOT NULL",
  );
  const onDisk = await storage.listStoredFiles(DOC_TYPES);
  const diskByKey = new Map(onDisk.map((f) => [f.fileKey, f]));
  const dbKeys = new Set(rows.map((r) => r.file_key));

  const missingFiles = rows.filter((r) => {
    const f = diskByKey.get(r.file_key);
    return !f || f.ext !== r.file_ext || f.docType !== r.doc_type;
  });
  const orphans = onDisk.filter((f) => !dbKeys.has(f.fileKey));
  const pending = await pendingRows(db, hasUrlColumn);
  const legacy = (await legacyColumnsPresent(db)).length ? await legacyOnlyRows(db) : [];
  const snaps = await scanSnapshots(db, false);

  console.log(`Folder: ${storage.STORAGE_ROOT}`);
  console.log(`Rows with a file key:                 ${rows.length}`);
  console.log(`  file missing from the folder:       ${missingFiles.length}`);
  console.log(`Files no row points at:               ${orphans.length}`);
  console.log(`Rows still only on Cloudinary/old URL: ${pending.length}`);
  console.log(`Photos only in old ef_personalinfos:  ${legacy.length}`);
  console.log(`Snapshot photo links to replace:      ${snaps.entries}  (in ${snaps.formsToChange} confirmed form(s))`);
  console.log(`Snapshot links with no stored photo:  ${snaps.unmatched.length}`);

  missingFiles.slice(0, 10).forEach((r) => console.log(`  missing file: ${r.service_no} ${r.doc_type} ${r.file_key}.${r.file_ext}`));
  pending.slice(0, 10).forEach((r) => console.log(`  not copied:   ${r.service_no} ${r.doc_type} ${r.url}`));

  const csv = writeCsv(
    "document-verify",
    ["problem", "service_no", "doc_type", "detail"],
    [
      ...missingFiles.map((r) => ({ problem: "file missing", service_no: r.service_no, doc_type: r.doc_type, detail: `${r.file_key}.${r.file_ext}` })),
      ...orphans.map((f) => ({ problem: "file without row", service_no: "", doc_type: f.docType, detail: f.path })),
      ...pending.map((r) => ({ problem: "not copied", service_no: r.service_no, doc_type: r.doc_type, detail: r.url })),
      ...legacy.map((r) => ({ problem: "only in ef_personalinfos", service_no: r.service_no, doc_type: r.doc_type, detail: r.url })),
      ...snaps.unmatched.map((u) => ({ problem: `snapshot of form ${u.form_id}: no stored photo`, service_no: u.service_no, doc_type: u.doc_type, detail: u.detail })),
    ],
  );
  if (csv) console.log(`\nDetails: ${csv}`);

  const ready =
    missingFiles.length === 0 && pending.length === 0 && legacy.length === 0 && snaps.entries === 0;
  if (!hasUrlColumn) {
    console.log(`\nThe Cloudinary columns have been dropped.${missingFiles.length ? " Some rows point at files that are not in the folder." : ""}`);
    if (snaps.entries) console.log("Snapshots still have old photo links: run --snapshots --apply.");
    return missingFiles.length || snaps.entries ? 1 : 0;
  }
  console.log(
    `\nThe Cloudinary columns can be dropped: ${ready ? "YES" : "NO"}` +
      (ready
        ? " (config/sql/pending/ef_documents_drop_cloudinary_columns.sql)"
        : pending.length
          ? " (copy the remaining photos first: --apply, then --apply --forget-missing for ones that are gone)"
          : legacy.length
            ? " (photos only in ef_personalinfos: --apply --include-legacy)"
            : missingFiles.length
              ? " (some rows point at files that are not in the folder)"
              : " (point the snapshots at the stored photos first: --snapshots --apply)"),
  );
  return ready ? 0 : 1;
}

// ─────────────────────────────────────────────────────────────

async function main() {
  const database = process.env.DB_OFFICERS || config.databases.officers;
  if (!database) throw new Error("MYSQL_DB_OFFICERS is not set.");

  const db = mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database,
    connectionLimit: CONCURRENCY + 1,
  });

  try {
    console.log(`Database: ${database}`);
    console.log(`Folder:   ${storage.STORAGE_ROOT}`);
    console.log(`Mode:     ${MODE}\n`);

    if (!(await columnExists(db, "ef_documents", "file_key"))) {
      console.error("ef_documents has no file_key column yet. Run: npm run migrate:up officers");
      return 1;
    }
    const hasUrlColumn = await columnExists(db, "ef_documents", "url");

    if (MODE === "verify") return await verify(db, hasUrlColumn);
    if (MODE.startsWith("snapshots")) return await snapshots(db, APPLY);
    if (MODE === "apply") return await apply(db, hasUrlColumn);
    await dryRun(db, hasUrlColumn);
    return 0;
  } finally {
    await db.end();
  }
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    console.error("❌", err.message);
    process.exit(1);
  });

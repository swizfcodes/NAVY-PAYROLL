const express = require("express");
const router = express.Router();
const pool = require("../../config/db");
const verifyToken = require("../../middware/authentication");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

// ══════════════════════════════════════════════════════════
// ATTACHMENT CONFIG
// ══════════════════════════════════════════════════════════
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB per file
const MAX_ATTACHMENTS = 3;
const DEFAULT_QUOTA = 500 * 1024 * 1024; // 500 MB per user
const RETENTION_DAYS = 90; // delete attachments after 90 days

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

// ── Upload directory (dated folders) ─────────────────────
function getUploadDir() {
  const now = new Date();
  const dir = path.join(
    __dirname,
    "../../uploads/mail",
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, getUploadDir()),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
    cb(null, uuidv4() + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) =>
    ALLOWED_MIME_TYPES.has(file.mimetype)
      ? cb(null, true)
      : cb(new Error("File type not allowed")),
});

// ══════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════

// Hash a file on disk using a stream (memory-efficient for large files)
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (err) => reject(err));
  });
}

function fmtBytes(b) {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
  return (b / (1024 * 1024)).toFixed(1) + " MB";
}

// Hard-delete a message row + its physical attachment files.
// Dedup references (is_duplicate=TRUE) share a physical file — only originals are unlinked.
async function hardDeleteMessage(msgId) {
  const [atts] = await pool.query(
    `SELECT id, stored_name, file_size, uploaded_by, is_duplicate
     FROM mail_attachments WHERE mail_id = ?`,
    [msgId],
  );

  for (const att of atts) {
    if (!att.is_duplicate) {
      // Only delete the physical file if no other duplicate rows reference it
      const [[{ refs }]] = await pool.query(
        `SELECT COUNT(*) AS refs FROM mail_attachments
         WHERE original_attachment_id = ? AND id != ?`,
        [att.id, att.id],
      );
      if (refs === 0) {
        fs.unlink(
          path.join(__dirname, "../../uploads/mail", att.stored_name),
          () => {},
        );
      }
      // Free quota from the uploader
      await pool
        .query(
          `UPDATE users SET storage_used_bytes = GREATEST(0, storage_used_bytes - ?)
         WHERE user_id = ?`,
          [att.file_size, att.uploaded_by],
        )
        .catch(() => {});
    }
  }

  // Cascade-deletes attachment rows via FK ON DELETE CASCADE
  await pool.query("DELETE FROM user_mails WHERE id = ?", [msgId]);
}

// ══════════════════════════════════════════════════════════
// POST /api/messages/upload
// Flow: multer saves file → quota check → dedup check → DB insert
// ══════════════════════════════════════════════════════════
router.post("/upload", verifyToken, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file received" });

  const filePath = req.file.path;

  try {
    // ── 1. Quota check ────────────────────────────────────
    const [[user]] = await pool.query(
      `SELECT storage_used_bytes,
              COALESCE(storage_quota_bytes, ?) AS storage_quota_bytes
       FROM users WHERE user_id = ?`,
      [DEFAULT_QUOTA, req.user_id],
    );

    if (!user) {
      fs.unlink(filePath, () => {});
      return res.status(403).json({ error: "User not found" });
    }

    const usedBytes = Number(user.storage_used_bytes) || 0;
    const quotaBytes = Number(user.storage_quota_bytes) || DEFAULT_QUOTA;

    if (usedBytes + req.file.size > quotaBytes) {
      fs.unlink(filePath, () => {});
      return res.status(400).json({
        error: "Storage quota exceeded",
        used: usedBytes,
        quota: quotaBytes,
        available: Math.max(0, quotaBytes - usedBytes),
        message: `You have used ${fmtBytes(usedBytes)} of your ${fmtBytes(quotaBytes)} quota.`,
      });
    }

    // ── 2. Deduplication check ────────────────────────────
    const contentHash = await hashFile(filePath);

    const [existing] = await pool.query(
      `SELECT id, stored_name FROM mail_attachments
       WHERE content_hash = ? AND mail_id IS NOT NULL AND is_duplicate = FALSE
       LIMIT 1`,
      [contentHash],
    );

    const tempToken = uuidv4();

    if (existing.length > 0) {
      // Duplicate found — discard the newly saved file, reference the original
      fs.unlink(filePath, () => {});

      await pool.query(
        `INSERT INTO mail_attachments
           (mail_id, temp_token, filename, stored_name, mime_type, file_size,
            uploaded_by, content_hash, is_duplicate, original_attachment_id)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, TRUE, ?)`,
        [
          tempToken,
          req.file.originalname.slice(0, 255),
          existing[0].stored_name, // point to the original file path
          req.file.mimetype,
          req.file.size,
          req.user_id,
          contentHash,
          existing[0].id,
        ],
      );

      console.log(
        `♻️  Dedup hit: ${req.file.originalname} → attachment #${existing[0].id}`,
      );

      // Quota NOT incremented — duplicate takes zero new disk space
      return res.status(201).json({
        temp_token: tempToken,
        filename: req.file.originalname,
        file_size: req.file.size,
        mime_type: req.file.mimetype,
      });
    }

    // ── 3. New unique file — store normally ───────────────
    const relativePath = path
      .relative(path.join(__dirname, "../../uploads/mail"), filePath)
      .replace(/\\/g, "/");

    await pool.query(
      `INSERT INTO mail_attachments
         (mail_id, temp_token, filename, stored_name, mime_type, file_size,
          uploaded_by, content_hash, is_duplicate)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, FALSE)`,
      [
        tempToken,
        req.file.originalname.slice(0, 255),
        relativePath,
        req.file.mimetype,
        req.file.size,
        req.user_id,
        contentHash,
      ],
    );

    // Increment user quota usage
    await pool.query(
      `UPDATE users SET storage_used_bytes = storage_used_bytes + ? WHERE user_id = ?`,
      [req.file.size, req.user_id],
    );

    console.log(
      `📎 Uploaded: ${req.file.originalname} (${fmtBytes(req.file.size)}) by ${req.user_id}` +
        ` — quota: ${fmtBytes(usedBytes + req.file.size)} / ${fmtBytes(quotaBytes)}`,
    );

    res.status(201).json({
      temp_token: tempToken,
      filename: req.file.originalname,
      file_size: req.file.size,
      mime_type: req.file.mimetype,
    });
  } catch (err) {
    fs.unlink(filePath, () => {});
    console.error("❌ Upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// Multer error handler — must sit immediately after the upload route
router.use(function (err, req, res, next) {
  if (
    err instanceof multer.MulterError ||
    err.message === "File type not allowed"
  )
    return res.status(400).json({ error: err.message });
  next(err);
});

// ══════════════════════════════════════════════════════════
// POST /api/messages — Send a message
// ══════════════════════════════════════════════════════════
router.post("/", verifyToken, async (req, res) => {
  const { to_user_id, to_name, subject, body, attachment_tokens } = req.body;
  if (!to_user_id || !subject || !body)
    return res
      .status(400)
      .json({ error: "Recipient, subject and body are required" });

  const tokens = Array.isArray(attachment_tokens) ? attachment_tokens : [];
  if (tokens.length > MAX_ATTACHMENTS)
    return res
      .status(400)
      .json({ error: `Maximum ${MAX_ATTACHMENTS} attachments allowed` });

  try {
    const [[sender]] = await pool.query(
      "SELECT email FROM users WHERE user_id = ? LIMIT 1",
      [req.user_id],
    );
    const fromEmail = sender?.email || req.email || "";

    const [result] = await pool.query(
      `INSERT INTO user_mails
         (from_user_id, from_name, from_email, to_user_id, to_name, subject, body)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user_id,
        req.user_fullname,
        fromEmail,
        to_user_id,
        to_name,
        subject,
        body,
      ],
    );
    const mailId = result.insertId;

    if (tokens.length > 0) {
      await pool.query(
        `UPDATE mail_attachments SET mail_id = ?
         WHERE temp_token IN (?) AND uploaded_by = ? AND mail_id IS NULL`,
        [mailId, tokens, req.user_id],
      );
    }
    res.status(201).json({ message: "✅ Message sent" });
  } catch (err) {
    console.error("❌ Send message error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/inbox
// Sets delivered_at on first fetch (= delivery timestamp)
// ══════════════════════════════════════════════════════════
router.get("/inbox", verifyToken, async (req, res) => {
  const { since, page = 1, limit = 20 } = req.query;
  try {
    let rows;
    if (since) {
      [rows] = await pool.query(
        `SELECT id, from_user_id, from_name, from_email, subject, body, is_read,
                sent_at, delivered_at, read_at
         FROM user_mails
         WHERE to_user_id = ? AND sent_at > ? AND deleted_by_receiver = FALSE
         ORDER BY sent_at DESC`,
        [req.user_id, since],
      );
    } else {
      const offset = (parseInt(page) - 1) * parseInt(limit);
      [rows] = await pool.query(
        `SELECT id, from_user_id, from_name, from_email, subject, body, is_read,
                sent_at, delivered_at, read_at
         FROM user_mails
         WHERE to_user_id = ? AND deleted_by_receiver = FALSE
         ORDER BY sent_at DESC
         LIMIT ? OFFSET ?`,
        [req.user_id, parseInt(limit), offset],
      );
    }
    // Mark delivered_at for any messages that haven't been stamped yet.
    // This is the moment the receiver's client first "sees" the message.
    const undelivered = rows.filter((r) => !r.delivered_at).map((r) => r.id);
    if (undelivered.length > 0) {
      await pool.query(
        "UPDATE user_mails SET delivered_at = NOW() WHERE id IN (?) AND delivered_at IS NULL",
        [undelivered],
      );
      const now = new Date().toISOString();
      rows.forEach((r) => {
        if (!r.delivered_at) r.delivered_at = now;
      });
    }

    const [[{ unread }]] = await pool.query(
      `SELECT COUNT(*) as unread FROM user_mails
       WHERE to_user_id = ? AND is_read = 0 AND deleted_by_receiver = FALSE`,
      [req.user_id],
    );

    res.json({
      messages: rows,
      unread,
      server_time: new Date().toISOString(),
      // getTimezoneOffset() returns minutes BEHIND UTC (negative for east zones)
      // We negate it so: UTC=0, UTC+1=60, UTC-1=-60 — intuitive for the client
      server_tz_offset: 0, // pool forces UTC — always 0
    });
  } catch (err) {
    console.error("❌ Inbox error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/sent
// Includes tick status columns for the sender's list view
// ══════════════════════════════════════════════════════════
router.get("/sent", verifyToken, async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  try {
    const [rows] = await pool.query(
      `SELECT id, to_user_id, to_name, subject, body,
              sent_at, delivered_at, read_at
       FROM user_mails
       WHERE from_user_id = ? AND deleted_by_sender = FALSE AND is_notification = FALSE
       ORDER BY sent_at DESC
       LIMIT ? OFFSET ?`,
      [req.user_id, parseInt(limit), offset],
    );
    res.json({
      messages: rows,
      server_tz_offset: 0,
    });
  } catch (err) {
    console.error("❌ Sent error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/sent-item/:id
// ══════════════════════════════════════════════════════════
router.get("/sent-item/:id", verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM user_mails WHERE id = ? AND from_user_id = ?",
      [req.params.id, req.user_id],
    );
    if (rows.length === 0)
      return res.status(404).json({ error: "Message not found" });
    const msg = rows[0];
    const [attachments] = await pool.query(
      "SELECT id, filename, stored_name, mime_type, file_size FROM mail_attachments WHERE mail_id = ?",
      [msg.id],
    );
    msg.attachments = attachments;
    res.json(msg);
  } catch (err) {
    console.error("❌ Get sent message error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/:id — Open inbox message + stamp read_at
// ══════════════════════════════════════════════════════════
router.get("/:id", verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM user_mails WHERE id = ? AND to_user_id = ?",
      [req.params.id, req.user_id],
    );
    if (rows.length === 0)
      return res.status(404).json({ error: "Message not found" });

    const msg = rows[0];

    if (!msg.read_at) {
      await pool.query(
        "UPDATE user_mails SET is_read = 1, read_at = NOW() WHERE id = ?",
        [req.params.id],
      );
      msg.read_at = new Date().toISOString();
    } else {
      await pool.query("UPDATE user_mails SET is_read = 1 WHERE id = ?", [
        req.params.id,
      ]);
    }

    const [attachments] = await pool.query(
      "SELECT id, filename, stored_name, mime_type, file_size FROM mail_attachments WHERE mail_id = ?",
      [msg.id],
    );
    msg.attachments = attachments;
    res.json(msg);
  } catch (err) {
    console.error("❌ Get message error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/tick/:id
// ══════════════════════════════════════════════════════════
router.get("/tick/:id", verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT sent_at, delivered_at, read_at
       FROM user_mails WHERE id = ? AND from_user_id = ?`,
      [req.params.id, req.user_id],
    );
    if (rows.length === 0)
      return res.status(404).json({ error: "Message not found" });
    const { sent_at, delivered_at, read_at } = rows[0];
    const tick = read_at ? "read" : delivered_at ? "delivered" : "sent";
    res.json({ tick, sent_at, delivered_at, read_at });
  } catch (err) {
    console.error("❌ Tick error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/attachment/:id
// Resolves dedup references transparently before serving
// ══════════════════════════════════════════════════════════
router.get("/attachment/:id", verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, m.from_user_id, m.to_user_id
       FROM mail_attachments a
       JOIN user_mails m ON m.id = a.mail_id
       WHERE a.id = ?`,
      [req.params.id],
    );
    if (rows.length === 0)
      return res.status(404).json({ error: "Attachment not found" });

    const att = rows[0];
    if (att.from_user_id !== req.user_id && att.to_user_id !== req.user_id)
      return res.status(403).json({ error: "Access denied" });

    // Resolve dedup: serve the original file even if this row is a duplicate reference
    let storedName = att.stored_name;
    if (att.is_duplicate && att.original_attachment_id) {
      const [origRows] = await pool.query(
        "SELECT stored_name FROM mail_attachments WHERE id = ?",
        [att.original_attachment_id],
      );
      if (origRows.length > 0) storedName = origRows[0].stored_name;
    }

    const filePath = path.join(__dirname, "../../uploads/mail", storedName);
    if (!fs.existsSync(filePath))
      return res.status(404).json({ error: "File not found on disk" });

    // Track download — INSERT IGNORE logs only first download per user per attachment
    await pool.query(
      `INSERT IGNORE INTO mail_attachment_downloads (attachment_id, user_id)
       VALUES (?, ?)`,
      [att.id, req.user_id],
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(att.filename)}"`,
    );
    res.setHeader("Content-Type", att.mime_type);
    res.sendFile(filePath);
  } catch (err) {
    console.error("❌ Attachment download error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/attachment-status/:mailId
// ══════════════════════════════════════════════════════════
router.get("/attachment-status/:mailId", verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.id, a.filename, a.mime_type, a.file_size,
              d.downloaded_at
       FROM mail_attachments a
       LEFT JOIN mail_attachment_downloads d
         ON d.attachment_id = a.id AND d.user_id = ?
       JOIN user_mails m ON m.id = a.mail_id
       WHERE a.mail_id = ?
         AND (m.from_user_id = ? OR m.to_user_id = ?)`,
      [req.user_id, req.params.mailId, req.user_id, req.user_id],
    );
    res.json({ attachments: rows });
  } catch (err) {
    console.error("❌ Attachment status error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/storage/me
// Returns the current user's quota usage
// ══════════════════════════════════════════════════════════
router.get("/storage/me", verifyToken, async (req, res) => {
  try {
    const [[user]] = await pool.query(
      `SELECT storage_used_bytes,
              COALESCE(storage_quota_bytes, ?) AS storage_quota_bytes
       FROM users WHERE user_id = ?`,
      [DEFAULT_QUOTA, req.user_id],
    );
    if (!user) return res.status(404).json({ error: "User not found" });

    const used = Number(user.storage_used_bytes) || 0;
    const quota = Number(user.storage_quota_bytes) || DEFAULT_QUOTA;
    const available = Math.max(0, quota - used);
    const pct = quota > 0 ? Math.round((used / quota) * 100) : 0;

    res.json({
      used_bytes: used,
      quota_bytes: quota,
      available_bytes: available,
      percent_used: pct,
      used_formatted: fmtBytes(used),
      quota_formatted: fmtBytes(quota),
    });
  } catch (err) {
    console.error("❌ Storage info error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ══════════════════════════════════════════════════════════
// DELETE /api/messages/:id
//
// SENDER "delete for all":
//   → Hard-deletes the row + files immediately
//   → Sends notification ONLY if receiver hadn't already deleted it
//
// SENDER "delete for me":
//   → Sets deleted_by_sender = TRUE (soft)
//   → If receiver had also already deleted it → hard-delete now
//
// RECEIVER "delete for me":
//   → Sets deleted_by_receiver = TRUE (soft)
//   → If sender had also already deleted it → hard-delete now
// ══════════════════════════════════════════════════════════
router.delete("/:id", verifyToken, async (req, res) => {
  const mode = req.query.mode || "me";
  try {
    const [msgs] = await pool.query(
      `SELECT from_user_id, to_user_id, from_name,
              deleted_by_sender, deleted_by_receiver,
              subject, is_notification
       FROM user_mails WHERE id = ?`,
      [req.params.id],
    );
    if (!msgs.length)
      return res.status(404).json({ error: "Message not found" });

    const msg = msgs[0];
    const isSender = msg.from_user_id === req.user_id;
    const isReceiver = msg.to_user_id === req.user_id;

    if (!isSender && !isReceiver)
      return res.status(403).json({ error: "Not authorized" });

    // ── RECEIVER deletes ───────────────────────────────────
    if (isReceiver && !isSender) {
      if (msg.is_notification || msg.subject === "Message Deleted") {
        await hardDeleteMessage(req.params.id);
      } else if (msg.deleted_by_sender) {
        await hardDeleteMessage(req.params.id);
      } else {
        await pool.query(
          "UPDATE user_mails SET deleted_by_receiver = TRUE WHERE id = ?",
          [req.params.id],
        );
      }
      return res.json({ message: "✅ Message deleted from your inbox" });
    }

    // ── SENDER deletes ─────────────────────────────────────
    if (isSender) {
      if (mode === "me") {
        if (msg.deleted_by_receiver) {
          await hardDeleteMessage(req.params.id);
        } else {
          await pool.query(
            "UPDATE user_mails SET deleted_by_sender = TRUE WHERE id = ?",
            [req.params.id],
          );
        }
        return res.json({
          message: "✅ Message deleted from your sent folder",
        });
      }

      if (mode === "all") {
        const receiverHadDeleted = msg.deleted_by_receiver;
        await hardDeleteMessage(req.params.id);

        if (!receiverHadDeleted) {
          const [[toUser]] = await pool.query(
            "SELECT full_name FROM users WHERE user_id = ?",
            [msg.to_user_id],
          );
          await pool.query(
            `INSERT INTO user_mails
               (from_user_id, from_name, to_user_id, to_name, subject, body, is_notification)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              req.user_id,
              req.user_fullname,
              msg.to_user_id,
              toUser ? toUser.full_name : "Recipient",
              "Message Deleted",
              `${req.user_fullname} deleted a message from your conversation`,
              true,
            ],
          );
        }
        return res.json({ message: "✅ Message deleted for all" });
      }
    }
  } catch (err) {
    console.error("❌ Delete message error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ══════════════════════════════════════════════════════════
// GET /api/messages/users/search?q=
// ══════════════════════════════════════════════════════════
router.get("/users/search", verifyToken, async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2)
    return res
      .status(400)
      .json({ error: "Search query must be at least 2 characters" });
  try {
    const [rows] = await pool.query(
      `SELECT user_id, full_name, email FROM users
       WHERE (full_name LIKE ? OR user_id LIKE ? OR email LIKE ?)
         AND status = 'active' AND user_id != ?
       LIMIT 20`,
      [`%${q}%`, `%${q}%`, `%${q}%`, req.user_id],
    );
    res.json({ users: rows });
  } catch (err) {
    console.error("❌ User search error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ══════════════════════════════════════════════════════════
// CLEANUP JOB — call this from your cron/scheduler
//
// Pass 1 — orphaned uploads (never sent) older than 24h
// Pass 2 — retention policy: attachments on READ messages older than 90 days
//
// Migration note: when moving to R2/S3, only the fs.unlink calls
// in this function and in hardDeleteMessage need to change.
// All quota and DB logic stays identical.
// ══════════════════════════════════════════════════════════
async function cleanupOrphanedAttachments() {
  console.log("🧹 Running attachment cleanup...");
  let orphanCount = 0;
  let expiredCount = 0;

  try {
    // ── Pass 1: orphaned uploads ──────────────────────────
    const [orphans] = await pool.query(
      `SELECT id, stored_name, file_size, uploaded_by, is_duplicate
       FROM mail_attachments
       WHERE mail_id IS NULL
         AND created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
    );

    for (const row of orphans) {
      if (!row.is_duplicate) {
        fs.unlink(
          path.join(__dirname, "../../uploads/mail", row.stored_name),
          () => {},
        );
        // Refund quota for original files only
        await pool
          .query(
            `UPDATE users SET storage_used_bytes = GREATEST(0, storage_used_bytes - ?)
           WHERE user_id = ?`,
            [row.file_size, row.uploaded_by],
          )
          .catch(() => {});
      }
      await pool.query("DELETE FROM mail_attachments WHERE id = ?", [row.id]);
      orphanCount++;
    }

    // ── Pass 2: retention policy ──────────────────────────
    // Only originals (is_duplicate=FALSE) are considered.
    // Unread messages keep their attachments indefinitely.
    const [expired] = await pool.query(
      `SELECT a.id, a.stored_name, a.file_size, a.uploaded_by
       FROM mail_attachments a
       JOIN user_mails m ON m.id = a.mail_id
       WHERE m.read_at IS NOT NULL
         AND a.created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
         AND a.is_duplicate = FALSE`,
      [RETENTION_DAYS],
    );

    for (const att of expired) {
      // Only unlink the physical file if no duplicate rows still reference it
      const [[{ refs }]] = await pool.query(
        `SELECT COUNT(*) AS refs FROM mail_attachments
         WHERE original_attachment_id = ?`,
        [att.id],
      );

      if (refs === 0) {
        fs.unlink(
          path.join(__dirname, "../../uploads/mail", att.stored_name),
          () => {},
        );
      }

      await pool.query("DELETE FROM mail_attachments WHERE id = ?", [att.id]);
      await pool
        .query(
          `UPDATE users SET storage_used_bytes = GREATEST(0, storage_used_bytes - ?)
         WHERE user_id = ?`,
          [att.file_size, att.uploaded_by],
        )
        .catch(() => {});

      expiredCount++;
    }

    const total = orphanCount + expiredCount;
    if (total > 0) {
      console.log(
        `🧹 Cleanup done — ${orphanCount} orphaned, ${expiredCount} expired (${total} total)`,
      );
    } else {
      console.log("🧹 Cleanup complete — nothing to remove");
    }
  } catch (err) {
    console.error("❌ Attachment cleanup error:", err);
  }
}

module.exports = router;
module.exports.cleanupOrphanedAttachments = cleanupOrphanedAttachments;

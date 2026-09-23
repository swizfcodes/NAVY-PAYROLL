/**
 * FILE: routes/auth/unifiedLogin.js
 *
 * Unified authentication for ALL personnel:
 *   - 40k+ personnel (payslip, emolument, email)
 *   - Payroll admins (also get can_payroll flag, then go to /users/login for class)
 *   - Emolument officers (DO/FO/CPO)
 *   - Emolument admins
 *
 * Password source: hr_employees.password (single source of truth)
 *
 * Routes:
 *   POST /auth/pre-login              ← replaces /users/pre-login
 *   POST /auth/logout                 ← clears hr_employees token
 *   POST /auth/change-password        ← updates hr_employees + users (sync)
 *   POST /auth/verify-identity ← replaces /users/pre-login/verify-identity
 *   POST /auth/reset-password  ← replaces /users/pre-login/reset-password
 *
 * What stays in /users:
 *   POST /login            — payroll full login (class selection)
 *   POST /logout           — clears payroll users token
 *   POST /refresh          — payroll token refresh
 *   POST /verify-identity  — payroll forgot password (requires class)
 *   POST /reset-password   — payroll forgot password reset (requires class)
 *   GET/POST/PUT/DELETE /  — user CRUD
 *
 * Token structure (pre-login, matches existing verifyToken exactly):
 * {
 *   user_id, full_name, email,
 *   role,           <- payroll role if in users table, else null
 *   primary_class,  <- payroll class if in users table, else null
 *   created_in,     <- officers DB name
 *   user_type,      <- PERSONNEL | PAYROLL_ADMIN | EMOL_OFFICER | EMOL_ADMIN
 * }
 *
 * Capabilities are returned in the login response body but NOT
 * embedded in the JWT — they are fetched live from ef_user_roles
 * on every protected request. This prevents stale role data
 * baked into long-lived tokens.
 */

"use strict";

const express = require("express");
const argon = require("argon2");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const router = express.Router();
const jwt = require("jsonwebtoken");
const pool = require("../../config/db");
const config = require("../../config");
const EmailProvider = require("../../providers/email");
const { applyReplacements } = require("../../utils/email_helper");
const {
  detectFormat,
  hashPassword,
  verifyHashed,
  recomputeLikeStored,
} = require("../../utils/legacyPassword");

const SECRET = config.jwt.secret;
const OFFICERS_DB = () => process.env.DB_OFFICERS || config.databases.officers;

if (!SECRET) throw new Error("JWT_SECRET not set");

function generateOtp() {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

// ─────────────────────────────────────────────────────────────
// POST /auth/pre-login
// Replaces: POST /users/pre-login
//
// All personnel use this. Password checked against hr_employees.
// Returns capabilities so frontend can render the correct dashboard.
// Payroll admins additionally call POST /api/users/login for class.
// ─────────────────────────────────────────────────────────────
router.post("/pre-login", async (req, res) => {
  const user_id = (req.body.user_id || "").trim();
  const password = (req.body.password || "").trim();

  if (!user_id || !password) {
    return res
      .status(400)
      .json({ error: "Service Number and password are required" });
  }

  try {
    pool.useDatabase(OFFICERS_DB());

    // ── 1. Verify against hr_employees ───────────────────────
    const [empRows] = await pool.query(
      `SELECT
         Empl_ID, Surname, OtherName, Title,
         email, gsm_number, payrollclass,
         password, force_change, exittype
       FROM hr_employees
       WHERE Empl_ID = ?
       LIMIT 1`,
      [user_id],
    );

    if (!empRows.length) {
      return res
        .status(401)
        .json({ error: "Invalid Service Number or password" });
    }

    const emp = empRows[0];

    if (emp.exittype && emp.exittype.trim() !== "") {
      return res
        .status(403)
        .json({ error: "Account deactivated. Contact administrator." });
    }

    if (emp.force_change || emp.force_change === 1) {
      return res.status(401).json({
        error: "Use the 'First Time?' option to change your password.",
      });
    }

    if (!emp.password) {
      return res
        .status(401)
        .json({ error: "Invalid Service Number or password" });
    }

    // ── Detect how the migrated password is stored ───────────
    // argon2 -> verify natively; md5/identity(PBKDF2) -> verify then rehash;
    // plaintext -> untrusted, push the user into the first-time change flow.
    const storedFormat = detectFormat(emp.password);

    if (storedFormat === "plaintext") {
      // Flag it so the existing force_change gate catches them next time too.
      await pool.query(
        "UPDATE hr_employees SET force_change = 1 WHERE Empl_ID = ?",
        [user_id],
      );
      return res.status(401).json({
        error: "Use the 'First Time?' option to change your password.",
      });
    }

    // ── DEBUG: recompute the typed password with the SAME technique as the
    //    stored value and print both, so you can compare/contrast directly.
    try {
      await recomputeLikeStored(password, emp.password);
    } catch (dbgErr) {
      console.error(`[pre-login] ${user_id}: compare-debug failed:`, dbgErr);
    }

    let passwordValid = false;
    let needsRehash = false;
    try {
      const result = await verifyHashed(password, emp.password);
      passwordValid = result.ok;
      needsRehash = result.needsRehash;
    } catch (err) {
      console.error(`[pre-login] ${user_id}: verify threw:`, err);
      return res
        .status(401)
        .json({ error: "Invalid Service Number or Password" });
    }

    if (!passwordValid) {
      return res
        .status(401)
        .json({ error: "Invalid Service Number or Password" });
    }

    // ── Verify-and-rehash: upgrade a verified legacy (md5/PBKDF2) hash to
    //    argon2 in place. Transparent to the user; runs once per account.
    if (needsRehash) {
      try {
        const upgraded = await hashPassword(password);
        await pool.query(
          "UPDATE hr_employees SET password = ?, password_changed_at = NOW() WHERE Empl_ID = ?",
          [upgraded, user_id],
        );
      } catch (err) {
        // Non-fatal: the user still authenticated. Log and continue.
        console.error(`Rehash failed for ${user_id}:`, err);
      }
    }

    // ── 2. Resolve capabilities (3 parallel queries) ─────────
    const capabilities = await resolveCapabilities(user_id);

    // ── 3. Determine user type ────────────────────────────────
    let userType = "PERSONNEL";
    if (capabilities.emol_roles.includes("EMOL_ADMIN")) userType = "EMOL_ADMIN";
    else if (capabilities.can_payroll) userType = "PAYROLL_ADMIN";
    else if (capabilities.emol_roles.length > 0) userType = "EMOL_OFFICER";

    // ── 4. Build full name ────────────────────────────────────
    const full_name = [
      emp.Title ? emp.Title.trim() + "." : null,
      emp.Surname,
      emp.OtherName ? emp.OtherName.trim().charAt(0) + "." : null,
    ]
      .filter(Boolean)
      .map((s) => s.trim())
      .join(" ");

    // ── 5. Pull payroll role + class if admin ─────────────────
    // Keeps token compatible with existing verifyToken middleware
    let payrollRole = null;
    let primaryClass = null;

    if (capabilities.can_payroll) {
      const [pRows] = await pool.query(
        "SELECT user_role, primary_class FROM users WHERE user_id = ? LIMIT 1",
        [user_id],
      );
      if (pRows.length) {
        payrollRole = pRows[0].user_role;
        primaryClass = pRows[0].primary_class;
      }
    }

    // ── 6. Issue pre-login JWT ────────────────────────────────
    const tokenPayload = {
      user_id,
      full_name,
      name: `${emp.Surname?.trim()} ${emp.OtherName?.trim() || ""}`.trim(),
      rank: emp.Title?.trim()?.toUpperCase()?.replace(/\./g, ""), // e.g. "CPT" from "Capt."
      email: emp.email || null,
      role: payrollRole, // null for non-payroll
      primary_class: primaryClass, // null for non-payroll
      created_in: OFFICERS_DB(),
      user_type: userType,
    };

    const token = jwt.sign(tokenPayload, SECRET, { expiresIn: "8h" });

    // ── 7. Persist token to hr_employees ─────────────────────
    await pool.query("UPDATE hr_employees SET token = ? WHERE Empl_ID = ?", [
      token,
      user_id,
    ]);

    // ── 8. Fetch available classes for payroll admins ─────────
    let available_classes = [];
    if (capabilities.can_payroll) {
      const [cRows] = await pool.query(
        `SELECT db_name, classname AS display_name
         FROM py_payrollclass WHERE status = 'active'
         ORDER BY db_name ASC`,
      );
      available_classes = cRows;
    }

    console.log(`✅ Pre-login: ${user_id} (${userType})`);

    return res.json({
      message: "✅ Pre-login successful",
      token,
      user: {
        user_id,
        full_name,
        email: emp.email || null,
        role: payrollRole,
        primary_class: primaryClass,
        user_type: userType,
        force_change: emp.force_change === 1,
      },
      capabilities,
      available_classes,
    });
  } catch (err) {
    console.error("❌ Pre-login error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /auth/logout
// Clears token from hr_employees.
// Payroll logout (users.token) is handled by POST /api/users/logout.
// ─────────────────────────────────────────────────────────────
router.post("/logout", async (req, res) => {
  const bearerHeader = req.headers["authorization"];
  const token = bearerHeader?.startsWith("Bearer ")
    ? bearerHeader.split(" ")[1]
    : null;

  if (!token) return res.status(204).send();

  try {
    let decoded;
    try {
      decoded = jwt.verify(token, SECRET);
    } catch {
      return res.status(204).send();
    }

    pool.useDatabase(OFFICERS_DB());
    await pool.query("UPDATE hr_employees SET token = NULL WHERE Empl_ID = ?", [
      decoded.user_id,
    ]);
    return res.status(204).send();
  } catch (err) {
    console.error("❌ Auth logout error:", err);
    return res.status(204).send();
  }
});

// ─────────────────────────────────────────────────────────────
// POST /auth/change-password
// Updates hr_employees.password (source of truth).
// Syncs to users.password so payroll full login still works.
// ─────────────────────────────────────────────────────────────
router.post("/change-password", async (req, res) => {
  const bearerHeader = req.headers["authorization"];
  const token = bearerHeader?.startsWith("Bearer ")
    ? bearerHeader.split(" ")[1]
    : null;

  if (!token) return res.status(401).json({ error: "Token required" });

  let decoded;
  try {
    decoded = jwt.verify(token, SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  const { old_password, new_password } = req.body;

  if (!old_password || !new_password)
    return res
      .status(400)
      .json({ error: "old_password and new_password are required" });
  if (new_password.length < 6)
    return res
      .status(400)
      .json({ error: "Password must be at least 6 characters" });
  if (old_password === new_password)
    return res
      .status(400)
      .json({ error: "New password must differ from current password" });

  try {
    pool.useDatabase(OFFICERS_DB());

    const [rows] = await pool.query(
      "SELECT password FROM hr_employees WHERE Empl_ID = ? LIMIT 1",
      [decoded.user_id],
    );

    if (!rows.length || !(await argon.verify(rows[0].password, old_password))) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    const newPwdhash = await argon.hash(new_password);

    await pool.query(
      `UPDATE hr_employees
       SET password = ?, force_change = 0, password_changed_at = NOW()
       WHERE Empl_ID = ?`,
      [newPwdhash, decoded.user_id],
    );

    return res.json({ message: "Password changed successfully" });
  } catch (err) {
    console.error("❌ Change password error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /auth/verify-identity
// Replaces: POST /users/pre-login/verify-identity
// No class required — checks hr_employees directly.
// ─────────────────────────────────────────────────────────────
router.post("/verify-identity", async (req, res) => {
  const { user_id, ac_number } = req.body;

  if (!user_id || !ac_number) {
    return res
      .status(400)
      .json({ error: "Service Number and Account Number are required" });
  }

  try {
    pool.useDatabase(OFFICERS_DB());

    const [rows] = await pool.query(
      `SELECT Empl_ID, Surname, OtherName, Title, exittype, BankACNumber,
        force_change, password 
       FROM hr_employees WHERE Empl_ID = ? AND BankACNumber = ? LIMIT 1`,
      [user_id, ac_number],
    );

    if (!rows.length) {
      return res
        .status(404)
        .json({ error: "User not found. Please check your Service Number." });
    }

    const emp = rows[0];

    if (emp.exittype && emp.exittype.trim() !== "") {
      return res
        .status(403)
        .json({ error: "Account deactivated. Contact administrator." });
    }

    // const storedName = [emp.Title, emp.Surname, emp.OtherName]
    //   .filter(Boolean)
    //   .map((s) => s.trim())
    //   .join(" ")
    //   .toLowerCase();
    // const inputName = full_name.trim().toLowerCase();

    // // Accept full title+name match OR surname+othername match
    // const nameOk =
    //   storedName === inputName ||
    //   `${emp.Surname} ${emp.OtherName}`.trim().toLowerCase() === inputName ||
    //   emp.Surname?.trim().toLowerCase() === inputName;

    // if (!nameOk) {
    //   return res.status(401).json({
    //     error:
    //       "Identity verification failed. Incorrect: Full Name. Please check and try again.",
    //   });
    // }

    if (
      emp.force_change === 0 ||
      (emp.password && emp.password.trim() !== "")
    ) {
      return res
        .status(400)
        .json({
          error:
            "password has been set. if you forgot your password, use the forgot password link",
        });
    }

    return res.json({
      message: "Identity verified successfully",
      user: { user_id: emp.Empl_ID },
    });
  } catch (err) {
    console.error("❌ Forgot verify-identity error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /auth/forgot/forgot-password
// Replaces: POST /users/pre-login/forgot-password
// Resets in hr_employees, syncs to users if payroll user.
// ─────────────────────────────────────────────────────────────
router.post("/forgot-password", async (req, res) => {
  const { user_id, email } = req.body;

  if (!user_id || !email) {
    return res.status(400).json({ error: "All fields are required" });
  }

  const genericRes = {
    message:
      "If an account matching that information exists, a link will be sent to the associated email to set your password.",
    user_id,
  };

  try {
    pool.useDatabase(OFFICERS_DB());

    const [rows] = await pool.query(
      `SELECT Empl_ID, email, exittype
       FROM hr_employees WHERE Empl_ID = ? AND email = ? LIMIT 1`,
      [user_id, email],
    );

    // No match, OR account deactivated — identical response either way.
    if (!rows.length || (rows[0].exittype && rows[0].exittype.trim() !== "")) {
      console.warn(`[forgot-password] no match or inactive: ${user_id}`);
      return res.json(genericRes);
    }

    const emp = rows[0];

    // Generate token + hash
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min

    // Persist — overwrites any prior pending token for this user
    await pool.query(
      `UPDATE hr_employees
       SET reset_hash = ?, reset_expires_at = ?
       WHERE Empl_ID = ?`,
      [tokenHash, expiresAt, emp.Empl_ID],
    );

    // Build email
    const RESET_URL = `${process.env.BASE_URL}/reset-password.html?token=${rawToken}`;

    const templateHtml = fs.readFileSync(
      path.join(__dirname, "../../templates/password-reset-link.html"),
      "utf-8",
    );

    const html = applyReplacements(templateHtml, {
      RESET_URL,
    });

    await EmailProvider.sendMessage({
      to: emp.email,
      subject: "Password Reset",
      html,
      text: "",
      from: "NNCPO",
    });

    console.log(`✅ Password reset link sent for ${user_id}`);
    return res.json(genericRes);
  } catch (err) {
    console.error("❌ Forgot reset-password error:", err);
    return res.json(genericRes); // still generic — no distinguishable error path
  }
});

// ─────────────────────────────────────────────────────────────
// NEW!!!
// POST /auth/forgot/forgot-password-otp
// Resets in hr_employees, syncs to users if payroll user.
// Sends OTP instead of Magic Link
// ─────────────────────────────────────────────────────────────
router.post("/forgot-password-otp", async (req, res) => {
  const { user_id, email } = req.body;

  if (!user_id || !email) {
    return res.status(400).json({ error: "All fields are required" });
  }

  const genericRes = {
    message:
      "If an account matching that information exists, a link will be sent to the associated email to set your password.",
    user_id,
  };

  try {
    pool.useDatabase(OFFICERS_DB());

    const [rows] = await pool.query(
      `SELECT Empl_ID, email, exittype
       FROM hr_employees WHERE Empl_ID = ? AND email = ? LIMIT 1`,
      [user_id, email],
    );

    // No match, OR account deactivated — identical response either way.
    if (!rows.length || (rows[0].exittype && rows[0].exittype.trim() !== "")) {
      console.warn(`[forgot-password] no match or inactive: ${user_id}`);
      return res.json(genericRes);
    }

    const emp = rows[0];

    // Generate token + hash
    const rawToken = generateOtp();
    const tokenHash = crypto
      .createHash("sha256")
      .update(`${user_id}:${rawToken}`)
      .digest("hex");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min

    // Persist — overwrites any prior pending token for this user
    await pool.query(
      `UPDATE hr_employees
       SET reset_hash = ?, reset_expires_at = ?
       WHERE Empl_ID = ?`,
      [tokenHash, expiresAt, emp.Empl_ID],
    );

    // Build email
    const RESET_URL = `${process.env.BASE_URL}/reset-password.html`;

    const templateHtml = fs.readFileSync(
      path.join(__dirname, "../../templates/password-reset-otp.html"),
      "utf-8",
    );

    const html = applyReplacements(templateHtml, {
      OTP_CODE: rawToken,
      OTP_PAGE_URL: RESET_URL,
    });

    await EmailProvider.sendMessage({
      to: emp.email,
      subject: "Password Reset",
      html,
      text: "",
      from: "NNCPO",
    });

    console.log(`✅ Password reset link sent for ${user_id}`);
    return res.json(genericRes);
  } catch (err) {
    console.error("❌ Forgot reset-password error:", err);
    return res.json(genericRes); // still generic — no distinguishable error path
  }
});

// ---------------------------------------------------------------------------
// GET /auth/verify-reset-token?token=...
// Called by the frontend reset page on load to check validity BEFORE
// showing the new-password form.
// ---------------------------------------------------------------------------
router.get("/verify-reset-token", async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ valid: false, reason: "missing" });
  }

  try {
    pool.useDatabase(OFFICERS_DB());

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const [rows] = await pool.query(
      `SELECT Empl_ID, reset_expires_at
       FROM hr_employees WHERE reset_hash = ? LIMIT 1`,
      [tokenHash],
    );

    if (!rows.length) {
      return res.status(400).json({ valid: false, reason: "invalid" });
    }

    const emp = rows[0];

    if (new Date(emp.reset_expires_at) < new Date()) {
      return res.status(400).json({ valid: false, reason: "expired" });
    }

    return res.json({ valid: true });
  } catch (err) {
    console.error("❌ verify-reset-token error:", err);
    return res.status(500).json({ valid: false, reason: "server_error" });
  }
});

// ---------------------------------------------------------------------------
// GET /auth/verify-reset-otp?token=...
// Called by the frontend otp page on load to check validity BEFORE REDIRECTING
// showing the new-password form.
// ---------------------------------------------------------------------------
router.patch("/verify-reset-otp", async (req, res) => {
  const { user_id, otp } = req.body || {};

  if (!otp || !user_id) {
    return res.status(400).json({ valid: false, reason: "missing" });
  }

  try {
    pool.useDatabase(OFFICERS_DB());

    const tokenHash = crypto
      .createHash("sha256")
      .update(`${user_id}:${otp}`)
      .digest("hex");

    const [rows] = await pool.query(
      `SELECT Empl_ID, reset_expires_at
       FROM hr_employees WHERE reset_hash = ? LIMIT 1`,
      [tokenHash],
    );

    if (!rows.length) {
      return res.status(400).json({ valid: false, reason: "invalid" });
    }

    const emp = rows[0];

    if (new Date(emp.reset_expires_at) < new Date()) {
      return res.status(400).json({ valid: false, reason: "expired" });
    }

    return res.json({ valid: true });
  } catch (err) {
    console.error("❌ verify-reset-token error:", err);
    return res.status(500).json({ valid: false, reason: "server_error" });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /auth/forgot/reset-password
// Replaces: POST /users/pre-login/reset-password
// Resets in hr_employees, syncs to users if payroll user.
// ─────────────────────────────────────────────────────────────
router.post("/reset-password", async (req, res) => {
  const { token, new_password } = req.body;

  if (!token || !new_password) {
    return res
      .status(400)
      .json({ error: "Token and new password are required" });
  }

  if (new_password.length < 6) {
    return res
      .status(400)
      .json({ error: "Password must be at least 6 characters" });
  }

  try {
    pool.useDatabase(OFFICERS_DB());

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const [rows] = await pool.query(
      `SELECT Empl_ID, Surname, OtherName, Title, exittype, reset_expires_at
       FROM hr_employees WHERE reset_hash = ? LIMIT 1`,
      [tokenHash],
    );

    if (!rows.length) {
      return res.status(400).json({ error: "invalid" });
    }

    const emp = rows[0];

    if (emp.exittype && emp.exittype.trim() !== "") {
      return res
        .status(403)
        .json({ error: "Account deactivated. Contact administrator." });
    }

    if (new Date(emp.reset_expires_at) < new Date()) {
      return res.status(400).json({ error: "expired" });
    }

    const passwordHash = await argon.hash(new_password);

    // Update password AND clear the reset token in the same statement —
    // this makes the token single-use; it can't be replayed after success.
    await pool.query(
      `UPDATE hr_employees
       SET password = ?, reset_hash = NULL, reset_expires_at = NULL, force_change = 0, password_changed_at = NOW()
       WHERE Empl_ID = ?`,
      [passwordHash, emp.Empl_ID],
    );

    console.log(`✅ Password reset completed for ${emp.Empl_ID}`);
    return res.json({ message: "Password reset successful" });
  } catch (err) {
    console.error("❌ reset-password error:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

// ─────────────────────────────────────────────────────────────
// NEW !!!
// POST /auth/forgot/set-password
// Resets in hr_employees, syncs to users if payroll user.
// ─────────────────────────────────────────────────────────────
router.post("/set-password", async (req, res) => {
  const { user_id, new_password } = req.body;

  if (!user_id || !new_password) {
    return res
      .status(400)
      .json({ error: "Service Number and New password are required" });
  }

  if (new_password.length < 6) {
    return res
      .status(400)
      .json({ error: "Password must be at least 6 characters" });
  }

  try {
    pool.useDatabase(OFFICERS_DB());

    const [rows] = await pool.query(
      `SELECT Empl_ID, Surname, OtherName, Title, exittype
       FROM hr_employees WHERE Empl_ID = ? LIMIT 1`,
      [user_id],
    );

    if (!rows.length) {
      return res.status(400).json({ error: "invalid" });
    }

    const emp = rows[0];

    if (emp.exittype && emp.exittype.trim() !== "") {
      return res
        .status(403)
        .json({ error: "Account deactivated. Contact administrator." });
    }

    const passwordHash = await argon.hash(new_password);

    // Update password AND clear the reset token in the same statement —
    // this makes the token single-use; it can't be replayed after success.
    await pool.query(
      `UPDATE hr_employees
       SET password = ?, reset_hash = NULL, reset_expires_at = NULL, force_change = 0, password_changed_at = NOW()
       WHERE Empl_ID = ?`,
      [passwordHash, emp.Empl_ID],
    );

    console.log(`✅ Password reset completed for ${emp.Empl_ID}`);
    return res.json({ message: "Password reset successful" });
  } catch (err) {
    console.error("❌ reset-password error:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

// ─────────────────────────────────────────────────────────────
// HELPER: resolveCapabilities
// Runs 3 parallel DB queries to determine what a user can access.
// Exported so emolumentAuth.js can also call it if needed.
// ─────────────────────────────────────────────────────────────
async function resolveCapabilities(userId) {
  pool.useDatabase(OFFICERS_DB());

  const [[payrollRows], [emolRows], [roleRows]] = await Promise.all([
    pool.query("SELECT user_id FROM users WHERE user_id = ? LIMIT 1", [userId]),
    pool.query(
      "SELECT serviceNumber FROM ef_personalinfos WHERE serviceNumber = ? LIMIT 1",
      [userId],
    ),
    pool.query(
      `SELECT role, scope_type, scope_value
       FROM ef_user_roles WHERE user_id = ? AND is_active = 1`,
      [userId],
    ),
  ]);

  const emol_roles = [...new Set(roleRows.map((r) => r.role))];
  const assigned_ships = [
    ...new Set(
      roleRows
        .filter(
          (r) =>
            ["DO", "FO"].includes(r.role) &&
            r.scope_type === "SHIP" &&
            r.scope_value,
        )
        .map((r) => r.scope_value),
    ),
  ];
  const assigned_commands = [
    ...new Set(
      roleRows
        .filter(
          (r) =>
            r.role === "CPO" && r.scope_type === "COMMAND" && r.scope_value,
        )
        .map((r) => r.scope_value),
    ),
  ];

  return {
    can_payroll: payrollRows.length > 0,
    can_emolument: emolRows.length > 0,
    can_view_payslip: true,
    can_access_email: true,
    emol_roles,
    assigned_ships,
    assigned_commands,
  };
}

module.exports = router;
module.exports.resolveCapabilities = resolveCapabilities;

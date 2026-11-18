// ============================================================
// USER PAYSLIP CONTROLLER
// routes/user-dashboard/userPayslip.js
// Single-user payslip: validate → DB switch → SP → render/PDF
// ============================================================

const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const pool = require("../../../config/db");
const verifyToken = require("../../../middware/authentication");
const Handlebars = require("handlebars");
const chromiumPdfGenerator = require("../../../lib/chromiumPdfGenerator");
const syncPublications = require("../../../services/sync/publication.service");

// ── Payrollclass → DB name map ────────────────────────────
async function getPayrollClassDb(classcode) {
  const [[row]] = await pool.query(
    `SELECT db_name
     FROM py_payrollclass
     WHERE classcode = ? AND status = 'active'
     LIMIT 1`,
    [classcode],
  );

  return row ? row.db_name : null;
}

// ── Payslip PDF: template, images and helpers kept in memory ──
// Read and compiled once (recompiled if the file changes), not on every request.
const PAYSLIP_TEMPLATE = path.join(__dirname, "../../../templates/user-payslip.html");
const PHOTOS_DIR = path.join(__dirname, "../../../public/photos");
let _payslipTemplate = null; // { mtimeMs, render }

function payslipTemplate() {
  const st = fs.statSync(PAYSLIP_TEMPLATE);
  if (!_payslipTemplate || _payslipTemplate.mtimeMs !== st.mtimeMs) {
    _payslipTemplate = {
      mtimeMs: st.mtimeMs,
      render: Handlebars.compile(fs.readFileSync(PAYSLIP_TEMPLATE, "utf8")),
    };
  }
  return _payslipTemplate.render;
}

const _images = new Map();
function imageDataUrl(file) {
  if (!_images.has(file)) {
    const p = path.join(PHOTOS_DIR, file);
    _images.set(
      file,
      fs.existsSync(p) ? `data:image/png;base64,${fs.readFileSync(p).toString("base64")}` : "",
    );
  }
  return _images.get(file);
}

// The same helpers the payslip template had before (passed per render, so the
// app-wide Handlebars helpers used by other reports are not replaced).
const PAYSLIP_HELPERS = {
  formatCurrency(value) {
    if (!value && value !== 0) return "0.00";
    return parseFloat(value)
      .toFixed(2)
      .replace(/\d(?=(\d{3})+\.)/g, "$&,");
  },
  formatDate(date) {
    const d = new Date(date);
    const months = ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"];
    return d.getDate() + " " + months[d.getMonth()] + " " + d.getFullYear();
  },
  ifCond(a, b, options) {
    return a === b ? options.fn(this) : options.inverse(this);
  },
};

// ============================================================
// HELPERS
// ============================================================

function zeroPad(n) {
  return String(n).padStart(2, "0");
}

function buildPeriod(year, month) {
  return `${year}${zeroPad(month)}`;
}

/**
 * Write key for py_webpayslip.work_station, unique per request (as in adminpayslip.js).
 * py_webpayslip is only a scratch table for the stored procedure's output: the rows are
 * read once and deleted straight away, so no payslip data stays stored. A unique key
 * also keeps two requests of the same user (double click, two tabs) apart.
 */
function makeSessionKey() {
  return `usr_${Date.now()}_${Math.floor(Math.random() * 0xffff).toString(16)}`;
}

/**
 * Map flat py_webpayslip rows for a single employee into structured object.
 * Mirrors _mapConsolidatedPayslipData but for one employee only.
 */
function mapPayslipRows(rows) {
  if (!rows || rows.length === 0) return null;

  const first = rows[0];
  const emp = {
    employee_id: first.numb || first.NUMB || "",
    surname: first.surname,
    othername: first.othername,
    title: first.title,
    gradelevel: first.gradelevel,
    department: first.location || first.Location || "",
    factory: first.factory || "",
    bank_name: first.bankname || "",
    bank_account_number: first.bankacnumber || "",
    nsitfcode: first.nsitfcode || "",
    payroll_month: first.desc1,
    payroll_year: first.ord,
    ippis: {
      taxable: [],
      nontaxable: [],
      deductions: [],
      taxable_total: 0,
      nontaxable_total: 0,
      deductions_total: 0,
      net: 0,
    },
    navy: {
      taxable: [],
      nontaxable: [],
      deductions: [],
      taxable_total: 0,
      nontaxable_total: 0,
      deductions_total: 0,
      net: 0,
    },
    net_pay: 0,
  };

  rows.forEach((row) => {
    const source = (row.source || "").toUpperCase();
    const category = (row.bpc || "").toUpperCase();
    const amount = parseFloat(row.bpm || row.BPM) || 0;
    const lbal = parseFloat(row.lbal) || 0;
    const lmth = parseInt(row.lmth) || 0;

    const item = {
      description: row.bp || row.BP || "",
      amount,
      loan_balance: lbal > 0 ? lbal : null,
      outstanding_months: lmth > 0 ? lmth : null,
    };

    const bucket = source === "IPPIS" ? emp.ippis : emp.navy;

    if (category === "BP" || category === "BT") {
      bucket.taxable.push(item);
      bucket.taxable_total += amount;
    } else if (category === "PT") {
      bucket.nontaxable.push(item);
      bucket.nontaxable_total += amount;
    } else if (category === "PR" || category === "PL") {
      bucket.deductions.push(item);
      bucket.deductions_total += amount;
    }
  });

  // Calculate nets
  emp.ippis.net =
    emp.ippis.taxable_total +
    emp.ippis.nontaxable_total -
    emp.ippis.deductions_total;
  emp.navy.net =
    emp.navy.taxable_total +
    emp.navy.nontaxable_total -
    emp.navy.deductions_total;
  emp.net_pay = emp.ippis.net + emp.navy.net;

  // Null out empty sections
  const isEmpty = (s) =>
    s.taxable.length === 0 &&
    s.nontaxable.length === 0 &&
    s.deductions.length === 0;
  if (isEmpty(emp.ippis)) emp.ippis = null;
  if (isEmpty(emp.navy)) emp.navy = null;

  return emp;
}

// ============================================================
// POST /payslip/generate
// Body: { year: "2025", month: "3" }
// ============================================================
router.post("/generate", verifyToken, async (req, res) => {
  const userId = req.user_id;
  const { year, month } = req.body;

  // ── 1. Basic input validation ──────────────────────────
  const inputYear = parseInt(year);
  const inputMonth = parseInt(month);

  if (!inputYear || !inputMonth || inputMonth < 1 || inputMonth > 12) {
    return res.status(400).json({ error: "Invalid year or month." });
  }

  // ── 2. Block future periods ────────────────────────────
  const now = new Date();
  if (
    inputYear > now.getFullYear() ||
    (inputYear === now.getFullYear() && inputMonth > now.getMonth() + 1)
  ) {
    return res.status(400).json({
      error: "Cannot generate payslip for a future period.",
    });
  }

  const period = buildPeriod(inputYear, inputMonth);

  // ── Fetch payrollclass from master DB (pool is still on hicaddata here) ──
  let payrollclass, targetDb;
  try {
    // ── 3. Fetch employee payrollclass from master DB ──
    // hr_employees lives in hicaddata (officers / master DB)
    const [empRows] = await pool.query(
      `SELECT payrollclass FROM hr_employees WHERE EMPL_ID = ? LIMIT 1`,
      [userId],
    );

    if (!empRows || empRows.length === 0) {
      return res.status(404).json({
        error: "No employee record found for your service number.",
      });
    }

    payrollclass = String(empRows[0].payrollclass);
    targetDb = await getPayrollClassDb(payrollclass);

    if (!targetDb) {
      return res.status(400).json({
        error: `Unsupported payroll class: ${payrollclass}.`,
      });
    }
  } catch (err) {
    console.error("❌ Payslip lookup error:", err);
    return res
      .status(500)
      .json({ error: "An error occurred while generating your payslip." });
  }

  // ── 4. All payroll DB work on a dedicated connection ──────────
  const conn = await pool.getConnection();
  let switchedDb = false;
  const sessionKey = makeSessionKey();
  let wroteRows = false;

  try {
    await conn.query(`USE \`${targetDb}\``);
    switchedDb = true;

    // ── 4b. Published check (Payslip Sync) ─────────────────
    // A month loaded from the payroll network shows only after Go live.
    // Months before the first synced publication stay visible.
    const pub = await syncPublications.isPeriodVisible(targetDb, period);
    if (!pub.visible) {
      return res.status(202).json({
        notReady: true,
        error:
          "Sorry, payslip for selected month and year is not ready yet. Please check again later.",
      });
    }

    // Steps 5–8 run on `conn`, the connection that ran USE <targetDb>.
    // pool.query may be routed to another database.

    // ── 5. Fetch BT05 (current processing period) ──────
    const [[bt05]] = await conn.query(
      `SELECT ord, mth FROM py_stdrate WHERE type = 'BT05' LIMIT 1`,
    );

    if (!bt05) {
      return res
        .status(500)
        .json({ error: "Could not determine current processing period." });
    }

    const currentYear = parseInt(bt05.ord);
    const currentMonth = parseInt(bt05.mth);
    const isCurrentPeriod =
      inputYear === currentYear && inputMonth === currentMonth;

    // ── 6. IPPIS check — always required for any period ──
    // If no IPPIS rows exist for this employee + period, payslip is not ready.
    // For current period this means upload hasn't happened yet.
    // For historical periods it means IPPIS was never uploaded for that month.
    const [[ippisCheck]] = await conn.query(
      `SELECT COUNT(*) AS cnt FROM py_ipis_payhistory
       WHERE numb = ? AND period = ?`,
      [userId, period],
    );

    if (!ippisCheck || Number(ippisCheck.cnt) === 0) {
      // For historical periods that had no IPPIS (e.g. NAVY-only months),
      // allow through — block only if it's the current processing period
      if (isCurrentPeriod) {
        return res.status(202).json({
          notReady: true,
          error:
            "Sorry, payslip for selected month and year is not ready yet. Please check again later.",
        });
      }
      // Historical with no IPPIS is fine — SP will just produce NAVY rows
    }

    // ── 7. Call stored procedure ───────────────────────
    // Output goes to py_webpayslip under this request's key; deleted in finally.
    wroteRows = true;
    await conn.query(`CALL py_generate_combined_payslip(?, ?, ?, ?, ?, ?)`, [
      userId,
      userId,
      period,
      payrollclass,
      sessionKey,
      "1",
    ]);

    // ── 8. Fetch generated rows ────────────────────────
    // ac_months exists only in the master DB, and `conn` is now on the
    // payroll class DB (raw connections are not auto-qualified), so name
    // the master DB explicitly.
    const [monthData] = await conn.query(
      `SELECT mthdesc FROM ${pool.qualify("ac_months")} WHERE cmonth = ? LIMIT 1`,
      [inputMonth],
    );

    if (!monthData || monthData.length === 0) {
      return res
        .status(500)
        .json({ error: "Could not resolve month description." });
    }

    const monthdesc = monthData[0].mthdesc;

    // ── Fetch generated rows ──────────────────────────────────
    const [rawRows] = await conn.query(
      `SELECT * FROM py_webpayslip
       WHERE work_station = ? AND ord = ? AND desc1 = ?
       ORDER BY source DESC, bpc, bp`,
      [sessionKey, String(inputYear), monthdesc],
    );

    if (!rawRows || rawRows.length === 0) {
      return res.status(404).json({
        error:
          "Sorry, no payslip information found for the selected year and month.",
      });
    }

    // ── 9. Map and return ──────────────────────────────
    const mapped = mapPayslipRows(rawRows);
    return res.json({ success: true, data: mapped });
  } catch (err) {
    console.error("❌ Payslip generate error:", err);
    return res
      .status(500)
      .json({ error: "An error occurred while generating your payslip." });
  } finally {
    // ── Clear py_webpayslip: nothing stays stored once the user has the data ──
    // (also rows left under the service number by the old code)
    if (wroteRows) {
      try {
        await conn.query(`DELETE FROM py_webpayslip WHERE work_station IN (?, ?)`, [sessionKey, String(userId)]);
      } catch (e) {
        console.warn("⚠️ py_webpayslip cleanup failed:", e.message);
      }
    }
    // ── Safe connection return — same pattern as adminPayslip ──
    if (switchedDb) {
      try {
        await conn.query(`USE \`${pool.getMasterDb()}\``);
        conn.release();
      } catch (_) {
        console.warn("⚠️ Failed to reset DB context — destroying connection.");
        conn.destroy();
      }
    } else {
      conn.release();
    }
  }
});

// ============================================================
// POST /payslip/pdf
// Body: { data: <mapped employee object>, stamp: true/false }
//
// Built to survive hundreds of staff printing at once on a small server:
//   - one shared Chromium for the whole app, at most PDF_MAX_CONCURRENT
//     pages rendering at a time (lib/pdfGate.js, default 2)
//   - a few requests may wait for a slot (PDF_MAX_WAITING, default 12, up to
//     PDF_MAX_WAIT_MS, default 20 s); beyond that the answer is
//     503 + Retry-After and the page retries by itself after that many seconds
//   - template, logo and stamp are kept in memory; jsreport (one new Chrome
//     per PDF) is not used for payslips
// ============================================================
router.post("/pdf", verifyToken, async (req, res) => {
  const { data, stamp } = req.body || {};

  if (!data || typeof data !== "object") {
    return res.status(400).json({ error: "No payslip data provided." });
  }

  try {
    const showStamp = !!stamp;
    const logoDataUrl = imageDataUrl("logo.png");
    const stampDataUrl = showStamp ? imageDataUrl("cpo-stamp.png") : "";

    // single employee array — the template iterates {{#each employees}}
    const html = payslipTemplate()(
      {
        payDate: new Date(),
        logoDataUrl,
        stampDataUrl,
        showStamp,
        employees: [{ ...data, stampDataUrl, showStamp }],
      },
      { helpers: PAYSLIP_HELPERS },
    );

    const pdf = await chromiumPdfGenerator.generateFromHTML(html, {
      format: "A5",
      landscape: false,
      margin: { top: "5mm", right: "5mm", bottom: "5mm", left: "5mm" },
      timeout: 30000,
      priority: "high", // staff payslips go before report batches
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=payslip.pdf");
    res.setHeader("Cache-Control", "no-store");
    return res.send(Buffer.from(pdf)); // puppeteer returns a Uint8Array
  } catch (err) {
    if (err && err.code === "PDF_BUSY") {
      res.setHeader("Retry-After", String(err.retryAfter));
      return res.status(503).json({ busy: true, retryAfter: err.retryAfter, error: err.message });
    }
    console.error("❌ Payslip PDF error:", err);
    return res.status(500).json({ error: "PDF generation failed." });
  }
});

// GET /payslip/pdf/status — how busy PDF generation is (for monitoring)
router.get("/pdf/status", verifyToken, (req, res) => {
  return res.json(require("../../../lib/pdfGate").stats());
});

module.exports = router;

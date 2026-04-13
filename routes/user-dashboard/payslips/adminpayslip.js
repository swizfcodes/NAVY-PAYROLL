// ============================================================
// ADMIN PAYSLIP CONTROLLER
// routes/admin/adminPayslip.js
//
// Supports three modes:
//   single  — one employee, one period
//   multi   — array of employee IDs, one period
//   range   — all employees between two service-number IDs, one period
//
// PDF delivery:
//   merged  — single PDF (all employees concatenated)
//   zip     — ZIP archive of individual PDFs
//
// Auth assumption: verifyToken populates req.user_role.
//   Swap `verifyAdmin` internals if your JWT uses a different field
//   or you need a DB lookup.
// ============================================================

const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const archiver = require("archiver"); // npm i archiver
const { PDFDocument } = require("pdf-lib"); // npm i pdf-lib
const pool = require("../../../config/db");
const verifyToken = require("../../../middware/authentication");
const BaseReportController = require("../../../controllers/Reports/reportsFallbackController");

// ── Re-use helpers from user payslip (copy or import) ────────
// If you extract these to a shared lib, replace with:
//   const { getPayrollClassDb, mapPayslipRows, buildPeriod, zeroPad }
//     = require("../../lib/payslipHelpers");

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

function zeroPad(n) {
  return String(n).padStart(2, "0");
}

function buildPeriod(year, month) {
  return `${year}${zeroPad(month)}`;
}

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

  emp.ippis.net =
    emp.ippis.taxable_total +
    emp.ippis.nontaxable_total -
    emp.ippis.deductions_total;
  emp.navy.net =
    emp.navy.taxable_total +
    emp.navy.nontaxable_total -
    emp.navy.deductions_total;
  emp.net_pay = emp.ippis.net + emp.navy.net;

  const isEmpty = (s) =>
    s.taxable.length === 0 &&
    s.nontaxable.length === 0 &&
    s.deductions.length === 0;
  if (isEmpty(emp.ippis)) emp.ippis = null;
  if (isEmpty(emp.navy)) emp.navy = null;

  return emp;
}

// ── Lazy PDF controller singleton ────────────────────────────
let _controller = null;
function getController() {
  if (!_controller) _controller = new BaseReportController();
  return _controller;
}

// ============================================================
// SHARED: resolve employee IDs for each mode
// ============================================================

/**
 * Returns an array of EMPL_IDs depending on mode:
 *   single  — [employeeId]
 *   multi   — employeeIds  (validated non-empty array)
 *   range   — all IDs between fromId and toId inclusive (lexicographic,
 *             matching how service numbers sort in hr_employees)
 */
async function resolveEmployeeIds(
  mode,
  { employeeId, employeeIds, fromId, toId },
) {
  switch (mode) {
    case "single": {
      if (!employeeId)
        throw {
          status: 400,
          message: "employeeId is required for single mode.",
        };
      return [String(employeeId)];
    }

    case "multi": {
      if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
        throw {
          status: 400,
          message: "employeeIds must be a non-empty array for multi mode.",
        };
      }
      if (employeeIds.length > 500) {
        throw {
          status: 400,
          message: "Maximum 500 employees per multi request.",
        };
      }
      return employeeIds.map(String);
    }

    case "range": {
      if (!fromId || !toId)
        throw {
          status: 400,
          message: "fromId and toId are required for range mode.",
        };

      // Pull all EMPL_IDs that fall between fromId and toId.
      // Adjust ORDER BY / WHERE if your IDs are numeric.
      const [rows] = await pool.query(
        `SELECT EMPL_ID
         FROM hr_employees
         WHERE EMPL_ID >= ? AND EMPL_ID <= ?
         ORDER BY EMPL_ID ASC`,
        [String(fromId), String(toId)],
      );

      if (!rows || rows.length === 0) {
        throw {
          status: 404,
          message: "No employees found in the specified range.",
        };
      }
      if (rows.length > 500) {
        throw {
          status: 400,
          message: "Range exceeds 500 employees. Please narrow the range.",
        };
      }

      return rows.map((r) => String(r.EMPL_ID));
    }

    default:
      throw {
        status: 400,
        message: "mode must be one of: single, multi, range.",
      };
  }
}

// ============================================================
// SHARED: generate payslip data for one employee
// Returns { empId, data } or { empId, skipped: true, reason }
// ============================================================
async function generateOnePayslip(
  empId,
  period,
  inputYear,
  inputMonth,
  monthdesc,
) {
  // Fetch payrollclass
  const [empRows] = await pool.query(
    `SELECT payrollclass FROM hr_employees WHERE EMPL_ID = ? LIMIT 1`,
    [empId],
  );
  if (!empRows || empRows.length === 0) {
    return { empId, skipped: true, reason: "Employee record not found." };
  }

  const payrollclass = String(empRows[0].payrollclass);
  const targetDb = await getPayrollClassDb(payrollclass);
  if (!targetDb) {
    return {
      empId,
      skipped: true,
      reason: `Unsupported payroll class: ${payrollclass}.`,
    };
  }

  // Switch DB context — all subsequent queries run against this employee's payroll DB
  const storeKey = pool._getSessionContext().getStore() || "default";
  pool.useDatabase(targetDb, storeKey);

  // ── BT05: read current processing period from this employee's own DB ──
  const [[bt05]] = await pool.query(
    `SELECT ord, mth FROM py_stdrate WHERE type = 'BT05' LIMIT 1`,
  );
  if (!bt05) {
    return {
      empId,
      skipped: true,
      reason: "Could not determine current processing period from payroll DB.",
    };
  }
  const isCurrentPeriod =
    inputYear === parseInt(bt05.ord) && inputMonth === parseInt(bt05.mth);

  // IPPIS readiness check
  const [[ippisCheck]] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM py_ipis_payhistory WHERE numb = ? AND period = ?`,
    [empId, period],
  );

  if (!ippisCheck || ippisCheck.cnt === 0) {
    if (isCurrentPeriod) {
      return {
        empId,
        skipped: true,
        reason: "Payslip not ready yet for the current period.",
      };
    }
    // Historical NAVY-only months — allow through
  }

  // Call SP
  await pool.query(`CALL py_generate_combined_payslip(?, ?, ?, ?, ?, ?)`, [
    empId,
    empId,
    period,
    payrollclass,
    empId,
    "1",
  ]);

  // Fetch rows
  const [rawRows] = await pool.query(
    `SELECT * FROM py_webpayslip
     WHERE work_station = ? AND ord = ? AND desc1 = ?
     ORDER BY source DESC, bpc, bp`,
    [empId, String(inputYear), monthdesc],
  );

  if (!rawRows || rawRows.length === 0) {
    return { empId, skipped: true, reason: "No payslip rows found." };
  }

  return { empId, data: mapPayslipRows(rawRows) };
}

// ============================================================
// POST /admin/payslip/generate
// Body:
//   { mode: "single",  employeeId: "N12345",               year: "2025", month: "3" }
//   { mode: "multi",   employeeIds: ["N12345","N12346"],    year: "2025", month: "3" }
//   { mode: "range",   fromId: "N12300", toId: "N12399",   year: "2025", month: "3" }
//
// Returns:
//   { success, results: [ { empId, data } | { empId, skipped, reason } ] }
// ============================================================
router.post("/generate", verifyToken, async (req, res) => {
  const { mode, employeeId, employeeIds, fromId, toId, year, month } = req.body;

  // ── Input validation ──────────────────────────────────────
  const inputYear = parseInt(year);
  const inputMonth = parseInt(month);

  if (!inputYear || !inputMonth || inputMonth < 1 || inputMonth > 12) {
    return res.status(400).json({ error: "Invalid year or month." });
  }

  const now = new Date();
  if (
    inputYear > now.getFullYear() ||
    (inputYear === now.getFullYear() && inputMonth > now.getMonth() + 1)
  ) {
    return res
      .status(400)
      .json({ error: "Cannot generate payslip for a future period." });
  }

  const period = buildPeriod(inputYear, inputMonth);

  try {
    // ── Resolve employee list ─────────────────────────────
    let empIds;
    try {
      empIds = await resolveEmployeeIds(mode, {
        employeeId,
        employeeIds,
        fromId,
        toId,
      });
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }

    // ── Month description ─────────────────────────────────
    const [monthData] = await pool.query(
      `SELECT mthdesc FROM ac_months WHERE cmonth = ? LIMIT 1`,
      [inputMonth],
    );
    if (!monthData || monthData.length === 0) {
      return res
        .status(500)
        .json({ error: "Could not resolve month description." });
    }
    const monthdesc = monthData[0].mthdesc;

    // ── Process all employees (sequential to respect DB context switching) ──
    const results = [];
    for (const empId of empIds) {
      const result = await generateOnePayslip(
        empId,
        period,
        inputYear,
        inputMonth,
        monthdesc,
      );
      results.push(result);
    }

    const successful = results.filter((r) => !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;

    return res.json({
      success: true,
      summary: { total: empIds.length, successful, skipped },
      results,
    });
  } catch (err) {
    console.error("❌ Admin payslip generate error:", err);
    return res
      .status(500)
      .json({ error: "An error occurred while generating payslips." });
  }
});

// ============================================================
// POST /admin/payslip/pdf
// Body:
//   {
//     results:  [ { empId, data }, ... ],   ← from /generate response
//     delivery: "merged" | "zip",           ← default: "merged"
//     stamp:    true | false
//   }
//
// Returns:
//   merged → application/pdf
//   zip    → application/zip
// ============================================================
router.post("/pdf", verifyToken, async (req, res) => {
  const { results, delivery = "merged", stamp = false } = req.body;

  if (!Array.isArray(results) || results.length === 0) {
    return res.status(400).json({ error: "No results provided." });
  }

  const validEntries = results.filter((r) => r.data);
  if (validEntries.length === 0) {
    return res.status(400).json({ error: "No valid payslip data to render." });
  }

  const templatePath = path.join(
    __dirname,
    "../../../templates/user-payslip.html",
  );
  const logoPath = path.join(__dirname, "../../../public/photos/logo.png");

  let logoDataUrl = "";
  if (fs.existsSync(logoPath)) {
    const buf = fs.readFileSync(logoPath);
    logoDataUrl = `data:image/png;base64,${buf.toString("base64")}`;
  }

  const controller  = getController();
  const BATCH_SIZE  = 50; // employees per Chromium render — tune up/down based on memory

  const pdfOptions = {
    format:    "A5",
    landscape: false,
    timeout:   120000,
    helpers: `
      function formatCurrency(value) {
        if (!value && value !== 0) return '0.00';
        return parseFloat(value).toFixed(2).replace(/\\d(?=(\\d{3})+\\.)/g, '$&,');
      }
      function formatDate(date) {
        const d = new Date(date);
        const months = ['January','February','March','April','May','June',
                        'July','August','September','October','November','December'];
        return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
      }
      function ifCond(a, b, options) {
        return a === b ? options.fn(this) : options.inverse(this);
      }
    `,
  };

  const sharedGlobals = { payDate: new Date(), logoDataUrl, showStamp: !!stamp };

  // ── Shared filename helpers ───────────────────────────────────
  const firstEmp    = validEntries[0]?.data || {};
  const periodMonth = firstEmp.payroll_month || "";
  const periodYear  = String(firstEmp.payroll_year || "");

  function zipFileName(entry) {
    const d       = entry.data || {};
    const surname = (d.surname   || "").trim().toUpperCase();
    const other   = (d.othername || "").trim().toUpperCase();
    const month   = d.payroll_month || periodMonth;
    const year    = String(d.payroll_year || periodYear);
    return [surname, other, month, year, "Payslip"].filter(Boolean).join(" ") + ".pdf";
  }

  try {
    // ════════════════════════════════════════════════════════════
    // MERGED PDF
    // One generateBatchedPDF call with ALL employees.
    // BATCH_SIZE controls how many employees Chromium renders per
    // page-load — the controller splits and merges automatically.
    // ════════════════════════════════════════════════════════════
    if (delivery === "merged") {
      console.log(`📄 Generating merged PDF for ${validEntries.length} employees`);

      const allData = validEntries.map((e) => e.data);

      // Single call — controller batches internally, one browser launch total
      const mergedBuffer = await controller.generateBatchedPDF(
        templatePath,
        allData,
        BATCH_SIZE,   // ← passed as third arg, not buried in pdfOptions
        pdfOptions,
        sharedGlobals,
      );

      const mergedName = `Payslips ${periodMonth} ${periodYear}.pdf`.trim();
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${mergedName}"`);
      return res.send(mergedBuffer);
    }

    // ════════════════════════════════════════════════════════════
    // ZIP — individual PDFs per employee
    // Still uses BATCH_SIZE: renders N employees per Chromium call,
    // then pdf-lib splits pages back into per-employee buffers.
    // Far fewer browser launches than the old 1-per-employee loop.
    // ════════════════════════════════════════════════════════════
    if (delivery === "zip") {
      // Archive name: "Payslips April 2025.zip"
      const firstEmpZ = validEntries[0]?.data || {};
      const zipMonth = firstEmpZ.payroll_month || String(inputMonth);
      const zipYear = firstEmpZ.payroll_year || String(inputYear);
      const zipName = `Payslips ${zipMonth} ${zipYear}.zip`;

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

      const archive = archiver("zip", { zlib: { level: 6 } });
      archive.on("error", (err) => {
        throw err;
      });
      archive.pipe(res);

      for (const entry of validEntries) {
        const buf = await controller.generateBatchedPDF(
          templatePath,
          [entry.data],
          1,
          pdfOptions,
          sharedGlobals,
        );
        // Per-file: "SURNAME OTHERNAME MONTH YEAR Payslip.pdf"
        const d = entry.data || {};
        const surname = (d.surname || "").trim().toUpperCase();
        const other = (d.othername || "").trim().toUpperCase();
        const month = d.payroll_month || String(inputMonth);
        const year = d.payroll_year || String(inputYear);
        const parts = [surname, other, month, year, "Payslip"].filter(Boolean);
        archive.append(buf, { name: parts.join(" ") + ".pdf" });
      }

      await archive.finalize();
      return; // response is streamed by archiver
    }

    return res.status(400).json({ error: "delivery must be 'merged' or 'zip'." });

  } catch (err) {
    console.error("❌ Admin payslip PDF error:", err);
    return res.status(500).json({ error: "PDF generation failed." });
  }
});

// ── GET /admin/employees/search ─────────────────────────────
// Query params:
//   q   — search string (min 2 chars)
//   max — max results (default 10, cap 30)
// ────────────────────────────────────────────────────────────
function looksLikeId(q) {
  return /^[A-Z]{1,3}\d+$/i.test(q) || /^\d+$/.test(q) || /^[A-Z]{2}\/\d{4}$/i.test(q);
}
 
router.get('/search', verifyToken, async (req, res) => {
  const { q, max } = req.query;
 
  if (!q || String(q).trim().length < 2) {
    return res.status(400).json({ error: 'Search query must be at least 2 characters.' });
  }
 
  const term  = String(q).trim();
  const limit = Math.min(parseInt(max) || 15, 30);
 
  // Active-employee predicate — shared by both branches
  const activePredicate = `((DateLeft IS NULL OR DateLeft = '' OR DateLeft > DATE_FORMAT(CURDATE(), '%Y%m%d')) AND (exittype IS NULL OR exittype = ''))`;
 
  try {
    let rows;
 
    if (looksLikeId(term)) {
      // ── Fast path: exact or prefix match on EMPL_ID ──────
      // EMPL_ID is typically the primary key, so this is O(log n).
      const [r] = await pool.query(
        `SELECT EMPL_ID AS id, Title AS title, Surname AS surname, OtherName AS othername
         FROM hr_employees
         WHERE ${activePredicate}
           AND EMPL_ID LIKE ?
         ORDER BY EMPL_ID ASC
         LIMIT ?`,
        [term + '%', limit]
      );
      rows = r;
    } else {
      // ── Name path: starts-with on Surname UNION OtherName ─
      // Both LIKE 'term%' patterns benefit from an index on the
      // respective column (add one if missing: INDEX(Surname), INDEX(OtherName)).
      // UNION removes duplicates automatically.
      const startsWith = term + '%';
      const [r] = await pool.query(
        `(
          SELECT EMPL_ID AS id, Title AS title, Surname AS surname, OtherName AS othername
          FROM hr_employees
          WHERE ${activePredicate}
            AND Surname LIKE ?
          ORDER BY Surname ASC
          LIMIT ?
        )
        UNION
        (
          SELECT EMPL_ID AS id, Title AS title, Surname AS surname, OtherName AS othername
          FROM hr_employees
          WHERE ${activePredicate}
            AND OtherName LIKE ?
          ORDER BY OtherName ASC
          LIMIT ?
        )
        LIMIT ?`,
        [startsWith, limit, startsWith, limit, limit]
      );
      rows = r;
    }
 
    const results = (rows || []).map(row => ({
      id:        String(row.id        || ''),
      title:     String(row.title     || ''),
      surname:   String(row.surname   || ''),
      othername: String(row.othername || ''),
    }));
 
    return res.json(results);
 
  } catch (err) {
    console.error('❌ Employee search error:', err);
    return res.status(500).json({ error: 'An error occurred during employee search.' });
  }
});

module.exports = router;
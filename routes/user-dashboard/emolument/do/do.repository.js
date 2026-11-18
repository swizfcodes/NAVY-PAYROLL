/**
 * FILE: routes/user-dashboard/emolument/do/do.repository.js
 *
 * All SQL for the Duty Officer (DO) review workflow.
 *
 * DO actions:
 *   - List SUBMITTED forms on their ship
 *   - View full form for a specific submission
 *   - Mark a form DO_REVIEWED (sets legacy 'FO' on ef_personalinfos)
 *   - Reject a form (resets to NULL)
 *
 * DO scope: always SHIP — they only see their assigned ship(s).
 * DO action: individual only — no bulk.
 *
 * TRANSACTION SAFETY:
 *   markDoReviewed and rejectForm each write to two tables.
 *   Both are wrapped in explicit transactions so a failure on the
 *   second write always rolls back the first — no split-brain state.
 */

"use strict";

const pool = require("../../../../config/db");
const config = require("../../../../config");
const documentsRepo = require("../documents/documents.repository");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// ─────────────────────────────────────────────────────────────
// TRANSACTION HELPER
// Acquires a dedicated connection from the pool, runs fn(conn),
// commits on success, rolls back + rethrows on any error.
// All two-table writes in this file use this helper.
// ─────────────────────────────────────────────────────────────

async function withTransaction(fn) {
  pool.useDatabase(DB());
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ─────────────────────────────────────────────────────────────
// LIST — SUBMITTED forms on a ship
// Returns summary rows only — not full form data
// ─────────────────────────────────────────────────────────────

async function getSubmittedForms(ship, limit, offset, search) {
  pool.useDatabase(DB());

  let searchClause = "";
  const searchParams = [];
  if (search && search.trim()) {
    searchClause = ` AND (p.Surname LIKE ? OR p.OtherName LIKE ? OR p.serviceNumber LIKE ?)`;
    const like = `%${search.trim()}%`;
    searchParams.push(like, like, like);
  }

  const submittedQuery = `SELECT
       p.serviceNumber, p.Surname, p.OtherName, p.Rank,
       p.payrollclass, p.classes, p.formNumber, p.FormYear,
       p.Status, p.datecreated,
       ef.id         AS form_id,
       ef.status     AS form_status,
       ef.submitted_at
     FROM ef_personalinfos p
     LEFT JOIN ef_emolument_forms ef
            ON ef.service_no = p.serviceNumber
           AND ef.ship       = p.ship
     WHERE p.ship   = ?
       AND p.Status IN ('Filled', 'SUBMITTED')
       AND (p.emolumentform IS NULL OR p.emolumentform != 'Yes')
       ${searchClause}
     ORDER BY p.Surname ASC, p.OtherName ASC
     LIMIT ? OFFSET ?`;

  const countQuery = `
      SELECT COUNT(*) AS total
      FROM ef_personalinfos p
      WHERE p.ship   = ?
       AND p.Status IN ('Filled', 'SUBMITTED')
       AND (p.emolumentform IS NULL OR p.emolumentform != 'Yes')
       ${searchClause};
    `;

  const [[rows], [countResults]] = await Promise.all([
    pool.query(submittedQuery, [ship, ...searchParams, limit, offset]),
    pool.query(countQuery, [ship, ...searchParams]),
  ]);
  return { forms: rows, total: countResults[0].total };
}

// ─────────────────────────────────────────────────────────────
// LIST — REVIEWED forms on a ship
// Returns summary rows only — not full form data
// ─────────────────────────────────────────────────────────────

async function getReviewedForms(ship, svc, limit, offset, search) {
  pool.useDatabase(DB());

  let searchClause = "";
  const searchParams = [];
  if (search && search.trim()) {
    searchClause = ` AND (p.Surname LIKE ? OR p.OtherName LIKE ? OR p.serviceNumber LIKE ?)`;
    const like = `%${search.trim()}%`;
    searchParams.push(like, like, like);
  }

  const reviewedQuery = `SELECT
       p.serviceNumber, p.Surname, p.OtherName, p.Rank,
       p.payrollclass, p.classes, p.formNumber, p.FormYear, p.div_off_date,
       p.Status, p.datecreated,
       ef.id         AS form_id,
       ef.status     AS form_status,
       ef.submitted_at
     FROM ef_personalinfos p
     LEFT JOIN ef_emolument_forms ef
            ON ef.service_no = p.serviceNumber
           AND ef.ship       = p.ship
     WHERE p.ship   = ?
       AND p.Status NOT IN ('Filled','SUBMITTED', 'REJECTED')
       AND p.div_off_svcno = ?
       ${searchClause}
     ORDER BY p.Surname ASC, p.OtherName ASC
     LIMIT ? OFFSET ?`;

  const countQuery = `
      SELECT COUNT(*) AS total
      FROM ef_personalinfos p
      WHERE p.ship   = ?
       AND p.Status NOT IN ('Filled','SUBMITTED', 'REJECTED')
       AND p.div_off_svcno = ?
       ${searchClause};
    `;

  const [[rows], [countResults]] = await Promise.all([
    pool.query(reviewedQuery, [ship, svc, ...searchParams, limit, offset]),
    pool.query(countQuery, [ship, svc, ...searchParams]),
  ]);
  return { forms: rows, total: countResults[0].total };
}

// ─────────────────────────────────────────────────────────────
// GET FORM DETAIL — full form for one personnel
// ─────────────────────────────────────────────────────────────

async function getFormDetail(formId) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT
       p.serviceNumber, p.Surname, p.OtherName, p.Title, p.Rank,
       p.Sex, p.MaritalStatus, p.Birthdate, p.religion,
       p.gsm_number, p.gsm_number2, p.email, p.home_address,
       p.BankACNumber, p.Bankcode, p.bankbranch, p.AccountName,
       p.pfacode, p.payrollclass, p.classes,
       p.specialisation, p.command, p.branch, p.ship,
       p.DateEmpl, p.seniorityDate, p.yearOfPromotion,
       p.expirationOfEngagementDate, p.runoutDate, p.advanceDate,
       p.StateofOrigin, p.LocalGovt, p.TaxCode,
       p.entry_mode, p.gradelevel, p.gradetype, p.taxed,
       p.entitlement, p.accomm_type,
       p.AcommodationStatus, p.AddressofAcommodation,
       p.GBC, p.GBC_Number, p.NSITFcode, p.NHFcode,
       p.qualification, p.division, p.NIN,
       p.formNumber, p.FormYear, p.Status,
       p.div_off_name, p.div_off_rank, p.div_off_svcno, p.div_off_date,
       cmd.commandName,
       br.branchName,
       lga.lgaName,
       st.Name   AS stateName,
       ef.id     AS form_id,
       ef.status AS form_status,
       ef.submitted_at
     FROM ef_emolument_forms ef
     JOIN ef_personalinfos p
            ON p.serviceNumber = ef.service_no
     LEFT JOIN ef_commands   cmd ON cmd.code   = p.command
     LEFT JOIN ef_branches   br  ON br.code    = p.branch
     LEFT JOIN ef_localgovts lga ON lga.Id     = p.LocalGovt
     LEFT JOIN ef_states     st  ON st.StateId = p.StateofOrigin
     WHERE ef.id = ?
       AND ef.status = 'SUBMITTED'
     LIMIT 1`,
    [formId],
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────
// CHILD DATA FETCHERS
// Run these in parallel via Promise.all() in the service layer.
// ─────────────────────────────────────────────────────────────

async function getNok(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT nok_order, full_name, relationship, phone1, phone2,
            email, address, national_id
     FROM ef_nok WHERE service_no = ? ORDER BY nok_order ASC`,
    [serviceNo],
  );
  return {
    primary: rows.find((r) => r.nok_order === 1) || null,
    alternate: rows.find((r) => r.nok_order === 2) || null,
  };
}

async function getSpouse(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT full_name, phone1, phone2, email
     FROM ef_spouse WHERE service_no = ? LIMIT 1`,
    [serviceNo],
  );
  return rows[0] || null;
}

async function getChildren(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT birth_order, child_name
     FROM ef_children WHERE service_no = ? ORDER BY birth_order ASC`,
    [serviceNo],
  );
  return rows;
}

async function getLoans(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT loan_type, amount, year_taken, tenor, balance, specify
     FROM ef_loans WHERE service_no = ?`,
    [serviceNo],
  );
  const out = {};
  rows.forEach((r) => {
    out[r.loan_type] = r;
  });
  return out;
}

async function getAllowances(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT allow_type, is_active, specify
     FROM ef_allowances WHERE service_no = ?`,
    [serviceNo],
  );
  const out = {};
  rows.forEach((r) => {
    out[r.allow_type] = r;
  });
  return out;
}

// Photos keyed by doc_type — shared with the documents module, which knows
// where they are stored.
async function getDocuments(serviceNo) {
  return documentsRepo.getDocumentMap(serviceNo);
}

// ─────────────────────────────────────────────────────────────
// REVIEW — mark form DO_REVIEWED
//
// TRANSACTION: writes ef_personalinfos first, then ef_emolument_forms.
// If the second write fails the first is rolled back — the form stays
// in SUBMITTED state and the DO can retry safely.
// ─────────────────────────────────────────────────────────────

async function markDoReviewed(
  serviceNo,
  formId,
  doName,
  doRank,
  doSvcNo,
  legacyStatus,
) {
  return withTransaction(async (conn) => {
    // 1. Update ef_personalinfos with DO details + legacy status string
    const [r1] = await conn.query(
      `UPDATE ef_personalinfos
       SET Status        = ?,
           div_off_name  = ?,
           div_off_rank  = ?,
           div_off_svcno = ?,
           div_off_date  = NOW(),
           dateModify    = NOW()
       WHERE serviceNumber = ?
         AND Status = 'Filled'`,
      [legacyStatus, doName, doRank, doSvcNo, serviceNo],
    );

    if (r1.affectedRows === 0) {
      // Form is no longer in Filled state — abort cleanly (no rows changed,
      // rollback is a no-op but we still call it via the helper).
      throw Object.assign(new Error("Form is not in SUBMITTED state"), {
        code: "STALE_STATUS",
      });
    }

    // 2. Update ef_emolument_forms with clean enum status
    const [efRes] = await conn.query(
      `UPDATE ef_emolument_forms
       SET status     = 'DO_REVIEWED',
           updated_at = NOW()
       WHERE id = ? AND status = 'SUBMITTED'`,
      [formId],
    );

    if (efRes.affectedRows === 0) {
      throw Object.assign(
        new Error("ef_emolument_forms row not in expected status"),
        { code: "STALE_STATUS" },
      );
    }

    return true;
  });
}

// ─────────────────────────────────────────────────────────────
// REJECT — reset form to NULL (personnel must re-fill)
//
// TRANSACTION: same two-table pattern as markDoReviewed.
// ─────────────────────────────────────────────────────────────

async function rejectForm(serviceNo, formId, ship) {
  return withTransaction(async (conn) => {
    // 1. Reset ef_personalinfos
    const [r1] = await conn.query(
      `UPDATE ef_personalinfos
       SET Status     = NULL,
           dateModify = NOW()
       WHERE serviceNumber = ?
         AND ship          = ?
         AND Status        = 'Filled'`,
      [serviceNo, ship],
    );

    if (r1.affectedRows === 0) {
      throw Object.assign(
        new Error("Form is not in SUBMITTED state or wrong ship"),
        { code: "STALE_STATUS" },
      );
    }

    // 2. Reset ef_emolument_forms
    const [efRes] = await conn.query(
      `UPDATE ef_emolument_forms
       SET status     = 'REJECTED',
           updated_at = NOW()
       WHERE id = ? AND status = 'SUBMITTED'`,
      [formId],
    );

    if (efRes.affectedRows === 0) {
      throw Object.assign(
        new Error("ef_emolument_forms row not in expected status"),
        { code: "STALE_STATUS" },
      );
    }

    return true;
  });
}

// ─────────────────────────────────────────────────────────────
// APPROVAL TRAIL + AUDIT
// ─────────────────────────────────────────────────────────────

async function insertFormApproval({
  formId,
  action,
  fromStatus,
  toStatus,
  performedBy,
  performerRole,
  remarks,
}) {
  pool.useDatabase(DB());
  await pool.query(
    `INSERT INTO ef_form_approvals
       (form_id, action, from_status, to_status, performed_by, performer_role, remarks, performed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      formId,
      action,
      fromStatus || null,
      toStatus,
      performedBy,
      performerRole || null,
      remarks || null,
    ],
  );
}

// When forms are rejected, we remove form approval trail records for that form. This is because the form is no longer approved, and we want to maintain an accurate record of approvals.
// Deletes all approval records for the given formId. This is called after a form is rejected to maintain data integrity and ensure that the approval trail reflects the current state of the form.
async function deleteFormApproval(formId) {
  pool.useDatabase(DB());
  await pool.query(
    `DELETE FROM ef_form_approvals
     WHERE form_id = ?`,
    [formId],
  );
}

async function insertFormRejection({formId, rejected_by, remarks, svc_no}) {
  pool.useDatabase(DB());
  await pool.query(
    `INSERT INTO ef_form_rejections
       (form_id, service_number, rejected_by, remarks)
     VALUES (?, ?, ?, ?)`,
    [
      formId,
      svc_no,
      rejected_by,
      remarks || null,
    ],
  );
}

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

// ─────────────────────────────────────────────────────────────
// STATUS STATS
// ─────────────────────────────────────────────────────────────

async function getStatusStats(ship, svc) {
  pool.useDatabase(DB());

  const [stats] = await pool.query(
    `SELECT
        (SELECT COUNT(*)
           FROM ef_personalinfos
          WHERE ship = ?
            AND status IN ('Filled', 'SUBMITTED')
        ) AS pending,

        (SELECT COUNT(*)
           FROM ef_form_approvals
          WHERE action = 'DO_REVIEWED'
            AND performed_by = ?
        ) AS reviewed,

        (SELECT COUNT(*)
           FROM ef_form_rejections
          WHERE rejected_by = ?
        ) AS rejected
    `,
    [ship, svc, svc],
  );
  return stats[0];
}

module.exports = {
  getSubmittedForms,
  getFormDetail,
  getNok,
  getSpouse,
  getChildren,
  getLoans,
  getAllowances,
  getDocuments,
  markDoReviewed,
  rejectForm,
  insertFormApproval,
  deleteFormApproval,
  insertFormRejection,
  insertAuditLog,
  getReviewedForms,
  getStatusStats,
};

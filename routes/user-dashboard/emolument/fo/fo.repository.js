/**
 * FILE: routes/user-dashboard/emolument/fo/fo.repository.js
 *
 * All SQL for the First Officer (FO) approval workflow.
 *
 * FO actions (from old SPs):
 *   - List DO_REVIEWED forms on their ship
 *   - View full form detail
 *   - Approve individual form  → UpdatePersonByIdByShipFO
 *   - Bulk approve by ship+class → UpdatePersonByShipFO
 *   - Reject form → reset to NULL
 *
 * CRITICAL — bulk approve uses Status = 'Filled' filter (not 'FO').
 * This matches the exact old SP behaviour (UpdatePersonByShipFO):
 *   WHERE status='Filled' AND ship=@ship AND classes=@classes
 *
 * TRANSACTION SAFETY:
 *   approveSingle, approveBulk, and rejectForm each write to two tables.
 *   All are wrapped in explicit transactions. approveBulk additionally
 *   bulk-inserts audit rows in one statement (not N individual inserts).
 */

"use strict";

const pool = require("../../../../config/db");
const config = require("../../../../config");
const documentsRepo = require("../documents/documents.repository");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// ─────────────────────────────────────────────────────────────
// TRANSACTION HELPER
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
// APPROVAL TRAIL — inside the caller's transaction
//
// Written on the same connection as the status change, from the same
// form rows, so a status never changes without its approval record
// (and a failed approval leaves no record either).
//   forms: [{ id, status }]   status = the form's status before the change
// ─────────────────────────────────────────────────────────────

async function insertApprovalsTx(conn, forms, { action, toStatus, performedBy, performerRole, remarks }) {
  if (!forms.length) return;
  const rows = forms.map(() => "(?, ?, ?, ?, ?, ?, ?, NOW())").join(", ");
  const params = [];
  for (const f of forms) {
    params.push(f.id, action, f.status || null, toStatus, performedBy, performerRole || null, remarks || null);
  }
  await conn.query(
    `INSERT INTO ef_form_approvals
       (form_id, action, from_status, to_status, performed_by, performer_role, remarks, performed_at)
     VALUES ${rows}`,
    params,
  );
}

const FO_TRAIL = { action: "FO_APPROVED", toStatus: "FO_APPROVED", performerRole: "FO" };

// ─────────────────────────────────────────────────────────────
// LIST — DO_REVIEWED forms on a ship
// ─────────────────────────────────────────────────────────────

async function getDoReviewedForms(ship, limit, offset, search) {
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
       p.payrollclass, p.classes, p.formNumber, p.FormYear,
       p.Status, p.datecreated,
       p.div_off_name, p.div_off_rank, p.div_off_svcno, p.div_off_date, p.dateModify as date_modified,
       ef.id          AS form_id,
       ef.status      AS form_status,
       ef.submitted_at
     FROM ef_personalinfos p
     LEFT JOIN ef_emolument_forms ef
            ON ef.service_no = p.serviceNumber
           AND ef.ship       = p.ship
     WHERE p.ship   = ?
       AND p.Status IN ('FO', 'DO_REVIEWED', 'Filled', 'SUBMITTED')
       AND (p.emolumentform IS NULL OR p.emolumentform != 'Yes')
       ${searchClause}
     ORDER BY p.Surname ASC, p.OtherName ASC
     LIMIT ? OFFSET ? ;
     `;

  const countQuery = `
      SELECT COUNT(*) AS total
      FROM ef_personalinfos p
      WHERE p.ship   = ?
       AND p.Status IN ('FO', 'DO_REVIEWED', 'Filled', 'SUBMITTED')
       AND (p.emolumentform IS NULL OR p.emolumentform != 'Yes')
       ${searchClause};
    `;

  const [[rows], [countResults]] = await Promise.all([
    pool.query(reviewedQuery, [ship, ...searchParams, limit, offset]),
    pool.query(countQuery, [ship, ...searchParams]),
  ]);
  return { forms: rows, total: countResults[0].total };
}

// ─────────────────────────────────────────────────────────────
// LIST — APPROVED forms on a ship
// Returns summary rows only — not full form data
// ─────────────────────────────────────────────────────────────

// getApprovedForms — same search treatment
async function getApprovedForms(ship, svc, limit, offset, search) {
  pool.useDatabase(DB());

  let searchClause = "";
  const searchParams = [];
  if (search && search.trim()) {
    searchClause = ` AND (p.Surname LIKE ? OR p.OtherName LIKE ? OR p.serviceNumber LIKE ?)`;
    const like = `%${search.trim()}%`;
    searchParams.push(like, like, like);
  }

  const approvedQuery = `SELECT
       p.serviceNumber, p.Surname, p.OtherName, p.Rank,
       p.payrollclass, p.classes, p.formNumber, p.FormYear,
       p.div_off_name, p.div_off_rank, p.div_off_svcno, p.div_off_date, p.dateModify as date_modified,
       p.fo_date,
       p.Status, p.datecreated,
       ef.id         AS form_id,
       ef.status     AS form_status,
       ef.submitted_at
      FROM ef_personalinfos p
      LEFT JOIN ef_emolument_forms ef
       ON ef.service_no = p.serviceNumber
      AND ef.ship       = p.ship
      LEFT JOIN ef_form_approvals fa
       ON fa.form_id = ef.id
      WHERE p.ship   = ?
       AND fa.action = 'FO_APPROVED'
       AND p.fo_svcno = ?
       ${searchClause}
     ORDER BY p.Surname ASC, p.OtherName ASC
     LIMIT ? OFFSET ?`;

  const countQuery = `
      SELECT COUNT(*) AS total
      FROM ef_personalinfos p
      LEFT JOIN ef_form_approvals fa
        ON p.fo_svcno = fa.performed_by  
      WHERE p.ship   = ?
       AND fa.action = 'FO_APPROVED'
       AND p.fo_svcno = ?
       ${searchClause};
    `;

  const [[rows], [countResults]] = await Promise.all([
    pool.query(approvedQuery, [ship, svc, ...searchParams, limit, offset]),
    pool.query(countQuery, [ship, svc, ...searchParams]),
  ]);
  return { forms: rows, total: countResults[0].total };
}

// ─────────────────────────────────────────────────────────────
// GET FORM DETAIL — gates on ef_emolument_forms.status = 'DO_REVIEWED'
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
       p.div_off_name, p.div_off_rank, p.div_off_svcno, p.div_off_date, p.dateModify as date_modified,
       p.fo_name, p.fo_rank, p.fo_svcno, p.fo_date,
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
     WHERE ef.id     = ?
       AND ef.status IN ('SUBMITTED','DO_REVIEWED')
     LIMIT 1`,
    [formId],
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────
// CHILD DATA FETCHERS — run in parallel via Promise.all()
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
// INDIVIDUAL APPROVE — UpdatePersonByIdByShipFO equivalent
//
// TRANSACTION: ef_personalinfos update gates on Status='FO'.
// If that row isn't found (stale — already approved or rejected
// by another session), we throw STALE_STATUS and the whole
// transaction rolls back cleanly. The caller gets a clear error
// to surface to the FO ("This form has already been actioned").
// ─────────────────────────────────────────────────────────────

async function approveSingle(
  serviceNo,
  formId,
  ship,
  foName,
  foRank,
  foSvcNo,
  legacyStatus,
  remarks = null,
) {
  return withTransaction(async (conn) => {
    // 0. Lock the form and read its current status (for the approval trail)
    const [[form]] = await conn.query(
      `SELECT id, status FROM ef_emolument_forms
       WHERE id = ? AND status IN ('SUBMITTED','DO_REVIEWED')
       FOR UPDATE`,
      [formId],
    );
    if (!form) {
      throw Object.assign(new Error("ef_emolument_forms row not in expected status"), {
        code: "STALE_STATUS",
      });
    }

    // 1. Update ef_personalinfos — gate on Status='FO' AND ship match
    const [r1] = await conn.query(
      `UPDATE ef_personalinfos
       SET Status     = ?,
           fo_name    = ?,
           fo_rank    = ?,
           fo_svcno   = ?,
           fo_date    = NOW(),
           dateModify = NOW()
       WHERE serviceNumber = ?
         AND ship          = ?
         AND Status        IN ('SUBMITTED','FO', 'Filled','DO_REVIEWED')`,
      [legacyStatus, foName, foRank, foSvcNo, serviceNo, ship],
    );

    if (r1.affectedRows === 0) {
      throw Object.assign(new Error("Form is not in DO_REVIEWED state"), {
        code: "STALE_STATUS",
      });
    }

    // 2. Update ef_emolument_forms — gate on DO_REVIEWED
    const [efRes] = await conn.query(
      `UPDATE ef_emolument_forms
       SET status     = 'FO_APPROVED',
           updated_at = NOW()
       WHERE id     = ?
         AND status  IN ('SUBMITTED','DO_REVIEWED')`,
      [formId],
    );

    if (efRes.affectedRows === 0) {
      throw Object.assign(
        new Error("ef_emolument_forms row not in expected status"),
        { code: "STALE_STATUS" },
      );
    }

    // 3. Approval trail, same transaction
    await insertApprovalsTx(conn, [form], { ...FO_TRAIL, performedBy: foSvcNo, remarks });

    return true;
  });
}

// ─────────────────────────────────────────────────────────────
// BULK APPROVE — UpdatePersonByShipFO equivalent
//
// CRITICAL: filters WHERE Status = 'Filled' AND serviceNumber IN @selected
// This matches the EXACT old SP behaviour — do not change to 'FO'.
//
// TRANSACTION: both table updates are inside one transaction.
// The pre-fetch of affected service numbers is done INSIDE the
// transaction so the set cannot change between fetch and update
// (another session approving the same records concurrently).
//
// Returns list of affected serviceNumbers for audit logging.
// ─────────────────────────────────────────────────────────────

async function approveBulk(
  ship,
  selected,
  foName,
  foRank,
  foSvcNo,
  legacyStatus,
  remarks = null,
) {
  const ids = [...new Set((selected || []).map(Number))];
  if (ids.length === 0 || ids.some(Number.isNaN)) {
    return { count: 0, serviceNumbers: [], skipped: [] };
  }

  return withTransaction(async (conn) => {
    const idPlaceholders = ids.map(() => "?").join(",");
    const norm = (v) => String(v ?? "").trim();

    // 1. Lock approvable forms
    const [forms] = await conn.query(
      `SELECT id, service_no, status FROM ef_emolument_forms
       WHERE ship = ?
         AND id IN (${idPlaceholders})
         AND status IN ('DO_REVIEWED', 'SUBMITTED')
       FOR UPDATE`,
      [ship, ...ids],
    );

    if (forms.length === 0)
      return { count: 0, serviceNumbers: [], skipped: [] };

    // 2. Lock the personnel rows that are actually eligible for update
    const formSvcNos = [...new Set(forms.map((f) => norm(f.service_no)))];
    const formSvcPlaceholders = formSvcNos.map(() => "?").join(",");

    const [eligible] = await conn.query(
      `SELECT serviceNumber FROM ef_personalinfos
       WHERE ship = ?
         AND serviceNumber IN (${formSvcPlaceholders})
         AND Status IN ('SUBMITTED','FO','Filled','DO_REVIEWED')
         AND (emolumentform IS NULL OR emolumentform != 'Yes')
       FOR UPDATE`,
      [ship, ...formSvcNos],
    );

    const eligibleSet = new Set(eligible.map((r) => norm(r.serviceNumber)));

    // 3. Split forms into approvable vs skipped
    const approvable = forms.filter((f) => eligibleSet.has(norm(f.service_no)));
    const skipped = forms
      .filter((f) => !eligibleSet.has(norm(f.service_no)))
      .map((f) => ({ id: f.id, serviceNumber: f.service_no }));

    if (approvable.length === 0)
      return { count: 0, serviceNumbers: [], skipped };

    const formIds = approvable.map((f) => f.id);
    const formPlaceholders = formIds.map(() => "?").join(",");
    // Use the DB's own serviceNumber values so the UPDATE matches exactly
    const dbSvcNos = eligible.map((r) => r.serviceNumber);
    const dbSvcPlaceholders = dbSvcNos.map(() => "?").join(",");

    // 4. Update ef_personalinfos
    const [result] = await conn.query(
      `UPDATE ef_personalinfos
       SET Status     = ?,
           fo_name    = ?,
           fo_rank    = ?,
           fo_svcno   = ?,
           fo_date    = NOW(),
           dateModify = NOW()
       WHERE ship = ?
         AND serviceNumber IN (${dbSvcPlaceholders})
         AND Status IN ('SUBMITTED','FO','Filled','DO_REVIEWED')
         AND (emolumentform IS NULL OR emolumentform != 'Yes')`,
      [legacyStatus, foName, foRank, foSvcNo, ship, ...dbSvcNos],
    );

    // Safety net: should never fire now, but if it does, roll everything back
    if (result.affectedRows !== dbSvcNos.length) {
      throw new Error(
        `approveBulk: expected ${dbSvcNos.length} personnel updates, got ${result.affectedRows}`,
      );
    }

    // 5. Update only the forms whose personnel row was updated
    await conn.query(
      `UPDATE ef_emolument_forms
       SET status     = 'FO_APPROVED',
           updated_at = NOW()
       WHERE ship = ?
         AND id IN (${formPlaceholders})`,
      [ship, ...formIds],
    );

    // 6. Approval trail for exactly these forms, same transaction
    await insertApprovalsTx(conn, approvable, { ...FO_TRAIL, performedBy: foSvcNo, remarks });

    return {
      count: formIds.length,
      serviceNumbers: [...new Set(approvable.map((f) => norm(f.service_no)))],
      skipped, // forms left untouched because the personnel row wasn't eligible
    };
  });
}

// ─────────────────────────────────────────────────────────────
// APPROVE ALL — UpdatePersonByShipFO equivalent
//
// CRITICAL: filters WHERE Status = 'Filled' AND classes = @classes
// This matches the EXACT old SP behaviour — do not change to 'FO'.
//
// TRANSACTION: both table updates are inside one transaction.
// The pre-fetch of affected service numbers is done INSIDE the
// transaction so the set cannot change between fetch and update
// (another session approving the same records concurrently).
//
// Returns list of affected serviceNumbers for audit logging.
// ─────────────────────────────────────────────────────────────

async function approveClass(
  ship,
  classes,
  foName,
  foRank,
  foSvcNo,
  legacyStatus,
  remarks = null,
) {
  return withTransaction(async (conn) => {
    const norm = (v) => String(v ?? "").trim();

    // 1. Lock the eligible personnel of this ship and class
    const [eligible] = await conn.query(
      `SELECT serviceNumber FROM ef_personalinfos
       WHERE ship    = ?
         AND classes = ?
         AND Status  IN ('SUBMITTED','FO', 'Filled','DO_REVIEWED')
         AND (emolumentform IS NULL OR emolumentform != 'Yes')
       FOR UPDATE`,
      [ship, classes],
    );
    if (eligible.length === 0) return { count: 0, serviceNumbers: [], skipped: [] };

    // 2. Lock their approvable forms on this ship
    const svcNos = eligible.map((r) => r.serviceNumber);
    const [forms] = await conn.query(
      `SELECT id, service_no, status FROM ef_emolument_forms
       WHERE ship = ?
         AND service_no IN (${svcNos.map(() => "?").join(",")})
         AND status IN ('SUBMITTED', 'DO_REVIEWED')
       FOR UPDATE`,
      [ship, ...svcNos],
    );

    // 3. Only personnel with a form are approved, so every status change has an
    //    approval record. The others are reported back and left untouched.
    const withForm = new Set(forms.map((f) => norm(f.service_no)));
    const approveSvc = svcNos.filter((s) => withForm.has(norm(s)));
    const skipped = svcNos
      .filter((s) => !withForm.has(norm(s)))
      .map((s) => ({ serviceNumber: s, reason: "no submitted form on this ship" }));
    if (approveSvc.length === 0) return { count: 0, serviceNumbers: [], skipped };

    // 4. Update ef_personalinfos
    const [result] = await conn.query(
      `UPDATE ef_personalinfos
       SET Status     = ?,
           fo_name    = ?,
           fo_rank    = ?,
           fo_svcno   = ?,
           fo_date    = NOW(),
           dateModify = NOW()
       WHERE ship    = ?
         AND serviceNumber IN (${approveSvc.map(() => "?").join(",")})
         AND Status  IN ('SUBMITTED','FO', 'Filled','DO_REVIEWED')
         AND (emolumentform IS NULL OR emolumentform != 'Yes')`,
      [legacyStatus, foName, foRank, foSvcNo, ship, ...approveSvc],
    );
    if (result.affectedRows !== approveSvc.length) {
      throw new Error(
        `approveClass: expected ${approveSvc.length} personnel updates, got ${result.affectedRows}`,
      );
    }

    // 5. Update exactly the locked forms
    const formIds = forms.map((f) => f.id);
    await conn.query(
      `UPDATE ef_emolument_forms
       SET status     = 'FO_APPROVED',
           updated_at = NOW()
       WHERE id IN (${formIds.map(() => "?").join(",")})`,
      formIds,
    );

    // 6. Approval trail, same transaction
    await insertApprovalsTx(conn, forms, { ...FO_TRAIL, performedBy: foSvcNo, remarks });

    return { count: result.affectedRows, serviceNumbers: approveSvc, skipped };
  });
}

// ─────────────────────────────────────────────────────────────
// GET BULK FORM IDS — for approval trail after bulk action
// ─────────────────────────────────────────────────────────────

async function getFormIdsByServiceNos(serviceNumbers, ship) {
  if (!serviceNumbers.length) return [];
  pool.useDatabase(DB());
  const placeholders = serviceNumbers.map(() => "?").join(",");
  const [rows] = await pool.query(
    `SELECT id, service_no FROM ef_emolument_forms
     WHERE service_no IN (${placeholders}) AND ship = ?`,
    [...serviceNumbers, ship],
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────
// REJECT — reset form to NULL (personnel must re-fill)
// FO can only reject DO_REVIEWED forms (Status = 'FO')
//
// TRANSACTION: same two-table pattern as approveSingle.
// ─────────────────────────────────────────────────────────────

async function rejectForm(serviceNo, formId, ship) {
  return withTransaction(async (conn) => {
    const [r1] = await conn.query(
      `UPDATE ef_personalinfos
       SET Status     = NULL,
           dateModify = NOW()
       WHERE serviceNumber = ?
         AND ship          = ?
         AND Status        IN ('Filled','FO')`,
      [serviceNo, ship],
    );

    if (r1.affectedRows === 0) {
      throw Object.assign(new Error("Form is not in DO_REVIEWED state"), {
        code: "STALE_STATUS",
      });
    }

    const [efRes] = await conn.query(
      `UPDATE ef_emolument_forms
       SET status     = 'REJECTED',
           updated_at = NOW()
       WHERE id     = ?
         AND status  IN ('SUBMITTED','DO_REVIEWED', 'Filled','FO')`,
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
// Bulk version accepts an array of formIds — one INSERT for N rows.
// Use bulkInsertFormApprovals after approveBulk instead of looping.
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

async function insertFormRejection({ formId, rejected_by, remarks, svc_no }) {
  pool.useDatabase(DB());
  await pool.query(
    `INSERT INTO ef_form_rejections
       (form_id, service_number, rejected_by, remarks)
     VALUES (?, ?, ?, ?)`,
    [formId, svc_no, rejected_by, remarks || null],
  );
}

async function bulkInsertFormApprovals(
  formIds,
  action,
  fromStatus,
  toStatus,
  performedBy,
  performerRole,
  remarks,
) {
  if (!formIds.length) return;
  pool.useDatabase(DB());
  const now = new Date();
  const values = formIds.map((id) => [
    id,
    action,
    fromStatus || null,
    toStatus,
    performedBy,
    performerRole || null,
    remarks || null,
    now,
  ]);
  await pool.query(
    `INSERT INTO ef_form_approvals
       (form_id, action, from_status, to_status, performed_by, performer_role, remarks, performed_at)
     VALUES ?`,
    [values],
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
            AND status IN ('FO', 'DO_REVIEWED', 'SUBMITTED', 'Filled')
        ) AS pending,

        (SELECT COUNT(*)
           FROM ef_form_approvals
          WHERE action = 'FO_APPROVED'
            AND performed_by = ?
        ) AS approved,

        (SELECT COUNT(*)
           FROM ef_form_rejections
          WHERE rejected_by = ?
        ) AS rejected
    `,
    [ship, svc, svc],
  );
  return stats[0];
}

// ─────────────────────────────────────────────────────────────
// FO REPORTS
//
// reportType:
//   pending  → forms awaiting FO approval
//   approved → forms approved by this FO
//   rejected → forms rejected by this FO
//
// We intentionally select p.* because the supplied report template
// contains fields whose exact DB column names were not shown
// (particularly RSA/PEN code). The service normalises them.
// ─────────────────────────────────────────────────────────────

async function getPendingReport(ship) {
  pool.useDatabase(DB());

  const [rows] = await pool.query(
    `
    SELECT
      p.*,
      ef.id            AS form_id,
      ef.status        AS form_status,
      ef.submitted_at  AS form_submitted_at,
      ef.updated_at    AS form_updated_at
    FROM ef_personalinfos p
    INNER JOIN ef_emolument_forms ef
      ON ef.service_no = p.serviceNumber
     AND ef.ship       = p.ship
    WHERE p.ship = ?
      AND p.Status IN ('Filled', 'SUBMITTED', 'FO', 'DO_REVIEWED')
      AND ef.status IN ('SUBMITTED', 'DO_REVIEWED')
      AND (p.emolumentform IS NULL OR p.emolumentform != 'Yes')
    ORDER BY
      p.Surname ASC,
      p.OtherName ASC
    `,
    [ship],
  );

  return rows;
}

// ─────────────────────────────────────────────────────────────
// APPROVED BY THIS FO
//
// Important: EXISTS ties FO_APPROVED to the exact form_id.
// This avoids duplicate rows when a form has multiple trail records.
// ─────────────────────────────────────────────────────────────

async function getApprovedReport(ship, svc) {
  pool.useDatabase(DB());

  const [rows] = await pool.query(
    `
    SELECT
      p.*,
      ef.id            AS form_id,
      ef.status        AS form_status,
      ef.submitted_at  AS form_submitted_at,
      ef.updated_at    AS form_updated_at
    FROM ef_personalinfos p
    INNER JOIN ef_emolument_forms ef
      ON ef.service_no = p.serviceNumber
     AND ef.ship       = p.ship
    WHERE p.ship = ?
      AND p.fo_svcno = ?
      AND EXISTS (
        SELECT 1
        FROM ef_form_approvals fa
        WHERE fa.form_id = ef.id
          AND fa.action = 'FO_APPROVED'
          AND fa.performed_by = ?
      )
    ORDER BY
      p.Surname ASC,
      p.OtherName ASC
    `,
    [ship, svc, svc],
  );

  return rows;
}

// ─────────────────────────────────────────────────────────────
// REJECTED BY THIS FO
//
// This is based on the rejection history table because the
// dashboard's "Rejected" count is also based on this table.
// ─────────────────────────────────────────────────────────────

async function getRejectedReport(ship, svc) {
  pool.useDatabase(DB());

  const [rows] = await pool.query(
    `
    SELECT
      p.*,
      ef.id            AS form_id,
      ef.status        AS form_status,
      ef.submitted_at  AS form_submitted_at,
      ef.updated_at    AS form_updated_at,

      fr.id            AS rejection_id,
      fr.rejected_by   AS rejection_by,
      fr.remarks       AS rejection_remarks,
      fr.created_at    AS rejection_date
    FROM ef_form_rejections fr
    INNER JOIN ef_emolument_forms ef
      ON ef.id = fr.form_id
    INNER JOIN ef_personalinfos p
      ON p.serviceNumber = ef.service_no
     AND p.ship          = ef.ship
    WHERE ef.ship = ?
      AND fr.rejected_by = ?
    ORDER BY
      fr.created_at DESC,
      p.Surname ASC,
      p.OtherName ASC
    `,
    [ship, svc],
  );

  return rows;
}

module.exports = {
  getDoReviewedForms,
  getApprovedForms,
  getFormDetail,
  getNok,
  getSpouse,
  getChildren,
  getLoans,
  getAllowances,
  getDocuments,
  approveSingle,
  approveBulk,
  approveClass,
  getFormIdsByServiceNos,
  rejectForm,
  insertFormApproval,
  deleteFormApproval,
  insertFormRejection,
  bulkInsertFormApprovals,
  insertAuditLog,
  getStatusStats,
  getPendingReport,
  getApprovedReport,
  getRejectedReport,
};

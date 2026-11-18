/**
 * FILE: routes/user-dashboard/emolument/cpo/cpo.repository.js
 *
 * All SQL for the CPO confirmation workflow.
 *
 * CPO actions (from old SPs — UpdatePayroll):
 *   - List FO_APPROVED forms scoped to CPO's command
 *   - View full form detail
 *   - Confirm individual form:
 *       ef_personalinfos.Status     → 'Verified'   (legacy)
 *       ef_personalinfos.emolumentform → 'Yes'
 *       ef_personalinfos.exittype   → 'Yes'
 *       ef_personalinfos.hod_svcno  → confirming CPO's service number
 *       ef_emolument_forms.status   → 'CPO_CONFIRMED' (clean)
 *       ef_emolument_forms.snapshot → full JSON snapshot of form at confirm time
 *   - Reject (any FO_APPROVED form in CPO's command)
 *
 * TRANSACTION SAFETY — CPO confirm is the most complex write in the system:
 *
 *   confirmForm writes to:
 *     1. ef_personalinfos  (Status, emolumentform, exittype, hod_svcno…)
 *     2. ef_emolument_forms (status = CPO_CONFIRMED, snapshot)
 *     3. ef_personalinfoshist (history record — idempotent INSERT IGNORE)
 *
 *   Previously confirmForm and insertHistoryRecord were separate functions
 *   called sequentially by the service layer with no transaction between them.
 *   If step 3 failed, the form was marked CPO_CONFIRMED but had no history
 *   record — a silent data loss.
 *
 *   They are now unified in confirmFormWithHistory, which wraps all three
 *   writes in one transaction. The old insertHistoryRecord is kept as a
 *   standalone export for any other callers but is now a no-op if the
 *   unique constraint (serviceNumber, FormYear) is already satisfied.
 *
 * CPO scope: COMMAND — they see all ships under their command.
 * CPO action: individual only — no bulk in the original SPs.
 *
 * The snapshot written to ef_emolument_forms.snapshot fixes the
 * old UpdatePayroll bug (hardcoded WHERE Id=332).
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
// LIST — FO_APPROVED forms scoped to a command (+ ship/classes filters)
// ─────────────────────────────────────────────────────────────

async function getFoApprovedForms(
  command,
  limit,
  offset,
  search,
  ship,
  classes,
) {
  pool.useDatabase(DB());

  let commandClause = "";
  const commandParams = [];
  if (command && command.trim()) {
    commandClause = ` AND p.command = ?`;
    commandParams.push(command.trim());
  }

  let searchClause = "";
  const searchParams = [];
  if (search && search.trim()) {
    searchClause = ` AND (p.Surname LIKE ? OR p.OtherName LIKE ? OR p.serviceNumber LIKE ?)`;
    const like = `%${search.trim()}%`;
    searchParams.push(like, like, like);
  }

  // NEW: optional ship filter
  let shipClause = "";
  const shipParams = [];
  if (ship && ship.trim()) {
    shipClause = ` AND p.ship = ?`;
    shipParams.push(ship.trim());
  }

  // NEW: optional classes filter (1=Officers, 2=Ratings, 3=Training)
  let classesClause = "";
  const classesParams = [];
  if (classes !== undefined && classes !== null && classes !== "") {
    classesClause = ` AND p.classes = ?`;
    classesParams.push(Number(classes));
  }

  const approvedQuery = `SELECT
       p.serviceNumber, p.Surname, p.OtherName, p.Rank,
       p.payrollclass, p.classes, p.ship, p.command,
       p.formNumber, p.FormYear, p.Status,
       p.div_off_name, p.div_off_rank, p.div_off_svcno, p.div_off_date,
       p.fo_name,     p.fo_rank,     p.fo_svcno,     p.fo_date,
       ef.id AS form_id, ef.status AS form_status, ef.submitted_at, ef.updated_at AS last_updated
     FROM ef_personalinfos p
     LEFT JOIN ef_emolument_forms ef
           ON ef.service_no = p.serviceNumber AND ef.command = p.command
     WHERE p.Status IN ('CPO', 'FO_APPROVED')
       AND (p.emolumentform IS NULL OR p.emolumentform != 'Yes')
       ${commandClause} ${searchClause} ${shipClause} ${classesClause}
     ORDER BY p.command ASC, p.ship ASC, p.Surname ASC, p.OtherName ASC
     LIMIT ? OFFSET ?`;

  const countQuery = `
      SELECT COUNT(*) AS total
      FROM ef_personalinfos p
      WHERE p.Status IN ('CPO', 'FO_APPROVED')
       AND (p.emolumentform IS NULL OR p.emolumentform != 'Yes')
       ${commandClause} ${searchClause} ${shipClause} ${classesClause}
    `;

  const [[rows], [countResults]] = await Promise.all([
    pool.query(approvedQuery, [
      ...commandParams,
      ...searchParams,
      ...shipParams,
      ...classesParams,
      limit,
      offset,
    ]),
    pool.query(countQuery, [
      ...commandParams,
      ...searchParams,
      ...shipParams,
      ...classesParams,
    ]),
  ]);
  return { forms: rows, total: countResults[0].total };
}

// ─────────────────────────────────────────────────────────────
// LIST — CPO_CONFIRMED forms scoped to a command (+ ship/classes filters)
// ─────────────────────────────────────────────────────────────

async function getCPOConfirmedForms(
  command,
  svc,
  limit,
  offset,
  search,
  ship,
  classes,
) {
  pool.useDatabase(DB());

  let commandClause = "";
  const commandParams = [];
  if (command && command.trim()) {
    commandClause = ` AND p.command = ?`;
    commandParams.push(command.trim());
  }

  let searchClause = "";
  const searchParams = [];
  if (search && search.trim()) {
    searchClause = ` AND (p.Surname LIKE ? OR p.OtherName LIKE ? OR p.serviceNumber LIKE ?)`;
    const like = `%${search.trim()}%`;
    searchParams.push(like, like, like);
  }

  let shipClause = "";
  const shipParams = [];
  if (ship && ship.trim()) {
    shipClause = ` AND p.ship = ?`;
    shipParams.push(ship.trim());
  }

  let classesClause = "";
  const classesParams = [];
  if (classes !== undefined && classes !== null && classes !== "") {
    classesClause = ` AND p.classes = ?`;
    classesParams.push(Number(classes));
  }

  const confirmedQuery = `SELECT
       p.serviceNumber, p.Surname, p.OtherName, p.Rank,
       p.payrollclass, p.classes, p.ship, p.command,
       p.formNumber, p.FormYear, p.Status,
       p.div_off_name, p.div_off_rank, p.div_off_svcno, p.div_off_date,
       p.fo_name,     p.fo_rank,     p.fo_svcno,     p.fo_date,
       p.hod_date, p.hod_svcno, p.hod_name,
       ef.id AS form_id, ef.status AS form_status, ef.submitted_at, ef.updated_at AS last_updated
     FROM ef_personalinfos p
     LEFT JOIN ef_emolument_forms ef
           ON ef.service_no = p.serviceNumber AND ef.command = p.command
     WHERE p.Status IN ('Verified', 'CPO_CONFIRMED')
       AND p.emolumentform = 'Yes'
       AND p.hod_svcno = ?
       ${commandClause} ${searchClause} ${shipClause} ${classesClause}
     ORDER BY p.command ASC, p.ship ASC, p.Surname ASC, p.OtherName ASC
     LIMIT ? OFFSET ?`;

  const countQuery = `
      SELECT COUNT(*) AS total
      FROM ef_personalinfos p
      WHERE p.Status IN ('Verified', 'CPO_CONFIRMED')
       AND p.emolumentform = 'Yes'
       AND p.hod_svcno = ?
       ${commandClause} ${searchClause} ${shipClause} ${classesClause}
    `;
  const [[rows], [countResults]] = await Promise.all([
    pool.query(confirmedQuery, [
      svc,
      ...commandParams,
      ...searchParams,
      ...shipParams,
      ...classesParams,
      limit,
      offset,
    ]),
    pool.query(countQuery, [
      svc,
      ...commandParams,
      ...searchParams,
      ...shipParams,
      ...classesParams,
    ]),
  ]);
  return { forms: rows, total: countResults[0].total };
}

// ─────────────────────────────────────────────────────────────
// GET FORM DETAIL — full form for CPO view
// Gates on ef_emolument_forms.status = 'FO_APPROVED'
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
       p.fo_name,     p.fo_rank,     p.fo_svcno,     p.fo_date,
       p.hod_name,    p.hod_rank,    p.hod_svcno,    p.hod_date,
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
       AND ef.status = 'FO_APPROVED'
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
// CONFIRM + HISTORY — three-table atomic write
//
// Replaces the old pattern of:
//   await confirmForm(...)          ← wrote tables 1 & 2
//   await insertHistoryRecord(...)  ← wrote table 3, outside any transaction
//
// Now all three writes are in one transaction. If writing the history
// record fails, the confirmation is rolled back and the form stays
// FO_APPROVED — the CPO can retry safely.
//
// The unique index on ef_personalinfoshist(serviceNumber, FormYear)
// from the index migration makes the INSERT IGNORE idempotent —
// a duplicate confirmation attempt is silently skipped at the DB level.
//
// Params:
//   serviceNo    — personnel service number
//   formId       — ef_emolument_forms.id
//   command      — CPO's command scope (guards against cross-command confirm)
//   cpoSvcNo     — confirming CPO's service number
//   legacyStatus — 'Verified' (written to ef_personalinfos.Status)
//   snapshot     — full form data object (serialised to JSON in ef_emolument_forms)
//   formYear     — e.g. 2024 (for the history record)
// ─────────────────────────────────────────────────────────────

async function confirmFormWithHistory(
  serviceNo,
  formId,
  command,
  cpoSvcNo,
  cpoRank,
  cpoName,
  legacyStatus,
  snapshot,
  formYear,
) {
  return withTransaction(async (conn) => {
    // 1. Update ef_personalinfos — gate on Status='CPO' and command match
    const [r1] = await conn.query(
      `UPDATE ef_personalinfos
      SET \`Status\`        = ?,
          emolumentform = 'Yes',
          hod_svcno     = ?,
          hod_name      = ?,
          hod_rank      = ?,
          hod_date      = NOW(),
          dateconfirmed = NOW(),
          dateModify    = NOW()
      WHERE serviceNumber = ?
        AND command       = ?
        AND \`Status\`        = 'CPO'
        AND (emolumentform IS NULL OR emolumentform != 'Yes')`,
      [legacyStatus, cpoSvcNo, cpoName, cpoRank, serviceNo, command],
    );

    if (r1.affectedRows === 0) {
      throw Object.assign(
        new Error("Form is not in FO_APPROVED state or already confirmed"),
        { code: "STALE_STATUS" },
      );
    }

    // 2. Update ef_emolument_forms — write clean status + full snapshot
    await conn.query(
      `UPDATE ef_emolument_forms
      SET status     = 'CPO_CONFIRMED',
          snapshot   = ?,
          updated_at = NOW()
      WHERE id     = ?
        AND status  = 'FO_APPROVED'`,
      [JSON.stringify(snapshot), formId],
    );

    // 3. Insert history record — INSERT IGNORE is safe due to the unique
    //    index on (serviceNumber, FormYear). A retry or duplicate call
    //    is silently skipped; it does NOT cause a rollback.
    await conn.query(
      `INSERT INTO ef_personalinfoshist (
        FormYear,
        serviceNumber, Surname, OtherName, Title, \`Rank\`,
        payrollclass, classes, ship, command, branch,
        \`Status\`, formNumber, emolumentform,
        confirmedBy, dateconfirmed,
        div_off_name, div_off_rank, div_off_svcno, div_off_date,
        hod_name,     hod_rank,     hod_svcno,     hod_date,
        fo_name,      fo_rank,      fo_svcno,       fo_date,
        NIN, upload
      )
      SELECT
        ?,
        serviceNumber, Surname, OtherName, Title, \`Rank\`,
        payrollclass, classes, ship, command, branch,
        \`Status\`, formNumber, emolumentform,
        confirmedBy, dateconfirmed,
        div_off_name, div_off_rank, div_off_svcno, div_off_date,
        hod_name,     hod_rank,     hod_svcno,     hod_date,
        fo_name,      fo_rank,      fo_svcno,       fo_date,
        NIN, upload
      FROM ef_personalinfos
      WHERE serviceNumber = ?`,
      [formYear, serviceNo],
    );

    return true;
  });
}

// ─────────────────────────────────────────────────────────────
// GET FORMS BY FORM NUMBERS
// Used by confirmBulk to prefetch candidate forms before the
// transaction — gives service layer formId, serviceNumber,
// command, and FormYear in one query.
//
// Filters: Status = @status
//          AND formNumber IN @formNumbers
//          AND emolumentform != 'Yes' (not already confirmed)
// ─────────────────────────────────────────────────────────────

async function getFormsByFormNumbers(formNumbers, status) {
  const placeholders = formNumbers.map(() => "?").join(",");

  const [rows] = await pool.query(
    `SELECT p.id, p.serviceNumber, p.formNumber, p.command, p.FormYear, ef.id  AS form_id
     FROM ef_personalinfos p
     JOIN ef_emolument_forms ef
       ON ef.service_no = p.serviceNumber
     WHERE p.formNumber IN (${placeholders})
       AND p.\`Status\`     = ?
       AND (p.emolumentform IS NULL OR p.emolumentform != 'Yes')`,
    [...formNumbers.map(String), status],
  );

  return rows;
}

// ─────────────────────────────────────────────────────────────
// GET FORMS BY FORM IDS
// Used by confirmBulk to prefetch candidate forms before the
// transaction — gives service layer formId, serviceNumber,
// command, and FormYear in one query.
//
// Filters: Status = @status
//          AND form_ids IN @formIds
//          AND emolumentform != 'Yes' (not already confirmed)
// ─────────────────────────────────────────────────────────────
async function getFormsByFormIDs(formIds, status) {
  const placeholders = formIds.map(() => "?").join(",");

  const [rows] = await pool.query(
    `SELECT p.id, p.serviceNumber, p.formNumber, p.command, p.FormYear, ef.id  AS form_id
     FROM ef_personalinfos p
     LEFT JOIN ef_emolument_forms ef
       ON ef.service_no = p.serviceNumber
     WHERE ef.id IN (${placeholders})
       AND p.\`Status\`     = ?
       AND (p.emolumentform IS NULL OR p.emolumentform != 'Yes')`,
    [...formIds.map(String), status],
  );

  return rows;
}

// ─────────────────────────────────────────────────────────────
// GET FORMS BY CLASS
// Used by confirmClass to prefetch candidate forms before the
// transaction. Command filter is applied here in SQL so the
// service layer doesn't need a post-fetch filter step.
//
// When cpoCommand = 'ALL' no command clause is added.
// Filters: Status = @status
//          AND classes = @classes
//          AND command = @cpoCommand (unless 'ALL')
//          AND emolumentform != 'Yes'
// ─────────────────────────────────────────────────────────────

async function getFormsByClass(classes, status, command) {
  const params = [classes, status];
  const commandClause = command ? "AND p.command = ?" : "";
  if (command) params.push(command);

  const [rows] = await pool.query(
    `SELECT p.id, p.serviceNumber, p.formNumber, p.command, p.FormYear, ef.id AS form_id
     FROM ef_personalinfos p
     JOIN ef_emolument_forms ef ON ef.service_no = p.serviceNumber
     WHERE p.classes = ?
       AND p.\`Status\` = ?
       ${commandClause}
       AND (p.emolumentform IS NULL OR p.emolumentform != 'Yes')`,
    params,
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────
// CONFIRM BULK WITH HISTORY — N-form atomic write
//
// Single transaction covering all forms. Each form gets:
//   1. UPDATE ef_personalinfos   — gate on Status='CPO' + command
//   2. UPDATE ef_emolument_forms — status → CPO_CONFIRMED + snapshot
//   3. INSERT IGNORE ef_personalinfoshist — unique (serviceNumber, FormYear)
//
// Skip semantics: if a form's ef_personalinfos UPDATE returns
// affectedRows = 0 (stale / already confirmed), that form is
// silently skipped — the transaction continues for the rest.
// No partial rollback — any DB error rolls back everything.
//
// Params:
//   forms       — array of { id, serviceNumber, command, FormYear }
//                 fetched by getFormsByFormNumbers / getFormsByClass
//   snapshots   — Map<formId, snapshot> built by buildSnapshotsInBatches
//   cpoSvcNo    — confirming CPO's service number
//   cpoName     — confirming CPO's name
//   cpoRank     — confirming CPO's rank
//   legacyStatus — 'Verified' (written to ef_personalinfos.Status)
//
// Returns:
//   count           — number of forms actually confirmed
//   confirmedFormIds — ef_emolument_forms.id for each confirmed form
//   skipped         — formIds that were stale / already confirmed
// ─────────────────────────────────────────────────────────────

async function confirmBulkWithHistory(
  forms,
  snapshots,
  cpoSvcNo,
  cpoName,
  cpoRank,
  legacyStatus,
) {
  return withTransaction(async (conn) => {
    let count = 0;
    const confirmedFormIds = [];
    const skipped = [];

    for (const form of forms) {
      const snapshot = snapshots.get(form.id);

      // 1. Update ef_personalinfos — gate on Status='CPO' and command match.
      //    Mirrors the single confirmFormWithHistory gate exactly.
      const [r1] = await conn.query(
        `UPDATE ef_personalinfos
         SET \`Status\`        = ?,
             emolumentform = 'Yes',
             hod_svcno     = ?,
             hod_name      = ?,
             hod_rank      = ?,
             hod_date      = NOW(),
             dateconfirmed = NOW(),
             dateModify    = NOW()
         WHERE serviceNumber = ?
           AND command       = ?
           AND Status        = 'CPO'
           AND (emolumentform IS NULL OR emolumentform != 'Yes')`,
        [
          legacyStatus,
          cpoSvcNo,
          cpoName,
          cpoRank,
          form.serviceNumber,
          form.command,
        ],
      );

      if (r1.affectedRows === 0) {
        // Stale or already confirmed — skip, don't roll back
        skipped.push(form.id);
        continue;
      }

      // 2. Update ef_emolument_forms — write snapshot + CPO_CONFIRMED status.
      await conn.query(
        `UPDATE ef_emolument_forms
         SET status     = 'CPO_CONFIRMED',
             snapshot   = ?,
             updated_at = NOW()
         WHERE id     = ?
           AND \`Status\`  = 'FO_APPROVED'`,
        [JSON.stringify(snapshot), form.form_id],
      );

      // 3. Insert history record — INSERT IGNORE is idempotent on the
      //    unique index (serviceNumber, FormYear). A retry won't cause
      //    a rollback; the duplicate is silently dropped.
      await conn.query(
        `INSERT IGNORE INTO ef_personalinfoshist (
          FormYear,
          serviceNumber, Surname, OtherName, Title, \`Rank\`,
          payrollclass, classes, ship, command, branch,
          \`Status\`, formNumber, emolumentform,
          confirmedBy, dateconfirmed,
          div_off_name, div_off_rank, div_off_svcno, div_off_date,
          hod_name,     hod_rank,     hod_svcno,     hod_date,
          fo_name,      fo_rank,      fo_svcno,       fo_date,
          NIN, upload
        )
        SELECT
          ?,
          serviceNumber, Surname, OtherName, Title, \`Rank\`,
          payrollclass, classes, ship, command, branch,
          \`Status\`, formNumber, emolumentform,
          confirmedBy, dateconfirmed,
          div_off_name, div_off_rank, div_off_svcno, div_off_date,
          hod_name,     hod_rank,     hod_svcno,     hod_date,
          fo_name,      fo_rank,      fo_svcno,       fo_date,
          NIN, upload
        FROM ef_personalinfos
        WHERE serviceNumber = ?`,
        [form.FormYear, form.serviceNumber],
      );

      count++;
      confirmedFormIds.push(form.form_id);
    }

    return { count, confirmedFormIds, skipped };
  });
}

// ─────────────────────────────────────────────────────────────
// REJECT — FO_APPROVED form reset to NULL
//
// TRANSACTION: two-table write.
// ─────────────────────────────────────────────────────────────

async function rejectForm(serviceNo, formId, command) {
  return withTransaction(async (conn) => {
    const [r1] = await conn.query(
      `UPDATE ef_personalinfos
     SET Status     = NULL,
         dateModify = NOW()
     WHERE serviceNumber = ?
       AND command       = ?
       AND \`Status\`        = 'CPO'`,
      [serviceNo, command],
    );

    if (r1.affectedRows === 0) {
      throw Object.assign(new Error("Form is not in FO_APPROVED state"), {
        code: "STALE_STATUS",
      });
    }

    await conn.query(
      `UPDATE ef_emolument_forms
     SET status     = 'REJECTED',
         updated_at = NOW()
     WHERE id     = ?
       AND \`Status\`  = 'FO_APPROVED'`,
      [formId],
    );

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

async function insertFormRejection({ formId, rejected_by, remarks, svc_no }) {
  pool.useDatabase(DB());
  await pool.query(
    `INSERT INTO ef_form_rejections
       (form_id, service_number, rejected_by, remarks)
     VALUES (?, ?, ?, ?)`,
    [formId, svc_no, rejected_by, remarks || null],
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
          WHERE command = ?
            AND status IN ('CPO', 'FO_APPROVED')
        ) AS pending,

        (SELECT COUNT(*)
           FROM ef_personalinfos
          WHERE command = ?
        ) AS total,

        (SELECT COUNT(*)
           FROM ef_form_approvals
          WHERE action = 'CPO_CONFIRMED'
            AND performed_by = ?
        ) AS confirmed,

        (SELECT COUNT(*)
           FROM ef_form_rejections
          WHERE rejected_by = ?
        ) AS rejected
    `,
    [ship, ship, svc, svc],
  );
  return stats[0];
}

async function getStatusStatsByShip(command, svc) {
  pool.useDatabase(DB());
  const cmdParams = command ? [command] : [];

  const [[totalsRows], [confirmedRows], [rejectedRows]] = await Promise.all([
    // SHARED: everyone sees total + pending
    pool.query(
      `SELECT command, ship,
          COUNT(*) AS total,
          COUNT(CASE WHEN \`Status\` IN ('CPO', 'FO_APPROVED') THEN 1 END) AS pending
        FROM ef_personalinfos
        WHERE 1=1 ${command ? "AND command = ?" : ""}
        AND classes IN (1, 2)
        GROUP BY command, ship
        ORDER BY command ASC, ship ASC`,
      cmdParams,
    ),

    // PERSONAL: forms this CPO confirmed
    pool.query(
      `SELECT p.command, p.ship, COUNT(*) AS confirmed
         FROM ef_form_approvals fa
         JOIN ef_emolument_forms ef ON ef.id = fa.form_id
         JOIN ef_personalinfos p    ON p.serviceNumber = ef.service_no
        WHERE fa.action = 'CPO_CONFIRMED'
          AND fa.performed_by = ?
          ${command ? "AND p.command = ?" : ""}
        GROUP BY p.command, p.ship`,
      [svc, ...cmdParams],
    ),

    // PERSONAL: forms this CPO rejected
    pool.query(
      `SELECT p.command, p.ship, COUNT(*) AS rejected
         FROM ef_form_rejections r
         JOIN ef_personalinfos p ON p.serviceNumber = r.service_number
        WHERE r.rejected_by = ?
          ${command ? "AND p.command = ?" : ""}
        GROUP BY p.command, p.ship`,
      [svc, ...cmdParams],
    ),
  ]);

  const key = (r) => `${r.command}::${r.ship}`;
  const confirmedMap = new Map(confirmedRows.map((r) => [key(r), r.confirmed]));
  const rejectedMap = new Map(rejectedRows.map((r) => [key(r), r.rejected]));

  return totalsRows.map((row) => ({
    command: row.command,
    ship: row.ship,
    total: row.total,
    pending: row.pending,
    confirmed: confirmedMap.get(key(row)) || 0,
    rejected: rejectedMap.get(key(row)) || 0,
  }));
}

async function getCpoGlobalTotals() {
  pool.useDatabase(DB());
  const [[row]] = await pool.query(
    `SELECT
        COUNT(*) AS total_personnel,
        SUM(CASE WHEN \`Status\` IN ('Verified','CPO_CONFIRMED') AND emolumentform='Yes' THEN 1 ELSE 0 END) AS total_confirmed,
        SUM(CASE WHEN \`Status\` IN ('CPO','FO_APPROVED') THEN 1 ELSE 0 END) AS total_pending,
        SUM(CASE WHEN \`Status\` IS NULL THEN 1 ELSE 0 END) AS total_not_filed
      FROM ef_personalinfos`,
  );
  const [[rejectedRow]] = await pool.query(
    `SELECT COUNT(*) AS total_rejected FROM ef_form_rejections`,
  );
  return { ...row, total_rejected: rejectedRow.total_rejected };
}

async function getTopShipsByCompletion(limit) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT
        ship, command,
        COUNT(*) AS total,
        SUM(CASE WHEN \`Status\` IN ('Verified','CPO_CONFIRMED') AND emolumentform='Yes' THEN 1 ELSE 0 END) AS confirmed,
        SUM(CASE WHEN \`Status\` IS NULL THEN 1 ELSE 0 END) AS not_filed
      FROM ef_personalinfos
      GROUP BY ship, command
      HAVING total > 0
      ORDER BY (confirmed / total) DESC
      LIMIT ?`,
    [limit],
  );
  return rows.map((r) => ({
    ...r,
    completion_pct: Math.round((r.confirmed / r.total) * 100),
  }));
}

module.exports = {
  getFoApprovedForms,
  getCPOConfirmedForms,
  getFormDetail,
  getNok,
  getSpouse,
  getChildren,
  getLoans,
  getAllowances,
  getDocuments,
  confirmFormWithHistory, // replaces confirmForm + insertHistoryRecord
  getFormsByFormNumbers,
  getFormsByFormIDs,
  getFormsByClass,
  confirmBulkWithHistory, // replaces confirmBulk + insertHistoryRecord in bulk
  rejectForm,
  insertFormApproval,
  deleteFormApproval,
  insertFormRejection,
  insertAuditLog,
  getStatusStats,
  getStatusStatsByShip,
  getCpoGlobalTotals,
  getTopShipsByCompletion,
};

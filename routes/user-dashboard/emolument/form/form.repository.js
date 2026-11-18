/**
 * FILE: routes/user-dashboard/emolument/form/form.repository.js
 *
 * All SQL for the emolument form lifecycle.
 * ef_personalinfos holds core identity/service only.
 * Related data lives in normalized tables:
 *   ef_nok, ef_spouse, ef_children, ef_loans, ef_allowances, ef_documents
 */

"use strict";

const pool = require("../../../../config/db");
const config = require("../../../../config");
const documentsRepo = require("../documents/documents.repository");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// ─────────────────────────────────────────────────────────────
// SYSTEM STATE
// ─────────────────────────────────────────────────────────────

async function getSystemInfo() {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT SiteStatus, opendate, closedate,
            OfficersFormNo, RatingsFormNo, TrainingFormNo
     FROM ef_systeminfos LIMIT 1`,
  );
  return rows[0] || null;
}

async function getProcessingYear(isTraining = false) {
  pool.useDatabase(DB());
  const where = isTraining ? `WHERE ship = 'All'` : "";
  const [rows] = await pool.query(
    `SELECT DISTINCT processingyear FROM ef_control ${where} LIMIT 1`,
  );
  return rows[0]?.processingyear || null;
}

// Resolve the command a ship belongs to, plus the name of the command the
// user picked. ef_ships.commandid -> ef_commands.Id; personnel store the
// command CODE (ef_commands.code) and the ship NAME (ef_ships.shipName).
async function getShipCommandMatch(shipName, commandCode) {
  pool.useDatabase(DB());
  // If the same ship name exists more than once, prefer the row under the
  // selected command, then the lowest Id — never an arbitrary row.
  const [shipRows] = await pool.query(
    `SELECT s.shipName, s.commandid, c.code AS commandCode, c.commandName
       FROM ef_ships s
       LEFT JOIN ef_commands c ON c.Id = s.commandid
      WHERE TRIM(s.shipName) = TRIM(?)
      ORDER BY (TRIM(c.code) = TRIM(?)) DESC, s.Id ASC
      LIMIT 1`,
    [shipName, commandCode],
  );
  const [cmdRows] = await pool.query(
    `SELECT code, commandName FROM ef_commands WHERE TRIM(code) = TRIM(?) LIMIT 1`,
    [commandCode],
  );
  return { ship: shipRows[0] || null, command: cmdRows[0] || null };
}

async function getShipOpenStatus(shipName) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT openship FROM ef_ships WHERE shipName = ? LIMIT 1`,
    [shipName],
  );
  return rows[0]?.openship ?? 0;
}

// ─────────────────────────────────────────────────────────────
// FIRST-TIMER INIT
// ─────────────────────────────────────────────────────────────

async function getFromHrEmployees(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT
       Empl_ID      AS serviceNumber,
       Surname,
       OtherName,
       Title,
       email,
       gsm_number,
       payrollclass,
       command,
       Location     AS ship,
       specialisation,
       bankcode,
       BankACNumber,
       DateEmpl,
       Birthdate,
       emolumentform
     FROM hr_employees
     WHERE Empl_ID = ?
     LIMIT 1`,
    [serviceNo],
  );
  return rows[0] || null;
}

async function initPersonnelFromHr(emp) {
  pool.useDatabase(DB());

  const payrollclass = String(emp.payrollclass);
  let classes;
  if (payrollclass === "1") classes = 1;
  else if (payrollclass === "6") classes = 3;
  else classes = 2;

  await pool.query(
    `INSERT INTO ef_personalinfos
       (serviceNumber, Surname, OtherName, Title, \`Rank\`, email,
        gsm_number, payrollclass, classes, command, ship,
        specialisation, Bankcode, BankACNumber,
        DateEmpl, Birthdate, AccountName, rankId, upload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    [
      emp.serviceNumber,
      emp.Surname ?? null,
      emp.OtherName ?? null,
      emp.Title ?? null,
      emp.Title ?? null, // Rank mirrors Title in hr_employees
      emp.email ?? null,
      emp.gsm_number ?? null,
      emp.payrollclass,
      classes,
      emp.command ?? null,
      emp.ship ?? null,
      emp.specialisation ?? null,
      emp.bankcode ?? null,
      emp.BankACNumber ?? null,
      emp.DateEmpl ?? null,
      emp.Birthdate ?? null,
      emp.Surname && emp.OtherName
        ? `${emp.Surname} ${emp.OtherName}`
        : (emp.Surname ?? null),
    ],
  );
}

// ─────────────────────────────────────────────────────────────
// PERSON CORE (status + eligibility checks only)
// ─────────────────────────────────────────────────────────────

async function getPersonCore(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT serviceNumber, Status, emolumentform, ship,
            payrollclass, classes, exittype, formNumber,
            command
     FROM ef_personalinfos
     WHERE serviceNumber = ? LIMIT 1`,
    [serviceNo],
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────
// LOAD FORM
// ─────────────────────────────────────────────────────────────

async function loadPersonCore(serviceNo) {
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
       p.entitlement, p.town, p.accomm_type,
       p.AcommodationStatus, p.AddressofAcommodation,
       p.NSITFcode, p.NHFcode,
       p.qualification, p.division, p.NIN,
       p.formNumber, p.FormYear, p.Status, p.emolumentform,
       p.div_off_name, p.div_off_rank, p.div_off_svcno, p.div_off_date,
       p.hod_name, p.hod_rank, p.hod_svcno, p.hod_date,
       p.cdr_name, p.cdr_rank, p.cdr_svcno, p.cdr_date,
       p.fo_name, p.fo_rank, p.fo_svcno, p.fo_date,
       p.datecreated, p.dateModify, p.confirmedBy, p.dateconfirmed,
       cmd.commandName,
       br.branchName,
       lga.lgaName,
       st.Name AS stateName,
       ef.id as formId,
       CONCAT(p.Surname, ' ', p.OtherName) AS fullAccountName
     FROM ef_personalinfos p
     LEFT JOIN ef_commands   cmd ON cmd.code    = p.command
     LEFT JOIN ef_branches   br  ON br.code     = p.branch
     LEFT JOIN ef_localgovts lga ON lga.Id      = p.LocalGovt
     LEFT JOIN ef_states     st  ON st.StateId  = p.StateofOrigin
     LEFT JOIN ef_emolument_forms ef  ON ef.service_no  = p.serviceNumber
     WHERE p.serviceNumber = ?`,
    [serviceNo],
  );
  return rows[0] || null;
}

async function loadNok(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT nok_order, full_name, relationship, phone1, phone2,
            email, address, national_id,
            nok_bank AS bank, nok_acc AS account_number
     FROM ef_nok
     WHERE service_no = ?
     ORDER BY nok_order ASC`,
    [serviceNo],
  );
  return {
    primary: rows.find((r) => r.nok_order === 1) || null,
    alternate: rows.find((r) => r.nok_order === 2) || null,
  };
}

async function loadSpouse(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT full_name, phone1, phone2, email
     FROM ef_spouse WHERE service_no = ? LIMIT 1`,
    [serviceNo],
  );
  return rows[0] || null;
}

async function loadChildren(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT birth_order, child_name
     FROM ef_children WHERE service_no = ?
     ORDER BY birth_order ASC`,
    [serviceNo],
  );
  return rows;
}

async function loadLoans(serviceNo) {
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

async function loadAllowances(serviceNo) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT allow_type, is_active, specify
     FROM ef_allowances WHERE service_no = ?`,
    [serviceNo],
  );

  // GCB is stored on ef_personalinfos as GBC / GBC_Number
  const [gbc] = await pool.query(
    `SELECT GBC, GBC_Number from ef_personalinfos WHERE serviceNumber = ? AND GBC IS NOT NULL LIMIT 1`,
    [serviceNo],
  );

  const out = {};
  rows.forEach((r) => {
    out[r.allow_type] = r;
  });
  if (gbc[0]?.GBC) {
    out["GCB"] = {
      allow_type: "GCB",
      is_active: 1,
      specify: null,
      gcb_number: gbc[0].GBC_Number,
    };
  }
  return out;
}

// Photos keyed by doc_type — shared with the documents module, which knows
// where they are stored.
async function loadDocuments(serviceNo) {
  return documentsRepo.getDocumentMap(serviceNo);
}

// ─────────────────────────────────────────────────────────────
// LOAD HISTORICAL FORM
// ─────────────────────────────────────────────────────────────

async function loadHistoricalForm(serviceNo, year) {
  pool.useDatabase(DB());

  const [histRows] = await pool.query(
    `SELECT
       h.FormYear, h.serviceNumber, h.Surname, h.OtherName,
       h.Title, h.Rank, h.payrollclass, h.classes,
       h.ship, h.command, h.branch, h.Status,
       h.formNumber, h.emolumentform,
       h.confirmedBy, h.dateconfirmed,
       h.div_off_name, h.div_off_rank, h.div_off_svcno, h.div_off_date,
       h.hod_name,     h.hod_rank,     h.hod_svcno,     h.hod_date,
       h.fo_name,      h.fo_rank,      h.fo_svcno,       h.fo_date,
       h.NIN, h.upload,
       cmd.commandName, br.branchName
     FROM ef_personalinfoshist h
     LEFT JOIN ef_commands cmd ON cmd.code = h.command
     LEFT JOIN ef_branches br  ON br.code  = h.branch
     WHERE h.serviceNumber = ? AND h.FormYear = ?
     LIMIT 1`,
    [serviceNo, year],
  );

  const histRow = histRows[0] || null;

  const [snapRows] = await pool.query(
    `SELECT snapshot, submitted_at, updated_at
     FROM ef_emolument_forms
     WHERE service_no = ?
       AND form_year  = ?
       AND status     = 'CPO_CONFIRMED'
     LIMIT 1`,
    [serviceNo, String(year)],
  );

  const snapRow = snapRows[0] || null;

  if (!histRow && !snapRow) return null;

  let snapshotData = null;
  if (snapRow?.snapshot) {
    try {
      snapshotData =
        typeof snapRow.snapshot === "string"
          ? JSON.parse(snapRow.snapshot)
          : snapRow.snapshot;
    } catch {
      console.warn(`⚠️  Malformed snapshot for ${serviceNo}/${year}`);
    }
  }

  return {
    FormYear: histRow?.FormYear ?? year,
    serviceNumber: histRow?.serviceNumber ?? serviceNo,
    Surname: histRow?.Surname,
    OtherName: histRow?.OtherName,
    Title: histRow?.Title,
    Rank: histRow?.Rank,
    payrollclass: histRow?.payrollclass,
    classes: histRow?.classes,
    ship: histRow?.ship,
    command: histRow?.command,
    commandName: histRow?.commandName,
    branch: histRow?.branch,
    branchName: histRow?.branchName,
    Status: histRow?.Status,
    formNumber: histRow?.formNumber,
    emolumentform: histRow?.emolumentform,
    confirmedBy: histRow?.confirmedBy,
    dateconfirmed: histRow?.dateconfirmed,
    div_off_name: histRow?.div_off_name,
    div_off_rank: histRow?.div_off_rank,
    div_off_svcno: histRow?.div_off_svcno,
    div_off_date: histRow?.div_off_date,
    hod_name: histRow?.hod_name,
    hod_rank: histRow?.hod_rank,
    hod_svcno: histRow?.hod_svcno,
    hod_date: histRow?.hod_date,
    fo_name: histRow?.fo_name,
    fo_rank: histRow?.fo_rank,
    fo_svcno: histRow?.fo_svcno,
    fo_date: histRow?.fo_date,
    NIN: histRow?.NIN,

    snapshot: snapshotData,
    hasSnapshot: snapshotData !== null,
    submittedAt: snapRow?.submitted_at ?? null,
  };
}

// ─────────────────────────────────────────────────────────────
// SHARED WRITE HELPERS
// Every one takes an executor (pool or transaction conn) so that
// saveDraft and submit use EXACTLY the same SQL.
// ─────────────────────────────────────────────────────────────

// Only columns present in the payload (not undefined) are updated,
// so fields the form doesn't send are never wiped to NULL.
const CORE_COLUMNS = [
  "Surname",
  "OtherName",
  "Rank",
  "Sex",
  "MaritalStatus",
  "Birthdate",
  "religion",
  "gsm_number",
  "gsm_number2",
  "email",
  "home_address",
  "BankACNumber",
  "Bankcode",
  "bankbranch",
  "pfacode",
  "specialisation",
  "command",
  "branch",
  "ship",
  "DateEmpl",
  "seniorityDate",
  "yearOfPromotion",
  "expirationOfEngagementDate",
  "StateofOrigin",
  "LocalGovt",
  "TaxCode",
  "entry_mode",
  "gradelevel",
  "gradetype",
  "taxed",
  "accomm_type",
  "AcommodationStatus",
  "AddressofAcommodation",
  "GBC",
  "GBC_Number",
  "NSITFcode",
  "NHFcode",
  "qualification",
  "division",
  "entitlement",
  "advanceDate",
  "runoutDate",
  "NIN",
  "AccountName",
  "confirmedBy", // Nature of Appointment (Permanent / Contract)
];

async function writeCore(exec, serviceNo, f) {
  const data = { ...(f || {}) };

  if (data.AccountName === undefined && data.Surname) {
    data.AccountName = `${data.Surname} ${data.OtherName ?? ""}`.trim();
  }

  const cols = CORE_COLUMNS.filter((c) => data[c] !== undefined);
  if (!cols.length) return true;

  const sql = `UPDATE ef_personalinfos SET
      ${cols.map((c) => `\`${c}\` = ?`).join(", ")},
      dateModify = NOW()
    WHERE serviceNumber = ?`;

  const [result] = await exec.query(sql, [
    ...cols.map((c) => data[c]),
    serviceNo,
  ]);
  return result.affectedRows > 0;
}

async function writeNok(exec, serviceNo, order, data) {
  if (!data) return;
  await exec.query(
    `INSERT INTO ef_nok
       (service_no, nok_order, full_name, relationship, phone1, phone2,
        email, address, national_id, nok_bank, nok_acc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       full_name    = VALUES(full_name),
       relationship = VALUES(relationship),
       phone1       = VALUES(phone1),
       phone2       = VALUES(phone2),
       email        = VALUES(email),
       address      = VALUES(address),
       national_id  = VALUES(national_id),
       nok_bank     = VALUES(nok_bank),
       nok_acc      = VALUES(nok_acc)`,
    [
      serviceNo,
      order,
      data.full_name ?? null,
      data.relationship ?? null,
      data.phone1 ?? null,
      data.phone2 ?? null,
      data.email ?? null,
      data.address ?? null,
      data.national_id ?? null,
      data.bank ?? null,
      data.account_number ?? null,
    ],
  );
}

async function writeSpouse(exec, serviceNo, spouse) {
  if (!spouse) return;
  await exec.query(
    `INSERT INTO ef_spouse (service_no, full_name, phone1, phone2, email)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       full_name = VALUES(full_name),
       phone1    = VALUES(phone1),
       phone2    = VALUES(phone2),
       email     = VALUES(email)`,
    [
      serviceNo,
      spouse.full_name ?? null,
      spouse.phone1 ?? null,
      spouse.phone2 ?? null,
      spouse.email ?? null,
    ],
  );
}

async function writeChildren(exec, serviceNo, children) {
  if (!Array.isArray(children)) return;
  await exec.query(`DELETE FROM ef_children WHERE service_no = ?`, [serviceNo]);
  const valid = children.slice(0, 4).filter((c) => c?.child_name?.trim());
  for (const [i, child] of valid.entries()) {
    await exec.query(
      `INSERT INTO ef_children (service_no, child_name, birth_order) VALUES (?, ?, ?)`,
      [serviceNo, child.child_name.trim(), child.birth_order ?? i + 1],
    );
  }
}

async function writeLoans(exec, serviceNo, loans, validLoanTypes) {
  if (!loans || typeof loans !== "object") return;
  for (const [loanType, data] of Object.entries(loans)) {
    if (!validLoanTypes.includes(loanType)) continue;

    // Unchecked loan → remove the stored row
    if (!data || data.is_active === false) {
      await exec.query(
        `DELETE FROM ef_loans WHERE service_no = ? AND loan_type = ?`,
        [serviceNo, loanType],
      );
      continue;
    }

    await exec.query(
      `INSERT INTO ef_loans
         (service_no, loan_type, amount, year_taken, tenor, balance, specify)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         amount     = VALUES(amount),
         year_taken = VALUES(year_taken),
         tenor      = VALUES(tenor),
         balance    = VALUES(balance),
         specify    = VALUES(specify)`,
      [
        serviceNo,
        loanType,
        data.amount ?? null,
        data.year_taken ?? null,
        data.tenor ?? null,
        data.balance ?? null,
        data.specify ?? null,
      ],
    );
  }
}

async function writeAllowances(exec, serviceNo, allowances, validAllowTypes) {
  if (!allowances || typeof allowances !== "object") return;
  for (const [allowType, data] of Object.entries(allowances)) {
    if (!validAllowTypes.includes(allowType)) continue;
    await exec.query(
      `INSERT INTO ef_allowances (service_no, allow_type, is_active, specify)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         is_active = VALUES(is_active),
         specify   = VALUES(specify)`,
      [serviceNo, allowType, data.is_active ? 1 : 0, data.specify ?? null],
    );
  }
}

// ─────────────────────────────────────────────────────────────
// SAVE (draft) — thin wrappers over the shared helpers
// ─────────────────────────────────────────────────────────────

async function savePersonCore(serviceNo, f) {
  pool.useDatabase(DB());
  return writeCore(pool, serviceNo, f);
}

async function saveNok(serviceNo, primary, alternate) {
  pool.useDatabase(DB());
  await writeNok(pool, serviceNo, 1, primary);
  await writeNok(pool, serviceNo, 2, alternate);
}

async function saveSpouse(serviceNo, spouse) {
  pool.useDatabase(DB());
  await writeSpouse(pool, serviceNo, spouse);
}

async function saveChildren(serviceNo, children) {
  pool.useDatabase(DB());
  await writeChildren(pool, serviceNo, children);
}

async function saveLoans(serviceNo, loans, validLoanTypes) {
  pool.useDatabase(DB());
  await writeLoans(pool, serviceNo, loans, validLoanTypes);
}

async function saveAllowances(serviceNo, allowances, validAllowTypes) {
  pool.useDatabase(DB());
  await writeAllowances(pool, serviceNo, allowances, validAllowTypes);
}

// ─────────────────────────────────────────────────────────────
// SUBMIT — atomic multi-table write (transaction version)
// Throws "ALREADY_SUBMITTED" when the status gate matches 0 rows so
// the whole transaction rolls back.
// ─────────────────────────────────────────────────────────────

// Writes every form table from a request body, without touching Status.
// Shared by submitAllTables (personnel submit) and the admin form-review
// edit, so both persist the form with exactly the same SQL.
async function saveAllTables(
  conn,
  serviceNo,
  body,
  validLoanTypes,
  validAllowTypes,
) {
  await writeCore(conn, serviceNo, body.core || {});
  await writeNok(conn, serviceNo, 1, body.nok?.primary);
  await writeNok(conn, serviceNo, 2, body.nok?.alternate);
  await writeSpouse(conn, serviceNo, body.spouse);
  await writeChildren(
    conn,
    serviceNo,
    Array.isArray(body.children) ? body.children : [],
  );
  await writeLoans(conn, serviceNo, body.loans || {}, validLoanTypes);
  await writeAllowances(
    conn,
    serviceNo,
    body.allowances || {},
    validAllowTypes,
  );
}

async function submitAllTables(
  conn,
  serviceNo,
  body,
  formNumber,
  formYear,
  legacyStatus,
  validLoanTypes,
  validAllowTypes,
) {
  await saveAllTables(conn, serviceNo, body, validLoanTypes, validAllowTypes);

  // Mark as submitted — gate ensures this only fires once
  const [result] = await conn.query(
    `UPDATE ef_personalinfos
     SET Status      = ?,
         formNumber  = ?,
         FormYear    = ?,
         datecreated = NOW(),
         dateModify  = NOW()
     WHERE serviceNumber = ?
       AND (Status IS NULL OR Status = '')
       AND (emolumentform IS NULL OR emolumentform != 'Yes')`,
    [legacyStatus, formNumber, formYear, serviceNo],
  );

  if (!result.affectedRows) throw new Error("ALREADY_SUBMITTED");
  return result.affectedRows;
}

// ─────────────────────────────────────────────────────────────
// INIT DRAFT
// ─────────────────────────────────────────────────────────────

async function initDraftForm(serviceNo, formYear, payrollClass, ship, command) {
  pool.useDatabase(DB());

  // Reuse the existing row for this year (no reliance on a UNIQUE key —
  // the old ON DUPLICATE KEY version inserted a new DRAFT on every load).
  const [existing] = await pool.query(
    `SELECT id FROM ef_emolument_forms
     WHERE service_no = ? AND form_year = ?
     ORDER BY (status <> 'DRAFT') DESC, id DESC
     LIMIT 1`,
    [serviceNo, formYear],
  );
  if (existing.length) return existing[0].id;

  const [result] = await pool.query(
    `INSERT INTO ef_emolument_forms
       (service_no, form_year, payroll_class, ship, command, status)
     VALUES (?, ?, ?, ?, ?, 'DRAFT')`,
    [serviceNo, formYear, payrollClass, ship ?? null, command ?? null],
  );
  return result.insertId || null;
}

async function submitForm(serviceNo, formNumber, formYear, legacyStatus) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `UPDATE ef_personalinfos
     SET Status      = ?,
         formNumber  = ?,
         FormYear    = ?,
         datecreated = NOW(),
         dateModify  = NOW()
     WHERE serviceNumber = ?
       AND (Status IS NULL OR Status = '')
       AND (emolumentform IS NULL OR emolumentform != 'Yes')`,
    [legacyStatus, formNumber, formYear, serviceNo],
  );
  return result.affectedRows > 0;
}

async function upsertEmolumentForm(
  serviceNo,
  formYear,
  formNumber,
  payrollClass,
  ship,
  command,
  formStatus,
  snapshot = null,
) {
  pool.useDatabase(DB());
  const snap = snapshot ? JSON.stringify(snapshot) : null;

  // Update the person's existing row for this year explicitly instead of
  // relying on ON DUPLICATE KEY: without a UNIQUE(service_no, form_year) key
  // the old upsert INSERTed a second row and left the draft row (the one
  // getEmolumentFormId returned) stuck at DRAFT.
  const [upd] = await pool.query(
    `UPDATE ef_emolument_forms
        SET submitted_at  = IF(status = 'DRAFT' AND ? <> 'DRAFT', NOW(), submitted_at),
            form_number   = ?,
            status        = ?,
            ship          = ?,
            command       = ?,
            payroll_class = ?,
            snapshot      = COALESCE(?, snapshot),
            updated_at    = NOW()
      WHERE service_no = ? AND form_year = ?`,
    [
      formStatus,
      formNumber,
      formStatus,
      ship ?? null,
      command ?? null,
      payrollClass,
      snap,
      serviceNo,
      formYear,
    ],
  );
  if (upd.affectedRows > 0) return true;

  const [ins] = await pool.query(
    `INSERT INTO ef_emolument_forms
       (service_no, form_year, form_number, payroll_class, ship, command, status, snapshot, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      serviceNo,
      formYear,
      formNumber,
      payrollClass,
      ship ?? null,
      command ?? null,
      formStatus,
      snap,
    ],
  );
  return ins.affectedRows > 0;
}

// ─────────────────────────────────────────────────────────────
// FORM NUMBER
// ─────────────────────────────────────────────────────────────

async function getCurrentFormNumber(formNoColumn) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT \`${formNoColumn}\` AS formNo FROM ef_control LIMIT 1`,
  );
  return rows[0]?.formNo ?? 1;
}

async function incrementFormNumber(formNoColumn) {
  pool.useDatabase(DB());
  await pool.query(
    `UPDATE ef_control SET \`${formNoColumn}\` = \`${formNoColumn}\` + 1`,
  );
}

// ─────────────────────────────────────────────────────────────
// AUDIT / APPROVAL LOGS
// ─────────────────────────────────────────────────────────────

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

// Same row getEmolumentFormId picks, with its status.
async function getEmolumentFormRow(serviceNo, formYear) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT id, status FROM ef_emolument_forms
     WHERE service_no = ? AND form_year = ?
     ORDER BY (status <> 'DRAFT') DESC, id DESC
     LIMIT 1`,
    [serviceNo, formYear],
  );
  return rows[0] || null;
}

async function getEmolumentFormId(serviceNo, formYear) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT id FROM ef_emolument_forms
     WHERE service_no = ? AND form_year = ?
     ORDER BY (status <> 'DRAFT') DESC, id DESC
     LIMIT 1`,
    [serviceNo, formYear],
  );
  return rows[0]?.id || null;
}

// ─────────────────────────────────────────────────────────────
// FORM OPTIONS
// ─────────────────────────────────────────────────────────────

async function getFormOptions() {
  try {
    const [
      banksResult,
      bankBranchesResult,
      commandsResult,
      branchesResult,
      shipsResult,
      specializationsResult,
      statesResult,
      lgasResult,
      relationshipsResult,
      entryModesResult,
      rankResult,
    ] = await Promise.all([
      pool.query("SELECT bankcode AS id, bankname AS name FROM ef_banks"),
      pool.query(
        "SELECT branchcode AS id, bankcode AS code, branchname AS name FROM ef_bank_branches",
      ),
      pool.query("SELECT code as id, commandName AS name FROM ef_commands"),
      pool.query("SELECT code AS id, branchName AS name FROM ef_branches"),
      // commandCode = the command the ship belongs to (ef_ships.commandid ->
      // ef_commands.code) — the same rule the submit check uses.
      pool.query(
        `SELECT s.Id AS id, s.shipName AS name, s.code, c.code AS commandCode
           FROM ef_ships s
           LEFT JOIN ef_commands c ON c.Id = s.commandid`,
      ),
      pool.query(
        "SELECT Id AS id, specname AS name FROM ef_specialisationareas",
      ),
      pool.query("SELECT StateId AS id, Name AS name FROM ef_states"),
      pool.query(
        "SELECT Id AS id, lgaName AS name, stateId FROM ef_localgovts",
      ),
      pool.query("SELECT Id AS id, description AS name FROM ef_relationships"),
      pool.query("SELECT Id AS id, Name AS name FROM ef_entrymodes"),
      pool.query(
        "SELECT Id AS id, rankName AS name, rankType AS type FROM ef_ranks",
      ),
    ]);

    return {
      banks: banksResult[0],
      bankBranches: bankBranchesResult[0],
      commands: commandsResult[0],
      branches: branchesResult[0],
      ships: shipsResult[0],
      specializations: specializationsResult[0],
      states: statesResult[0],
      lgas: lgasResult[0],
      relationships: relationshipsResult[0],
      entryModes: entryModesResult[0],
      ranks: rankResult[0],
    };
  } catch (error) {
    console.error("Error fetching form options:", error);
    throw error;
  }
}

module.exports = {
  getSystemInfo,
  getProcessingYear,
  getShipOpenStatus,
  getFromHrEmployees,
  initPersonnelFromHr,
  getPersonCore,
  loadPersonCore,
  loadNok,
  loadSpouse,
  loadChildren,
  loadLoans,
  loadAllowances,
  loadDocuments,
  loadHistoricalForm,
  savePersonCore,
  saveNok,
  saveSpouse,
  saveChildren,
  saveLoans,
  saveAllowances,
  submitForm,
  saveAllTables,
  submitAllTables,
  initDraftForm,
  getShipCommandMatch,
  getEmolumentFormRow,
  upsertEmolumentForm,
  getCurrentFormNumber,
  incrementFormNumber,
  insertAuditLog,
  insertFormApproval,
  getEmolumentFormId,
  getFormOptions,
};

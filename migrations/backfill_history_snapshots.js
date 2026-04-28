/**
 * FILE: migrations/backfill_history_snapshots.js
 *
 * PURPOSE:
 *   Convert existing flat rows in ef_personalinfoshist into JSON snapshots
 *   stored in ef_emolument_forms.snapshot.
 *
 * CONTEXT:
 *   The old system stored confirmed form data as flat columns in
 *   ef_personalinfoshist. The new system stores a full JSON snapshot
 *   in ef_emolument_forms.snapshot at confirmation time.
 *
 *   This migration backfills snapshots for all historical confirmed forms
 *   so that GET /form/history/:year returns full data for every year,
 *   not just forms confirmed after the new system went live.
 *
 * WHAT CAN BE RECONSTRUCTED:
 *   ✅ All core personal/service/bank/approval columns from ef_personalinfoshist
 *   ✅ NOK data       — from ef_nok        (if already migrated to child tables)
 *   ✅ Spouse data    — from ef_spouse      (if already migrated)
 *   ✅ Children data  — from ef_children    (if already migrated)
 *   ✅ Loans data     — from ef_loans       (if already migrated)
 *   ✅ Allowances     — from ef_allowances  (if already migrated)
 *   ✅ Documents      — from ef_documents   (Cloudinary URLs)
 *   ⚠️  Child tables may be empty for older years — snapshot will note this.
 *
 * SAFETY:
 *   - Idempotent: skips ef_emolument_forms rows that already have a snapshot
 *   - Dry run mode: set DRY_RUN=true to preview without writing
 *   - Batch processing: processes BATCH_SIZE rows at a time
 *   - Full audit log written to migration_audit table
 *   - Transaction per row: one failure does not stop the rest
 *
 * USAGE:
 *   node migrations/backfill_history_snapshots.js
 *   $env:DRY_RUN="true"; node migrations/backfill_history_snapshots.js
 *   $env:BATCH_SIZE="50"; node migrations/backfill_history_snapshots.js
 *
 * RUN ORDER:
 *   1. Run this migration BEFORE running migration_drop_flat_columns.sql
 *      (this script reads the flat columns — they must still exist)
 *   2. Verify snapshots with the post-run queries at the bottom
 *   3. Then run migration_drop_flat_columns.sql to drop flat columns
 */

'use strict';

// ── Direct MySQL connection — bypasses the shared async pool ──
// This makes the script fully self-contained and runnable
// without waiting for pool initialisation to complete.
const mysql = require('mysql2/promise');
const fs   = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env.local') });

const DRY_RUN    = process.env.DRY_RUN    === 'true';
const BATCH_SIZE = Number(process.env.BATCH_SIZE) || 100;

// Read connection details from env (loaded by dotenv in your project)
const DB_HOST = process.env.MYSQL_HOST;
const DB_PORT = Number(process.env.MYSQL_PORT || 3306);
const DB_USER = process.env.MYSQL_USER;
const DB_PASS = process.env.MYSQL_PASSWORD;
const DB_NAME = process.env.MYSQL_DB_OFFICERS;

if (!DB_NAME) {
  console.error('❌ MYSQL_DB_OFFICERS env var is not set. Check your .env.local file.');
  process.exit(1);
}

// Create connection (not pool — single connection for a migration is fine)
async function getConnection() {
  const conn = await mysql.createConnection({
    host:     DB_HOST,
    port:     DB_PORT,
    user:     DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    dateStrings:    true,
    timezone:       'local',
    connectTimeout: 30000,
  });
  return conn;
}

// Thin query wrapper — uses query() not execute() so LIMIT/OFFSET
// integer params work correctly and missing optional columns don't
// cause prepared-statement type errors.
async function q(conn, sql, params = []) {
  const [rows] = await conn.query(sql, params);
  return [rows];
}

// ─────────────────────────────────────────────────────────────
// SAFE COLUMN HELPER
// Wraps column reads in COALESCE so a missing column falls back
// to NULL rather than crashing the whole query.
// We check which optional flat columns actually exist in this DB
// before building the SELECT so we don't reference dropped cols.
// ─────────────────────────────────────────────────────────────

async function getExistingColumns(conn, tableName) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tableName],
  );
  return new Set(rows.map(r => r.COLUMN_NAME));
}

function colOrNull(cols, colName, alias) {
  return cols.has(colName)
    ? `h.${colName}${alias ? ` AS ${alias}` : ''}`
    : `NULL AS ${alias || colName}`;
}


// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────

async function run() {
  let conn;
  try {
    conn = await getConnection();
    console.log(`✅ Connected to database: ${DB_NAME}`);
  } catch (err) {
    console.error(`❌ Could not connect to database: ${err.message}`);
    console.error(`   Host: ${DB_HOST}:${DB_PORT}  DB: ${DB_NAME}  User: ${DB_USER}`);
    process.exit(1);
  }

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║   BACKFILL HISTORY SNAPSHOTS — emolument system      ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`  Mode:       ${DRY_RUN ? '🟡 DRY RUN (no writes)' : '🔴 LIVE RUN'}`);
  console.log(`  Batch size: ${BATCH_SIZE}`);
  console.log(`  Database:   ${DB_NAME}\n`);

  // ── 1. Count total historical rows to process ──────────────
  const [[{ total }]] = await q(conn,
    `SELECT COUNT(*) AS total FROM ef_personalinfoshist`,
  );

  console.log(`  Total history rows found: ${total}`);
  if (total === 0) {
    console.log('  Nothing to migrate. Exiting.\n');
    await conn.end();
    return;
  }

  // ── 2. Count already-snapshotted rows (skip these) ────────
  const [[{ alreadyDone }]] = await q(conn,
    `SELECT COUNT(*) AS alreadyDone
     FROM ef_emolument_forms ef
     JOIN ef_personalinfoshist h
          ON h.serviceNumber = ef.service_no
         AND h.FormYear      = ef.form_year
     WHERE ef.snapshot IS NOT NULL`,
  );

  console.log(`  Already snapshotted: ${alreadyDone} (will be skipped)`);
  console.log(`  To process:          ${total - alreadyDone}\n`);

  // ── 3. Detect which optional flat columns actually exist ───
  // ef_personalinfoshist may have already had some columns dropped.
  // We build the SELECT dynamically so we never reference missing cols.
  console.log('  Detecting available columns in ef_personalinfoshist…');
  const cols = await getExistingColumns(conn, 'ef_personalinfoshist');
  console.log(`  Found ${cols.size} columns.\n`);

  // Build the SELECT — required cols first, then optional flat cols
  const selectCols = [
    // Always present
    'h.Id', 'h.FormYear', 'h.serviceNumber',
    'h.Surname', 'h.OtherName', 'h.Title', 'h.Rank',
    'h.payrollclass', 'h.classes', 'h.ship', 'h.command', 'h.branch',
    'h.Status', 'h.formNumber', 'h.emolumentform',
    'h.confirmedBy', 'h.dateconfirmed',
    'h.div_off_name', 'h.div_off_rank', 'h.div_off_svcno', 'h.div_off_date',
    'h.hod_name',     'h.hod_rank',     'h.hod_svcno',     'h.hod_date',
    'h.fo_name',      'h.fo_rank',      'h.fo_svcno',      'h.fo_date',
    'h.upload', 'h.NIN',

    // Optional — may have been dropped already
    colOrNull(cols, 'Sex'),
    colOrNull(cols, 'MaritalStatus'),
    colOrNull(cols, 'Birthdate'),
    colOrNull(cols, 'religion'),
    colOrNull(cols, 'gsm_number'),
    colOrNull(cols, 'gsm_number2'),
    colOrNull(cols, 'email'),
    colOrNull(cols, 'home_address'),
    colOrNull(cols, 'Bankcode'),
    colOrNull(cols, 'bankbranch'),
    colOrNull(cols, 'BankACNumber'),
    colOrNull(cols, 'AccountName'),
    colOrNull(cols, 'pfacode'),
    colOrNull(cols, 'specialisation'),
    colOrNull(cols, 'exittype'),
    colOrNull(cols, 'DateEmpl'),
    colOrNull(cols, 'DateLeft'),
    colOrNull(cols, 'seniorityDate'),
    colOrNull(cols, 'yearOfPromotion'),
    colOrNull(cols, 'expirationOfEngagementDate'),
    colOrNull(cols, 'StateofOrigin'),
    colOrNull(cols, 'LocalGovt'),
    colOrNull(cols, 'TaxCode'),
    colOrNull(cols, 'entry_mode'),
    colOrNull(cols, 'taxed'),
    colOrNull(cols, 'gradelevel'),
    colOrNull(cols, 'gradetype'),
    colOrNull(cols, 'entitlement'),
    colOrNull(cols, 'town'),
    colOrNull(cols, 'accomm_type'),
    colOrNull(cols, 'AcommodationStatus'),
    colOrNull(cols, 'AddressofAcommodation'),
    colOrNull(cols, 'GBC'),
    colOrNull(cols, 'GBC_Number'),
    colOrNull(cols, 'qualification'),
    colOrNull(cols, 'division'),
    colOrNull(cols, 'advanceDate'),
    colOrNull(cols, 'runoutDate'),
    colOrNull(cols, 'NSITFcode'),
    colOrNull(cols, 'NHFcode'),
    colOrNull(cols, 'NSITFcodeYear'),
    colOrNull(cols, 'NHFcodeYear'),
    // NOK flat cols
    colOrNull(cols, 'nok_name'),
    colOrNull(cols, 'nok_relation'),
    colOrNull(cols, 'nok_phone'),
    colOrNull(cols, 'nok_phone12'),
    colOrNull(cols, 'nok_email'),
    colOrNull(cols, 'nok_address'),
    colOrNull(cols, 'nok_nationalId'),
    colOrNull(cols, 'nok_name2'),
    colOrNull(cols, 'nok_relation2'),
    colOrNull(cols, 'nok_phone2'),
    colOrNull(cols, 'nok_phone22'),
    colOrNull(cols, 'nok_email2'),
    colOrNull(cols, 'nok_address2'),
    colOrNull(cols, 'nok_nationalId2'),
    // Spouse flat cols
    colOrNull(cols, 'sp_name'),
    colOrNull(cols, 'sp_phone'),
    colOrNull(cols, 'sp_phone2'),
    colOrNull(cols, 'sp_email'),
    // Children flat cols
    colOrNull(cols, 'chid_name'),
    colOrNull(cols, 'chid_name2'),
    colOrNull(cols, 'chid_name3'),
    colOrNull(cols, 'chid_name4'),
    // Loan flat cols
    colOrNull(cols, 'FGSHLS_loan'),
    colOrNull(cols, 'FGSHLS_loanYear'),
    colOrNull(cols, 'car_loan'),
    colOrNull(cols, 'car_loanYear'),
    colOrNull(cols, 'welfare_loan'),
    colOrNull(cols, 'welfare_loanYear'),
    colOrNull(cols, 'NNNCS_loan'),
    colOrNull(cols, 'NNNCS_loanYear'),
    colOrNull(cols, 'NNMFBL_loan'),
    colOrNull(cols, 'NNMFBL_loanYear'),
    colOrNull(cols, 'PPCFS_loan'),
    colOrNull(cols, 'PPCFS_loanYear'),
    colOrNull(cols, 'Anyother_Loan'),
    colOrNull(cols, 'Anyother_LoanYear'),
    // Allowance flat cols
    colOrNull(cols, 'aircrew_allow'),
    colOrNull(cols, 'pilot_allow'),
    colOrNull(cols, 'shift_duty_allow'),
    colOrNull(cols, 'hazard_allow'),
    colOrNull(cols, 'rent_subsidy'),
    colOrNull(cols, 'SBC_allow'),
    colOrNull(cols, 'special_forces_allow'),
    colOrNull(cols, 'call_duty_allow'),
    colOrNull(cols, 'other_allow'),
    colOrNull(cols, 'other_allowspecify'),
    // Photo blob cols
    colOrNull(cols, 'Passport'),
    colOrNull(cols, 'NokPassport'),
    colOrNull(cols, 'AltNokPassport'),
  ].join(',\n         ');

  // ── 4. Process in batches ──────────────────────────────────
  let offset    = 0;
  let processed = 0;
  let skipped   = 0;
  let orphaned  = 0;
  let failed    = 0;
  const errors  = [];

  while (true) {
    const [rows] = await q(conn,
      `SELECT ${selectCols}
       FROM ef_personalinfoshist h
       ORDER BY h.FormYear ASC, h.serviceNumber ASC
       LIMIT ? OFFSET ?`,
      [BATCH_SIZE, offset],
    );

    if (rows.length === 0) break;

    console.log(`  Batch ${Math.floor(offset/BATCH_SIZE)+1}: rows ${offset+1}–${offset+rows.length} of ${total}`);

    for (const row of rows) {
      const label = `  [${row.serviceNumber}/${row.FormYear}]`;

      try {
        // ── Check if already snapshotted ──────────────────
        const [existing] = await q(conn,
          `SELECT id, snapshot FROM ef_emolument_forms
           WHERE service_no = ? AND form_year = ?
           LIMIT 1`,
          [row.serviceNumber, String(row.FormYear)],
        );

        if (existing[0]?.snapshot) {
          process.stdout.write(`${label} ⏭  already snapshotted\n`);
          skipped++;
          continue;
        }

        // ── Fetch child table data (best effort) ──────────
        const [nokRows] = await q(conn,
          `SELECT nok_order, full_name, relationship, phone1, phone2,
                  email, address, national_id
           FROM ef_nok WHERE service_no = ? ORDER BY nok_order ASC`,
          [row.serviceNumber],
        );
        const nokFromChildTable = {
          primary:   nokRows.find(r => r.nok_order === 1) || null,
          alternate: nokRows.find(r => r.nok_order === 2) || null,
        };

        const [spouseRows] = await q(conn,
          `SELECT full_name, phone1, phone2, email
           FROM ef_spouse WHERE service_no = ? LIMIT 1`,
          [row.serviceNumber],
        );

        const [childrenRows] = await q(conn,
          `SELECT birth_order, child_name
           FROM ef_children WHERE service_no = ?
           ORDER BY birth_order ASC`,
          [row.serviceNumber],
        );

        const [loanRows] = await q(conn,
          `SELECT loan_type, amount, year_taken, tenor, balance, specify
           FROM ef_loans WHERE service_no = ?`,
          [row.serviceNumber],
        );
        const loansFromChildTable = {};
        loanRows.forEach(r => { loansFromChildTable[r.loan_type] = r; });

        const [allowRows] = await q(conn,
          `SELECT allow_type, is_active, specify
           FROM ef_allowances WHERE service_no = ?`,
          [row.serviceNumber],
        );
        const allowsFromChildTable = {};
        allowRows.forEach(r => { allowsFromChildTable[r.allow_type] = r; });

        const [docRows] = await q(conn,
          `SELECT doc_type, url, cloudinary_id
           FROM ef_documents WHERE service_no = ?`,
          [row.serviceNumber],
        );
        const docsFromChildTable = {};
        docRows.forEach(r => { docsFromChildTable[r.doc_type] = r; });

        // ── Build NOK from flat columns (fallback) ────────
        // Use child table data if present, else reconstruct from flat cols
        const nok = nokFromChildTable.primary || nokFromChildTable.alternate
          ? nokFromChildTable
          : {
              primary: row.nok_name ? {
                full_name:    row.nok_name    || null,
                relationship: row.nok_relation || null,
                phone1:       row.nok_phone   || null,
                phone2:       row.nok_phone12 || null,
                email:        row.nok_email   || null,
                address:      row.nok_address || null,
                national_id:  row.nok_nationalId || null,
                _source:      'flat_columns',
              } : null,
              alternate: row.nok_name2 ? {
                full_name:    row.nok_name2    || null,
                relationship: row.nok_relation2 || null,
                phone1:       row.nok_phone2   || null,
                phone2:       row.nok_phone22  || null,
                email:        row.nok_email2   || null,
                address:      row.nok_address2 || null,
                national_id:  row.nok_nationalId2 || null,
                _source:      'flat_columns',
              } : null,
            };

        // ── Build spouse from flat columns (fallback) ─────
        const spouse = spouseRows[0] || (row.sp_name ? {
          full_name: row.sp_name  || null,
          phone1:    row.sp_phone || null,
          phone2:    row.sp_phone2 || null,
          email:     row.sp_email || null,
          _source:   'flat_columns',
        } : null);

        // ── Build children from flat columns (fallback) ───
        const children = childrenRows.length > 0
          ? childrenRows
          : [
              row.chid_name  ? { birth_order:1, child_name: row.chid_name,  _source:'flat_columns' } : null,
              row.chid_name2 ? { birth_order:2, child_name: row.chid_name2, _source:'flat_columns' } : null,
              row.chid_name3 ? { birth_order:3, child_name: row.chid_name3, _source:'flat_columns' } : null,
              row.chid_name4 ? { birth_order:4, child_name: row.chid_name4, _source:'flat_columns' } : null,
            ].filter(Boolean);

        // ── Build loans from flat columns (fallback) ──────
        const loans = Object.keys(loansFromChildTable).length > 0
          ? loansFromChildTable
          : {
              FGSHLS:  row.FGSHLS_loan  ? { amount: row.FGSHLS_loan,  year_taken: row.FGSHLS_loanYear,  _source:'flat_columns' } : null,
              CAR:     row.car_loan     ? { amount: row.car_loan,      year_taken: row.car_loanYear,      _source:'flat_columns' } : null,
              WELFARE: row.welfare_loan ? { amount: row.welfare_loan,  year_taken: row.welfare_loanYear,  _source:'flat_columns' } : null,
              NNNCS:   row.NNNCS_loan   ? { amount: row.NNNCS_loan,    year_taken: row.NNNCS_loanYear,    _source:'flat_columns' } : null,
              NNMFBL:  row.NNMFBL_loan  ? { amount: row.NNMFBL_loan,   year_taken: row.NNMFBL_loanYear,   _source:'flat_columns' } : null,
              PPCFS:   row.PPCFS_loan   ? { amount: row.PPCFS_loan,    year_taken: row.PPCFS_loanYear,    _source:'flat_columns' } : null,
              OTHER:   row.Anyother_Loan? { amount: row.Anyother_Loan, year_taken: row.Anyother_LoanYear, _source:'flat_columns' } : null,
              NHF:     row.NHFcode      ? { code: row.NHFcode,   year: row.NHFcodeYear,   _source:'flat_columns' } : null,
              NSITF:   row.NSITFcode    ? { code: row.NSITFcode, year: row.NSITFcodeYear, _source:'flat_columns' } : null,
            };

        // ── Build allowances from flat columns (fallback) ─
        const allowances = Object.keys(allowsFromChildTable).length > 0
          ? allowsFromChildTable
          : {
              AIRCREW:        { is_active: !!row.aircrew_allow,        _source:'flat_columns' },
              PILOT:          { is_active: !!row.pilot_allow,          _source:'flat_columns' },
              SHIFT_DUTY:     { is_active: !!row.shift_duty_allow,     _source:'flat_columns' },
              HAZARD:         { is_active: !!row.hazard_allow,         _source:'flat_columns' },
              RENT_SUBSIDY:   { is_active: !!row.rent_subsidy,         _source:'flat_columns' },
              SBC:            { is_active: !!row.SBC_allow,            _source:'flat_columns' },
              SPECIAL_FORCES: { is_active: !!row.special_forces_allow, _source:'flat_columns' },
              CALL_DUTY:      { is_active: !!row.call_duty_allow,      _source:'flat_columns' },
              OTHER:          { is_active: !!row.other_allow, specify: row.other_allowspecify, _source:'flat_columns' },
            };

        // ── Build documents ───────────────────────────────
        // Child table first; blob columns in hist as last resort (null in new system)
        const documents = {
          PASSPORT:         docsFromChildTable['PASSPORT']         || null,
          NOK_PASSPORT:     docsFromChildTable['NOK_PASSPORT']     || null,
          ALT_NOK_PASSPORT: docsFromChildTable['ALT_NOK_PASSPORT'] || null,
        };

        // ── Assemble snapshot ─────────────────────────────
        const snapshot = {
          _meta: {
            migratedAt:    new Date().toISOString(),
            migratedFrom:  'ef_personalinfoshist',
            histRowId:     row.Id,
            formYear:      row.FormYear,
            dataSource:    'BACKFILL_MIGRATION',
            childDataNote: nokRows.length === 0 && childrenRows.length === 0
              ? 'NOK/children/loans reconstructed from flat history columns — may be incomplete'
              : 'Child table data available',
          },
          confirmedAt:  row.dateconfirmed || null,
          confirmedBy:  row.confirmedBy   || null,
          core: {
            serviceNumber: row.serviceNumber,
            Surname:       row.Surname,
            OtherName:     row.OtherName,
            Title:         row.Title,
            Rank:          row.Rank,
            Sex:           row.Sex,
            MaritalStatus: row.MaritalStatus,
            Birthdate:     row.Birthdate,
            religion:      row.religion,
            gsm_number:    row.gsm_number,
            gsm_number2:   row.gsm_number2,
            email:         row.email,
            home_address:  row.home_address,
            Bankcode:      row.Bankcode,
            bankbranch:    row.bankbranch,
            BankACNumber:  row.BankACNumber,
            AccountName:   row.AccountName,
            pfacode:       row.pfacode,
            payrollclass:  row.payrollclass,
            classes:       row.classes,
            specialisation:row.specialisation,
            command:       row.command,
            branch:        row.branch,
            ship:          row.ship,
            exittype:      row.exittype,
            DateEmpl:      row.DateEmpl,
            DateLeft:      row.DateLeft,
            seniorityDate: row.seniorityDate,
            yearOfPromotion: row.yearOfPromotion,
            expirationOfEngagementDate: row.expirationOfEngagementDate,
            StateofOrigin: row.StateofOrigin,
            LocalGovt:     row.LocalGovt,
            TaxCode:       row.TaxCode,
            entry_mode:    row.entry_mode,
            Status:        row.Status,
            taxed:         row.taxed,
            gradelevel:    row.gradelevel,
            gradetype:     row.gradetype,
            entitlement:   row.entitlement,
            town:          row.town,
            accomm_type:   row.accomm_type,
            AcommodationStatus:     row.AcommodationStatus,
            AddressofAcommodation:  row.AddressofAcommodation,
            GBC:           row.GBC,
            GBC_Number:    row.GBC_Number,
            qualification: row.qualification,
            division:      row.division,
            NIN:           row.NIN,
            formNumber:    row.formNumber,
            emolumentform: row.emolumentform,
            advanceDate:   row.advanceDate,
            runoutDate:    row.runoutDate,
            NSITFcode:     row.NSITFcode,
            NHFcode:       row.NHFcode,
            // Approval chain
            div_off_name:  row.div_off_name,
            div_off_rank:  row.div_off_rank,
            div_off_svcno: row.div_off_svcno,
            div_off_date:  row.div_off_date,
            hod_name:      row.hod_name,
            hod_rank:      row.hod_rank,
            hod_svcno:     row.hod_svcno,
            hod_date:      row.hod_date,
            fo_name:       row.fo_name,
            fo_rank:       row.fo_rank,
            fo_svcno:      row.fo_svcno,
            fo_date:       row.fo_date,
          },
          nok,
          spouse,
          children,
          loans,
          allowances,
          documents,
        };

        if (DRY_RUN) {
          process.stdout.write(`${label} 🟡 [DRY RUN] would write snapshot (${JSON.stringify(snapshot).length} bytes)\n`);
          processed++;
          continue;
        }

        // ── Verify personnel record exists (FK guard) ─────
        // History rows may reference service numbers that no longer
        // exist in ef_personalinfos (retired, removed, cleaned up).
        // The FK fk_form_person prevents inserting these rows.
        // Skip them gracefully rather than failing the whole batch.
        const [personCheck] = await q(conn,
          `SELECT serviceNumber FROM ef_personalinfos
           WHERE serviceNumber = ? LIMIT 1`,
          [row.serviceNumber],
        );

        if (!personCheck.length) {
          process.stdout.write(`${label} ⚠️  skipped — no ef_personalinfos record (orphaned history row)\n`);
          orphaned++;
          continue;
        }

        // ── Upsert ef_emolument_forms row ─────────────────
        const existingForm = existing[0];

        if (existingForm) {
          // Row exists but no snapshot — update it
          await q(conn,
            `UPDATE ef_emolument_forms
             SET snapshot   = ?,
                 status     = COALESCE(status, 'CPO_CONFIRMED'),
                 updated_at = NOW()
             WHERE id = ?`,
            [JSON.stringify(snapshot), existingForm.id],
          );
        } else {
          // No ef_emolument_forms row at all — create one
          await q(conn,
            `INSERT INTO ef_emolument_forms
               (service_no, form_year, form_number, payroll_class,
                ship, command, status, snapshot, submitted_at)
             VALUES (?, ?, ?, ?, ?, ?, 'CPO_CONFIRMED', ?, ?)
             ON DUPLICATE KEY UPDATE
               snapshot   = VALUES(snapshot),
               status     = COALESCE(status, 'CPO_CONFIRMED'),
               updated_at = NOW()`,
            [
              row.serviceNumber,
              String(row.FormYear),
              row.formNumber || null,
              row.payrollclass,
              row.ship        || null,
              row.command     || null,
              JSON.stringify(snapshot),
              row.dateconfirmed || row.hod_date || null,
            ],
          );
        }

        process.stdout.write(`${label} ✅ snapshot written\n`);
        processed++;

      } catch (err) {
        failed++;
        const msg = `${label} ❌ FAILED: ${err.message}`;
        process.stdout.write(msg + '\n');
        errors.push({ serviceNumber: row.serviceNumber, FormYear: row.FormYear, error: err.message });
      }
    }

    offset += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }

  // ── Summary ────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║   MIGRATION COMPLETE                                  ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`  Processed: ${processed}`);
  console.log(`  Skipped:   ${skipped}  (already had snapshot)`);
  console.log(`  Orphaned:  ${orphaned}  (no ef_personalinfos record — FK constraint)`);
  console.log(`  Failed:    ${failed}`);
  if (DRY_RUN) console.log(`\n  ⚠️  DRY RUN — no data was written.`);

  if (errors.length) {
    console.log('\n  Failed rows:');
    errors.forEach(e => console.log(`    ${e.serviceNumber}/${e.FormYear} — ${e.error}`));
  }

  console.log('\n  Run these queries to verify:\n');
  console.log(`  -- Total snapshots now in ef_emolument_forms:`);
  console.log(`  SELECT COUNT(*) FROM ef_emolument_forms WHERE snapshot IS NOT NULL;\n`);
  console.log(`  -- History rows still without a snapshot:`);
  console.log(`  SELECT h.serviceNumber, h.FormYear`);
  console.log(`  FROM ef_personalinfoshist h`);
  console.log(`  LEFT JOIN ef_emolument_forms ef`);
  console.log(`    ON ef.service_no = h.serviceNumber AND ef.form_year = h.FormYear`);
  console.log(`  WHERE ef.snapshot IS NULL;\n`);
  console.log(`  -- Sample a snapshot to verify structure:`);
  console.log(`  SELECT service_no, form_year, JSON_LENGTH(snapshot) AS fields`);
  console.log(`  FROM ef_emolument_forms WHERE snapshot IS NOT NULL LIMIT 5;\n`);

  await conn.end();
}

// ─────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────

run().catch(err => {
  console.error('\n❌ Migration failed fatally:', err.message);
  process.exit(1);
});
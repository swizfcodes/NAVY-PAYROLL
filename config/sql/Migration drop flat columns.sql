-- ============================================================
-- MIGRATION: Drop flat columns from ef_personalinfos and
--            ef_personalinfoshist, slim down history table.
--
-- Run order:
--   1. Verify child tables have data before dropping parent cols
--   2. Drop flat columns from ef_personalinfos
--   3. Drop flat columns + heavy columns from ef_personalinfoshist
--   4. ef_personalinfoshist becomes a lightweight index/archive table
--
-- ef_emolument_forms.snapshot is the authoritative historical
-- record for full form data. ef_personalinfoshist is now only
-- used for listing/filtering by year, ship, command, class.
--
-- IMPORTANT: Take a full database backup before running.
-- Run each section in a transaction and verify row counts.
-- ============================================================


-- ============================================================
-- SECTION 0 — PRE-FLIGHT CHECKS
-- Run these selects before executing any ALTER statements.
-- Confirm child tables have data before dropping parent columns.
-- ============================================================

-- Confirm ef_nok has rows (replaces flat nok_* columns)
SELECT COUNT(*) AS ef_nok_rows FROM ef_nok;

-- Confirm ef_spouse has rows (replaces sp_* columns)
SELECT COUNT(*) AS ef_spouse_rows FROM ef_spouse;

-- Confirm ef_children has rows (replaces chid_name* columns)
SELECT COUNT(*) AS ef_children_rows FROM ef_children;

-- Confirm ef_loans has rows (replaces *_loan columns)
SELECT COUNT(*) AS ef_loans_rows FROM ef_loans;

-- Confirm ef_allowances has rows (replaces *_allow columns)
SELECT COUNT(*) AS ef_allowances_rows FROM ef_allowances;

-- Confirm ef_documents has rows (replaces Passport blob columns)
SELECT COUNT(*) AS ef_documents_rows FROM ef_documents;

-- Confirm snapshots exist before dropping history flat cols
SELECT COUNT(*) AS snapshot_count
FROM ef_emolument_forms
WHERE snapshot IS NOT NULL;

-- ============================================================
-- SECTION 1 — DROP FLAT COLUMNS FROM ef_personalinfos
--
-- These columns are replaced by normalised child tables:
--   ef_nok        → nok_* columns (primary + alternate)
--   ef_spouse     → sp_* columns
--   ef_children   → chid_name* columns
--   ef_loans      → *_loan + *_loanYear columns
--   ef_allowances → *_allow columns
--   ef_documents  → Passport, NokPassport, AltNokPassport blobs
--                   + mypassporturl, mynokpassporturl, myalternatenokpassporturl
-- ============================================================

ALTER TABLE ef_personalinfos

  -- NOK primary (replaced by ef_nok WHERE nok_order = 1)
  DROP COLUMN IF EXISTS nok_address,
  DROP COLUMN IF EXISTS nok_relation,
  DROP COLUMN IF EXISTS nok_phone,
  DROP COLUMN IF EXISTS nok_email,
  DROP COLUMN IF EXISTS nok_nationalId,
  DROP COLUMN IF EXISTS nok_name,
  DROP COLUMN IF EXISTS nok_phone12,

  -- NOK alternate (replaced by ef_nok WHERE nok_order = 2)
  DROP COLUMN IF EXISTS nok_address2,
  DROP COLUMN IF EXISTS nok_relation2,
  DROP COLUMN IF EXISTS nok_phone2,
  DROP COLUMN IF EXISTS nok_email2,
  DROP COLUMN IF EXISTS nok_nationalId2,
  DROP COLUMN IF EXISTS nok_name2,
  DROP COLUMN IF EXISTS nok_phone22,

  -- Spouse (replaced by ef_spouse)
  DROP COLUMN IF EXISTS sp_name,
  DROP COLUMN IF EXISTS sp_phone,
  DROP COLUMN IF EXISTS sp_phone2,
  DROP COLUMN IF EXISTS sp_email,

  -- Children (replaced by ef_children)
  DROP COLUMN IF EXISTS chid_name,
  DROP COLUMN IF EXISTS chid_name2,
  DROP COLUMN IF EXISTS chid_name3,
  DROP COLUMN IF EXISTS chid_name4,

  -- Loans (replaced by ef_loans)
  DROP COLUMN IF EXISTS FGSHLS_loan,
  DROP COLUMN IF EXISTS FGSHLS_loanYear,
  DROP COLUMN IF EXISTS car_loan,
  DROP COLUMN IF EXISTS car_loanYear,
  DROP COLUMN IF EXISTS welfare_loan,
  DROP COLUMN IF EXISTS welfare_loanYear,
  DROP COLUMN IF EXISTS NNNCS_loan,
  DROP COLUMN IF EXISTS NNNCS_loanYear,
  DROP COLUMN IF EXISTS NNMFBL_loan,
  DROP COLUMN IF EXISTS NNMFBL_loanYear,
  DROP COLUMN IF EXISTS PPCFS_loan,
  DROP COLUMN IF EXISTS PPCFS_loanYear,
  DROP COLUMN IF EXISTS Anyother_Loan,
  DROP COLUMN IF EXISTS Anyother_LoanYear,
  DROP COLUMN IF EXISTS NHFcode,
  DROP COLUMN IF EXISTS NHFcodeYear,
  DROP COLUMN IF EXISTS NSITFcode,
  DROP COLUMN IF EXISTS NSITFcodeYear,

  -- Allowances (replaced by ef_allowances)
  DROP COLUMN IF EXISTS aircrew_allow,
  DROP COLUMN IF EXISTS pilot_allow,
  DROP COLUMN IF EXISTS shift_duty_allow,
  DROP COLUMN IF EXISTS hazard_allow,
  DROP COLUMN IF EXISTS rent_subsidy,
  DROP COLUMN IF EXISTS SBC_allow,
  DROP COLUMN IF EXISTS special_forces_allow,
  DROP COLUMN IF EXISTS call_duty_allow,
  DROP COLUMN IF EXISTS other_allow,
  DROP COLUMN IF EXISTS other_allowspecify,

  -- Photo blobs (replaced by ef_documents Cloudinary URLs)
  DROP COLUMN IF EXISTS Passport,
  DROP COLUMN IF EXISTS NokPassport,
  DROP COLUMN IF EXISTS AltNokPassport,

  -- Old Cloudinary URL flat columns (replaced by ef_documents)
  DROP COLUMN IF EXISTS mypassporturl,
  DROP COLUMN IF EXISTS mynokpassporturl,
  DROP COLUMN IF EXISTS myalternatenokpassporturl;


-- ============================================================
-- SECTION 2 — SLIM DOWN ef_personalinfoshist
--
-- ef_personalinfoshist becomes a lightweight index/archive table.
-- Full form data is in ef_emolument_forms.snapshot.
--
-- KEEP these columns (needed for filtering and listing):
--   FormYear, serviceNumber, Surname, OtherName, Title, Rank,
--   payrollclass, classes, ship, command, branch, Status,
--   formNumber, emolumentform, confirmedBy, dateconfirmed,
--   div_off_name, div_off_rank, div_off_svcno, div_off_date,
--   hod_name, hod_rank, hod_svcno, hod_date,
--   fo_name, fo_rank, fo_svcno, fo_date,
--   NIN, upload, datecreated, dateModify
--
-- DROP everything else — blobs, flat NOK/children/loan/allow cols.
-- ============================================================

ALTER TABLE ef_personalinfoshist

  -- Personal details no longer needed (prefill comes from ef_personalinfos)
  DROP COLUMN IF EXISTS Sex,
  DROP COLUMN IF EXISTS MaritalStatus,
  DROP COLUMN IF EXISTS Birthdate,
  DROP COLUMN IF EXISTS religion,
  DROP COLUMN IF EXISTS gsm_number,
  DROP COLUMN IF EXISTS gsm_number2,
  DROP COLUMN IF EXISTS email,
  DROP COLUMN IF EXISTS home_address,
  DROP COLUMN IF EXISTS Bankcode,
  DROP COLUMN IF EXISTS bankbranch,
  DROP COLUMN IF EXISTS BankACNumber,
  DROP COLUMN IF EXISTS AccountName,
  DROP COLUMN IF EXISTS bankbranch,
  DROP COLUMN IF EXISTS pfacode,
  DROP COLUMN IF EXISTS specialisation,
  DROP COLUMN IF EXISTS DateEmpl,
  DROP COLUMN IF EXISTS DateLeft,
  DROP COLUMN IF EXISTS seniorityDate,
  DROP COLUMN IF EXISTS yearOfPromotion,
  DROP COLUMN IF EXISTS expirationOfEngagementDate,
  DROP COLUMN IF EXISTS StateofOrigin,
  DROP COLUMN IF EXISTS LocalGovt,
  DROP COLUMN IF EXISTS TaxCode,
  DROP COLUMN IF EXISTS exittype,
  DROP COLUMN IF EXISTS entry_mode,
  DROP COLUMN IF EXISTS gradelevel,
  DROP COLUMN IF EXISTS gradetype,
  DROP COLUMN IF EXISTS taxed,
  DROP COLUMN IF EXISTS entitlement,
  DROP COLUMN IF EXISTS town,
  DROP COLUMN IF EXISTS accomm_type,
  DROP COLUMN IF EXISTS AcommodationStatus,
  DROP COLUMN IF EXISTS AddressofAcommodation,
  DROP COLUMN IF EXISTS GBC,
  DROP COLUMN IF EXISTS GBC_Number,
  DROP COLUMN IF EXISTS qualification,
  DROP COLUMN IF EXISTS division,
  DROP COLUMN IF EXISTS appointment,
  DROP COLUMN IF EXISTS advanceDate,
  DROP COLUMN IF EXISTS runoutDate,
  DROP COLUMN IF EXISTS rankId,
  DROP COLUMN IF EXISTS createdby,
  DROP COLUMN IF EXISTS datecreated,
  DROP COLUMN IF EXISTS dateModify,
  DROP COLUMN IF EXISTS dateVerify,
  DROP COLUMN IF EXISTS verifyBy,

  -- NOK flat columns (never properly populated in history anyway)
  DROP COLUMN IF EXISTS nok_address,
  DROP COLUMN IF EXISTS nok_relation,
  DROP COLUMN IF EXISTS nok_phone,
  DROP COLUMN IF EXISTS nok_email,
  DROP COLUMN IF EXISTS nok_nationalId,
  DROP COLUMN IF EXISTS nok_name,
  DROP COLUMN IF EXISTS nok_phone12,
  DROP COLUMN IF EXISTS nok_address2,
  DROP COLUMN IF EXISTS nok_relation2,
  DROP COLUMN IF EXISTS nok_phone2,
  DROP COLUMN IF EXISTS nok_email2,
  DROP COLUMN IF EXISTS nok_nationalId2,
  DROP COLUMN IF EXISTS nok_name2,
  DROP COLUMN IF EXISTS nok_phone22,

  -- Spouse flat columns
  DROP COLUMN IF EXISTS sp_name,
  DROP COLUMN IF EXISTS sp_phone,
  DROP COLUMN IF EXISTS sp_phone2,
  DROP COLUMN IF EXISTS sp_email,

  -- Children flat columns
  DROP COLUMN IF EXISTS chid_name,
  DROP COLUMN IF EXISTS chid_name2,
  DROP COLUMN IF EXISTS chid_name3,
  DROP COLUMN IF EXISTS chid_name4,

  -- Loan flat columns
  DROP COLUMN IF EXISTS FGSHLS_loan,
  DROP COLUMN IF EXISTS FGSHLS_loanYear,
  DROP COLUMN IF EXISTS car_loan,
  DROP COLUMN IF EXISTS car_loanYear,
  DROP COLUMN IF EXISTS welfare_loan,
  DROP COLUMN IF EXISTS welfare_loanYear,
  DROP COLUMN IF EXISTS NNNCS_loan,
  DROP COLUMN IF EXISTS NNNCS_loanYear,
  DROP COLUMN IF EXISTS NNMFBL_loan,
  DROP COLUMN IF EXISTS NNMFBL_loanYear,
  DROP COLUMN IF EXISTS PPCFS_loan,
  DROP COLUMN IF EXISTS PPCFS_loanYear,
  DROP COLUMN IF EXISTS Anyother_Loan,
  DROP COLUMN IF EXISTS Anyother_LoanYear,
  DROP COLUMN IF EXISTS NHFcode,
  DROP COLUMN IF EXISTS NHFcodeYear,
  DROP COLUMN IF EXISTS NSITFcode,
  DROP COLUMN IF EXISTS NSITFcodeYear,

  -- Allowance flat columns
  DROP COLUMN IF EXISTS aircrew_allow,
  DROP COLUMN IF EXISTS pilot_allow,
  DROP COLUMN IF EXISTS shift_duty_allow,
  DROP COLUMN IF EXISTS hazard_allow,
  DROP COLUMN IF EXISTS rent_subsidy,
  DROP COLUMN IF EXISTS SBC_allow,
  DROP COLUMN IF EXISTS special_forces_allow,
  DROP COLUMN IF EXISTS call_duty_allow,
  DROP COLUMN IF EXISTS other_allow,
  DROP COLUMN IF EXISTS other_allowspecify,

  -- Photo blobs (full data in snapshot, URLs in ef_documents)
  DROP COLUMN IF EXISTS Passport,
  DROP COLUMN IF EXISTS NokPassport,
  DROP COLUMN IF EXISTS AltNokPassport,
  DROP COLUMN IF EXISTS mypassporturl,
  DROP COLUMN IF EXISTS mynokpassporturl,
  DROP COLUMN IF EXISTS myalternatenokpassporturl;


-- ============================================================
-- SECTION 3 — ADD INDEX TO ef_personalinfoshist
-- Optimise the columns actually used for filtering now.
-- ============================================================

-- Index for year-based listing (most common query)
CREATE INDEX IF NOT EXISTS idx_hist_year
  ON ef_personalinfoshist (FormYear);

-- Index for personnel history lookup
CREATE INDEX IF NOT EXISTS idx_hist_svcno_year
  ON ef_personalinfoshist (serviceNumber, FormYear);

-- Index for ship + year reporting
CREATE INDEX IF NOT EXISTS idx_hist_ship_year
  ON ef_personalinfoshist (ship, FormYear);

-- Index for command + year reporting
CREATE INDEX IF NOT EXISTS idx_hist_command_year
  ON ef_personalinfoshist (command, FormYear);


-- ============================================================
-- SECTION 4 — UPDATE insertHistoryRecord IN cpo.repository.js
--
-- After running this migration, the INSERT in insertHistoryRecord
-- must be updated to only select the retained columns.
-- The query in cpo.repository.js should become:
--
--   INSERT INTO ef_personalinfoshist (
--     FormYear, serviceNumber, Surname, OtherName, Title, Rank,
--     payrollclass, classes, ship, command, branch, Status,
--     formNumber, emolumentform, confirmedBy, dateconfirmed,
--     div_off_name, div_off_rank, div_off_svcno, div_off_date,
--     hod_name, hod_rank, hod_svcno, hod_date,
--     fo_name, fo_rank, fo_svcno, fo_date,
--     NIN, upload
--   )
--   SELECT
--     ?, serviceNumber, Surname, OtherName, Title, Rank,
--     payrollclass, classes, ship, command, branch, Status,
--     formNumber, emolumentform, confirmedBy, dateconfirmed,
--     div_off_name, div_off_rank, div_off_svcno, div_off_date,
--     hod_name, hod_rank, hod_svcno, hod_date,
--     fo_name, fo_rank, fo_svcno, fo_date,
--     NIN, upload
--   FROM ef_personalinfos WHERE serviceNumber = ?
--
-- For full form data, use ef_emolument_forms.snapshot.
-- ============================================================


-- ============================================================
-- SECTION 5 — POST-MIGRATION VERIFICATION
-- Run after ALTER statements to confirm structure is correct.
-- ============================================================

-- Verify ef_personalinfos no longer has flat NOK columns
SELECT COUNT(*) AS should_be_zero
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME   = 'ef_personalinfos'
  AND COLUMN_NAME  IN ('nok_address','sp_name','chid_name','FGSHLS_loan',
                       'aircrew_allow','Passport','mypassporturl');

-- Verify ef_personalinfoshist only has index columns remaining
SELECT COLUMN_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME   = 'ef_personalinfoshist'
ORDER BY ORDINAL_POSITION;

-- Confirm ef_emolument_forms has snapshots for all confirmed forms
SELECT
  COUNT(*)                                           AS total_confirmed,
  SUM(CASE WHEN snapshot IS NOT NULL THEN 1 ELSE 0 END) AS has_snapshot,
  SUM(CASE WHEN snapshot IS NULL     THEN 1 ELSE 0 END) AS missing_snapshot
FROM ef_emolument_forms
WHERE status = 'CPO_CONFIRMED';
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
  DROP COLUMN nok_address,
  DROP COLUMN nok_relation,
  DROP COLUMN nok_phone,
  DROP COLUMN nok_email,
  DROP COLUMN nok_nationalId,
  DROP COLUMN nok_name,
  DROP COLUMN nok_phone12,

  -- NOK alternate (replaced by ef_nok WHERE nok_order = 2)
  DROP COLUMN nok_address2,
  DROP COLUMN nok_relation2,
  DROP COLUMN nok_phone2,
  DROP COLUMN nok_email2,
  DROP COLUMN nok_nationalId2,
  DROP COLUMN nok_name2,
  DROP COLUMN nok_phone22,

  -- Spouse (replaced by ef_spouse)
  DROP COLUMN sp_name,
  DROP COLUMN sp_phone,
  DROP COLUMN sp_phone2,
  DROP COLUMN sp_email,

  -- Children (replaced by ef_children)
  DROP COLUMN chid_name,
  DROP COLUMN chid_name2,
  DROP COLUMN chid_name3,
  DROP COLUMN chid_name4,

  -- Loans (replaced by ef_loans)
  DROP COLUMN FGSHLS_loan,
  DROP COLUMN FGSHLS_loanYear,
  DROP COLUMN car_loan,
  DROP COLUMN car_loanYear,
  DROP COLUMN welfare_loan,
  DROP COLUMN welfare_loanYear,
  DROP COLUMN NNNCS_loan,
  DROP COLUMN NNNCS_loanYear,
  DROP COLUMN NNMFBL_loan,
  DROP COLUMN NNMFBL_loanYear,
  DROP COLUMN PPCFS_loan,
  DROP COLUMN PPCFS_loanYear,
  DROP COLUMN Anyother_Loan,
  DROP COLUMN Anyother_LoanYear,
  DROP COLUMN NHFcode,
  DROP COLUMN NHFcodeYear,
  DROP COLUMN NSITFcode,
  DROP COLUMN NSITFcodeYear,

  -- Allowances (replaced by ef_allowances)
  DROP COLUMN aircrew_allow,
  DROP COLUMN pilot_allow,
  DROP COLUMN shift_duty_allow,
  DROP COLUMN hazard_allow,
  DROP COLUMN rent_subsidy,
  DROP COLUMN SBC_allow,
  DROP COLUMN special_forces_allow,
  DROP COLUMN call_duty_allow,
  DROP COLUMN other_allow,
  DROP COLUMN other_allowspecify,

  -- Photo blobs (replaced by ef_documents Cloudinary URLs)
  DROP COLUMN Passport,
  DROP COLUMN NokPassport,
  DROP COLUMN AltNokPassport,

  -- Old Cloudinary URL flat columns (replaced by ef_documents)
  DROP COLUMN mypassporturl,
  DROP COLUMN mynokpassporturl,
  DROP COLUMN myalternatenokpassporturl;


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
  DROP COLUMN Sex,
  DROP COLUMN MaritalStatus,
  DROP COLUMN Birthdate,
  DROP COLUMN religion,
  DROP COLUMN gsm_number,
  DROP COLUMN gsm_number2,
  DROP COLUMN email,
  DROP COLUMN home_address,
  DROP COLUMN Bankcode,
  DROP COLUMN bankbranch,
  DROP COLUMN BankACNumber,
  DROP COLUMN AccountName,
  DROP COLUMN bankbranch,
  DROP COLUMN pfacode,
  DROP COLUMN specialisation,
  DROP COLUMN DateEmpl,
  DROP COLUMN DateLeft,
  DROP COLUMN seniorityDate,
  DROP COLUMN yearOfPromotion,
  DROP COLUMN expirationOfEngagementDate,
  DROP COLUMN StateofOrigin,
  DROP COLUMN LocalGovt,
  DROP COLUMN TaxCode,
  DROP COLUMN exittype,
  DROP COLUMN entry_mode,
  DROP COLUMN gradelevel,
  DROP COLUMN gradetype,
  DROP COLUMN taxed,
  DROP COLUMN entitlement,
  DROP COLUMN town,
  DROP COLUMN accomm_type,
  DROP COLUMN AcommodationStatus,
  DROP COLUMN AddressofAcommodation,
  DROP COLUMN GBC,
  DROP COLUMN GBC_Number,
  DROP COLUMN qualification,
  DROP COLUMN division,
  DROP COLUMN appointment,
  DROP COLUMN advanceDate,
  DROP COLUMN runoutDate,
  DROP COLUMN rankId,
  DROP COLUMN createdby,
  DROP COLUMN datecreated,
  DROP COLUMN dateModify,
  DROP COLUMN dateVerify,
  DROP COLUMN verifyBy,

  -- NOK flat columns (never properly populated in history anyway)
  DROP COLUMN nok_address,
  DROP COLUMN nok_relation,
  DROP COLUMN nok_phone,
  DROP COLUMN nok_email,
  DROP COLUMN nok_nationalId,
  DROP COLUMN nok_name,
  DROP COLUMN nok_phone12,
  DROP COLUMN nok_address2,
  DROP COLUMN nok_relation2,
  DROP COLUMN nok_phone2,
  DROP COLUMN nok_email2,
  DROP COLUMN nok_nationalId2,
  DROP COLUMN nok_name2,
  DROP COLUMN nok_phone22,

  -- Spouse flat columns
  DROP COLUMN sp_name,
  DROP COLUMN sp_phone,
  DROP COLUMN sp_phone2,
  DROP COLUMN sp_email,

  -- Children flat columns
  DROP COLUMN chid_name,
  DROP COLUMN chid_name2,
  DROP COLUMN chid_name3,
  DROP COLUMN chid_name4,

  -- Loan flat columns
  DROP COLUMN FGSHLS_loan,
  DROP COLUMN FGSHLS_loanYear,
  DROP COLUMN car_loan,
  DROP COLUMN car_loanYear,
  DROP COLUMN welfare_loan,
  DROP COLUMN welfare_loanYear,
  DROP COLUMN NNNCS_loan,
  DROP COLUMN NNNCS_loanYear,
  DROP COLUMN NNMFBL_loan,
  DROP COLUMN NNMFBL_loanYear,
  DROP COLUMN PPCFS_loan,
  DROP COLUMN PPCFS_loanYear,
  DROP COLUMN Anyother_Loan,
  DROP COLUMN Anyother_LoanYear,
  DROP COLUMN NHFcode,
  DROP COLUMN NHFcodeYear,
  DROP COLUMN NSITFcode,
  DROP COLUMN NSITFcodeYear,

  -- Allowance flat columns
  DROP COLUMN aircrew_allow,
  DROP COLUMN pilot_allow,
  DROP COLUMN shift_duty_allow,
  DROP COLUMN hazard_allow,
  DROP COLUMN rent_subsidy,
  DROP COLUMN SBC_allow,
  DROP COLUMN special_forces_allow,
  DROP COLUMN call_duty_allow,
  DROP COLUMN other_allow,
  DROP COLUMN other_allowspecify,

  -- Photo blobs (full data in snapshot, URLs in ef_documents)
  DROP COLUMN Passport,
  DROP COLUMN NokPassport,
  DROP COLUMN AltNokPassport,
  DROP COLUMN mypassporturl,
  DROP COLUMN mynokpassporturl,
  DROP COLUMN myalternatenokpassporturl;


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
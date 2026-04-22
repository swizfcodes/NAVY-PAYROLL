-- =============================================================
-- EMOLUMENT SYSTEM — PHASE 1
-- FILE: 03_seed_migration.sql
-- DESC: Seed initial data and migrate existing admin users
-- RUN:  After 02_new_tables.sql
-- =============================================================

USE hicaddata;

-- -------------------------------------------------------------
-- SECTION A: MIGRATE EXISTING EMOL ADMINS
-- ef_nodeusers was the old admin table. We pull service numbers
-- that were active admins and seed them into ef_user_roles.
-- ef_nodeusers is dropped after this migration.
-- -------------------------------------------------------------

INSERT INTO ef_user_roles (user_id, role, scope_type, scope_value, assigned_by)
SELECT DISTINCT
  nu.UserName,          -- service number
  'EMOL_ADMIN',
  'GLOBAL',
  NULL,
  'SYSTEM_MIGRATION'    -- audit trail — this was a seeded record
FROM ef_nodeusers nu
WHERE
  nu.UserName IS NOT NULL
  AND nu.UserName != ''
  AND nu.IsActive = 1
  -- Only migrate if this service number actually exists in personalinfos
  AND EXISTS (
    SELECT 1 FROM ef_personalinfos p
    WHERE p.serviceNumber = nu.UserName
  )
ON DUPLICATE KEY UPDATE
  is_active = 1,
  assigned_by = 'SYSTEM_MIGRATION';


-- -------------------------------------------------------------
-- SECTION B: MIGRATE SHIP OFFICERS FROM ef_shiplogins
-- ef_shiplogins had DO and FO roles scoped to ships.
-- We migrate these to ef_user_roles with proper scope.
-- ef_shiplogins is dropped after this migration.
-- -------------------------------------------------------------

INSERT INTO ef_user_roles (user_id, role, scope_type, scope_value, assigned_by)
SELECT
  sl.ServiceNumber,
  CASE
    WHEN UPPER(sl.Appointment) = 'DO' THEN 'DO'
    WHEN UPPER(sl.Appointment) = 'FO' THEN 'FO'
    WHEN UPPER(sl.Appointment) = 'CPO' THEN 'CPO'
    ELSE NULL
  END AS role,
  'SHIP',
  sl.ship,
  'SYSTEM_MIGRATION'
FROM ef_shiplogins sl
WHERE
  sl.ServiceNumber IS NOT NULL
  AND sl.ServiceNumber != ''
  AND sl.Appointment IN ('DO','FO','CPO','do','fo','cpo')
  AND sl.ship IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM ef_personalinfos p
    WHERE p.serviceNumber = sl.ServiceNumber
  )
ON DUPLICATE KEY UPDATE
  is_active = 1,
  assigned_by = 'SYSTEM_MIGRATION';

-- Now safe to drop ef_shiplogins
DROP TABLE IF EXISTS ef_shiplogins;


-- -------------------------------------------------------------
-- SECTION C: MIGRATE EXISTING PHOTO URLS TO ef_documents
-- ef_personalinfos had mypassporturl, mynokpassporturl,
-- myalternatenokpassporturl as flat columns.
-- Migrate non-null values to ef_documents then we can
-- optionally drop those columns once confirmed.
-- -------------------------------------------------------------

-- Personnel passport
INSERT INTO ef_documents (service_no, doc_type, url, uploaded_by, uploaded_at)
SELECT
  serviceNumber,
  'PASSPORT',
  mypassporturl,
  'SYSTEM_MIGRATION',
  NOW()
FROM ef_personalinfos
WHERE mypassporturl IS NOT NULL
  AND mypassporturl != ''
ON DUPLICATE KEY UPDATE
  url = VALUES(url);

-- NOK passport
INSERT INTO ef_documents (service_no, doc_type, url, uploaded_by, uploaded_at)
SELECT
  serviceNumber,
  'NOK_PASSPORT',
  mynokpassporturl,
  'SYSTEM_MIGRATION',
  NOW()
FROM ef_personalinfos
WHERE mynokpassporturl IS NOT NULL
  AND mynokpassporturl != ''
ON DUPLICATE KEY UPDATE
  url = VALUES(url);

-- Alternate NOK passport
INSERT INTO ef_documents (service_no, doc_type, url, uploaded_by, uploaded_at)
SELECT
  serviceNumber,
  'ALT_NOK_PASSPORT',
  myalternatenokpassporturl,
  'SYSTEM_MIGRATION',
  NOW()
FROM ef_personalinfos
WHERE myalternatenokpassporturl IS NOT NULL
  AND myalternatenokpassporturl != ''
ON DUPLICATE KEY UPDATE
  url = VALUES(url);


-- -------------------------------------------------------------
-- SECTION D: MIGRATE NOK DATA TO ef_nok
-- Flatten the nok_* columns into proper rows
-- -------------------------------------------------------------

-- Primary NOK
INSERT INTO ef_nok (
  service_no, nok_order, full_name, relationship,
  phone1, phone2, email, address, national_id
)
SELECT
  p.serviceNumber,
  1,
  p.nok_name,
  r.description,        -- resolve relationship ID to text
  p.nok_phone,
  p.nok_phone2,
  p.nok_email,
  p.nok_address,
  p.nok_nationalId
FROM ef_personalinfos p
LEFT JOIN ef_relationships r ON r.Id = p.nok_relation
WHERE p.nok_name IS NOT NULL AND p.nok_name != ''
ON DUPLICATE KEY UPDATE
  full_name    = VALUES(full_name),
  relationship = VALUES(relationship),
  phone1       = VALUES(phone1),
  phone2       = VALUES(phone2),
  email        = VALUES(email),
  address      = VALUES(address),
  national_id  = VALUES(national_id);

-- Alternate NOK
INSERT INTO ef_nok (
  service_no, nok_order, full_name, relationship,
  phone1, phone2, email, address, national_id
)
SELECT
  p.serviceNumber,
  2,
  p.nok_name2,
  r.description,
  p.nok_phone2,
  p.nok_phone22,
  p.nok_email2,
  p.nok_address2,
  p.nok_nationalId2
FROM ef_personalinfos p
LEFT JOIN ef_relationships r ON r.Id = p.nok_relation2
WHERE p.nok_name2 IS NOT NULL AND p.nok_name2 != ''
ON DUPLICATE KEY UPDATE
  full_name    = VALUES(full_name),
  relationship = VALUES(relationship),
  phone1       = VALUES(phone1),
  phone2       = VALUES(phone2),
  email        = VALUES(email),
  address      = VALUES(address),
  national_id  = VALUES(national_id);


-- -------------------------------------------------------------
-- SECTION E: MIGRATE SPOUSE DATA TO ef_spouse
-- -------------------------------------------------------------

INSERT INTO ef_spouse (service_no, full_name, phone1, phone2, email)
SELECT
  serviceNumber,
  sp_name,
  sp_phone,
  sp_phone2,
  sp_email
FROM ef_personalinfos
WHERE sp_name IS NOT NULL AND sp_name != ''
ON DUPLICATE KEY UPDATE
  full_name = VALUES(full_name),
  phone1    = VALUES(phone1),
  phone2    = VALUES(phone2),
  email     = VALUES(email);


-- -------------------------------------------------------------
-- SECTION F: MIGRATE CHILDREN TO ef_children
-- chid_name1 through chid_name4 become rows
-- -------------------------------------------------------------

INSERT INTO ef_children (service_no, child_name, birth_order)
SELECT serviceNumber, chid_name, 1
FROM ef_personalinfos
WHERE chid_name IS NOT NULL AND chid_name != '';

INSERT INTO ef_children (service_no, child_name, birth_order)
SELECT serviceNumber, chid_name2, 2
FROM ef_personalinfos
WHERE chid_name2 IS NOT NULL AND chid_name2 != '';

INSERT INTO ef_children (service_no, child_name, birth_order)
SELECT serviceNumber, chid_name3, 3
FROM ef_personalinfos
WHERE chid_name3 IS NOT NULL AND chid_name3 != '';

INSERT INTO ef_children (service_no, child_name, birth_order)
SELECT serviceNumber, chid_name4, 4
FROM ef_personalinfos
WHERE chid_name4 IS NOT NULL AND chid_name4 != '';


-- -------------------------------------------------------------
-- SECTION G: MIGRATE LOANS TO ef_loans
-- Each loan column becomes a row (only where value is not null/empty)
-- -------------------------------------------------------------

INSERT INTO ef_loans (service_no, loan_type, amount, year_taken)
SELECT serviceNumber, 'FGSHLS', NULL, FGSHLS_loanYear
FROM ef_personalinfos
WHERE FGSHLS_loan IS NOT NULL AND FGSHLS_loan != '' AND FGSHLS_loan != '0'
ON DUPLICATE KEY UPDATE year_taken = VALUES(year_taken);

INSERT INTO ef_loans (service_no, loan_type, amount, year_taken)
SELECT serviceNumber, 'CAR', NULL, car_loanYear
FROM ef_personalinfos
WHERE car_loan IS NOT NULL AND car_loan != '' AND car_loan != '0'
ON DUPLICATE KEY UPDATE year_taken = VALUES(year_taken);

INSERT INTO ef_loans (service_no, loan_type, amount, year_taken)
SELECT serviceNumber, 'WELFARE', NULL, welfare_loanYear
FROM ef_personalinfos
WHERE welfare_loan IS NOT NULL AND welfare_loan != '' AND welfare_loan != '0'
ON DUPLICATE KEY UPDATE year_taken = VALUES(year_taken);

INSERT INTO ef_loans (service_no, loan_type, amount, year_taken)
SELECT serviceNumber, 'NNNCS', NULL, NNNCS_loanYear
FROM ef_personalinfos
WHERE NNNCS_loan IS NOT NULL AND NNNCS_loan != '' AND NNNCS_loan != '0'
ON DUPLICATE KEY UPDATE year_taken = VALUES(year_taken);

INSERT INTO ef_loans (service_no, loan_type, amount, year_taken)
SELECT serviceNumber, 'NNMFBL', NULL, NNMFBL_loanYear
FROM ef_personalinfos
WHERE NNMFBL_loan IS NOT NULL AND NNMFBL_loan != '' AND NNMFBL_loan != '0'
ON DUPLICATE KEY UPDATE year_taken = VALUES(year_taken);

INSERT INTO ef_loans (service_no, loan_type, amount, year_taken)
SELECT serviceNumber, 'PPCFS', NULL, PPCFS_loanYear
FROM ef_personalinfos
WHERE PPCFS_loan IS NOT NULL AND PPCFS_loan != '' AND PPCFS_loan != '0'
ON DUPLICATE KEY UPDATE year_taken = VALUES(year_taken);

INSERT INTO ef_loans (service_no, loan_type, amount, year_taken)
SELECT serviceNumber, 'OTHER', NULL, Anyother_LoanYear
FROM ef_personalinfos
WHERE Anyother_Loan IS NOT NULL AND Anyother_Loan != '' AND Anyother_Loan != '0'
ON DUPLICATE KEY UPDATE year_taken = VALUES(year_taken);


-- -------------------------------------------------------------
-- SECTION H: MIGRATE ALLOWANCES TO ef_allowances
-- Only insert where the allowance was marked active (not null/empty/'No')
-- -------------------------------------------------------------

INSERT INTO ef_allowances (service_no, allow_type, is_active)
SELECT serviceNumber, 'AIRCREW', 1 FROM ef_personalinfos
WHERE aircrew_allow IS NOT NULL AND aircrew_allow NOT IN ('','No','0')
ON DUPLICATE KEY UPDATE is_active = 1;

INSERT INTO ef_allowances (service_no, allow_type, is_active)
SELECT serviceNumber, 'PILOT', 1 FROM ef_personalinfos
WHERE pilot_allow IS NOT NULL AND pilot_allow NOT IN ('','No','0')
ON DUPLICATE KEY UPDATE is_active = 1;

INSERT INTO ef_allowances (service_no, allow_type, is_active)
SELECT serviceNumber, 'SHIFT_DUTY', 1 FROM ef_personalinfos
WHERE shift_duty_allow IS NOT NULL AND shift_duty_allow NOT IN ('','No','0')
ON DUPLICATE KEY UPDATE is_active = 1;

INSERT INTO ef_allowances (service_no, allow_type, is_active)
SELECT serviceNumber, 'HAZARD', 1 FROM ef_personalinfos
WHERE hazard_allow IS NOT NULL AND hazard_allow NOT IN ('','No','0')
ON DUPLICATE KEY UPDATE is_active = 1;

INSERT INTO ef_allowances (service_no, allow_type, is_active)
SELECT serviceNumber, 'RENT_SUBSIDY', 1 FROM ef_personalinfos
WHERE rent_subsidy IS NOT NULL AND rent_subsidy NOT IN ('','No','0')
ON DUPLICATE KEY UPDATE is_active = 1;

INSERT INTO ef_allowances (service_no, allow_type, is_active)
SELECT serviceNumber, 'SBC', 1 FROM ef_personalinfos
WHERE SBC_allow IS NOT NULL AND SBC_allow NOT IN ('','No','0')
ON DUPLICATE KEY UPDATE is_active = 1;

INSERT INTO ef_allowances (service_no, allow_type, is_active)
SELECT serviceNumber, 'SPECIAL_FORCES', 1 FROM ef_personalinfos
WHERE special_forces_allow IS NOT NULL AND special_forces_allow NOT IN ('','No','0')
ON DUPLICATE KEY UPDATE is_active = 1;

INSERT INTO ef_allowances (service_no, allow_type, is_active)
SELECT serviceNumber, 'CALL_DUTY', 1 FROM ef_personalinfos
WHERE call_duty_allow IS NOT NULL AND call_duty_allow NOT IN ('','No','0')
ON DUPLICATE KEY UPDATE is_active = 1;

INSERT INTO ef_allowances (service_no, allow_type, is_active, specify)
SELECT serviceNumber, 'OTHER', 1, other_allowspecify FROM ef_personalinfos
WHERE other_allow IS NOT NULL AND other_allow NOT IN ('','No','0')
ON DUPLICATE KEY UPDATE is_active = 1, specify = VALUES(specify);


-- -------------------------------------------------------------
-- SECTION I: VALIDATION QUERIES
-- Run these after migration to confirm data integrity.
-- All counts should be > 0 and match expectations.
-- -------------------------------------------------------------

SELECT 'ef_user_roles EMOL_ADMIN count' AS check_name,
       COUNT(*) AS count
FROM ef_user_roles WHERE role = 'EMOL_ADMIN';

SELECT 'ef_user_roles DO/FO/CPO count' AS check_name,
       COUNT(*) AS count
FROM ef_user_roles WHERE role IN ('DO','FO','CPO');

SELECT 'ef_nok migrated' AS check_name, COUNT(*) AS count FROM ef_nok;
SELECT 'ef_spouse migrated' AS check_name, COUNT(*) AS count FROM ef_spouse;
SELECT 'ef_children migrated' AS check_name, COUNT(*) AS count FROM ef_children;
SELECT 'ef_loans migrated' AS check_name, COUNT(*) AS count FROM ef_loans;
SELECT 'ef_allowances migrated' AS check_name, COUNT(*) AS count FROM ef_allowances;
SELECT 'ef_documents (passports)' AS check_name, COUNT(*) AS count FROM ef_documents;

-- Show any service numbers in ef_user_roles that DON'T exist in ef_personalinfos
-- This should return 0 rows — if it doesn't, investigate before proceeding
SELECT ur.user_id, ur.role
FROM ef_user_roles ur
LEFT JOIN ef_personalinfos p ON p.serviceNumber = ur.user_id
WHERE p.serviceNumber IS NULL;
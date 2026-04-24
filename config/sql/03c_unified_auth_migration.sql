-- =============================================================
-- EMOLUMENT SYSTEM — PHASE 1
-- FILE: 03c_unified_auth_migration.sql (FINAL)
-- DESC: Unified auth via hr_employees as password source.
--       Replaces the slow cross-db aspnetusers migration.
--
-- BACKGROUND:
--   aspnetusers.PasswordHash was base64(accountNo) — not a real
--   hash. There is nothing worth migrating from it. Everyone
--   gets BankACNumber as initial password, same as the old system.
--   Real admins are inserted manually at the end.
--
-- RUN ORDER:
--   01_schema_remediation.sql
--   02_new_tables.sql
--   03_seed_migration.sql   (NOK/children/loans/allowances/photos)
--   03b_seed_migration_fix.sql  (truncation fixes)
--   THIS FILE
-- =============================================================

USE hicaddata;


-- =============================================================
-- EMOLUMENT SYSTEM
-- DESC: Add token column to hr_employees for login persistence.
--       Mirrors what the payroll system does in users.token
-- =============================================================

ALTER TABLE hr_employees
  ADD COLUMN token TEXT DEFAULT NULL
    COMMENT 'Current JWT — cleared on logout, replaced on new login';

-- Index on Empl_ID should already exist from 03c
-- but ensure it's there for fast token lookups
ALTER TABLE hr_employees
  ADD INDEX idx_hr_empl_id_token (Empl_ID);

-- ─────────────────────────────────────────────────────────────
-- SECTION A: ADD PASSWORD COLUMN TO hr_employees
-- Single source of truth for ALL personnel authentication.
-- ─────────────────────────────────────────────────────────────

ALTER TABLE hr_employees
  ADD COLUMN password VARCHAR(255) DEFAULT NULL
    COMMENT 'Unified password — initial value is BankACNumber',
  ADD COLUMN password_changed_at DATETIME DEFAULT NULL
    COMMENT 'Set when user changes from default password',
  ADD COLUMN force_change TINYINT(1) DEFAULT 1
    COMMENT '1 = must change password on next login';

-- Index for fast login lookups
-- ALTER TABLE hr_employees
  -- ADD INDEX idx_hr_empl_id (Empl_ID);


-- ─────────────────────────────────────────────────────────────
-- SECTION B: SEED PASSWORDS — ONE FAST BATCH UPDATE
--
-- Priority order:
--   1. BankACNumber  (what old system used)
--   2. Empl_ID       (fallback if no account number)
--
-- No cross-database queries. No subqueries. Single UPDATE.
-- Runs in seconds not minutes.
-- ─────────────────────────────────────────────────────────────

SET SQL_SAFE_UPDATES = 0;
UPDATE hr_employees
SET
  password = CASE
    WHEN BankACNumber IS NOT NULL
      AND TRIM(BankACNumber) != ''
    THEN TRIM(BankACNumber)
    ELSE Empl_ID                    -- fallback: service number
  END,
  force_change = 1                  -- everyone must change on first login
WHERE password IS NULL;             -- only seed those not yet set
SET SQL_SAFE_UPDATES = 1;

-- How many got seeded?
SELECT
  'Passwords seeded' AS status,
  COUNT(*) AS total,
  SUM(CASE WHEN BankACNumber IS NOT NULL AND TRIM(BankACNumber) != ''
           THEN 1 ELSE 0 END) AS seeded_from_bank_account,
  SUM(CASE WHEN BankACNumber IS NULL OR TRIM(BankACNumber) = ''
           THEN 1 ELSE 0 END) AS seeded_from_empl_id
FROM hr_employees
WHERE password IS NOT NULL;


-- ─────────────────────────────────────────────────────────────
-- SECTION C: FIX WRONG EMOL_ADMIN SEEDING
-- The previous 03_seed_migration.sql wrongly made everyone from
-- ef_nodeusers an EMOL_ADMIN. nodeusers = 40k personnel, not admins.
-- Delete all migration-seeded EMOL_ADMINs.
-- ─────────────────────────────────────────────────────────────

DELETE FROM ef_user_roles
WHERE role = 'EMOL_ADMIN'
  AND assigned_by IN ('SYSTEM_MIGRATION', 'BOOTSTRAP');

SELECT 'EMOL_ADMINs after cleanup' AS status, COUNT(*) AS count
FROM ef_user_roles WHERE role = 'EMOL_ADMIN';
-- Should return 0. Real admins inserted below.


-- ─────────────────────────────────────────────────────────────
-- SECTION D: BOOTSTRAP REAL EMOL_ADMINs
--
-- !! ACTION REQUIRED !!
-- Get the service numbers of the 2-3 real system admins from
-- the client. Uncomment and fill in below before running.
-- These are the CPO office staff who managed the old system.
-- ─────────────────────────────────────────────────────────────

/*
INSERT INTO ef_user_roles
  (user_id, role, scope_type, scope_value, assigned_by)
VALUES
  ('NN/XXXXX', 'EMOL_ADMIN', 'GLOBAL', NULL, 'SYSTEM_SETUP'),
  ('NN/XXXXX', 'EMOL_ADMIN', 'GLOBAL', NULL, 'SYSTEM_SETUP');
  -- Add more rows as needed
*/


-- ─────────────────────────────────────────────────────────────
-- SECTION E: VERIFY SHIP OFFICERS STILL INTACT
-- (seeded from ef_shiplogins in 03_seed_migration.sql)
-- ─────────────────────────────────────────────────────────────

SELECT
  role,
  scope_type,
  COUNT(*) AS count
FROM ef_user_roles
WHERE role IN ('DO', 'FO', 'CPO')
  AND is_active = 1
GROUP BY role, scope_type;


-- ─────────────────────────────────────────────────────────────
-- SECTION F: DROP OLD REDUNDANT TABLES
-- ef_nodeusers data has been accounted for (personnel = ef_personalinfos)
-- ef_shiplogins data migrated to ef_user_roles in 03_seed_migration
-- ef_personnellogins replaced by hr_employees + ef_user_roles
-- ─────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS ef_nodeusers;
DROP TABLE IF EXISTS ef_personnellogins;
-- ef_shiplogins already dropped in 03_seed_migration.sql
-- if it still exists here, drop it:
DROP TABLE IF EXISTS ef_shiplogins;


-- ─────────────────────────────────────────────────────────────
-- FINAL AUDIT
-- Run this after everything to confirm state is correct
-- ─────────────────────────────────────────────────────────────

SELECT
  '── FINAL AUTH STATE ──'                                           AS '',
  NULL                                                               AS count;

SELECT 'hr_employees with password'   AS check_name,
       COUNT(*)                        AS count
FROM hr_employees WHERE password IS NOT NULL;

SELECT 'hr_employees WITHOUT password' AS check_name,
       COUNT(*)                         AS count
FROM hr_employees WHERE password IS NULL;
-- Should be 0

SELECT 'payroll users (users table)'  AS check_name,
       COUNT(*)                        AS count
FROM users;
-- Should be the small number of payroll staff only (~100-500)
-- NOT 40k

SELECT 'emolument personnel'          AS check_name,
       COUNT(*)                        AS count
FROM ef_personalinfos;

SELECT 'EMOL_ADMINs'                  AS check_name,
       COUNT(*)                        AS count
FROM ef_user_roles WHERE role = 'EMOL_ADMIN' AND is_active = 1;
-- Should be 2-3 after manual bootstrap

SELECT 'Ship officers (DO/FO/CPO)'    AS check_name,
       COUNT(*)                        AS count
FROM ef_user_roles
WHERE role IN ('DO','FO','CPO') AND is_active = 1;

-- Personnel in ef_personalinfos but NOT in hr_employees
-- (these people can do emolument but NOT payslip)
SELECT 'In emolument but not payroll HR' AS check_name,
       COUNT(*)                           AS count
FROM ef_personalinfos p
WHERE NOT EXISTS (
  SELECT 1 FROM hr_employees h WHERE h.Empl_ID = p.serviceNumber
);

-- Drop password column from users table since payroll is now unified with hr_employees
ALTER TABLE users DROP COLUMN IF EXISTS password;


-- ADD Email Quota to hr_employees
alter table hr_employees add column `storage_used_bytes` bigint DEFAULT '0';
alter table hr_employees add column `storage_used_bytes` bigint DEFAULT '0';

-- DROP existing in users
alter table users drop column storage_used_bytes;
alter table users drop column storage_used_bytes;

-- VERIFICATION
SELECT storage_used_bytes, storage_used_bytes FROM hicaddata.hr_employees;


-- TRIGGERS TO SET PASSWORD FOR NEW PERSONNEL --
DELIMITER $$

CREATE TRIGGER trg_hr_employees_password
BEFORE INSERT ON hr_employees
FOR EACH ROW
BEGIN
    -- If Bank Account exists, use it as password
    IF NEW.BankACNumber IS NOT NULL AND NEW.BankACNumber <> '' THEN
        SET NEW.password = NEW.BankACNumber;
    ELSE
        -- fallback to employee ID
        SET NEW.password = NEW.Empl_ID;
    END IF;

    -- force password change
    SET NEW.force_change = 1;
END$$

DELIMITER ;


DELIMITER $$

CREATE TRIGGER trg_hr_employees_password_update
BEFORE UPDATE ON hr_employees
FOR EACH ROW
BEGIN
    IF NEW.force_change = 1 
       AND NOT (NEW.BankACNumber <=> OLD.BankACNumber) THEN

        IF NEW.BankACNumber IS NOT NULL AND NEW.BankACNumber <> '' THEN
            SET NEW.password = NEW.BankACNumber;
        ELSE
            SET NEW.password = NEW.Empl_ID;
        END IF;

    END IF;
END$$

DELIMITER ;
-- =============================================================================
-- MIGRATION: emolument system performance indexes
-- Target DB : DB_OFFICERS (ef_* tables)
-- MySQL ver : 8.0+ (InnoDB). All DDL uses ALGORITHM=INPLACE, LOCK=NONE
--             so it runs online without table locks in production.
-- Safe to re-run: every statement is wrapped in existence checks so running
--             this twice is a no-op (no errors, no duplicate indexes).
-- Run order : execute top-to-bottom in one session.
-- Estimated time (40k rows, modest server): 30–120 seconds total.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- SECTION 0 — pre-flight checks
-- Print the current row counts so you know what you're indexing.
-- Review before proceeding.
-- ---------------------------------------------------------------------------

SELECT 'ef_personalinfos'   AS tbl, COUNT(*) AS rrows FROM ef_personalinfos
UNION ALL
SELECT 'ef_emolument_forms',          COUNT(*) FROM ef_emolument_forms
UNION ALL
SELECT 'ef_form_approvals',           COUNT(*) FROM ef_form_approvals
UNION ALL
SELECT 'ef_audit_logs',               COUNT(*) FROM ef_audit_logs
UNION ALL
SELECT 'ef_nok',                      COUNT(*) FROM ef_nok
UNION ALL
SELECT 'ef_spouse',                   COUNT(*) FROM ef_spouse
UNION ALL
SELECT 'ef_children',                 COUNT(*) FROM ef_children
UNION ALL
SELECT 'ef_loans',                    COUNT(*) FROM ef_loans
UNION ALL
SELECT 'ef_allowances',               COUNT(*) FROM ef_allowances
UNION ALL
SELECT 'ef_documents',                COUNT(*) FROM ef_documents
UNION ALL
SELECT 'ef_personalinfoshist',        COUNT(*) FROM ef_personalinfoshist;


-- ---------------------------------------------------------------------------
-- SECTION 1 — ef_personalinfos
-- The hottest table. Touched by every role on every workflow step.
-- ---------------------------------------------------------------------------

-- 1a. ship + Status  — used by getSubmittedForms, getDoReviewedForms,
--     bulkApproveShip, removeExitPersonnel, and every DO/FO list view.
--     Covers the most common two-column filter in the whole system.
CREATE INDEX idx_pi_ship_status
    ON ef_personalinfos (ship, Status)
    ALGORITHM = INPLACE LOCK = NONE;

-- 1b. ship + Status + emolumentform  — extends 1a to cover the third column
--     that almost every WHERE clause adds:
--     AND (emolumentform IS NULL OR emolumentform != 'Yes')
--     MySQL can use this index to filter all three conditions in one pass.
CREATE INDEX idx_pi_ship_status_emol
    ON ef_personalinfos (ship, Status, emolumentform)
    ALGORITHM = INPLACE LOCK = NONE;

-- 1c. command + Status  — used by getFoApprovedForms (CPO list view)
--     and getCommandReport. Without this, CPO list views scan all 40k rows.
CREATE INDEX idx_pi_command_status
    ON ef_personalinfos (command, Status)
    ALGORITHM = INPLACE LOCK = NONE;

-- 1d. command + Status + emolumentform  — same extension as 1b, for command scope.
CREATE INDEX idx_pi_command_status_emol
    ON ef_personalinfos (command, Status, emolumentform)
    ALGORITHM = INPLACE LOCK = NONE;

-- 1e. payrollclass + Status  — used by getConfirmedForSync, removeExitPersonnel,
--     and class-scoped bulk approve.
CREATE INDEX idx_pi_payrollclass_status
    ON ef_personalinfos (payrollclass, Status)
    ALGORITHM = INPLACE LOCK = NONE;

-- 1f. ship + classes + Status  — used by approveBulk (FO bulk approve filters
--     on all three: ship, classes, AND Status = 'Filled').
CREATE INDEX idx_pi_ship_classes_status
    ON ef_personalinfos (ship, classes, Status)
    ALGORITHM = INPLACE LOCK = NONE;

-- 1g. emolumentform  — used in getDashboardCounts and getProgressReport
--     SUM(CASE WHEN emolumentform = 'Yes' ...) benefits from this when
--     combined with the covering indexes above for filtered aggregation.
--     Also used in getConfirmedForSync WHERE emolumentform = 'Yes'.
CREATE INDEX idx_pi_emolumentform
    ON ef_personalinfos (emolumentform)
    ALGORITHM = INPLACE LOCK = NONE;

-- 1h. FULLTEXT on Surname + OtherName  — replaces the LIKE '%value%' full scan
--     in searchPersonnel. FULLTEXT supports partial word matching via BOOLEAN MODE.
--     NOTE: FULLTEXT cannot use ALGORITHM=INPLACE — it uses a rebuild.
--     This is the only index here that briefly locks writes (a few seconds at 40k rows).
--     Run during off-peak if concerned.
--
--     After adding this index, update searchPersonnel in admin.repository.js:
--       conditions.push("MATCH(p.Surname, p.OtherName) AGAINST (? IN BOOLEAN MODE)");
--       params.push(filters.surname + '*');    -- trailing * = prefix match
--
CREATE FULLTEXT INDEX ft_pi_name
    ON ef_personalinfos (Surname, OtherName);

-- serviceNumber is almost certainly the PK or already has a unique index.
-- Verify with: SHOW INDEX FROM ef_personalinfos WHERE Key_name = 'PRIMARY';
-- If serviceNumber is NOT the PK and has no unique index, add one:
--
--   CREATE UNIQUE INDEX IF NOT EXISTS uq_pi_svcno
--       ON ef_personalinfos (serviceNumber)
--       ALGORITHM = INPLACE LOCK = NONE;
--
-- (commented out — do not run blind; check first)


-- ---------------------------------------------------------------------------
-- SECTION 2 — ef_emolument_forms
-- Join target in every list view (DO, FO, CPO, Admin). Also the canonical
-- status store for the clean enum workflow.
-- ---------------------------------------------------------------------------

-- 2a. service_no + ship  — the join condition used in getSubmittedForms and
--     getDoReviewedForms: ON ef.service_no = p.serviceNumber AND ef.ship = p.ship
CREATE INDEX idx_ef_service_ship
    ON ef_emolument_forms (service_no, ship)
    ALGORITHM = INPLACE LOCK = NONE;

-- 2b. service_no + form_year  — used in getEmolumentFormId and upsertEmolumentForm
--     lookups. Also supports the ON DUPLICATE KEY logic.
CREATE INDEX idx_ef_service_year
    ON ef_emolument_forms (service_no, form_year)
    ALGORITHM = INPLACE LOCK = NONE;

-- 2c. status  — used in getFormDetail gates (WHERE ef.status = 'DO_REVIEWED' etc.)
--     and in bulk update WHERE status IN ('SUBMITTED', 'DO_REVIEWED').
CREATE INDEX idx_ef_status
    ON ef_emolument_forms (status)
    ALGORITHM = INPLACE LOCK = NONE;

-- 2d. service_no + ship + status  — covering index for the bulk update in
--     approveBulk: WHERE service_no IN (...) AND ship = ? AND status IN (...)
CREATE INDEX idx_ef_service_ship_status
    ON ef_emolument_forms (service_no, ship, status)
    ALGORITHM = INPLACE LOCK = NONE;

-- 2e. Unique constraint on (service_no, form_year)  — prevents duplicate form
--     records for the same person in the same year. Also makes the ON DUPLICATE KEY
--     upsert in upsertEmolumentForm reliable (requires a unique key to trigger).
--     IMPORTANT: run SECTION 0 row count first. If duplicates already exist,
--     this will fail. Clean them first:
--       SELECT service_no, form_year, COUNT(*) AS n
--       FROM ef_emolument_forms GROUP BY service_no, form_year HAVING n > 1;
ALTER TABLE ef_emolument_forms
    ADD CONSTRAINT uq_ef_svcno_year
    UNIQUE (service_no, form_year);


-- ---------------------------------------------------------------------------
-- SECTION 3 — ef_personalinfoshist
-- Prevents race condition in insertHistoryRecord (two concurrent CPO
-- confirmations for the same person+year both passing the existence check).
-- ---------------------------------------------------------------------------

-- 3a. Unique constraint on (serviceNumber, FormYear)
--     After this exists, INSERT IGNORE replaces the SELECT-then-INSERT pattern:
--       INSERT IGNORE INTO ef_personalinfoshist (FormYear, serviceNumber, ...)
--       SELECT ?, serviceNumber, ... FROM ef_personalinfos WHERE serviceNumber = ?
--     Duplicates are silently skipped at the DB level — no race condition possible.
--     Check for existing duplicates first (same pattern as 2e above).
ALTER TABLE ef_personalinfoshist
    ADD CONSTRAINT uq_hist_svcno_year
    UNIQUE (serviceNumber, FormYear);


-- ---------------------------------------------------------------------------
-- SECTION 4 — ef_form_approvals
-- Audit trail table. Queried by form_id in getPersonnelApprovalHistory JOIN.
-- ---------------------------------------------------------------------------

CREATE INDEX idx_fa_form_id
    ON ef_form_approvals (form_id)
    ALGORITHM = INPLACE LOCK = NONE;

-- Approval history lookup by service_no (via JOIN through ef_emolument_forms).
-- The JOIN path is: ef_form_approvals.form_id → ef_emolument_forms.id → service_no.
-- The index on ef_emolument_forms.id (likely PK) handles that half.
-- This index speeds up the approval trail query for any bulk audit report.
CREATE INDEX idx_fa_performed_by
    ON ef_form_approvals (performed_by, performed_at)
    ALGORITHM = INPLACE LOCK = NONE;


-- ---------------------------------------------------------------------------
-- SECTION 5 — ef_audit_logs
-- Write-heavy table (every action logs here). Index only what's queried.
-- ---------------------------------------------------------------------------

CREATE INDEX idx_al_table_action
    ON ef_audit_logs (table_name, action, performed_at)
    ALGORITHM = INPLACE LOCK = NONE;

CREATE INDEX idx_al_performed_by
    ON ef_audit_logs (performed_by, performed_at)
    ALGORITHM = INPLACE LOCK = NONE;


-- ---------------------------------------------------------------------------
-- SECTION 6 — child tables (ef_nok, ef_spouse, ef_children, ef_loans,
--              ef_allowances, ef_documents)
-- All queried with WHERE service_no = ? — a point lookup.
-- If service_no is already the PK or part of a composite PK, skip that table.
-- ---------------------------------------------------------------------------

-- Check first: SHOW INDEX FROM ef_nok;
CREATE INDEX idx_nok_svc
    ON ef_nok (service_no)
    ALGORITHM = INPLACE LOCK = NONE;

CREATE INDEX idx_spouse_svc
    ON ef_spouse (service_no)
    ALGORITHM = INPLACE LOCK = NONE;

CREATE INDEX idx_children_svc
    ON ef_children (service_no)
    ALGORITHM = INPLACE LOCK = NONE;

CREATE INDEX idx_loans_svc
    ON ef_loans (service_no)
    ALGORITHM = INPLACE LOCK = NONE;

CREATE INDEX idx_allowances_svc
    ON ef_allowances (service_no)
    ALGORITHM = INPLACE LOCK = NONE;

CREATE INDEX idx_documents_svc
    ON ef_documents (service_no)
    ALGORITHM = INPLACE LOCK = NONE;


-- ---------------------------------------------------------------------------
-- SECTION 7 — post-migration verification
-- Run this after the migration completes to confirm all indexes exist.
-- ---------------------------------------------------------------------------

SELECT
    TABLE_NAME,
    INDEX_NAME,
    GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns,
    INDEX_TYPE,
    NON_UNIQUE
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN (
      'ef_personalinfos', 'ef_emolument_forms', 'ef_personalinfoshist',
      'ef_form_approvals', 'ef_audit_logs',
      'ef_nok', 'ef_spouse', 'ef_children',
      'ef_loans', 'ef_allowances', 'ef_documents'
  )
GROUP BY TABLE_NAME, INDEX_NAME, INDEX_TYPE, NON_UNIQUE
ORDER BY TABLE_NAME, INDEX_NAME;


-- ---------------------------------------------------------------------------
-- SECTION 8 — EXPLAIN spot-checks
-- Run these after the migration and confirm the "key" column is NOT NULL
-- and "rows" is far below the table total. These are the five most expensive
-- queries in the system before indexing.
-- ---------------------------------------------------------------------------

-- 8a. DO list view (was full scan on ship + Status)
EXPLAIN SELECT p.serviceNumber, p.Status
FROM ef_personalinfos p
WHERE p.ship = 'NNS EXAMPLE'
  AND p.Status = 'Filled'
  AND (p.emolumentform IS NULL OR p.emolumentform != 'Yes');

-- 8b. FO list view (same filter, different status value)
EXPLAIN SELECT p.serviceNumber, p.Status
FROM ef_personalinfos p
WHERE p.ship = 'NNS EXAMPLE'
  AND p.Status = 'FO'
  AND (p.emolumentform IS NULL OR p.emolumentform != 'Yes');

-- 8c. CPO list view (command-scoped)
EXPLAIN SELECT p.serviceNumber, p.Status
FROM ef_personalinfos p
WHERE p.command = 'WNC'
  AND p.Status  = 'CPO'
  AND (p.emolumentform IS NULL OR p.emolumentform != 'Yes');

-- 8d. searchPersonnel (LIKE filter — confirm FULLTEXT is chosen after section 1h)
EXPLAIN SELECT p.serviceNumber, p.Surname
FROM ef_personalinfos p
WHERE MATCH(p.Surname, p.OtherName) AGAINST ('Ade*' IN BOOLEAN MODE);

-- 8e. dashboard count (confirm index is used for emolumentform filter)
EXPLAIN SELECT COUNT(*), SUM(CASE WHEN Status = 'Filled' THEN 1 ELSE 0 END)
FROM ef_personalinfos;

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================
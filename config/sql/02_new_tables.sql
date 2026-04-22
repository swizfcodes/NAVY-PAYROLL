-- =============================================================
-- EMOLUMENT SYSTEM — PHASE 1
-- FILE: 02_new_tables.sql
-- DESC: Create all new emolument tables
-- RUN:  After 01_schema_remediation.sql
-- =============================================================

USE hicaddata;

-- -------------------------------------------------------------
-- TABLE 1: ef_user_roles
-- Maps service numbers to elevated emolument roles.
-- Regular PERSONNEL access is implied by existence in
-- ef_personalinfos — no row needed here for them.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ef_user_roles (
  id           INT NOT NULL AUTO_INCREMENT,
  user_id      VARCHAR(30) NOT NULL
                 COMMENT 'Service number — matches ef_personalinfos.serviceNumber',
  role         ENUM('DO','FO','CPO','EMOL_ADMIN') NOT NULL,
  scope_type   ENUM('SHIP','COMMAND','GLOBAL') NOT NULL
                 COMMENT 'SHIP=scoped to one ship, COMMAND=scoped to one command, GLOBAL=all',
  scope_value  VARCHAR(100) DEFAULT NULL
                 COMMENT 'Ship name or command code when scope_type is SHIP or COMMAND',
  is_active    TINYINT(1) NOT NULL DEFAULT 1,
  assigned_by  VARCHAR(30) DEFAULT NULL
                 COMMENT 'Service number of the EMOL_ADMIN who made this assignment',
  assigned_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at   DATETIME DEFAULT NULL,
  revoked_by   VARCHAR(30) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_role_scope (user_id, role, scope_value),
  INDEX idx_ur_user_id (user_id),
  INDEX idx_ur_role (role),
  INDEX idx_ur_active (is_active),
  INDEX idx_ur_scope (scope_type, scope_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Elevated emolument role assignments per personnel';


-- -------------------------------------------------------------
-- TABLE 2: ef_nok
-- Normalized Next of Kin (replaces 14 nok_ columns in personalinfos)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ef_nok (
  id            INT NOT NULL AUTO_INCREMENT,
  service_no    VARCHAR(30) NOT NULL
                  COMMENT 'FK to ef_personalinfos.serviceNumber',
  nok_order     TINYINT NOT NULL DEFAULT 1
                  COMMENT '1 = primary NOK, 2 = alternate NOK',
  full_name     VARCHAR(200) DEFAULT NULL,
  relationship  VARCHAR(50) DEFAULT NULL
                  COMMENT 'FK to ef_relationships.description — stored as text for portability',
  phone1        VARCHAR(20) DEFAULT NULL,
  phone2        VARCHAR(20) DEFAULT NULL,
  email         VARCHAR(100) DEFAULT NULL,
  address       TEXT DEFAULT NULL,
  national_id   VARCHAR(50) DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_nok_person_order (service_no, nok_order),
  INDEX idx_nok_svcno (service_no),
  CONSTRAINT fk_nok_person
    FOREIGN KEY (service_no) REFERENCES ef_personalinfos(serviceNumber)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Next of kin records — up to 2 per personnel';


-- -------------------------------------------------------------
-- TABLE 3: ef_children
-- Normalized children records (replaces chid_name1-4 columns)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ef_children (
  id           INT NOT NULL AUTO_INCREMENT,
  service_no   VARCHAR(30) NOT NULL,
  child_name   VARCHAR(100) NOT NULL,
  birth_order  TINYINT DEFAULT NULL COMMENT '1 = first child, 2 = second, etc.',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_children_svcno (service_no),
  CONSTRAINT fk_children_person
    FOREIGN KEY (service_no) REFERENCES ef_personalinfos(serviceNumber)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Children records per personnel';


-- -------------------------------------------------------------
-- TABLE 4: ef_loans
-- Normalized loan records (replaces 16 loan columns)
-- Each loan type per person is one row, not one column
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ef_loans (
  id          INT NOT NULL AUTO_INCREMENT,
  service_no  VARCHAR(30) NOT NULL,
  loan_type   ENUM(
                'FGSHLS',    -- Federal Government Staff Housing Loan Scheme
                'CAR',       -- Car Loan
                'WELFARE',   -- Welfare Loan
                'NNNCS',     -- Nigerian Navy Non-Commissioned Scheme
                'NNMFBL',    -- Nigerian Navy Mortgage Finance Board Loan
                'PPCFS',     -- Post Primary & Civil Service Cooperative
                'OTHER'      -- Any other loan
              ) NOT NULL,
  amount      DECIMAL(15,2) DEFAULT NULL,
  year_taken  VARCHAR(10) DEFAULT NULL,
  tenor       INT DEFAULT NULL COMMENT 'Loan tenor in months',
  balance     DECIMAL(15,2) DEFAULT NULL,
  specify     VARCHAR(200) DEFAULT NULL COMMENT 'Details when type is OTHER',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_loan_person_type (service_no, loan_type),
  INDEX idx_loans_svcno (service_no),
  CONSTRAINT fk_loans_person
    FOREIGN KEY (service_no) REFERENCES ef_personalinfos(serviceNumber)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Loan records per personnel — one row per loan type';


-- -------------------------------------------------------------
-- TABLE 5: ef_allowances
-- Normalized allowance flags (replaces 8 allow columns)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ef_allowances (
  id           INT NOT NULL AUTO_INCREMENT,
  service_no   VARCHAR(30) NOT NULL,
  allow_type   ENUM(
                 'AIRCREW',
                 'PILOT',
                 'SHIFT_DUTY',
                 'HAZARD',
                 'RENT_SUBSIDY',
                 'SBC',           -- Special Boat Command
                 'SPECIAL_FORCES',
                 'CALL_DUTY',
                 'OTHER'
               ) NOT NULL,
  is_active    TINYINT(1) NOT NULL DEFAULT 0,
  specify      VARCHAR(200) DEFAULT NULL COMMENT 'Details when type is OTHER',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_allow_person_type (service_no, allow_type),
  INDEX idx_allow_svcno (service_no),
  CONSTRAINT fk_allow_person
    FOREIGN KEY (service_no) REFERENCES ef_personalinfos(serviceNumber)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Allowance flags per personnel';


-- -------------------------------------------------------------
-- TABLE 6: ef_documents
-- Photo and document URLs (replaces blob columns + scattered URL columns)
-- Cloudinary stores the actual files; we store metadata here
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ef_documents (
  id              INT NOT NULL AUTO_INCREMENT,
  service_no      VARCHAR(30) NOT NULL,
  doc_type        ENUM(
                    'PASSPORT',
                    'NOK_PASSPORT',
                    'ALT_NOK_PASSPORT'
                  ) NOT NULL,
  cloudinary_id   VARCHAR(300) DEFAULT NULL
                    COMMENT 'Cloudinary public_id — needed for deletions and transformations',
  url             VARCHAR(500) DEFAULT NULL
                    COMMENT 'Full Cloudinary delivery URL',
  uploaded_by     VARCHAR(30) DEFAULT NULL
                    COMMENT 'Service number of uploader',
  uploaded_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  replaced_at     DATETIME DEFAULT NULL
                    COMMENT 'Set when a newer upload replaces this one',
  PRIMARY KEY (id),
  UNIQUE KEY uq_doc_person_type (service_no, doc_type),
  INDEX idx_docs_svcno (service_no),
  CONSTRAINT fk_docs_person
    FOREIGN KEY (service_no) REFERENCES ef_personalinfos(serviceNumber)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Document and photo metadata per personnel';


-- -------------------------------------------------------------
-- TABLE 7: ef_emolument_forms
-- One form per person per processing year.
-- The snapshot column captures the full personnel state at
-- submission time — replaces ef_personalinfoshist duplication.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ef_emolument_forms (
  id            INT NOT NULL AUTO_INCREMENT,
  service_no    VARCHAR(30) NOT NULL,
  form_year     VARCHAR(10) NOT NULL
                  COMMENT 'Processing year e.g. 2025 — from ef_control.processingyear',
  form_number   VARCHAR(50) DEFAULT NULL
                  COMMENT 'Sequential form number assigned on submission',
  payroll_class VARCHAR(5) DEFAULT NULL
                  COMMENT 'Payroll class of personnel at time of submission',
  ship          VARCHAR(100) DEFAULT NULL
                  COMMENT 'Denormalized from personalinfos for fast DO/FO queries',
  command       VARCHAR(50) DEFAULT NULL
                  COMMENT 'Denormalized from personalinfos for fast CPO queries',
  status        ENUM(
                  'DRAFT',          -- started but not yet submitted
                  'SUBMITTED',      -- personnel submitted, awaiting DO
                  'DO_REVIEWED',    -- DO has reviewed, awaiting FO
                  'FO_APPROVED',    -- FO approved, awaiting CPO
                  'CPO_CONFIRMED',  -- CPO confirmed — final state
                  'REJECTED'        -- rejected at any stage, back to DRAFT
                ) NOT NULL DEFAULT 'DRAFT',
  snapshot      JSON DEFAULT NULL
                  COMMENT 'Full personnel data snapshot at submission time',
  submitted_at  DATETIME DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_form_person_year (service_no, form_year),
  INDEX idx_form_status (status),
  INDEX idx_form_ship (ship),
  INDEX idx_form_command (command),
  INDEX idx_form_year (form_year),
  INDEX idx_form_svcno (service_no),
  CONSTRAINT fk_form_person
    FOREIGN KEY (service_no) REFERENCES ef_personalinfos(serviceNumber)
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='One emolument form per personnel per year with full workflow status';


-- -------------------------------------------------------------
-- TABLE 8: ef_form_approvals
-- Immutable audit trail of every status transition on a form.
-- Every action — submit, review, approve, reject — is one row.
-- Never deleted, never updated.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ef_form_approvals (
  id            INT NOT NULL AUTO_INCREMENT,
  form_id       INT NOT NULL,
  action        VARCHAR(50) NOT NULL
                  COMMENT 'e.g. SUBMITTED, DO_REVIEWED, FO_APPROVED, CPO_CONFIRMED, REJECTED',
  from_status   VARCHAR(30) DEFAULT NULL,
  to_status     VARCHAR(30) NOT NULL,
  performed_by  VARCHAR(30) NOT NULL
                  COMMENT 'Service number of the person who took this action',
  performer_role VARCHAR(20) DEFAULT NULL
                  COMMENT 'The emolument role they acted as e.g. DO, FO, CPO, PERSONNEL',
  remarks       TEXT DEFAULT NULL
                  COMMENT 'Required when action is REJECTED',
  performed_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_approvals_form (form_id),
  INDEX idx_approvals_by (performed_by),
  INDEX idx_approvals_at (performed_at),
  CONSTRAINT fk_approval_form
    FOREIGN KEY (form_id) REFERENCES ef_emolument_forms(id)
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Immutable audit trail of all emolument form workflow actions';


-- -------------------------------------------------------------
-- TABLE 9: ef_audit_logs (replaces broken ef_auditlogs)
-- General system audit log for all write operations.
-- Populated by the audit middleware, not by application code.
-- -------------------------------------------------------------
DROP TABLE IF EXISTS ef_auditlogs; -- drop the broken one

CREATE TABLE IF NOT EXISTS ef_audit_logs (
  id            BIGINT NOT NULL AUTO_INCREMENT,
  table_name    VARCHAR(100) NOT NULL,
  action        ENUM('INSERT','UPDATE','DELETE') NOT NULL,
  record_key    VARCHAR(100) NOT NULL
                  COMMENT 'Primary key value of the affected record',
  old_values    JSON DEFAULT NULL,
  new_values    JSON DEFAULT NULL,
  performed_by  VARCHAR(30) NOT NULL
                  COMMENT 'Service number or system identifier',
  ip_address    VARCHAR(45) DEFAULT NULL,
  user_agent    VARCHAR(300) DEFAULT NULL,
  performed_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_al_table (table_name),
  INDEX idx_al_key (record_key),
  INDEX idx_al_by (performed_by),
  INDEX idx_al_at (performed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='General write audit log — populated by audit middleware';


-- -------------------------------------------------------------
-- TABLE 10: ef_spouse
-- Spouse details (was flat columns in personalinfos)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ef_spouse (
  id           INT NOT NULL AUTO_INCREMENT,
  service_no   VARCHAR(30) NOT NULL,
  full_name    VARCHAR(200) DEFAULT NULL,
  phone1       VARCHAR(20) DEFAULT NULL,
  phone2       VARCHAR(20) DEFAULT NULL,
  email        VARCHAR(100) DEFAULT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_spouse_person (service_no),
  CONSTRAINT fk_spouse_person
    FOREIGN KEY (service_no) REFERENCES ef_personalinfos(serviceNumber)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Spouse details per personnel';
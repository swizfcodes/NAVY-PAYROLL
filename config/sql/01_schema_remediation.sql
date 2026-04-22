-- =============================================================
-- EMOLUMENT SYSTEM — PHASE 1
-- FILE: 01_schema_remediation.sql
-- DESC: Fix migrated tables — add PKs, constraints, drop junk
-- RUN:  Once against hicaddata (the emolument MySQL database)
-- =============================================================

USE hicaddata;

-- -------------------------------------------------------------
-- SECTION A: DROP JUNK / STAGING TABLES
-- These were migration artifacts or one-time staging tables
-- and should not be part of the new system
-- -------------------------------------------------------------

DROP TABLE IF EXISTS ef_sheet1;
DROP TABLE IF EXISTS ef_checkship;
DROP TABLE IF EXISTS ef_migrationshistory;
DROP TABLE IF EXISTS ef_hr_empl;
DROP TABLE IF EXISTS ef_ships2;           -- duplicate of ef_ships
DROP TABLE IF EXISTS ef_personnellogins;  -- replaced by payroll users table + ef_user_roles
DROP TABLE IF EXISTS ef_nodeusers;        -- replaced by payroll users table + ef_user_roles
-- NOTE: ef_hr_employees kept as READ-ONLY payroll reference
-- NOTE: ef_shiplogins kept temporarily — data will be migrated to ef_user_roles


-- -------------------------------------------------------------
-- SECTION B: FIX LOOKUP / REFERENCE TABLES
-- Add proper PKs, AUTO_INCREMENT, and foreign keys
-- -------------------------------------------------------------

-- ef_states
ALTER TABLE ef_states
  MODIFY COLUMN StateId INT NOT NULL AUTO_INCREMENT,
  ADD PRIMARY KEY (StateId),
  MODIFY COLUMN Name VARCHAR(100) NOT NULL,
  MODIFY COLUMN Code VARCHAR(10) DEFAULT NULL;

-- ef_localgovts
ALTER TABLE ef_localgovts
  MODIFY COLUMN Id INT NOT NULL AUTO_INCREMENT,
  ADD PRIMARY KEY (Id),
  MODIFY COLUMN lgaName VARCHAR(150) NOT NULL,
  MODIFY COLUMN code VARCHAR(20) DEFAULT NULL,
  ADD CONSTRAINT fk_lga_state
    FOREIGN KEY (StateId) REFERENCES ef_states(StateId) ON UPDATE CASCADE;

-- ef_banks
ALTER TABLE ef_banks
  MODIFY COLUMN bankcode VARCHAR(50) NOT NULL,
  ADD PRIMARY KEY (bankcode),
  MODIFY COLUMN bankname VARCHAR(150) DEFAULT NULL;

-- ef_branches (Navy branches e.g. Engineering, Supply, Medical)
ALTER TABLE ef_branches
  MODIFY COLUMN Id INT NOT NULL AUTO_INCREMENT,
  ADD PRIMARY KEY (Id),
  MODIFY COLUMN code VARCHAR(20) DEFAULT NULL,
  MODIFY COLUMN branchName VARCHAR(100) DEFAULT NULL;

-- ef_commands
ALTER TABLE ef_commands
  MODIFY COLUMN Id INT NOT NULL AUTO_INCREMENT,
  ADD PRIMARY KEY (Id),
  MODIFY COLUMN code VARCHAR(20) DEFAULT NULL,
  MODIFY COLUMN commandName VARCHAR(150) DEFAULT NULL;

-- ef_ships
SET FOREIGN_KEY_CHECKS = 0;
ALTER TABLE ef_ships
  MODIFY COLUMN Id INT NOT NULL AUTO_INCREMENT,
  ADD PRIMARY KEY (Id),
  MODIFY COLUMN code VARCHAR(20) DEFAULT NULL,
  MODIFY COLUMN shipName VARCHAR(150) DEFAULT NULL,
  MODIFY COLUMN LandSea VARCHAR(20) DEFAULT NULL,
  ADD CONSTRAINT fk_ship_command
    FOREIGN KEY (commandid) REFERENCES ef_commands(Id) ON UPDATE CASCADE;
SET FOREIGN_KEY_CHECKS = 1;

-- ef_relationships (NOK relationship types)
ALTER TABLE ef_relationships
  MODIFY COLUMN Id INT NOT NULL AUTO_INCREMENT,
  ADD PRIMARY KEY (Id),
  MODIFY COLUMN description VARCHAR(100) DEFAULT NULL;

-- ef_specialisationareas
ALTER TABLE ef_specialisationareas
  MODIFY COLUMN Id INT NOT NULL AUTO_INCREMENT,
  ADD PRIMARY KEY (Id),
  MODIFY COLUMN specName VARCHAR(150) DEFAULT NULL;

-- ef_entrymodes
ALTER TABLE ef_entrymodes
  MODIFY COLUMN Id INT NOT NULL AUTO_INCREMENT,
  ADD PRIMARY KEY (Id),
  MODIFY COLUMN Name VARCHAR(100) DEFAULT NULL;


-- -------------------------------------------------------------
-- SECTION C: FIX OPERATIONAL TABLES
-- -------------------------------------------------------------

-- ef_personalinfos — add PK and unique constraint on serviceNumber
-- NOTE: Id was bigint NOT NULL but had no PK defined after migration
ALTER TABLE ef_personalinfos
  MODIFY COLUMN Id BIGINT NOT NULL AUTO_INCREMENT,
  ADD PRIMARY KEY (Id),
  ADD UNIQUE KEY uq_personalinfos_svcno (serviceNumber),
  -- Remove legacy blob passport columns (photos now in ef_documents)
  DROP COLUMN Passport,
  DROP COLUMN NokPassport,
  DROP COLUMN AltNokPassport;

-- ef_personalinfoshist — history/snapshot table
ALTER TABLE ef_personalinfoshist
  MODIFY COLUMN Id INT NOT NULL AUTO_INCREMENT,
  ADD PRIMARY KEY (Id),
  ADD INDEX idx_hist_svcno (serviceNumber),
  ADD INDEX idx_hist_year (FormYear);

-- ef_control — form cycle management
ALTER TABLE ef_control
  MODIFY COLUMN Id INT NOT NULL AUTO_INCREMENT,
  ADD PRIMARY KEY (Id),
  ADD INDEX idx_control_status (status);

-- ef_systeminfos — global system config
ALTER TABLE ef_systeminfos
  MODIFY COLUMN Id INT NOT NULL AUTO_INCREMENT,
  ADD PRIMARY KEY (Id);

-- ef_auditlogs — fix the broken audit table
ALTER TABLE ef_auditlogs
  MODIFY COLUMN Id INT NOT NULL AUTO_INCREMENT,
  ADD PRIMARY KEY (Id),
  ADD INDEX idx_audit_table (TableName(100)),
  ADD INDEX idx_audit_performed_at (PerformedAt),
  ADD INDEX idx_audit_performed_by (PerformedBy(50));

-- ef_contactus
ALTER TABLE ef_contactus
  MODIFY COLUMN Id INT NOT NULL AUTO_INCREMENT,
  ADD PRIMARY KEY (Id);

-- ef_menugroups
ALTER TABLE ef_menugroups
  MODIFY COLUMN Id INT NOT NULL AUTO_INCREMENT,
  ADD PRIMARY KEY (Id);

-- ef_menus
ALTER TABLE ef_menus
  MODIFY COLUMN Id INT NOT NULL AUTO_INCREMENT,
  ADD PRIMARY KEY (Id),
  ADD INDEX idx_menus_group (MenuGroupId);

-- ef_rolemenus
ALTER TABLE ef_rolemenus
  MODIFY COLUMN Id INT NOT NULL AUTO_INCREMENT,
  ADD PRIMARY KEY (Id);
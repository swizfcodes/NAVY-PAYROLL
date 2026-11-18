-- @scope: master   (hicaddata (officers) only)
-- Migration: ef_ships_hq_opds_to_dhq
-- Created: 2026-11-18T12:00:00.000Z
--
-- Ship HQ OPDS moves from command NHQ to command DHQ.
--
--   1. ef_ships            HQ OPDS -> DHQ
--   2. ef_personalinfos    personnel on HQ OPDS whose command is NHQ -> DHQ
--   3. ef_emolument_forms  current-cycle form rows (ship HQ OPDS, command NHQ)
--                          -> DHQ, so in-flight forms route to the DHQ CPO
--
-- Left as they are: past cycles (other form years, ef_personalinfoshist) and
-- hr_employees (payroll master, its own py_navalcommand codes).
--
-- DHQ / NHQ are matched on ef_commands.code first, then on commandName.
-- If a command or the ship can't be found exactly, the migration stops
-- with an error and changes nothing.
--
-- Every row changed is recorded in ef_mig_hq_opds_dhq (with its old value)
-- so the rollback below restores exactly those rows. Safe to re-run.
--
-- Run:  npm run migrate:up officers
-- By hand: run only the block between the UP and DOWN markers.

-- UP

DROP PROCEDURE IF EXISTS mig_hq_opds_to_dhq_up;

DELIMITER $$

CREATE PROCEDURE mig_hq_opds_to_dhq_up()
BEGIN
  DECLARE v_n        INT DEFAULT 0;
  DECLARE v_dhq_id   INT DEFAULT NULL;
  DECLARE v_dhq_code VARCHAR(50) DEFAULT NULL;
  DECLARE v_nhq_id   INT DEFAULT NULL;
  DECLARE v_nhq_code VARCHAR(50) DEFAULT NULL;
  DECLARE v_ships    INT DEFAULT 0;
  DECLARE v_people   INT DEFAULT 0;
  DECLARE v_forms    INT DEFAULT 0;

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  -- Resolve DHQ: by code, else by name. Must be exactly one row.
  SELECT COUNT(*) INTO v_n FROM ef_commands WHERE UPPER(TRIM(code)) = 'DHQ';
  IF v_n = 1 THEN
    SELECT Id, TRIM(code) INTO v_dhq_id, v_dhq_code
      FROM ef_commands WHERE UPPER(TRIM(code)) = 'DHQ';
  ELSEIF v_n = 0 THEN
    SELECT COUNT(*) INTO v_n FROM ef_commands WHERE UPPER(TRIM(commandName)) = 'DHQ';
    IF v_n = 1 THEN
      SELECT Id, TRIM(code) INTO v_dhq_id, v_dhq_code
        FROM ef_commands WHERE UPPER(TRIM(commandName)) = 'DHQ';
    END IF;
  END IF;
  IF v_dhq_id IS NULL OR COALESCE(v_dhq_code, '') = '' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Command DHQ not found once in ef_commands (by code or name). Nothing changed.';
  END IF;

  -- Resolve NHQ the same way.
  SELECT COUNT(*) INTO v_n FROM ef_commands WHERE UPPER(TRIM(code)) = 'NHQ';
  IF v_n = 1 THEN
    SELECT Id, TRIM(code) INTO v_nhq_id, v_nhq_code
      FROM ef_commands WHERE UPPER(TRIM(code)) = 'NHQ';
  ELSEIF v_n = 0 THEN
    SELECT COUNT(*) INTO v_n FROM ef_commands WHERE UPPER(TRIM(commandName)) = 'NHQ';
    IF v_n = 1 THEN
      SELECT Id, TRIM(code) INTO v_nhq_id, v_nhq_code
        FROM ef_commands WHERE UPPER(TRIM(commandName)) = 'NHQ';
    END IF;
  END IF;
  IF v_nhq_id IS NULL OR COALESCE(v_nhq_code, '') = '' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Command NHQ not found once in ef_commands (by code or name). Nothing changed.';
  END IF;

  SELECT COUNT(*) INTO v_n FROM ef_ships WHERE UPPER(TRIM(shipName)) = 'HQ OPDS';
  IF v_n = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Ship HQ OPDS not found in ef_ships. Nothing changed.';
  END IF;

  -- Record of every row changed (old value) for the rollback. Created only
  -- after the checks pass, so a failed run leaves nothing behind.
  CREATE TABLE IF NOT EXISTS ef_mig_hq_opds_dhq (
    tbl         VARCHAR(40)  NOT NULL,
    row_key     VARCHAR(64)  NOT NULL,
    old_value   VARCHAR(100) NULL,
    changed_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tbl, row_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  START TRANSACTION;

  -- 1. The ship itself.
  INSERT IGNORE INTO ef_mig_hq_opds_dhq (tbl, row_key, old_value)
    SELECT 'ef_ships', CAST(Id AS CHAR), CAST(commandid AS CHAR)
      FROM ef_ships
     WHERE UPPER(TRIM(shipName)) = 'HQ OPDS'
       AND NOT (commandid <=> v_dhq_id);

  UPDATE ef_ships
     SET commandid = v_dhq_id
   WHERE UPPER(TRIM(shipName)) = 'HQ OPDS'
     AND NOT (commandid <=> v_dhq_id);
  SET v_ships = ROW_COUNT();

  -- 2. Personnel on HQ OPDS still under NHQ.
  --    Column values are compared under an explicit collation so the
  --    statement works whatever collation each legacy table uses.
  INSERT IGNORE INTO ef_mig_hq_opds_dhq (tbl, row_key, old_value)
    SELECT 'ef_personalinfos', serviceNumber, command
      FROM ef_personalinfos
     WHERE UPPER(TRIM(ship)) = 'HQ OPDS'
       AND CONVERT(UPPER(TRIM(command)) USING utf8mb4) COLLATE utf8mb4_general_ci
           IN (UPPER(v_nhq_code), 'NHQ');

  UPDATE ef_personalinfos
     SET command = v_dhq_code
   WHERE UPPER(TRIM(ship)) = 'HQ OPDS'
     AND CONVERT(UPPER(TRIM(command)) USING utf8mb4) COLLATE utf8mb4_general_ci
         IN (UPPER(v_nhq_code), 'NHQ');
  SET v_people = ROW_COUNT();

  -- 3. Their current-cycle form rows (processing year(s) in ef_control).
  INSERT IGNORE INTO ef_mig_hq_opds_dhq (tbl, row_key, old_value)
    SELECT 'ef_emolument_forms', CAST(id AS CHAR), command
      FROM ef_emolument_forms
     WHERE UPPER(TRIM(ship)) = 'HQ OPDS'
       AND CONVERT(UPPER(TRIM(command)) USING utf8mb4) COLLATE utf8mb4_general_ci
           IN (UPPER(v_nhq_code), 'NHQ')
       AND CONVERT(form_year USING utf8mb4) COLLATE utf8mb4_general_ci IN
           (SELECT CONVERT(processingyear USING utf8mb4) COLLATE utf8mb4_general_ci
              FROM ef_control);

  UPDATE ef_emolument_forms
     SET command = v_dhq_code, updated_at = NOW()
   WHERE UPPER(TRIM(ship)) = 'HQ OPDS'
     AND CONVERT(UPPER(TRIM(command)) USING utf8mb4) COLLATE utf8mb4_general_ci
         IN (UPPER(v_nhq_code), 'NHQ')
     AND CONVERT(form_year USING utf8mb4) COLLATE utf8mb4_general_ci IN
         (SELECT CONVERT(processingyear USING utf8mb4) COLLATE utf8mb4_general_ci
            FROM ef_control);
  SET v_forms = ROW_COUNT();

  INSERT INTO ef_audit_logs
    (table_name, action, record_key, old_values, new_values, performed_by, performed_at)
  VALUES
    ('ef_ships', 'UPDATE', 'MIGRATION:HQ_OPDS_TO_DHQ',
     JSON_OBJECT('ship', 'HQ OPDS', 'command', v_nhq_code),
     JSON_OBJECT('ship', 'HQ OPDS', 'command', v_dhq_code,
                 'ships',     CAST(v_ships  AS UNSIGNED),
                 'personnel', CAST(v_people AS UNSIGNED),
                 'forms',     CAST(v_forms  AS UNSIGNED)),
     'MIGRATION', NOW());

  COMMIT;

  SELECT v_ships  AS ships_moved,
         v_people AS personnel_moved,
         v_forms  AS forms_moved,
         v_dhq_code AS new_command;
END$$

DELIMITER ;

CALL mig_hq_opds_to_dhq_up();
DROP PROCEDURE IF EXISTS mig_hq_opds_to_dhq_up;

-- DOWN

DROP PROCEDURE IF EXISTS mig_hq_opds_to_dhq_down;

DELIMITER $$

CREATE PROCEDURE mig_hq_opds_to_dhq_down()
BEGIN
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  IF EXISTS (
    SELECT 1 FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ef_mig_hq_opds_dhq'
  ) THEN
    START TRANSACTION;

    UPDATE ef_ships s
      JOIN ef_mig_hq_opds_dhq b
        ON b.tbl = 'ef_ships' AND CAST(b.row_key AS UNSIGNED) = s.Id
       SET s.commandid = CAST(b.old_value AS SIGNED);

    UPDATE ef_personalinfos p
      JOIN ef_mig_hq_opds_dhq b
        ON b.tbl = 'ef_personalinfos'
       AND CONVERT(b.row_key USING utf8mb4) COLLATE utf8mb4_bin
         = CONVERT(p.serviceNumber USING utf8mb4) COLLATE utf8mb4_bin
       SET p.command = b.old_value;

    UPDATE ef_emolument_forms f
      JOIN ef_mig_hq_opds_dhq b
        ON b.tbl = 'ef_emolument_forms' AND CAST(b.row_key AS UNSIGNED) = f.id
       SET f.command = b.old_value, f.updated_at = NOW();

    INSERT INTO ef_audit_logs
      (table_name, action, record_key, old_values, new_values, performed_by, performed_at)
    SELECT 'ef_ships', 'UPDATE', 'MIGRATION:HQ_OPDS_TO_DHQ:ROLLBACK',
           NULL, JSON_OBJECT('restored_rows', COUNT(*)), 'MIGRATION', NOW()
      FROM ef_mig_hq_opds_dhq;

    COMMIT;
  END IF;
END$$

DELIMITER ;

CALL mig_hq_opds_to_dhq_down();
DROP PROCEDURE IF EXISTS mig_hq_opds_to_dhq_down;
DROP TABLE IF EXISTS ef_mig_hq_opds_dhq;

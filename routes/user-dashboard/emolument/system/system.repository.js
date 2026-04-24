/**
 * FILE: routes/user-dashboard/emolument/system/system.repository.js
 *
 * All SQL for emolument system control:
 *   - Global open / close (ef_systeminfos)
 *   - Per-ship open / close (ef_ships.openship)
 *   - Processing year (ef_control)
 *   - Form number counters (ef_systeminfos)
 *   - Reference data reads (ships, commands)
 */

"use strict";

const pool = require("../../../../config/db");
const config = require("../../../../config");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// ─────────────────────────────────────────────────────────────
// ef_systeminfos — single-row config table
// ─────────────────────────────────────────────────────────────

async function getSystemInfo() {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT
       SiteStatus, opendate, closedate,
       OfficersFormNo, RatingsFormNo, TrainingFormNo,
       comp_name, Address, email, tel
     FROM ef_systeminfos LIMIT 1`,
  );
  return rows[0] || null;
}

async function setGlobalStatus(status, opendate, closedate) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `UPDATE ef_systeminfos
     SET SiteStatus = ?,
         opendate   = ?,
         closedate  = ?`,
    [status, opendate, closedate],
  );
  return result.affectedRows > 0;
}

async function setFormCounters(officersNo, ratingsNo, trainingNo) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `UPDATE ef_systeminfos
     SET OfficersFormNo = ?,
         RatingsFormNo  = ?,
         TrainingFormNo = ?`,
    [officersNo, ratingsNo, trainingNo],
  );
  return result.affectedRows > 0;
}

// ─────────────────────────────────────────────────────────────
// ef_ships — per-ship open/close
// ─────────────────────────────────────────────────────────────

async function getShipByName(shipName) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT Id, shipName, openship, commandid
     FROM ef_ships WHERE shipName = ? LIMIT 1`,
    [shipName],
  );
  return rows[0] || null;
}

async function getShipById(shipId) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT Id, shipName, openship, commandid
     FROM ef_ships WHERE Id = ? LIMIT 1`,
    [shipId],
  );
  return rows[0] || null;
}

async function setShipOpenStatus(shipId, openship) {
  pool.useDatabase(DB());
  const [result] = await pool.query(
    `UPDATE ef_ships SET openship = ? WHERE Id = ?`,
    [openship ? 1 : 0, shipId],
  );
  return result.affectedRows > 0;
}

async function setAllShipsStatus(openship) {
  pool.useDatabase(DB());
  const [result] = await pool.query(`UPDATE ef_ships SET openship = ?`, [
    openship ? 1 : 0,
  ]);
  return result.affectedRows;
}

async function getAllShips() {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT s.Id, s.shipName, s.openship, s.LandSea,
            c.commandName, c.code AS commandCode
     FROM ef_ships s
     LEFT JOIN ef_commands c ON c.Id = s.commandid
     ORDER BY c.commandName ASC, s.shipName ASC`,
  );
  return rows;
}

async function getShipsByCommand(commandCode) {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT s.Id, s.shipName, s.openship, s.LandSea
     FROM ef_ships s
     JOIN ef_commands c ON c.Id = s.commandid
     WHERE c.code = ?
     ORDER BY s.shipName ASC`,
    [commandCode],
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────
// ef_control — processing year
// ─────────────────────────────────────────────────────────────

async function getAllControlRows() {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT Id, ship, startdate, enddate, status, processingyear, createdby, datecreated
     FROM ef_control
     ORDER BY Id ASC`,
  );
  return rows;
}

async function getProcessingYear(isTraining = false) {
  pool.useDatabase(DB());
  const where = isTraining ? `WHERE ship = 'All'` : "";
  const [rows] = await pool.query(
    `SELECT DISTINCT processingyear FROM ef_control ${where} LIMIT 1`,
  );
  return rows[0]?.processingyear || null;
}

async function setProcessingYear(year, createdBy, isTraining = false) {
  pool.useDatabase(DB());

  // Check if a row already exists for this context
  const where = isTraining ? `ship = 'All'` : `ship != 'All' OR ship IS NULL`;
  const [existing] = await pool.query(
    `SELECT Id FROM ef_control WHERE ${where} LIMIT 1`,
  );

  if (existing.length > 0) {
    const [result] = await pool.query(
      `UPDATE ef_control SET processingyear = ? WHERE ${where}`,
      [String(year)],
    );
    return result.affectedRows > 0;
  }

  // Insert new row
  const shipVal = isTraining ? "All" : null;
  const [result] = await pool.query(
    `INSERT INTO ef_control (ship, startdate, enddate, status, processingyear, createdby, datecreated)
     VALUES (?, NOW(), NOW(), 'active', ?, ?, NOW())`,
    [shipVal, String(year), createdBy],
  );
  return result.affectedRows > 0;
}

// ─────────────────────────────────────────────────────────────
// ef_commands — reference
// ─────────────────────────────────────────────────────────────

async function getAllCommands() {
  pool.useDatabase(DB());
  const [rows] = await pool.query(
    `SELECT Id, code, commandName FROM ef_commands ORDER BY commandName ASC`,
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────
// AUDIT
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

module.exports = {
  getSystemInfo,
  setGlobalStatus,
  setFormCounters,
  getShipByName,
  getShipById,
  setShipOpenStatus,
  setAllShipsStatus,
  getAllShips,
  getShipsByCommand,
  getAllControlRows,
  getProcessingYear,
  setProcessingYear,
  getAllCommands,
  insertAuditLog,
};

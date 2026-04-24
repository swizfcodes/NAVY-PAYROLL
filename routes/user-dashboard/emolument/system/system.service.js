/**
 * FILE: routes/user-dashboard/emolument/system/system.service.js
 *
 * Business logic for emolument system control.
 * All status/config mutations are EMOL_ADMIN only —
 * enforced at the route level, not here.
 *
 * Functions:
 *   getStatus          → full system state snapshot
 *   openGlobal         → open forms site-wide
 *   closeGlobal        → close forms site-wide
 *   openShip           → open forms for one ship
 *   closeShip          → close forms for one ship
 *   openAllShips       → open forms for every ship
 *   closeAllShips      → close forms for every ship
 *   setProcessingYear  → set form year (all or training only)
 *   setFormCounters    → manually reset form number sequences
 *   listShips          → all ships with open/close state
 *   listCommands       → all commands
 */

"use strict";

const repo = require("./system.repository");

// ─────────────────────────────────────────────────────────────
// GET STATUS — full system snapshot
// ─────────────────────────────────────────────────────────────

async function getStatus() {
  const [systemInfo, allShips, controlRows, formYear, trainingYear] =
    await Promise.all([
      repo.getSystemInfo(),
      repo.getAllShips(),
      repo.getAllControlRows(),
      repo.getProcessingYear(false),
      repo.getProcessingYear(true),
    ]);

  if (!systemInfo) {
    return {
      success: false,
      code: 500,
      message: "System configuration not found.",
    };
  }

  const shipsOpen = allShips.filter((s) => s.openship === 1).length;
  const shipsClosed = allShips.filter((s) => s.openship === 0).length;

  return {
    success: true,
    data: {
      global: {
        siteStatus: systemInfo.SiteStatus,
        isOpen: systemInfo.SiteStatus === 1,
        opendate: systemInfo.opendate,
        closedate: systemInfo.closedate,
      },
      formCounters: {
        officers: systemInfo.OfficersFormNo,
        ratings: systemInfo.RatingsFormNo,
        training: systemInfo.TrainingFormNo,
      },
      processingYear: {
        standard: formYear,
        training: trainingYear,
      },
      ships: {
        total: allShips.length,
        open: shipsOpen,
        closed: shipsClosed,
      },
      controlRows,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// GLOBAL OPEN / CLOSE
// ─────────────────────────────────────────────────────────────

async function openGlobal(opendate, closedate, performedBy, ip) {
  if (!opendate || !closedate) {
    return {
      success: false,
      code: 400,
      message: "opendate and closedate are required.",
    };
  }
  if (new Date(closedate) <= new Date(opendate)) {
    return {
      success: false,
      code: 400,
      message: "closedate must be after opendate.",
    };
  }

  const before = await repo.getSystemInfo();
  const ok = await repo.setGlobalStatus(1, opendate, closedate);
  if (!ok)
    return {
      success: false,
      code: 500,
      message: "Failed to update system status.",
    };

  await repo.insertAuditLog({
    tableName: "ef_systeminfos",
    action: "UPDATE",
    recordKey: "global",
    oldValues: {
      SiteStatus: before?.SiteStatus,
      opendate: before?.opendate,
      closedate: before?.closedate,
    },
    newValues: { SiteStatus: 1, opendate, closedate },
    performedBy,
    ipAddress: ip,
  });

  return {
    success: true,
    message: "Emolument forms opened globally.",
    data: { SiteStatus: 1, opendate, closedate },
  };
}

async function closeGlobal(performedBy, ip) {
  const before = await repo.getSystemInfo();
  const ok = await repo.setGlobalStatus(0, before?.opendate, before?.closedate);
  if (!ok)
    return {
      success: false,
      code: 500,
      message: "Failed to update system status.",
    };

  await repo.insertAuditLog({
    tableName: "ef_systeminfos",
    action: "UPDATE",
    recordKey: "global",
    oldValues: { SiteStatus: before?.SiteStatus },
    newValues: { SiteStatus: 0 },
    performedBy,
    ipAddress: ip,
  });

  return { success: true, message: "Emolument forms closed globally." };
}

// ─────────────────────────────────────────────────────────────
// PER-SHIP OPEN / CLOSE
// ─────────────────────────────────────────────────────────────

async function openShip(shipId, performedBy, ip) {
  const ship = await repo.getShipById(shipId);
  if (!ship)
    return { success: false, code: 404, message: `Ship not found: ${shipId}` };

  const ok = await repo.setShipOpenStatus(shipId, true);
  if (!ok)
    return { success: false, code: 500, message: "Failed to open ship." };

  await repo.insertAuditLog({
    tableName: "ef_ships",
    action: "UPDATE",
    recordKey: String(shipId),
    oldValues: { openship: ship.openship },
    newValues: { openship: 1 },
    performedBy,
    ipAddress: ip,
  });

  return { success: true, message: `Forms opened for ship: ${ship.shipName}.` };
}

async function closeShip(shipId, performedBy, ip) {
  const ship = await repo.getShipById(shipId);
  if (!ship)
    return { success: false, code: 404, message: `Ship not found: ${shipId}` };

  const ok = await repo.setShipOpenStatus(shipId, false);
  if (!ok)
    return { success: false, code: 500, message: "Failed to close ship." };

  await repo.insertAuditLog({
    tableName: "ef_ships",
    action: "UPDATE",
    recordKey: String(shipId),
    oldValues: { openship: ship.openship },
    newValues: { openship: 0 },
    performedBy,
    ipAddress: ip,
  });

  return { success: true, message: `Forms closed for ship: ${ship.shipName}.` };
}

// ─────────────────────────────────────────────────────────────
// BULK SHIP OPEN / CLOSE
// ─────────────────────────────────────────────────────────────

async function openAllShips(performedBy, ip) {
  const affected = await repo.setAllShipsStatus(true);

  await repo.insertAuditLog({
    tableName: "ef_ships",
    action: "UPDATE",
    recordKey: "ALL",
    oldValues: null,
    newValues: { openship: 1, affectedRows: affected },
    performedBy,
    ipAddress: ip,
  });

  return {
    success: true,
    message: `Forms opened for all ships.`,
    data: { affectedShips: affected },
  };
}

async function closeAllShips(performedBy, ip) {
  const affected = await repo.setAllShipsStatus(false);

  await repo.insertAuditLog({
    tableName: "ef_ships",
    action: "UPDATE",
    recordKey: "ALL",
    oldValues: null,
    newValues: { openship: 0, affectedRows: affected },
    performedBy,
    ipAddress: ip,
  });

  return {
    success: true,
    message: `Forms closed for all ships.`,
    data: { affectedShips: affected },
  };
}

// ─────────────────────────────────────────────────────────────
// PROCESSING YEAR
// ─────────────────────────────────────────────────────────────

async function setProcessingYear(year, target, performedBy, ip) {
  // target: 'all' | 'standard' | 'training'
  if (!year || !/^\d{4}$/.test(String(year))) {
    return {
      success: false,
      code: 400,
      message: "Year must be a 4-digit number.",
    };
  }

  const validTargets = ["all", "standard", "training"];
  if (!validTargets.includes(target)) {
    return {
      success: false,
      code: 400,
      message: `target must be one of: ${validTargets.join(", ")}.`,
    };
  }

  const setStandard = target === "all" || target === "standard";
  const setTraining = target === "all" || target === "training";

  if (setStandard) await repo.setProcessingYear(year, performedBy, false);
  if (setTraining) await repo.setProcessingYear(year, performedBy, true);

  await repo.insertAuditLog({
    tableName: "ef_control",
    action: "UPDATE",
    recordKey: target,
    oldValues: null,
    newValues: { processingyear: String(year), target },
    performedBy,
    ipAddress: ip,
  });

  return {
    success: true,
    message: `Processing year set to ${year} (${target}).`,
    data: { year: String(year), target },
  };
}

// ─────────────────────────────────────────────────────────────
// FORM NUMBER COUNTERS
// ─────────────────────────────────────────────────────────────

async function setFormCounters(
  { officersNo, ratingsNo, trainingNo },
  performedBy,
  ip,
) {
  const before = await repo.getSystemInfo();

  // Each counter is optional — default to current value if not provided
  const newOfficers =
    officersNo != null ? Number(officersNo) : before?.OfficersFormNo;
  const newRatings =
    ratingsNo != null ? Number(ratingsNo) : before?.RatingsFormNo;
  const newTraining =
    trainingNo != null ? Number(trainingNo) : before?.TrainingFormNo;

  if (
    [newOfficers, newRatings, newTraining].some(
      (n) => !Number.isInteger(n) || n < 1,
    )
  ) {
    return {
      success: false,
      code: 400,
      message: "Form counters must be positive integers.",
    };
  }

  const ok = await repo.setFormCounters(newOfficers, newRatings, newTraining);
  if (!ok)
    return {
      success: false,
      code: 500,
      message: "Failed to update form counters.",
    };

  await repo.insertAuditLog({
    tableName: "ef_systeminfos",
    action: "UPDATE",
    recordKey: "formCounters",
    oldValues: {
      OfficersFormNo: before?.OfficersFormNo,
      RatingsFormNo: before?.RatingsFormNo,
      TrainingFormNo: before?.TrainingFormNo,
    },
    newValues: {
      OfficersFormNo: newOfficers,
      RatingsFormNo: newRatings,
      TrainingFormNo: newTraining,
    },
    performedBy,
    ipAddress: ip,
  });

  return {
    success: true,
    message: "Form counters updated.",
    data: { officers: newOfficers, ratings: newRatings, training: newTraining },
  };
}

// ─────────────────────────────────────────────────────────────
// REFERENCE LISTS
// ─────────────────────────────────────────────────────────────

async function listShips(commandCode) {
  const ships = commandCode
    ? await repo.getShipsByCommand(commandCode)
    : await repo.getAllShips();

  return { success: true, data: ships };
}

async function listCommands() {
  const commands = await repo.getAllCommands();
  return { success: true, data: commands };
}

module.exports = {
  getStatus,
  openGlobal,
  closeGlobal,
  openShip,
  closeShip,
  openAllShips,
  closeAllShips,
  setProcessingYear,
  setFormCounters,
  listShips,
  listCommands,
};

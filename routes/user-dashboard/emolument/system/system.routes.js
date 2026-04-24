/**
 * FILE: routes/user-dashboard/emolument/system/system.routes.js
 *
 * System control endpoints — EMOL_ADMIN only except where noted.
 *
 * All routes:
 *   verifyToken + requireEmolRole('EMOL_ADMIN')
 *   except GET /status and GET /ships and GET /commands
 *   which also allow any elevated emolument role (for dashboards).
 *
 * ─── ROUTE MAP ───────────────────────────────────────────────
 *
 *  GET    /system/status                → full system state
 *  GET    /system/ships                 → all ships + open/close state
 *  GET    /system/ships/:commandCode    → ships filtered by command
 *  GET    /system/commands              → all commands
 *
 *  POST   /system/open                  → open globally
 *  POST   /system/close                 → close globally
 *  POST   /system/ships/:id/open        → open one ship
 *  POST   /system/ships/:id/close       → close one ship
 *  POST   /system/ships/open-all        → open all ships
 *  POST   /system/ships/close-all       → close all ships
 *
 *  PUT    /system/processing-year       → set processing year
 *  PUT    /system/form-counters         → set form number sequences
 */

"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../../../../config/db");
const config = require("../../../../config");
const verifyToken = require("../../../../middware/authentication");
const {
  requireEmolRole,
  requireAnyEmolRole,
} = require("../../../../middware/emolumentAuth");
const systemService = require("./system.service");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// Set DB context for all routes in this module
router.use((req, res, next) => {
  pool.useDatabase(DB());
  next();
});

// All routes require authentication
router.use(verifyToken);

// ─────────────────────────────────────────────────────────────
// READ-ONLY — any elevated emolument role
// ─────────────────────────────────────────────────────────────

// GET /api/emolument/system/status
router.get("/status", requireAnyEmolRole, async (req, res) => {
  try {
    const result = await systemService.getStatus();
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /system/status:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/emolument/system/ships
router.get("/ships", requireAnyEmolRole, async (req, res) => {
  try {
    const result = await systemService.listShips();
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /system/ships:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/emolument/system/ships/:commandCode
router.get("/ships/:commandCode", requireAnyEmolRole, async (req, res) => {
  try {
    const result = await systemService.listShips(req.params.commandCode);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /system/ships/:commandCode:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /api/emolument/system/commands
router.get("/commands", requireAnyEmolRole, async (req, res) => {
  try {
    const result = await systemService.listCommands();
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /system/commands:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// GLOBAL OPEN / CLOSE — EMOL_ADMIN only
// ─────────────────────────────────────────────────────────────

// POST /api/emolument/system/open
// Body: { opendate, closedate }
router.post("/open", requireEmolRole("EMOL_ADMIN"), async (req, res) => {
  const { opendate, closedate } = req.body;
  if (!opendate || !closedate) {
    return res
      .status(400)
      .json({ error: "opendate and closedate are required." });
  }
  try {
    const result = await systemService.openGlobal(
      opendate,
      closedate,
      req.user_id,
      req.ip,
    );
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message, data: result.data });
  } catch (err) {
    console.error("❌ POST /system/open:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /api/emolument/system/close
router.post("/close", requireEmolRole("EMOL_ADMIN"), async (req, res) => {
  try {
    const result = await systemService.closeGlobal(req.user_id, req.ip);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message });
  } catch (err) {
    console.error("❌ POST /system/close:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// PER-SHIP OPEN / CLOSE — EMOL_ADMIN only
// Note: /open-all and /close-all must come BEFORE /:id routes
// to prevent Express matching 'open-all' as an :id param.
// ─────────────────────────────────────────────────────────────

// POST /api/emolument/system/ships/open-all
router.post(
  "/ships/open-all",
  requireEmolRole("EMOL_ADMIN"),
  async (req, res) => {
    try {
      const result = await systemService.openAllShips(req.user_id, req.ip);
      if (!result.success)
        return res.status(result.code).json({ error: result.message });
      return res.json({ message: result.message, data: result.data });
    } catch (err) {
      console.error("❌ POST /system/ships/open-all:", err);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

// POST /api/emolument/system/ships/close-all
router.post(
  "/ships/close-all",
  requireEmolRole("EMOL_ADMIN"),
  async (req, res) => {
    try {
      const result = await systemService.closeAllShips(req.user_id, req.ip);
      if (!result.success)
        return res.status(result.code).json({ error: result.message });
      return res.json({ message: result.message, data: result.data });
    } catch (err) {
      console.error("❌ POST /system/ships/close-all:", err);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

// POST /api/emolument/system/ships/:id/open
router.post(
  "/ships/:id/open",
  requireEmolRole("EMOL_ADMIN"),
  async (req, res) => {
    const shipId = Number(req.params.id);
    if (!Number.isInteger(shipId) || shipId < 1) {
      return res.status(400).json({ error: "Invalid ship ID." });
    }
    try {
      const result = await systemService.openShip(shipId, req.user_id, req.ip);
      if (!result.success)
        return res.status(result.code).json({ error: result.message });
      return res.json({ message: result.message });
    } catch (err) {
      console.error("❌ POST /system/ships/:id/open:", err);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

// POST /api/emolument/system/ships/:id/close
router.post(
  "/ships/:id/close",
  requireEmolRole("EMOL_ADMIN"),
  async (req, res) => {
    const shipId = Number(req.params.id);
    if (!Number.isInteger(shipId) || shipId < 1) {
      return res.status(400).json({ error: "Invalid ship ID." });
    }
    try {
      const result = await systemService.closeShip(shipId, req.user_id, req.ip);
      if (!result.success)
        return res.status(result.code).json({ error: result.message });
      return res.json({ message: result.message });
    } catch (err) {
      console.error("❌ POST /system/ships/:id/close:", err);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

// ─────────────────────────────────────────────────────────────
// PROCESSING YEAR — EMOL_ADMIN only
// ─────────────────────────────────────────────────────────────

// PUT /api/emolument/system/processing-year
// Body: { year: 2025, target: 'all' | 'standard' | 'training' }
router.put(
  "/processing-year",
  requireEmolRole("EMOL_ADMIN"),
  async (req, res) => {
    const { year, target = "all" } = req.body;
    if (!year) {
      return res.status(400).json({ error: "year is required." });
    }
    try {
      const result = await systemService.setProcessingYear(
        year,
        target,
        req.user_id,
        req.ip,
      );
      if (!result.success)
        return res.status(result.code).json({ error: result.message });
      return res.json({ message: result.message, data: result.data });
    } catch (err) {
      console.error("❌ PUT /system/processing-year:", err);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

// ─────────────────────────────────────────────────────────────
// FORM COUNTERS — EMOL_ADMIN only
// ─────────────────────────────────────────────────────────────

// PUT /api/emolument/system/form-counters
// Body: { officersNo?, ratingsNo?, trainingNo? }
// All fields optional — omitted fields keep their current value.
router.put(
  "/form-counters",
  requireEmolRole("EMOL_ADMIN"),
  async (req, res) => {
    const { officersNo, ratingsNo, trainingNo } = req.body;
    if (officersNo == null && ratingsNo == null && trainingNo == null) {
      return res
        .status(400)
        .json({
          error:
            "At least one counter (officersNo, ratingsNo, trainingNo) is required.",
        });
    }
    try {
      const result = await systemService.setFormCounters(
        { officersNo, ratingsNo, trainingNo },
        req.user_id,
        req.ip,
      );
      if (!result.success)
        return res.status(result.code).json({ error: result.message });
      return res.json({ message: result.message, data: result.data });
    } catch (err) {
      console.error("❌ PUT /system/form-counters:", err);
      return res.status(500).json({ error: "Server error" });
    }
  },
);

module.exports = router;

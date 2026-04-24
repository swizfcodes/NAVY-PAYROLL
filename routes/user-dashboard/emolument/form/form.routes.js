/**
 * FILE: routes/user-dashboard/emolument/form/form.routes.js
 *
 * Routes for the emolument form lifecycle (personnel side).
 *
 * All routes require verifyToken + requirePersonnel.
 *
 * Request body shape for PUT /save and POST /submit:
 * {
 *   core: {
 *     Surname, OtherName, Sex, MaritalStatus, Birthdate, religion,
 *     gsm_number, gsm_number2, email, home_address,
 *     BankACNumber, Bankcode, bankbranch, pfacode,
 *     specialisation, command, branch, DateEmpl, seniorityDate,
 *     yearOfPromotion, expirationOfEngagementDate,
 *     StateofOrigin, LocalGovt, TaxCode,
 *     entry_mode, gradelevel, gradetype, taxed,
 *     accomm_type, AcommodationStatus, AddressofAcommodation,
 *     GBC, GBC_Number, NSITFcode, NHFcode,
 *     qualification, division, entitlement,
 *     advanceDate, runoutDate, NIN, AccountName
 *   },
 *   nok: {
 *     primary:   { full_name, relationship, phone1, phone2, email, address, national_id },
 *     alternate: { full_name, relationship, phone1, phone2, email, address, national_id }
 *   },
 *   spouse:   { full_name, phone1, phone2, email },
 *   children: [ { child_name, birth_order }, ... ],   // max 4
 *   loans: {
 *     FGSHLS:  { amount, year_taken },
 *     CAR:     { amount, year_taken },
 *     WELFARE: { amount, year_taken },
 *     NNNCS:   { amount, year_taken },
 *     NNMFBL:  { amount, year_taken },
 *     PPCFS:   { amount, year_taken },
 *     OTHER:   { amount, year_taken, specify }
 *   },
 *   allowances: {
 *     AIRCREW:        { is_active: true/false },
 *     PILOT:          { is_active: true/false },
 *     SHIFT_DUTY:     { is_active: true/false },
 *     HAZARD:         { is_active: true/false },
 *     RENT_SUBSIDY:   { is_active: true/false },
 *     SBC:            { is_active: true/false },
 *     SPECIAL_FORCES: { is_active: true/false },
 *     CALL_DUTY:      { is_active: true/false },
 *     OTHER:          { is_active: true/false, specify: "description" }
 *   }
 * }
 */

"use strict";

const express = require("express");
const router = express.Router();
const verifyToken = require("../../../../middware/authentication");
const { requirePersonnel } = require("../../../../middware/emolumentAuth");
const formService = require("./form.service");

router.use(verifyToken, requirePersonnel);

// ─────────────────────────────────────────────────────────────
// GET /api/emolument/form/load
// ─────────────────────────────────────────────────────────────
router.get("/load", async (req, res) => {
  try {
    const result = await formService.loadForm(req.user_id);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /form/load:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/emolument/form/history/:year
// ─────────────────────────────────────────────────────────────
router.get("/history/:year", async (req, res) => {
  const { year } = req.params;
  if (!year || !/^\d{4}$/.test(year)) {
    return res.status(400).json({ error: "Invalid year format." });
  }
  try {
    const result = await formService.loadFormHistory(req.user_id, year);
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error("❌ GET /form/history/:year:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/emolument/form/save  (draft — no status change)
// ─────────────────────────────────────────────────────────────
router.put("/save", async (req, res) => {
  const body = req.body;
  if (!body || !body.core) {
    return res
      .status(400)
      .json({ error: "Request body must include a core object." });
  }
  try {
    const result = await formService.saveDraft(
      req.user_id,
      body,
      req.user_id,
      req.ip,
    );
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message });
  } catch (err) {
    console.error("❌ PUT /form/save:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/emolument/form/submit
// ─────────────────────────────────────────────────────────────
router.post("/submit", async (req, res) => {
  const body = req.body;
  if (!body || !body.core) {
    return res
      .status(400)
      .json({ error: "Request body must include a core object." });
  }
  try {
    const result = await formService.submitForm(
      req.user_id,
      body,
      req.user_id,
      req.ip,
    );
    if (!result.success)
      return res.status(result.code).json({ error: result.message });
    return res.json({
      message: result.message,
      formNumber: result.data.formNumber,
      formYear: result.data.formYear,
      status: result.data.status,
    });
  } catch (err) {
    console.error("❌ POST /form/submit:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;

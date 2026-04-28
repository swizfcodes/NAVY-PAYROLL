/**
 * FILE: routes/user-dashboard/emolument/admin/admin.routes.js
 *
 * Routes for EMOL_ADMIN functions.
 * Every route requires verifyToken + requireEmolRole('EMOL_ADMIN').
 *
 * ─── ROUTE MAP ───────────────────────────────────────────────
 *
 *  Role management:
 *  GET    /admin/roles                        → list active role assignments
 *  POST   /admin/roles/assign                 → assign a role
 *  DELETE /admin/roles/:role_id/revoke        → revoke a role
 *
 *  Personnel:
 *  GET    /admin/personnel                    → search personnel (filters + pagination)
 *  GET    /admin/personnel/:svcno             → get single personnel record
 *  PUT    /admin/personnel/:svcno/contact     → update email + phone
 *  PUT    /admin/personnel/commission         → update service number
 *  DELETE /admin/personnel/exits/:payrollclass → remove exit personnel
 *
 *  Form actions:
 *  POST   /admin/ship/:ship/bulk-approve      → bulk approve ship (bypass DO)
 *  POST   /admin/forms/:form_id/reject        → reject any form at any stage
 *
 *  Upload:
 *  POST   /admin/upload/personnel             → upsert personnel batch
 *
 *  Payroll sync:
 *  POST   /admin/payroll/sync                 → sync confirmed → Updated
 */

'use strict';

const express = require("express");
const router = express.Router();
const pool = require("../../../../config/db");
const config = require("../../../../config");
const verifyToken = require("../../../../middware/authentication");
const {requireEmolRole} = require("../../../../middware/emolumentAuth");
const adminService = require("./admin.service");

const DB = () => process.env.DB_OFFICERS || config.databases.officers;

// Set DB context for all routes in this module
router.use((req, res, next) => {
  pool.useDatabase(DB());
  next();
});

// All routes require authentication + EMOL_ADMIN role
router.use(verifyToken, requireEmolRole('EMOL_ADMIN'));

// ─────────────────────────────────────────────────────────────
// ROLE MANAGEMENT
// ─────────────────────────────────────────────────────────────

// GET /admin/roles
// Query: ?role=DO&scope_type=SHIP&scope_value=NNS+BEECROFT&user_id=X1234
router.get('/roles', async (req, res) => {
  const filters = {
    role:        req.query.role        || undefined,
    scope_type:  req.query.scope_type  || undefined,
    scope_value: req.query.scope_value || undefined,
    user_id:     req.query.user_id     || undefined,
  };
  try {
    const result = await adminService.listRoles(filters);
    return res.json(result.data);
  } catch (err) {
    console.error('❌ GET /admin/roles:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /admin/roles/assign
// Body: { user_id, role, scope_type, scope_value? }
router.post('/roles/assign', async (req, res) => {
  try {
    const result = await adminService.assignRole(req.body, req.user_id, req.ip);
    if (!result.success) return res.status(result.code).json({ error: result.message });
    return res.status(201).json({ message: result.message, data: result.data });
  } catch (err) {
    console.error('❌ POST /admin/roles/assign:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /admin/roles/:role_id/revoke
router.delete('/roles/:role_id/revoke', async (req, res) => {
  const roleId = Number(req.params.role_id);
  if (!Number.isInteger(roleId) || roleId < 1) {
    return res.status(400).json({ error: 'Invalid role ID.' });
  }
  try {
    const result = await adminService.revokeRole(roleId, req.user_id, req.ip);
    if (!result.success) return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message, data: result.data });
  } catch (err) {
    console.error('❌ DELETE /admin/roles/:role_id/revoke:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
// PERSONNEL MANAGEMENT
// ─────────────────────────────────────────────────────────────

// GET /admin/personnel
// Query: ?serviceNumber=X&surname=ADU&ship=NNS+BEECROFT&command=&payrollclass=2&status=Filled&page=1&pageSize=50
router.get('/personnel', async (req, res) => {
  const filters = {
    serviceNumber: req.query.serviceNumber || undefined,
    surname:       req.query.surname       || undefined,
    ship:          req.query.ship          || undefined,
    command:       req.query.command       || undefined,
    payrollclass:  req.query.payrollclass  || undefined,
    status:        req.query.status        !== undefined ? req.query.status : undefined,
  };
  try {
    const result = await adminService.searchPersonnel(
      filters,
      req.query.page,
      req.query.pageSize,
    );
    if (!result.success) return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error('❌ GET /admin/personnel:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// PUT /admin/personnel/commission
// Body: { old_svc_no, new_svc_no }
// MUST be declared before /:svcno routes — 'commission' is a literal
// path segment and would otherwise be matched as a :svcno param value.
router.put('/personnel/commission', async (req, res) => {
  try {
    const result = await adminService.updateServiceNumber(req.body, req.user_id, req.ip);
    if (!result.success) return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message, data: result.data });
  } catch (err) {
    console.error('❌ PUT /admin/personnel/commission:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /admin/personnel/:svcno
router.get('/personnel/:svcno', async (req, res) => {
  try {
    const result = await adminService.getPersonnel(req.params.svcno);
    if (!result.success) return res.status(result.code).json({ error: result.message });
    return res.json(result.data);
  } catch (err) {
    console.error('❌ GET /admin/personnel/:svcno:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// PUT /admin/personnel/:svcno/contact
// Body: { email?, phone_number? }
router.put('/personnel/:svcno/contact', async (req, res) => {
  const { svcno } = req.params;
  try {
    const result = await adminService.updateContact(svcno, req.body, req.user_id, req.ip);
    if (!result.success) return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message, data: result.data });
  } catch (err) {
    console.error('❌ PUT /admin/personnel/:svcno/contact:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /admin/personnel/exits/:payrollclass
router.delete('/personnel/exits/:payrollclass', async (req, res) => {
  const { payrollclass } = req.params;
  try {
    const result = await adminService.removeExitPersonnel(payrollclass, req.user_id, req.ip);
    if (!result.success) return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message, data: result.data });
  } catch (err) {
    console.error('❌ DELETE /admin/personnel/exits/:payrollclass:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
// FORM ACTIONS
// ─────────────────────────────────────────────────────────────

// POST /admin/ship/:ship/bulk-approve
// Body: { fo_name, fo_rank, fo_date }
router.post('/ship/:ship/bulk-approve', async (req, res) => {
  const { ship } = req.params;
  try {
    const result = await adminService.bulkApproveShip(ship, req.body, req.user_id, req.ip);
    if (!result.success) return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message, data: result.data });
  } catch (err) {
    console.error('❌ POST /admin/ship/:ship/bulk-approve:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /admin/forms/:form_id/reject
// Body: { ship, remarks }
router.post('/forms/:form_id/reject', async (req, res) => {
  const formId = Number(req.params.form_id);
  if (!Number.isInteger(formId) || formId < 1) {
    return res.status(400).json({ error: 'Invalid form ID.' });
  }
  try {
    const result = await adminService.rejectForm(formId, req.body, req.user_id, req.ip);
    if (!result.success) return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message, data: result.data });
  } catch (err) {
    console.error('❌ POST /admin/forms/:form_id/reject:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
// UPLOAD
// ─────────────────────────────────────────────────────────────

// POST /admin/upload/personnel
// Body: single personnel object OR array of personnel objects
// Shape: { serviceNumber, surname, otherName, rank, email,
//          phoneNumber, accountNo, bankCode, ship,
//          payrollclass, classes, dateOfBirth?, dateOfJoining? }
router.post('/upload/personnel', async (req, res) => {
  if (!req.body || (Array.isArray(req.body) && req.body.length === 0)) {
    return res.status(400).json({ error: 'Request body must contain at least one personnel record.' });
  }
  try {
    const result = await adminService.uploadPersonnel(req.body, req.user_id, req.ip);
    if (!result.success) return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message, data: result.data });
  } catch (err) {
    console.error('❌ POST /admin/upload/personnel:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
// PAYROLL SYNC
// ─────────────────────────────────────────────────────────────

// POST /admin/payroll/sync
// Body: { payrollclass }
router.post('/payroll/sync', async (req, res) => {
  if (!req.body?.payrollclass) {
    return res.status(400).json({ error: 'payrollclass is required.' });
  }
  try {
    const result = await adminService.syncPayroll(req.body, req.user_id, req.ip);
    if (!result.success) return res.status(result.code).json({ error: result.message });
    return res.json({ message: result.message, data: result.data });
  } catch (err) {
    console.error('❌ POST /admin/payroll/sync:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
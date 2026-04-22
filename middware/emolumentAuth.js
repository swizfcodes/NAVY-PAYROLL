/**
 * EMOLUMENT SYSTEM — PHASE 1
 * FILE: middware/emolumentAuth.js
 *
 * Emolument role-based access guard.
 * Always used AFTER the existing verifyToken middleware —
 * it assumes req.user_id is already populated.
 *
 * Usage:
 *   const { requireEmolRole, loadEmolRoles } = require('../middware/emolumentAuth');
 *
 *   // Any authenticated personnel (exists in ef_personalinfos)
 *   router.get('/my-form', verifyToken, requirePersonnel, handler);
 *
 *   // Must be a DO for the ship in params/body
 *   router.post('/forms/:id/review', verifyToken, requireEmolRole('DO'), handler);
 *
 *   // Must be CPO — scope checked against form's command
 *   router.post('/forms/:id/confirm', verifyToken, requireEmolRole('CPO'), handler);
 *
 *   // EMOL_ADMIN only, no scope check
 *   router.get('/admin/reports', verifyToken, requireEmolRole('EMOL_ADMIN'), handler);
 */

'use strict';

const pool   = require('../config/db');
const config = require('../config');

// ── Internal: fetch all active emolument roles for a user ─────
async function fetchEmolRoles(userId) {
  pool.useDatabase(process.env.DB_OFFICERS || config.databases.officers);

  const [rows] = await pool.query(
    `SELECT role, scope_type, scope_value
     FROM ef_user_roles
     WHERE user_id = ? AND is_active = 1`,
    [userId]
  );

  return rows; // array of { role, scope_type, scope_value }
}

// ── Internal: confirm user exists as active personnel ─────────
async function isPersonnel(userId) {
  pool.useDatabase(process.env.DB_OFFICERS || config.databases.officers);

  const [rows] = await pool.query(
    `SELECT serviceNumber FROM ef_personalinfos
     WHERE serviceNumber = ? LIMIT 1`,
    [userId]
  );

  return rows.length > 0;
}

// ── Internal: resolve the scope value for the current request ─
// We look in (in order): req.params, req.body, req.query
function resolveScope(req, scopeType) {
  if (scopeType === 'SHIP') {
    return (
      req.params.ship   ||
      req.body?.ship    ||
      req.query?.ship   ||
      null
    );
  }
  if (scopeType === 'COMMAND') {
    return (
      req.params.command  ||
      req.body?.command   ||
      req.query?.command  ||
      null
    );
  }
  return null; // GLOBAL — no scope value needed
}

// ── Internal: check if user's roles satisfy requirement ───────
function hasRequiredRole(roles, requiredRole, req) {
  return roles.some(r => {
    if (r.role !== requiredRole) return false;

    // GLOBAL scope — always passes
    if (r.scope_type === 'GLOBAL') return true;

    // Scoped — must match the scope value in the request
    const requestScope = resolveScope(req, r.scope_type);
    if (!requestScope) return false; // scope required but not provided in request

    return r.scope_value === requestScope;
  });
}

// ─────────────────────────────────────────────────────────────
// MIDDLEWARE: loadEmolRoles
// Attaches req.emolRoles to every authenticated request.
// Use this on routes that need to KNOW the roles but not
// strictly gate access (e.g. dashboard summary endpoints).
// ─────────────────────────────────────────────────────────────
const loadEmolRoles = async (req, res, next) => {
  if (!req.user_id) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    req.emolRoles     = await fetchEmolRoles(req.user_id);
    req.isPersonnel   = await isPersonnel(req.user_id);
    req.isEmolAdmin   = req.emolRoles.some(r => r.role === 'EMOL_ADMIN');
    next();
  } catch (err) {
    console.error('❌ emolumentAuth.loadEmolRoles error:', err);
    res.status(500).json({ error: 'Server error loading emolument roles' });
  }
};

// ─────────────────────────────────────────────────────────────
// MIDDLEWARE: requirePersonnel
// Allows access to anyone who exists in ef_personalinfos.
// This is the baseline — filling your own form, viewing your
// own form status etc.
// ─────────────────────────────────────────────────────────────
const requirePersonnel = async (req, res, next) => {
  if (!req.user_id) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const personnel = await isPersonnel(req.user_id);
    if (!personnel) {
      return res.status(403).json({
        error: 'Access denied. Personnel record not found.'
      });
    }

    // Also load roles for downstream use
    req.emolRoles   = await fetchEmolRoles(req.user_id);
    req.isPersonnel = true;
    req.isEmolAdmin = req.emolRoles.some(r => r.role === 'EMOL_ADMIN');
    next();
  } catch (err) {
    console.error('❌ emolumentAuth.requirePersonnel error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────
// MIDDLEWARE FACTORY: requireEmolRole(role)
// Gates access to users who hold the specified emolument role.
// Scope is automatically checked against request params/body.
// EMOL_ADMIN always passes — they can do everything.
//
// Examples:
//   requireEmolRole('DO')         → must be DO for req ship
//   requireEmolRole('FO')         → must be FO for req ship/command
//   requireEmolRole('CPO')        → must be CPO for req command
//   requireEmolRole('EMOL_ADMIN') → must be EMOL_ADMIN (global)
// ─────────────────────────────────────────────────────────────
const requireEmolRole = (requiredRole) => {
  return async (req, res, next) => {
    if (!req.user_id) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
      const roles = await fetchEmolRoles(req.user_id);

      // EMOL_ADMIN bypasses all role checks
      const isAdmin = roles.some(r => r.role === 'EMOL_ADMIN');
      if (isAdmin) {
        req.emolRoles   = roles;
        req.isEmolAdmin = true;
        req.isPersonnel = true;
        return next();
      }

      // Check for required role with scope
      const passes = hasRequiredRole(roles, requiredRole, req);
      if (!passes) {
        return res.status(403).json({
          error: `Access denied. Required emolument role: ${requiredRole}`
        });
      }

      req.emolRoles   = roles;
      req.isEmolAdmin = false;
      req.isPersonnel = await isPersonnel(req.user_id);
      next();
    } catch (err) {
      console.error(`❌ emolumentAuth.requireEmolRole(${requiredRole}) error:`, err);
      res.status(500).json({ error: 'Server error' });
    }
  };
};

// ─────────────────────────────────────────────────────────────
// MIDDLEWARE: requireAnyEmolRole
// Passes if user holds ANY elevated emolument role.
// Useful for shared views (e.g. "officer review dashboard")
// that DOs, FOs, CPOs and admins can all see.
// ─────────────────────────────────────────────────────────────
const requireAnyEmolRole = async (req, res, next) => {
  if (!req.user_id) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const roles = await fetchEmolRoles(req.user_id);
    if (roles.length === 0) {
      return res.status(403).json({
        error: 'Access denied. No elevated emolument role assigned.'
      });
    }

    req.emolRoles   = roles;
    req.isEmolAdmin = roles.some(r => r.role === 'EMOL_ADMIN');
    req.isPersonnel = true;
    next();
  } catch (err) {
    console.error('❌ emolumentAuth.requireAnyEmolRole error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {
  loadEmolRoles,
  requirePersonnel,
  requireEmolRole,
  requireAnyEmolRole,
};
/**
 * EMOLUMENT ROLE GUARDS
 * FILE: routes/auth/emolument-guards.js
 * 
 * Middleware for protecting emolument endpoints
 * Works with pre-login tokens (no current_class needed)
 */

'use strict';

const pool = require('../../config/db');
const config = require('../../config');

/**
 * Require authenticated personnel (exists in ef_personalinfos or emolument system)
 */
const requirePersonnel = async (req, res, next) => {
  try {
    pool.useDatabase(process.env.DB_OFFICERS || config.databases.officers);

    const [rows] = await pool.query(
      `SELECT serviceNumber FROM ef_personalinfos WHERE serviceNumber = ? LIMIT 1`,
      [req.user_id]
    );

    if (!rows || rows.length === 0) {
      return res.status(403).json({ message: 'Not authorized as personnel' });
    }

    next();
  } catch (err) {
    console.error('❌ requirePersonnel error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Require specific emolument role (DO, FO, CPO, EMOL_ADMIN)
 * Can be scoped to SHIP or COMMAND if needed
 * 
 * Usage: requireEmolRole('DO') or requireEmolRole('FO', 'SHIP')
 */
const requireEmolRole = (role, scopeType = null) => {
  return async (req, res, next) => {
    try {
      pool.useDatabase(process.env.DB_OFFICERS || config.databases.officers);

      // Get all active roles for this user
      const [rows] = await pool.query(
        `SELECT role, scope_type, scope_value FROM ef_user_roles
         WHERE user_id = ? AND is_active = 1`,
        [req.user_id]
      );

      if (!rows || rows.length === 0) {
        return res.status(403).json({ message: `Not authorized as ${role}` });
      }

      // Find matching role
      const hasRole = rows.some((r) => {
        if (r.role !== role) return false;
        if (!scopeType) return true; // GLOBAL scope OK
        return r.scope_type === scopeType;
      });

      if (!hasRole) {
        return res.status(403).json({ message: `Not authorized as ${role}` });
      }

      // Attach user's roles to request for later use
      req.emol_roles = rows;
      next();
    } catch (err) {
      console.error(`❌ requireEmolRole(${role}) error:`, err);
      return res.status(500).json({ message: 'Server error' });
    }
  };
};

/**
 * Require specific ship access for DO/FO
 * Checks if user has DO or FO role scoped to the ship in params
 * 
 * Usage: router.post('/:ship/action', requireShipAccess, handler);
 * Expects req.params.ship or req.body.ship
 */
const requireShipAccess = async (req, res, next) => {
  try {
    const ship = req.params.ship || req.body?.ship;
    if (!ship) {
      return res.status(400).json({ message: 'Ship name required' });
    }

    pool.useDatabase(process.env.DB_OFFICERS || config.databases.officers);

    const [rows] = await pool.query(
      `SELECT role FROM ef_user_roles
       WHERE user_id = ? 
         AND role IN ('DO', 'FO')
         AND scope_type = 'SHIP'
         AND scope_value = ?
         AND is_active = 1
       LIMIT 1`,
      [req.user_id, ship]
    );

    if (!rows || rows.length === 0) {
      return res.status(403).json({ 
        message: `Not authorized for ship: ${ship}` 
      });
    }

    req.user_ship = ship;
    req.user_ship_role = rows[0].role; // 'DO' or 'FO'
    next();
  } catch (err) {
    console.error('❌ requireShipAccess error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

/**
 * Require specific command access for CPO
 * Checks if user has CPO role scoped to the command in params
 */
const requireCommandAccess = async (req, res, next) => {
  try {
    const command = req.params.command || req.body?.command;
    if (!command) {
      return res.status(400).json({ message: 'Command name required' });
    }

    pool.useDatabase(process.env.DB_OFFICERS || config.databases.officers);

    const [rows] = await pool.query(
      `SELECT scope_value FROM ef_user_roles
       WHERE user_id = ? 
         AND role = 'CPO'
         AND scope_type = 'COMMAND'
         AND scope_value = ?
         AND is_active = 1
       LIMIT 1`,
      [req.user_id, command]
    );

    if (!rows || rows.length === 0) {
      return res.status(403).json({ 
        message: `Not authorized for command: ${command}` 
      });
    }

    req.user_command = command;
    next();
  } catch (err) {
    console.error('❌ requireCommandAccess error:', err);
    return res.status(500).json({ message: 'Server error' });
  }
};

module.exports = {
  requirePersonnel,
  requireEmolRole,
  requireShipAccess,
  requireCommandAccess,
};

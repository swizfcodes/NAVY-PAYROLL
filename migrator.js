/**
 * EMOLUMENT SYSTEM — PHASE 1
 * FILE: migrator.js
 * DESC: Runs all Phase 1 SQL migration files in order.
 *       Mirrors the pattern used in the existing payroll system migrator.
 * RUN:  node migrator.js
 *       node migrator.js --dry-run   (prints SQL without executing)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// ── Config ────────────────────────────────────────────────────
const DB_CONFIG = {
  host:               process.env.DB_HOST     || 'localhost',
  port:               parseInt(process.env.DB_PORT || '3306'),
  user:               process.env.DB_USER,
  password:           process.env.DB_PASSWORD,
  database:           process.env.DB_OFFICERS,
  multipleStatements: true,   // required to run full SQL files
  timezone:           'Z',
};

const DRY_RUN = process.argv.includes('--dry-run');

// ── Migration files — ORDER MATTERS ───────────────────────────
const MIGRATIONS = [
  '01_schema_remediation.sql',
  '02_new_tables.sql',
  '03_seed_migration.sql',
];

// ── Helpers ───────────────────────────────────────────────────
const SQL_DIR = path.resolve(__dirname);

function loadSql(filename) {
  const filepath = path.join(SQL_DIR, filename);
  if (!fs.existsSync(filepath)) {
    throw new Error(`Migration file not found: ${filepath}`);
  }
  return fs.readFileSync(filepath, 'utf8');
}

function log(msg, type = 'info') {
  const prefix = {
    info:    '  ℹ',
    success: '  ✅',
    warn:    '  ⚠️',
    error:   '  ❌',
    step:    '\n📌',
  }[type] || '  ';
  console.log(`${prefix} ${msg}`);
}

// ── Main ──────────────────────────────────────────────────────
async function runMigrations() {
  console.log('\n========================================');
  console.log('  EMOLUMENT SYSTEM — Phase 1 Migration');
  if (DRY_RUN) console.log('  MODE: DRY RUN — no changes will be made');
  console.log('========================================\n');

  let connection;

  try {
    if (!DRY_RUN) {
      log('Connecting to database...', 'info');
      connection = await mysql.createConnection(DB_CONFIG);
      log(`Connected to ${DB_CONFIG.database} on ${DB_CONFIG.host}`, 'success');
    }

    for (const filename of MIGRATIONS) {
      log(`Running: ${filename}`, 'step');

      const sql = loadSql(filename);

      if (DRY_RUN) {
        console.log('\n--- SQL Preview ---');
        // Show first 500 chars of each file in dry run
        console.log(sql.substring(0, 500) + (sql.length > 500 ? '\n... (truncated)' : ''));
        console.log('--- End Preview ---\n');
        log(`[DRY RUN] Would execute ${sql.length} chars of SQL`, 'info');
        continue;
      }

      try {
        // Split on GO or run as multi-statement
        // MySQL doesn't support GO — split on delimiter if present,
        // otherwise run the whole file as multipleStatements
        const statements = sql
          .split(/;\s*\n/)
          .map(s => s.trim())
          .filter(s => s.length > 0 && !s.startsWith('--'));

        // We use multipleStatements mode so we can send the whole file
        await connection.query(sql);
        log(`Completed: ${filename}`, 'success');
      } catch (sqlErr) {
        // Some ALTER TABLE statements fail if already applied — warn, don't crash
        if (
          sqlErr.code === 'ER_DUP_KEYNAME' ||
          sqlErr.code === 'ER_MULTIPLE_PRI_KEY' ||
          sqlErr.message.includes('Duplicate key name') ||
          sqlErr.message.includes('Multiple primary key')
        ) {
          log(`${filename} — already applied (${sqlErr.code}), skipping`, 'warn');
        } else {
          log(`Failed on ${filename}: ${sqlErr.message}`, 'error');
          throw sqlErr; // re-throw — stop migration on real errors
        }
      }
    }

    console.log('\n========================================');
    if (DRY_RUN) {
      log('DRY RUN complete — no changes made', 'info');
    } else {
      log('Phase 1 migration complete ✅', 'success');
      log('Run the validation queries in 03_seed_migration.sql to verify', 'info');
    }
    console.log('========================================\n');

  } catch (err) {
    log(`Migration failed: ${err.message}`, 'error');
    console.error(err);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
      log('Database connection closed', 'info');
    }
  }
}

runMigrations();
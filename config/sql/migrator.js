// ============================================
// FILE: sql_migrations/migrator.js
// ============================================
const fs = require("fs").promises;
const path = require("path");
const mysql = require("mysql2/promise");
const config = require("../../config");

class Migrator {
  constructor() {
    this.migrationsDir = path.join(__dirname, "migrations");
    this.connection = null;
    this.targetDatabase = null;
  }

  async connect(database = null) {
    if (this.connection) return;

    this.targetDatabase = database || config.databases.officers;

    this.connection = await mysql.createConnection({
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      database: this.targetDatabase,
      multipleStatements: true,
    });

    console.log(`🔗 Connected to database: ${this.targetDatabase}`);
  }

  async ensureMigrationsTable() {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS migrations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        batch INT NOT NULL,
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_name (name),
        INDEX idx_batch (batch)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `;
    await this.connection.query(createTableSQL);
  }

  async getLastBatch() {
    try {
      const [rows] = await this.connection.query(
        "SELECT MAX(batch) as last_batch FROM migrations",
      );
      return rows[0].last_batch || 0;
    } catch (error) {
      return 0;
    }
  }

  async getExecutedMigrations() {
    try {
      const [rows] = await this.connection.query(
        "SELECT name, batch FROM migrations ORDER BY id",
      );
      return rows;
    } catch (error) {
      return [];
    }
  }

  /**
   * Where a migration runs, from a "-- @scope:" line near the top of the file:
   *   -- @scope: master   hicaddata (officers) only: users, login, emolument (ef_*), sync_*
   *   -- @scope: all      every payroll database: payroll tables (py_*)
   * A file without the line counts as "all" (with a warning).
   */
  async getScope(filename) {
    const fh = await fs.open(path.join(this.migrationsDir, filename), "r");
    try {
      const buf = Buffer.alloc(2048);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const m = buf.toString("utf8", 0, bytesRead).match(/--\s*@scope:\s*(master|all)\b/i);
      if (m) return m[1].toLowerCase();
    } finally {
      await fh.close();
    }
    this._untagged = this._untagged || new Set();
    if (!this._untagged.has(filename)) {
      this._untagged.add(filename);
      console.warn(`⚠️  ${filename} has no "-- @scope: master|all" line; running it on every database`);
    }
    return "all";
  }

  isMasterDatabase(database = this.targetDatabase) {
    return String(database || "").toLowerCase() === String(config.databases.officers || "").toLowerCase();
  }

  async getPendingMigrations() {
    const files = await fs.readdir(this.migrationsDir);
    const sqlFiles = files
      .filter((f) => f.endsWith(".sql") && !f.includes("migrator"))
      .sort();

    const executed = await this.getExecutedMigrations();
    const executedNames = executed.map((e) => e.name);

    const pending = [];
    for (const f of sqlFiles) {
      if (executedNames.includes(f)) continue;
      // master-scoped migrations never run (or count as pending) on the class databases
      if (!this.isMasterDatabase() && (await this.getScope(f)) === "master") continue;
      pending.push(f);
    }
    return pending;
  }

  async executeMigration(filename, batch) {
    const filepath = path.join(this.migrationsDir, filename);
    const content = await fs.readFile(filepath, "utf8");

    const upMatch = content.match(/-- UP\s+([\s\S]*?)(?=-- DOWN|$)/i);

    if (!upMatch) {
      throw new Error(`Migration ${filename} missing -- UP section`);
    }

    const statements = this.parseStatements(upMatch[1]);

    await this.connection.beginTransaction();

    try {
      for (const stmt of statements) {
        await this.connection.query(stmt);
      }

      await this.connection.query(
        "INSERT INTO migrations (name, batch) VALUES (?, ?)",
        [filename, batch],
      );

      await this.connection.commit();
      console.log(`✓ Executed migration: ${filename}`);
    } catch (error) {
      await this.connection.rollback();
      throw error;
    }
  }

  async rollbackMigration(migration) {
    const filepath = path.join(this.migrationsDir, migration.name);
    const content = await fs.readFile(filepath, "utf8");

    const downMatch = content.match(/-- DOWN\s+([\s\S]*?)$/i);

    if (!downMatch) {
      throw new Error(`Migration ${migration.name} missing -- DOWN section`);
    }

    const statements = this.parseStatements(downMatch[1]);

    await this.connection.beginTransaction();

    try {
      for (const stmt of statements) {
        await this.connection.query(stmt);
      }

      await this.connection.query("DELETE FROM migrations WHERE name = ?", [
        migration.name,
      ]);

      await this.connection.commit();
      console.log(`✓ Rolled back migration: ${migration.name}`);
    } catch (error) {
      await this.connection.rollback();
      throw error;
    }
  }

  // Add this new method to the class
  parseStatements(sql) {
    const normalized = sql
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\xA0/g, " ");

    const statements = [];
    let current = "";
    let inProcedure = false;
    let delimiter = ";"; // track current delimiter

    for (const line of normalized.split("\n")) {
      const trimmed = line.trim();

      // Handle DELIMITER changes — strip them entirely, just update internal tracker
      const delimiterMatch = trimmed.match(/^DELIMITER\s+(\S+)$/i);
      if (delimiterMatch) {
        delimiter = delimiterMatch[1]; // e.g. '$$'
        continue; // never send DELIMITER to MySQL
      }

      // Skip full-line comments and empty lines (outside procedures)
      if (!inProcedure && (trimmed.startsWith("--") || trimmed === "")) {
        continue;
      }

      // Detect entering a procedure/function body
      if (/^(CREATE\s+PROCEDURE|CREATE\s+FUNCTION)/i.test(trimmed)) {
        inProcedure = true;
      }

      current += line + "\n";

      if (inProcedure) {
        // End of procedure: END followed by current delimiter (END$$ or END;)
        const escapedDelim = delimiter.replace(/[$^.*+?()[\]{}|\\]/g, "\\$&");
        const endPattern = new RegExp(`^END\\s*${escapedDelim}\\s*$`, "i");
        if (endPattern.test(trimmed)) {
          // Normalize: replace END$$ with END so MySQL accepts it
          const normalized = current
            .trim()
            .replace(new RegExp(`${escapedDelim}\\s*$`), "");
          statements.push(normalized);
          current = "";
          inProcedure = false;
          delimiter = ";"; // reset delimiter after procedure
        }
      } else {
        // Normal statement ends at semicolon
        if (trimmed.endsWith(";")) {
          const stmt = current.trim().replace(/;$/, "").trim();
          if (stmt) statements.push(stmt);
          current = "";
        }
      }
    }

    // Catch any remaining statement without trailing semicolon
    const remaining = current.trim().replace(/;$/, "").trim();
    if (remaining) statements.push(remaining);

    return statements.filter(Boolean);
  }

  async runMigrations(database = null) {
    try {
      await this.connect(database);
      await this.ensureMigrationsTable();

      const pending = await this.getPendingMigrations();

      if (pending.length === 0) {
        console.log("✅ No pending migrations");
        return;
      }

      console.log(
        `📋 Found ${pending.length} pending migration(s) for ${this.targetDatabase}`,
      );

      const batch = (await this.getLastBatch()) + 1;

      for (const migration of pending) {
        await this.executeMigration(migration, batch);
      }

      console.log(`✅ All migrations completed successfully (Batch ${batch})`);
    } catch (error) {
      console.error("❌ Migration failed:", error);
      throw error;
    } finally {
      await this.disconnect();
    }
  }

  /**
   * Record every pending migration up to and including `throughFile` as
   * executed WITHOUT running it — for a database whose schema already has
   * those changes but whose migrations table does not say so.
   * Rows go in batch 0, which rollback never touches.
   * Without `apply` it only lists what would be recorded.
   */
  async baseline(database, throughFile, apply = false) {
    try {
      await this.connect(database);
      await this.ensureMigrationsTable();

      const pending = await this.getPendingMigrations();
      const through = pending.indexOf(throughFile);
      if (through === -1) {
        throw new Error(
          `${throughFile} is not a pending migration on ${this.targetDatabase}. ` +
            "Check the name with: npm run migrate:status",
        );
      }

      const toRecord = pending.slice(0, through + 1);
      console.log(
        `📋 ${apply ? "Recording" : "Would record"} ${toRecord.length} migration(s) on ${this.targetDatabase} as already executed (not run):`,
      );
      toRecord.forEach((m) => console.log(`  ✓ ${m}`));
      const left = pending.slice(through + 1);
      console.log(`\n⧗ Still pending afterwards (${left.length}):`);
      left.forEach((m) => console.log(`  - ${m}`));

      if (!apply) {
        console.log("\nDry run — nothing recorded. Add --apply to record them.");
        return;
      }

      for (const name of toRecord) {
        await this.connection.query(
          "INSERT IGNORE INTO migrations (name, batch) VALUES (?, 0)",
          [name],
        );
      }
      console.log(`\n✅ Recorded ${toRecord.length} migration(s) in batch 0`);
    } catch (error) {
      console.error("❌ Baseline failed:", error.message);
      throw error;
    } finally {
      await this.disconnect();
    }
  }

  async runOnAllDatabases() {
    console.log("🚀 Running migrations on all databases...\n");

    const databases = Object.values(config.databases);
    const results = [];

    for (const db of databases) {
      console.log(`\n📊 Migrating database: ${db}`);
      console.log("─".repeat(50));

      try {
        await this.connect(db);
        await this.ensureMigrationsTable();

        const pending = await this.getPendingMigrations();

        if (pending.length === 0) {
          console.log(`✅ ${db} - No pending migrations`);
          results.push({ database: db, status: "up-to-date", migrations: 0 });
        } else {
          const batch = (await this.getLastBatch()) + 1;
          for (const migration of pending) {
            await this.executeMigration(migration, batch);
          }
          console.log(`✅ ${db} - Completed ${pending.length} migration(s)`);
          results.push({
            database: db,
            status: "success",
            migrations: pending.length,
          });
        }
      } catch (error) {
        console.error(`❌ ${db} - Failed:`, error.message);
        results.push({ database: db, status: "failed", error: error.message });
      } finally {
        await this.disconnect();
      }
    }

    console.log("\n" + "=".repeat(50));
    console.log("📊 MIGRATION SUMMARY");
    console.log("=".repeat(50));
    results.forEach((r) => {
      const icon =
        r.status === "success" || r.status === "up-to-date" ? "✓" : "✗";
      console.log(
        `${icon} ${r.database}: ${r.status} ${r.migrations ? `(${r.migrations} migrations)` : ""}`,
      );
    });

    const failed = results.filter((r) => r.status === "failed");
    if (failed.length > 0) {
      console.log(`\n⚠️  ${failed.length} database(s) failed migration`);
      process.exit(1);
    }
  }

  async rollback(database = null, steps = 1) {
    try {
      await this.connect(database);
      await this.ensureMigrationsTable();

      const executed = await this.getExecutedMigrations();

      if (executed.length === 0) {
        console.log("✅ No migrations to rollback");
        return;
      }

      const lastBatch = await this.getLastBatch();
      // Batch 0 holds migrations recorded by `baseline`: they were never run
      // by this tool, so their DOWN sections must not run either.
      if (lastBatch < 1) {
        console.log("✅ No migrations to rollback (only baseline-recorded ones remain)");
        return;
      }
      const migrationsToRollback = executed
        .filter((m) => m.batch === lastBatch)
        .reverse();

      if (migrationsToRollback.length === 0) {
        console.log("✅ No migrations in last batch");
        return;
      }

      console.log(
        `⚠️  Rolling back ${migrationsToRollback.length} migration(s) from batch ${lastBatch}...`,
      );

      for (const migration of migrationsToRollback) {
        await this.rollbackMigration(migration);
      }

      console.log("✅ Rollback completed successfully");
    } catch (error) {
      console.error("❌ Rollback failed:", error);
      throw error;
    } finally {
      await this.disconnect();
    }
  }

  async status(database = null) {
    try {
      await this.connect(database);
      await this.ensureMigrationsTable();

      const executed = await this.getExecutedMigrations();
      const pending = await this.getPendingMigrations();

      console.log(`\n${"=".repeat(50)}`);
      console.log(`📊 MIGRATION STATUS - ${this.targetDatabase}`);
      console.log("=".repeat(50));

      console.log(`\n✓ Executed (${executed.length}):`);
      if (executed.length === 0) {
        console.log("  (none)");
      } else {
        const batches = {};
        executed.forEach((m) => {
          if (!batches[m.batch]) batches[m.batch] = [];
          batches[m.batch].push(m.name);
        });

        Object.entries(batches).forEach(([batch, migrations]) => {
          console.log(
            `\n  Batch ${batch}${batch === "0" ? " (recorded by baseline, not run here)" : ""}:`,
          );
          migrations.forEach((m) => console.log(`    ✓ ${m}`));
        });
      }

      console.log(`\n⧗ Pending (${pending.length}):`);
      if (pending.length === 0) {
        console.log("  (none)");
      } else {
        pending.forEach((m) => console.log(`  - ${m}`));
      }
      console.log("");
    } catch (error) {
      console.error("❌ Status check failed:", error);
      throw error;
    } finally {
      await this.disconnect();
    }
  }

  async statusAll() {
    console.log("\n" + "=".repeat(60));
    console.log("📊 MIGRATION STATUS - ALL DATABASES");
    console.log("=".repeat(60));

    const databases = Object.entries(config.databases);

    for (const [name, db] of databases) {
      try {
        await this.connect(db);
        await this.ensureMigrationsTable();

        const executed = await this.getExecutedMigrations();
        const pending = await this.getPendingMigrations();
        const lastBatch = await this.getLastBatch();

        console.log(`\n🗄️  ${name.toUpperCase()} (${db})`);
        console.log(`   ✓ Executed: ${executed.length} (Batch ${lastBatch})`);
        console.log(`   ⧗ Pending: ${pending.length}`);

        if (pending.length > 0) {
          pending.slice(0, 3).forEach((m) => console.log(`      - ${m}`));
          if (pending.length > 3)
            console.log(`      ... and ${pending.length - 3} more`);
        }
      } catch (error) {
        console.log(`\n🗄️  ${name.toUpperCase()} (${db})`);
        console.log(`   ❌ Error: ${error.message}`);
      } finally {
        await this.disconnect();
      }
    }
    console.log("");
  }

  async createMigration(name) {
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\..+/, "")
      .replace("T", "_");
    const filename = `${timestamp}_${name}.sql`;
    const filepath = path.join(`${this.migrationsDir}`, filename);

    const template = `-- @scope: all   (all = every payroll database, for py_* tables; master = hicaddata only, for users / emolument / sync)
-- Migration: ${name}
-- Created: ${new Date().toISOString()}

-- UP
-- Add your schema changes here


-- DOWN
-- Add rollback logic here (reverse of UP)

`;

    await fs.writeFile(filepath, template);
    console.log(`✓ Created migration: ${filename}`);
    console.log(`📝 Edit the file at: sql_migrations/${filename}`);
  }

  async disconnect() {
    if (this.connection) {
      await this.connection.end();
      this.connection = null;
    }
  }
}

module.exports = new Migrator();

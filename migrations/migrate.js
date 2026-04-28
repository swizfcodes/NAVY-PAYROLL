// ============================================
// FILE: migrate.js (CLI script at project root)
// ============================================

// #!/usr/bin/env node
const migrator = require("../config/sql/migrator");
const config = require("../config");

const command = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];

async function run() {
  try {
    console.log("🔧 Migration Tool\n");

    switch (command) {
      case "make":
        if (!arg1) {
          console.log("Usage: npm run migrate:make <migration_name>");
          console.log("Example: npm run migrate:make add_phone_to_users");
          process.exit(1);
        }
        await migrator.createMigration(arg1);
        break;

      case "up":
        if (arg1 === "all") {
          await migrator.runOnAllDatabases();
        } else if (arg1) {
          const dbName = config.databases[arg1] || arg1;
          await migrator.runMigrations(dbName);
        } else {
          console.log("Usage: npm run migrate:up [database|all]");
          console.log(
            "Available databases:",
            Object.keys(config.databases).join(", "),
          );
          process.exit(1);
        }
        break;

      case "down":
        if (!arg1) {
          console.log("Usage: npm run migrate:down [database]");
          console.log(
            "Available databases:",
            Object.keys(config.databases).join(", "),
          );
          process.exit(1);
        }
        const dbName = config.databases[arg1] || arg1;
        const steps = arg2 ? parseInt(arg2) : 1;
        await migrator.rollback(dbName, steps);
        break;

      case "status":
        if (arg1 === "all" || !arg1) {
          await migrator.statusAll();
        } else {
          const dbName = config.databases[arg1] || arg1;
          await migrator.status(dbName);
        }
        break;

      default:
        console.log("Migration Commands:");
        console.log("");
        console.log(
          "  npm run migrate:make <name>        - Create a new migration file",
        );
        console.log(
          "  npm run migrate:up [database|all]  - Run pending migrations",
        );
        console.log(
          "  npm run migrate:down [database]    - Rollback last batch",
        );
        console.log(
          "  npm run migrate:status [all]       - Check migration status",
        );
        console.log("");
        console.log("Examples:");
        console.log("  npm run migrate:make add_phone_to_users");
        console.log("  npm run migrate:up officers");
        console.log("  npm run migrate:up all");
        console.log("  npm run migrate:down officers");
        console.log("  npm run migrate:status all");
    }

    process.exit(0);
  } catch (error) {
    console.error("\n❌ Migration error:", error.message);
    if (process.env.NODE_ENV !== "production") {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

run();

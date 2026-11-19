import fs from "node:fs";
import Database from "better-sqlite3";
import { config } from "../config.js";
import { runMigrations } from "./migrations.js";

import { migrateSecrets } from "./secretBox.js";

let db: Database.Database | null = null;

/**
 * Opens the local SQLite database, creating the file and schema on first run.
 * Called once at server startup.
 */
export function initDatabase(): Database.Database {
  if (db) return db;

  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  }

  const firstRun = !fs.existsSync(config.dbPath);

  const connection = new Database(config.dbPath);
  try {
    fs.chmodSync(config.dbPath, 0o600);
    connection.pragma("secure_delete = ON");
    connection.pragma("journal_mode = WAL");
    connection.pragma("foreign_keys = ON");
    runMigrations(connection);
    migrateSecrets(connection);
    db = connection;
  } catch (error) {
    connection.close();
    throw error;
  }

  if (firstRun) {
    console.log(`Created local database at ${config.dbPath}`);
  }

  return db;
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() at startup.");
  }
  return db;
}

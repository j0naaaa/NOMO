import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

const prefix = "nomo:v1:";

function key(): Buffer {
  const raw = process.env.NOMO_SECRET_KEY ?? "";
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== raw) {
    throw new Error("Set NOMO_SECRET_KEY to a base64-encoded 32-byte key before saving or opening credentials.");
  }
  return bytes;
}

export function seal(provider: string, value: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), nonce);
  cipher.setAAD(Buffer.from(provider));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return prefix + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
}

export function unseal(provider: string, value: string): string {
  if (!value.startsWith(prefix)) throw new Error("Credential encryption format is invalid.");
  const data = Buffer.from(value.slice(prefix.length), "base64");
  const cipher = createDecipheriv("aes-256-gcm", key(), data.subarray(0, 12));
  cipher.setAAD(Buffer.from(provider));
  cipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString("utf8");
}

export function migrateSecrets(db: Database.Database): void {
  const changed = db.transaction(() => {
    const rows = db.prepare("SELECT provider, secret FROM credentials").all() as { provider: string; secret: string }[];
    const update = db.prepare("UPDATE credentials SET secret = ? WHERE provider = ?");
    let changed = false;
    for (const row of rows) {
      if (row.secret.startsWith(prefix)) {
        unseal(row.provider, row.secret);
      } else {
        update.run(seal(row.provider, row.secret), row.provider);
        changed = true;
      }
    }
    return changed;
  })();
  if (changed) {
    db.exec("VACUUM");
    db.pragma("wal_checkpoint(TRUNCATE)");
  }
}

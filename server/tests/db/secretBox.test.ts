import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { migrateSecrets, unseal } from "../../src/db/secretBox.js";

test("legacy credentials migrate atomically, survive restart and require the same key", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE credentials(provider TEXT PRIMARY KEY, secret TEXT); INSERT INTO credentials VALUES('test','example')");
  delete process.env.NOMO_SECRET_KEY;
  assert.throws(() => migrateSecrets(db));
  process.env.NOMO_SECRET_KEY = randomBytes(32).toString("base64");
  migrateSecrets(db);
  const {secret} = db.prepare("SELECT secret FROM credentials").get() as {secret: string};
  assert.ok(!secret.includes("example"));
  assert.equal(unseal("test", secret), "example");
  assert.throws(() => unseal("different", secret));
  migrateSecrets(db);
  process.env.NOMO_SECRET_KEY = randomBytes(32).toString("base64");
  assert.throws(() => migrateSecrets(db));
  db.close();
});

import { randomBytes } from "node:crypto";
import { openSync, closeSync, writeFileSync } from "node:fs";

const envFile = new URL("../.env", import.meta.url);
let fd;
try {
  fd = openSync(envFile, "wx", 0o600);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("Existing .env preserved. For an existing installation, follow the credential migration notes in README.");
  process.exit(0);
}
try {
  writeFileSync(fd, [
    "NOMO_SECRET_KEY=" + randomBytes(32).toString("base64"),
    "NOMO_MAX_ORDER_USD=",
    "NOMO_MAX_POSITION_USD=",
    "NOMO_MAX_TOTAL_USD=",
    "",
  ].join("\n"));
} finally { closeSync(fd); }
console.log("Created private .env. Order limits are unset.");

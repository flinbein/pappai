import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "./store.ts";
import { issueCode, migrateAuth } from "./auth.ts";

const [action, rawEmail] = process.argv.slice(2);
const email = rawEmail?.trim().toLowerCase();
if (process.argv.length !== 4 || !["admin","otp"].includes(action) || !email || !/^[^\s@]+@[^\s@]+$/.test(email)) {
  console.error("Usage: node src/admin.ts <admin|otp> EMAIL");
  process.exit(1);
}
const location = resolve(process.env.PAPPAI_DB || "data/pappai.sqlite");
mkdirSync(dirname(location),{recursive:true});
const db = new DatabaseSync(location);
try {
  const store = new Store(db);
  migrateAuth(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    const account = action === "admin" ? store.ensureAdmin(email) : store.byEmail(email);
    if (!account) throw new Error("Аккаунт не найден");
    const code = issueCode(db,account.id,action === "admin");
    db.exec("COMMIT");
    console.log(code);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Ошибка административной команды");
  process.exitCode = 1;
} finally {
  db.close();
}

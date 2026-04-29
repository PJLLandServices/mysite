// One-time setup: create or replace the CRM admin password.
//
// Usage:   npm run setup-password
//   (or)   node server/setup-password.js
//
// Writes server/data/auth.json with:
//   - a fresh random salt
//   - the scrypt hash of the password you typed
//   - a fresh random session secret (signs the login cookie)
//
// Re-run this any time you want to rotate the password. The leads.json
// in the same folder is left untouched.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const DATA_DIR = path.join(__dirname, "data");
const AUTH_FILE = path.join(DATA_DIR, "auth.json");

console.log("");
console.log("============================================================");
console.log(" PJL CRM — Set Admin Password");
console.log("============================================================");
console.log("");
console.log(" This sets the password used to log in to /admin.");
console.log(" Pick something you will remember. Don't reuse a password");
console.log(" you use anywhere else.");
console.log("");
console.log(" NOTE: as you type, your password WILL be visible on this");
console.log(" screen. Nobody else can see it — it's just on your computer.");
console.log("");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
const lines = [];

process.stdout.write(" New password:        ");

rl.on("line", (line) => {
  lines.push(line);
  if (lines.length === 1) {
    process.stdout.write(" Confirm password:    ");
    return;
  }
  if (lines.length === 2) {
    rl.close();
    finish(lines[0], lines[1]);
  }
});

function fail(message) {
  console.error("");
  console.error(" ❌ " + message);
  process.exit(1);
}

function finish(first, second) {
  if (!first || first.trim().length < 8) {
    fail("Password must be at least 8 characters. Nothing was saved.");
  }
  if (first !== second) {
    fail("The two passwords don't match. Nothing was saved.");
  }

  // Match the format server.js expects (see verifyPassword + signSession).
  const salt = crypto.randomBytes(16).toString("base64");
  const passwordHash = crypto.scryptSync(first, salt, 64).toString("base64");
  const sessionSecret = crypto.randomBytes(32).toString("base64");
  const config = {
    salt,
    passwordHash,
    sessionSecret,
    createdAt: new Date().toISOString()
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(config, null, 2) + "\n", "utf8");

  console.log("");
  console.log(" ✓ Password saved to: server/data/auth.json");
  console.log("");
  console.log(" Next steps:");
  console.log("   1. Make sure the server is running:  npm start");
  console.log("   2. Open in browser:                  http://127.0.0.1:4173/login");
  console.log("   3. Log in with your new password.");
  console.log("");
  console.log(" To change the password later, just run this again.");
  console.log("");
}

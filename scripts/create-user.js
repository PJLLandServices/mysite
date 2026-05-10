// Create a CRM admin or tech user. Replaces the legacy setup-password
// script — accounts now live in server/data/users.json instead of the
// single-password auth.json. The auth.json file is still used post-
// migration, but only as the session-secret store.
//
// Usage:   npm run create-user
//   (or)   node scripts/create-user.js
//
// Prompts for email, name, role (default admin), and password. Writes a
// new user record with a fresh per-user scrypt salt + hash. Re-running
// the script with the same email is rejected — to rotate a password,
// reset it through the admin /admin/users UI or call users.setPassword
// programmatically.
//
// On a fresh install, this script also seeds server/data/auth.json with
// a session secret if one isn't already there. It NEVER overwrites an
// existing sessionSecret — that would invalidate every active session.

const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const readline = require("node:readline");

const REPO_ROOT = path.resolve(__dirname, "..");
const SERVER_LIB = path.join(REPO_ROOT, "server", "lib");
const users = require(path.join(SERVER_LIB, "users.js"));

const DATA_DIR = path.join(REPO_ROOT, "server", "data");
const AUTH_FILE = path.join(DATA_DIR, "auth.json");

function banner() {
  console.log("");
  console.log("============================================================");
  console.log(" PJL CRM — Create User");
  console.log("============================================================");
  console.log("");
  console.log(" This adds a new admin or tech account to users.json.");
  console.log(" Pick something the user will remember; passwords must be");
  console.log(" at least 10 characters.");
  console.log("");
  console.log(" NOTE: as you type, the password WILL be visible on this");
  console.log(" screen. Nobody else sees it — it's just on this machine.");
  console.log("");
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function fail(message) {
  console.error("");
  console.error(" ❌ " + message);
  process.exit(1);
}

async function ensureSessionSecret() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  let config = {};
  if (fs.existsSync(AUTH_FILE)) {
    try { config = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")); }
    catch { config = {}; }
  }
  if (config && typeof config.sessionSecret === "string" && config.sessionSecret.length >= 32) {
    return;
  }
  const next = { sessionSecret: crypto.randomBytes(32).toString("base64") };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");
  console.log(" • Seeded fresh session secret in server/data/auth.json");
}

async function main() {
  banner();

  const email = (await prompt(" Email:               ")).trim();
  if (!email) fail("Email is required.");

  const name = (await prompt(" Full name:           ")).trim();
  if (!name) fail("Name is required.");

  const roleRaw = (await prompt(" Role [admin/tech] (default: admin): ")).trim().toLowerCase();
  const role = roleRaw || "admin";
  if (!users.ROLES.includes(role)) fail(`Role must be one of: ${users.ROLES.join(", ")}.`);

  const pw1 = await prompt(" Password (min 10):   ");
  const pw2 = await prompt(" Confirm password:    ");
  if (pw1 !== pw2) fail("Passwords don't match. Nothing was saved.");

  await ensureSessionSecret();

  let user;
  try {
    user = await users.create({ email, name, role, password: pw1 });
  } catch (err) {
    fail(err.message || "Couldn't create the user.");
  }

  console.log("");
  console.log(` ✓ Created ${user.id} <${user.email}> (${user.role})`);
  console.log("");
  console.log(" Next steps:");
  console.log("   1. Make sure the server is running:  npm start");
  console.log("   2. Open in browser:                  http://127.0.0.1:4173/login");
  console.log("   3. Sign in with the email + password above.");
  console.log("");
  console.log(" To add more users, re-run this script. Existing users can");
  console.log(" be managed from /admin/users once you're logged in.");
  console.log("");
}

main().catch((err) => fail(err?.message || String(err)));

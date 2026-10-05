// scripts/lib/crash-at.cjs
//
// TEST ONLY — required into a test server's process by bootServer's
// `preload`; never by the server itself. It kills the process with SIGKILL
// (no cleanup, no finally blocks, no flushing — a real crash) at one
// chosen point, set by PJL_CRASH_AT = "<point>:<n>":
//
//   data-written:<n>   right after the nth change to purchase-orders.json
//                      or material-lists.json reaches the disk
//   data-torn:<n>      in the middle of the nth such change: an in-place
//                      write is cut off half-way (what the old code did);
//                      a temp-file write dies before its rename
//   journal-unlink:<n> just before the purchasing journal is removed
//   email-before:<n>   just before the nth purchase-order email is handed
//                      to the mail stub (nothing sent)
//   email-after:<n>    just after it (sent)
//
// Nothing is counted until the test arms it by creating
// $PJL_STUB_OUTBOX.arm (just before the request under test), so whatever
// the server writes while booting or while the test seeds data can't
// trigger it. Each counted event writes one line to $PJL_STUB_OUTBOX.crash,
// so the test can see exactly where the process died.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const [POINT, N] = String(process.env.PJL_CRASH_AT || "").split(":");
const want = Number(N) || 1;
const DATA_FILES = new Set(["purchase-orders.json", "material-lists.json"]);
const TRACE = `${process.env.PJL_STUB_OUTBOX}.crash`;
const ARM = `${process.env.PJL_STUB_OUTBOX}.arm`;
const counts = {};

function event(point, detail) {
  if (!fs.existsSync(ARM)) return false;
  counts[point] = (counts[point] || 0) + 1;
  fs.appendFileSync(TRACE, JSON.stringify({ point, n: counts[point], detail }) + "\n");
  return point === POINT && counts[point] === want;
}
function die(detail) {
  fs.appendFileSync(TRACE, JSON.stringify({ killed: `${POINT}:${want}`, detail }) + "\n");
  process.kill(process.pid, "SIGKILL");
}

const isData = (p) => typeof p === "string" && DATA_FILES.has(path.basename(p));

// The old code: fs.promises.writeFile straight onto the data file.
const writeFile = fsp.writeFile;
fsp.writeFile = async function (file, data, ...rest) {
  if (!isData(file)) return writeFile.call(this, file, data, ...rest);
  if (event("data-torn", path.basename(file))) {
    const text = String(data);
    fs.writeFileSync(file, text.slice(0, Math.floor(text.length / 2)));
    die(`${path.basename(file)} half-written`);
  }
  const out = await writeFile.call(this, file, data, ...rest);
  if (event("data-written", path.basename(file))) die(`${path.basename(file)} written`);
  return out;
};

// The new code: temp file, then rename onto the data file.
const rename = fsp.rename;
fsp.rename = async function (from, to) {
  if (!isData(to)) return rename.call(this, from, to);
  if (event("data-torn", path.basename(to))) die(`${path.basename(to)} temp written, not renamed`);
  const out = await rename.call(this, from, to);
  if (event("data-written", path.basename(to))) die(`${path.basename(to)} renamed into place`);
  return out;
};

const unlink = fsp.unlink;
fsp.unlink = async function (file) {
  if (typeof file === "string" && path.basename(file) === "purchasing-journal.json" && event("journal-unlink", "")) die("journal about to be removed");
  return unlink.call(this, file);
};

// The mail stub records every send with fs.appendFileSync on the outbox.
const append = fs.appendFileSync;
fs.appendFileSync = function (file, data, ...rest) {
  const isPoEmail = file === process.env.PJL_STUB_OUTBOX && /"channel":"email"/.test(String(data)) && /PO-\d{4}-\d{4}/.test(String(data));
  if (isPoEmail && event("email-before", "")) die("before the PO email");
  const out = append.call(this, file, data, ...rest);
  if (isPoEmail && event("email-after", "")) die("after the PO email");
  return out;
};

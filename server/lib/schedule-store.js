// Schedule storage — wraps server/data/schedule.json.
//
// The file holds two things:
//   1. settings — overrides for working hours and engine config. Optional;
//      defaults from availability.js are used when the file is missing or
//      a key is absent.
//   2. blocks   — array of { id, start, end, label } admin-created blocks.
//      e.g. vacation Aug 1-8, dentist Tuesday 1-3pm, holidays.
//
// Bookings themselves live on the lead record (lead.booking) — schedule.json
// only carries the off-platform admin blocks.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FILE = path.join(__dirname, "..", "data", "schedule.json");

const EMPTY = {
  settings: {},   // engine setting overrides (bufferMinutes, leadTimeHours, etc.)
  hours: {},      // working-hours overrides per day-of-week
  blocks: []      // [{ id, start, end, label }]
};

async function ensureFile() {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  if (!fsSync.existsSync(FILE)) {
    await fs.writeFile(FILE, JSON.stringify(EMPTY, null, 2) + "\n", "utf8");
  }
}

async function read() {
  await ensureFile();
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return {
      settings: parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {},
      hours: parsed.hours && typeof parsed.hours === "object" ? parsed.hours : {},
      blocks: Array.isArray(parsed.blocks) ? parsed.blocks : []
    };
  } catch {
    return { ...EMPTY };
  }
}

async function write(data) {
  await ensureFile();
  await fs.writeFile(FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function listBlocks() {
  const data = await read();
  return data.blocks;
}

async function addBlock({ start, end, label }) {
  if (!start || !end) throw new Error("Block requires start and end timestamps.");
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw new Error("Block timestamps are invalid.");
  }
  if (endDate.getTime() <= startDate.getTime()) {
    throw new Error("Block end must be after block start.");
  }
  const data = await read();
  const block = {
    id: crypto.randomUUID(),
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    label: String(label || "Blocked").trim().slice(0, 120) || "Blocked",
    createdAt: new Date().toISOString()
  };
  data.blocks.push(block);
  data.blocks.sort((a, b) => new Date(a.start) - new Date(b.start));
  await write(data);
  return block;
}

async function removeBlock(id) {
  const data = await read();
  const before = data.blocks.length;
  data.blocks = data.blocks.filter((b) => b.id !== id);
  if (data.blocks.length === before) return false;
  await write(data);
  return true;
}

async function settings() {
  const data = await read();
  return { settings: data.settings, hours: data.hours };
}

async function updateSettings({ settings: nextSettings, hours: nextHours }) {
  const data = await read();
  if (nextSettings && typeof nextSettings === "object") {
    data.settings = { ...data.settings, ...nextSettings };
  }
  if (nextHours && typeof nextHours === "object") {
    data.hours = { ...data.hours, ...nextHours };
  }
  await write(data);
  return data;
}

module.exports = { read, listBlocks, addBlock, removeBlock, settings, updateSettings };

// Every stored record that names a part number, by store. Used before a
// duplicate part is retired: a number that a Material List, purchase order,
// RFQ, project design, work order or invoice still points at is history
// and must keep meaning what it meant. Reads the JSON stores directly and
// matches the number as a whole quoted value, so "405-007" never matches
// "1405-0071".
//
// One copy of the rule: the merge-into route (server.js) and the duplicate
// migration tool (lib/part-merge-duplicates.js) both ask here.

const fsSync = require("node:fs");
const path = require("node:path");

const STORES = {
  materialLists: "material-lists.json",
  purchaseOrders: "purchase-orders.json",
  quoteRequests: "quote-requests.json",
  projects: "projects.json",
  workOrders: "work-orders.json",
  invoices: "invoices.json"
};

function findPartReferences(dataDir, sku) {
  const needle = JSON.stringify(String(sku));
  const out = { total: 0 };
  for (const [name, file] of Object.entries(STORES)) {
    let ids = [];
    try {
      const p = path.join(dataDir, file);
      if (fsSync.existsSync(p)) {
        const records = JSON.parse(fsSync.readFileSync(p, "utf8") || "[]");
        ids = (Array.isArray(records) ? records : []).filter((r) => JSON.stringify(r).includes(needle)).map((r) => r && r.id).filter(Boolean);
      }
    } catch (err) {
      // An unreadable store can't prove the number is unreferenced.
      throw new Error(`Couldn't read ${file} to check references (${err.message}).`);
    }
    out[name] = ids;
    out.total += ids.length;
  }
  out.summary = Object.entries(out).filter(([, v]) => Array.isArray(v) && v.length).map(([k, v]) => `${v.length} in ${k}`).join(", ") || "none";
  return out;
}

module.exports = { STORES, findPartReferences };

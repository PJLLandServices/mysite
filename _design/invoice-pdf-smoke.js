// Render-test for server/lib/invoice-pdf.js. Generates four PDFs to
// disk so a human can eyeball them. Not run by CI; this is a one-shot
// smoke test from the PR 1 build cycle. Delete or leave — it's harmless.
//
// Usage:
//   node _design/invoice-pdf-smoke.js
//
// Outputs: _design/_smoke/<scenario>.pdf

const fs = require("node:fs");
const path = require("node:path");
const { generateInvoicePdf } = require("../server/lib/invoice-pdf");

const OUT = path.join(__dirname, "_smoke");
fs.mkdirSync(OUT, { recursive: true });

const baseLine = (i) => ({
  name: `Hunter PGV-100G valve replacement (zone ${i})`,
  description: i % 3 === 0 ? "Includes manifold rebuild + pressure test" : "",
  quantity: i % 4 === 0 ? 2 : 1,
  rate: 74.95,
  amount: (i % 4 === 0 ? 2 : 1) * 74.95
});

const scenarios = {
  "01-residential-1line": {
    id: "I-2026-0001",
    status: "draft",
    createdAt: "2026-05-06T14:00:00-04:00",
    customerName: "Patrick Lalande",
    customerEmail: "patrickjlalande@gmail.com",
    customerPhone: "(905) 960-0181",
    address: "1118 Cenotaph Blvd\nNewmarket, ON  L3X 0A5",
    lineItems: [{
      label: "Spring Opening (2026)",
      qty: 1,
      unitPrice: 90,
      lineTotal: 90
    }],
    subtotal: 90,
    hst: 11.70,
    total: 101.70
  },
  "02-residential-5lines-sent": {
    id: "I-2026-0002",
    status: "sent",
    createdAt: "2026-05-04T09:30:00-04:00",
    sentAt: "2026-05-04T09:35:00-04:00",
    customerName: "Patrick Lalande",
    customerEmail: "patrickjlalande@gmail.com",
    customerPhone: "(905) 960-0181",
    address: "1118 Cenotaph Blvd\nNewmarket, ON  L3X 0A5",
    lineItems: [
      { label: "Spring Opening (2026)", qty: 1, unitPrice: 90, lineTotal: 90 },
      { label: "3-valve manifold rebuild", note: "Covers 1–3 valves", qty: 1, unitPrice: 135, lineTotal: 135 },
      { label: "Hunter PGV-100G valve", note: "Per valve replaced", qty: 3, unitPrice: 74.95, lineTotal: 224.85 },
      { label: "Hunter PGP rotor head", qty: 4, unitPrice: 21.50, lineTotal: 86 },
      { label: "Diagnostic + repair labour", note: "1.5 hrs at $95/hr", qty: 1.5, unitPrice: 95, lineTotal: 142.50 }
    ],
    subtotal: 678.35,
    hst: 88.19,
    total: 766.54
  },
  "03-b2b-shipto-overdue": {
    id: "I-2026-0042",
    status: "sent",
    createdAt: "2026-02-25T08:00:00-05:00",
    sentAt: "2026-02-25T08:00:00-05:00",
    bill_to: {
      name: "Jeff Rodger",
      company: "Emco Corporation o/a Wamco Municipal Products",
      addr1: "2124 Oxford St. East",
      city: "London",
      province: "Ontario",
      postalCode: "N5V 0B7",
      email: "jeff.rodger@example.com"
    },
    ship_to: {
      name: "Jeff Rodger",
      addr1: "551 Tiffin St.",
      city: "Barrie",
      province: "Ontario",
      postalCode: "L4N 9W6"
    },
    terms: "Due on receipt",
    issuedAt: "2026-02-25T08:00:00-05:00",
    dueAt: "2026-02-25T08:00:00-05:00",
    lineItems: [{
      name: "Wamco Subcontract Compensation — Meter Change-Outs",
      description: "Per March 26 2026 Compensation Report",
      quantity: 1, rate: 540, amount: 540
    }],
    subtotal: 540, taxAmount: 70.20, total: 610.20
  },
  "04-thirty-lines-paid": {
    id: "I-2026-0099",
    status: "paid",
    createdAt: "2026-04-12T10:00:00-04:00",
    sentAt: "2026-04-12T10:05:00-04:00",
    paidAt: "2026-04-15T16:23:00-04:00",
    customerName: "Acme Holdings Ltd.",
    customerEmail: "ar@acme.example",
    address: "100 Industrial Dr\nNewmarket, ON  L3Y 8V1",
    lineItems: Array.from({ length: 30 }, (_, i) => baseLine(i + 1)),
    subtotal: Array.from({ length: 30 }, (_, i) => baseLine(i + 1)).reduce((s, l) => s + l.amount, 0)
  },
  "05-zero-lines-empty-fields": {
    id: "I-2026-0100",
    status: "draft",
    createdAt: "2026-05-07T08:00:00-04:00",
    customerName: "",
    address: "",
    lineItems: [],
    subtotal: 0, hst: 0, total: 0
  }
};

(async () => {
  for (const [name, inv] of Object.entries(scenarios)) {
    try {
      const buf = await generateInvoicePdf(inv);
      const outPath = path.join(OUT, `${name}.pdf`);
      fs.writeFileSync(outPath, buf);
      console.log(`✓  ${name}.pdf  ${(buf.length / 1024).toFixed(1)} KB`);
    } catch (err) {
      console.error(`✗  ${name}: ${err.message}`);
      console.error(err.stack);
    }
  }
})();

#!/usr/bin/env node
// scripts/test-crm-contrast.mjs
//
// CRM-20 — dark-ground components must win their own text colour.
//
// crm.css carries two blanket rules that style bare tags across the whole
// admin shell:
//
//   .pjl-crm-body p { color: var(--pjl-text-mid); }   /* #4A4A4A */
//   .pjl-crm-body a { color: inherit; }
//
// Both are (0,1,1). A component that paints a dark pill and sets its own
// `color: #fff` on a single class is (0,1,0) — so the blanket wins and the
// component's text comes out near-black on near-black. Worse, a component
// that sets the colour on a WRAPPER and expects its children to inherit
// loses too, because an inherited value is beaten by any rule that matches
// the child directly, whatever its specificity.
//
// That is not a hypothetical. Both of the fixtures Patrick reported were
// this, measured in Chromium against the real stylesheets:
//
//   work-order completion banner   #4A4A4A on #1B4D2E   1.10:1
//   assignment-messages test toast #4A4A4A on #1B4D2E   1.10:1
//
// and a sweep of all 38 CRM pages found three more of the same shape:
//   settings.html .settings-save, work-order.html .wo-tech-mode-btn,
//   warranty-claim.html .wcd-status-link — all 1.78–1.99:1.
//
// The failure mode is what makes this worth a build-time check: nothing
// errors, the source reads correctly (`color: #fff` is right there), and
// it is only wrong once a browser resolves the cascade. So this suite
// computes specificity rather than eyeballing declarations, and asserts
// that every dark-ground fixture's colour outranks the blanket rules.
//
// The rendered proof — every fixture and every banner state measured for
// WCAG contrast in headless Chromium — is recorded in the register entry;
// build:check is node-only by design.
//
// Run: node scripts/test-crm-contrast.mjs  (also in `npm run build:check`)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; }
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

// (ids, classes/attrs/pseudo-classes, elements) — enough for this
// stylesheet, which uses no ids and no !important in these components.
function specificity(selector) {
  const s = selector.replace(/::[\w-]+/g, "");           // pseudo-elements count as elements
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const classes = (s.match(/\.[\w-]+/g) || []).length
    + (s.match(/\[[^\]]+\]/g) || []).length
    + (s.match(/:(?!:)[\w-]+/g) || []).length;
  const elements = (s.replace(/[.#[][^\s>+~,]*/g, " ").match(/\b[a-zA-Z][\w-]*\b/g) || []).length
    + (s.match(/::[\w-]+/g) || []).length;
  return [ids, classes, elements];
}
const beats = (a, b) => {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false; // a tie is decided by source order — not something to rely on
};

// Read every rule as { selectors[], body }. Comments are stripped first so
// a commented-out declaration can never satisfy an assertion.
async function rules(file) {
  const css = (await fs.readFile(path.join(ROOT, "server", file), "utf8"))
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectorText = m[1].trim();
    if (selectorText.startsWith("@") || !selectorText) continue;
    out.push({ selectors: selectorText.split(",").map((x) => x.trim()).filter(Boolean), body: m[2] });
  }
  return out;
}

// ---- 1. The blanket rules are still there, at the specificity assumed --
// If either is deleted or rescoped, the fixtures below are over-defended
// rather than broken — but the reasoning in their comments goes stale, so
// this is the assumption worth stating out loud.
{
  const crm = await rules("crm.css");
  for (const [tag, label] of [["p", "paragraph"], ["a", "link"]]) {
    const blanket = crm.find((r) => r.selectors.includes(`.pjl-crm-body ${tag}`) && /(^|[;{\s])color:/.test(r.body));
    ok(Boolean(blanket), `crm.css still carries the blanket ${label} rule .pjl-crm-body ${tag}`);
    const spec = specificity(`.pjl-crm-body ${tag}`);
    ok(spec[1] === 1 && spec[2] === 1, `.pjl-crm-body ${tag} is (0,1,1) — one class, one element`);
  }
}

// ---- 2. Every dark-ground fixture outranks the blanket ----------------
// `element` is the tag the rule actually lands on in the markup, which is
// what decides WHICH blanket it has to beat.
const BLANKET = specificity(".pjl-crm-body p"); // (0,1,1) — same for `a`

const FIXTURES = [
  {
    label: "assignment-messages test-send toast",
    css: "assignment-messages.css",
    className: "am-toast",
    element: "p",
    ground: "var(--pjl-green) / #A33"
  },
  {
    label: "settings save/connect pill",
    css: "settings.css",
    className: "settings-save",
    element: "a",
    ground: "#1B4D2E"
  },
  {
    label: "work-order tech-mode link",
    css: "work-order.css",
    className: "wo-tech-mode-btn",
    element: "a",
    ground: "var(--pjl-green)"
  },
  {
    label: "warranty-claim status link",
    css: "warranty-claims.css",
    className: "wcd-status-link",
    element: "a",
    ground: "#1F4F6E"
  }
];

for (const fix of FIXTURES) {
  const all = await rules(fix.css);
  // Rules that set a colour on this component (ignore :hover-only variants,
  // which don't decide the resting state).
  const setters = all.filter((r) =>
    /(^|[;\s])color\s*:/.test(r.body) &&
    r.selectors.some((sel) => sel.includes(`.${fix.className}`) && !/:(hover|focus|active)/.test(sel))
  );
  ok(setters.length > 0, `${fix.label}: .${fix.className} sets its own colour somewhere`);

  const winning = setters.some((r) => r.selectors.some((sel) =>
    sel.includes(`.${fix.className}`) && beats(specificity(sel), BLANKET)
  ));
  ok(winning,
    `${fix.label}: its colour rule outranks the (0,1,1) blanket .pjl-crm-body ${fix.element} — ` +
    `otherwise this sits on ${fix.ground} wearing the body's near-black`);
}

// ---- 3. The post-signature banner keeps ONE source of truth -----------
// The banner is the other shape of the same bug: four state rules set the
// colour on the WRAPPER, and the two text lines are <p>. Inheritance loses
// to the blanket no matter how specific the wrapper rule is, so the
// children have to re-assert `inherit` at a specificity that wins.
for (const [file, prefix] of [["work-order.css", "wo"], ["work-order-tech.css", "tech"]]) {
  const all = await rules(file);
  const banner = `${prefix}-postsig-banner`;

  const states = all.filter((r) => r.selectors.some((s) => s.startsWith(`.${banner}[data-state=`)));
  ok(states.length >= 4, `${file}: .${banner} styles at least four states`);
  const completed = states.find((r) => r.selectors.some((s) => s.includes('data-state="completed"')));
  ok(completed && /color:\s*#fff/i.test(completed.body),
    `${file}: the completed state (solid dark green) asks for white text`);

  // Both text lines must take the banner's colour, not the blanket's.
  for (const part of ["headline", "detail"]) {
    const child = `${prefix}-postsig-${part}`;
    const inheriting = all.filter((r) =>
      /color\s*:\s*inherit/.test(r.body) &&
      r.selectors.some((s) => s.includes(`.${child}`) && beats(specificity(s), BLANKET))
    );
    // The tech page is not .pjl-crm-body, so the blanket cannot reach it —
    // assert only where the blanket actually applies.
    const html = await fs.readFile(path.join(ROOT, "server", prefix === "wo" ? "work-order.html" : "work-order-tech.html"), "utf8");
    const exposed = /<body class="[^"]*pjl-crm-body/.test(html);
    if (!exposed) { passed += 1; continue; }
    ok(inheriting.length > 0,
      `${file}: .${child} re-asserts color: inherit above the blanket — ` +
      "without it the banner's four state colours never reach its own text");
  }
}

console.log(`\ntest-crm-contrast: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

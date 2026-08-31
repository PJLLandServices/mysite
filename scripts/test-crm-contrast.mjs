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

// ---- 4. Muted text must clear the readability floor -------------------
// The second half of what Patrick reported: text that was legible but too
// light — muted labels, table headings, hint lines. The CRM had drifted
// into SEVEN spellings of "muted grey" (#7A7A72, #777, #888, #9A9A90,
// #9A9A92, #9A9A8E, #8A8A80), none of which cleared 4.5:1 on a white
// card, plus two green-greys and an amber pill. They are collapsed onto
// three deliberate values.
//
// Unlike the dark-ground bug above, this one IS decidable from source:
// the foreground is a literal and the grounds are the shell's own light
// surfaces. So the ratio is computed here rather than described.

function srgb(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance([r, g, b]) {
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}
function rgb(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}
function contrast(a, b) {
  const la = luminance(rgb(a)), lb = luminance(rgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Every light surface muted text actually lands on in this CRM.
const LIGHT_GROUNDS = ["#FFFFFF", "#FAFAF5", "#F4F2EC", "#EAF3DE", "#FDF0E4", "#F4EFE4"];
const FLOOR = 4.5;
const worstOn = (fg) => Math.min(...LIGHT_GROUNDS.map((bg) => contrast(fg, bg)));

// The muted tokens. pay.css and portal.css are the customer's own pages
// and carry their own copy of the same token under a different name —
// they drifted apart once before, which is how three files ended up
// defining the same grey.
const MUTED_TOKENS = [
  ["crm.css", "--pjl-text-muted"],
  ["pay.css", "--text-muted"],
  ["portal.css", "--text-muted"]
];
for (const [file, token] of MUTED_TOKENS) {
  const css = await fs.readFile(path.join(ROOT, "server", file), "utf8");
  const m = css.match(new RegExp(`${token}:\\s*(#[0-9A-Fa-f]{3,6})\\s*;`));
  ok(Boolean(m), `${file}: ${token} is defined as a literal colour`);
  if (!m) continue;
  const worst = worstOn(m[1]);
  ok(worst >= FLOOR,
    `${file}: ${token} (${m[1]}) reads at ${worst.toFixed(2)}:1 on the worst light ground — ` +
    `below the ${FLOOR}:1 floor it is legible-but-straining, which is exactly what was reported`);
}

// The retired greys must not come back as text. Each is still fine as a
// border, a fill or a background — only `color:` has a contrast floor,
// and schedule.css legitimately still paints a swatch with #7A7A72.
// Six-digit and three-digit spellings both, because the first pass fixed
// only the long forms and the short ones sailed through. #555 (7.46:1) and
// #666 (5.74:1) are NOT here: they already clear the floor, and sweeping
// them in alongside the rest made text lighter, not darker.
const RETIRED = ["#7A7A72", "#9A9A90", "#9A9A92", "#9A9A8E", "#8A8A80",
                 "#888888", "#777777", "#999999", "#8FA093",
                 "#888", "#777", "#999", "#aaa"];
{
  const files = (await fs.readdir(path.join(ROOT, "server")))
    .filter((f) => f.endsWith(".css") || f.endsWith(".html"));
  const offenders = [];
  for (const file of files) {
    const text = (await fs.readFile(path.join(ROOT, "server", file), "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, "");
    for (const line of text.split("\n")) {
      if (!/(^|[;{\s])color\s*:/.test(line)) continue;
      for (const grey of RETIRED) {
        if (new RegExp(grey + "(?![0-9A-Fa-f])", "i").test(line)) offenders.push(`${file}: ${line.trim().slice(0, 70)}`);
      }
    }
  }
  ok(offenders.length === 0,
    `a retired too-light grey is back as text (${offenders.length}): ${offenders.slice(0, 3).join(" | ")}`);
}

// And the three replacements themselves clear the floor — if someone
// lightens one, this says so before it ships rather than after.
for (const [label, value] of [
  ["the warm muted grey", "#6B6B63"],
  ["the green-grey", "#616D64"],
  ["the amber pill text", "#7E6234"]
]) {
  const worst = worstOn(value);
  ok(worst >= FLOOR, `${label} (${value}) clears the floor on every light ground (${worst.toFixed(2)}:1)`);
}

// ---- 5. Self-contained components audit themselves ------------------
// The gap that let a whole class through: the rendered sweep measured only
// what was ON SCREEN at page load, and it deliberately skipped [hidden]
// elements. Every toast, modal, badge, status pill and dropdown in the CRM
// is hidden at load, so none of them was ever measured — 41 components
// below the floor, found only once the check stopped depending on
// rendering.
//
// Any rule that sets BOTH a background colour and a text colour carries
// its own contrast and can be checked from source, visible or not. That is
// what this does, over every stylesheet and every inline <style>.

const NAMED = { white: "#FFFFFF", black: "#000000" };
function colourIn(value) {
  const v = String(value).trim();
  const named = NAMED[v.toLowerCase()];
  if (named) return named;
  const m = v.match(/#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b/);
  // Normalise to six-digit upper case, or "#fff" and "#FFFFFF" compare as
  // different colours and the allowlist silently stops matching.
  if (m) {
    const h = m[0].slice(1);
    return "#" + (h.length === 3 ? [...h].map((c) => c + c).join("") : h).toUpperCase();
  }
  const fn = v.match(/rgba?\(([^)]+)\)/);
  if (fn) {
    const p = fn[1].split(",").map((x) => parseFloat(x));
    if (p.length > 3 && p[3] < 0.95) return null;   // translucent: ground unknown
    return ("#" + p.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, "0")).join("")).toUpperCase();
  }
  return null;
}
function declared(body, prop) {
  const m = body.match(new RegExp("(?:^|[;{\\s])" + prop + "\\s*:\\s*([^;]+)", "i"));
  return m ? m[1] : null;
}

// White-on-brand-amber is a known, deliberate exception pending a design
// decision — it is the PJL amber on primary buttons across the CRM, the
// login page and the customer portal. Listed explicitly so it stays
// visible rather than silently tolerated, and so the count can only go
// down: any NEW component below the floor fails this suite.
const AMBER = ["#F8AC65", "#F59B4A", "#E0A85A", "#E07B24", "#C96A2A", "#C4691B"];
const isKnownAmber = (fg, bg) =>
  fg.toUpperCase() === "#FFFFFF" && AMBER.includes(bg.toUpperCase());

{
  const dir = path.join(ROOT, "server");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".css") || f.endsWith(".html"));
  const below = [];
  let audited = 0;
  for (const file of files) {
    let text = await fs.readFile(path.join(dir, file), "utf8");
    if (file.endsWith(".html")) {
      text = [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
      if (!text.trim()) continue;
    }
    text = text.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim();
      if (sel.startsWith("@") || !sel) continue;
      const bgRaw = declared(m[2], "background(?:-color)?");
      const fgRaw = declared(m[2], "color");
      if (!bgRaw || !fgRaw) continue;
      // A gradient's first stop stands in for its lightest region.
      const bg = colourIn(bgRaw), fg = colourIn(fgRaw);
      if (!bg || !fg) continue;
      audited += 1;
      const v = contrast(fg, bg);
      if (v < 4.5 && !isKnownAmber(fg, bg)) {
        below.push(`${file} {${sel.replace(/\s+/g, " ").slice(0, 46)}} ${fg} on ${bg} = ${v.toFixed(2)}:1`);
      }
    }
  }
  ok(audited > 100, `the component audit actually ran (${audited} rules carry both a background and a text colour)`);
  ok(below.length === 0,
    `${below.length} component(s) below ${FLOOR}:1 — these are mostly hidden at page load, so only a ` +
    `source-level check sees them: ${below.slice(0, 4).join(" | ")}`);
}

console.log(`\ntest-crm-contrast: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

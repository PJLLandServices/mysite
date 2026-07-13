// Unit test for the Brief C2 section-body markup parser
// (parseSectionBody / parseInlineRuns in server/lib/quote-pdf.js).
// Pure functions — no PDF rendering. Run: node scripts/test-section-markup.mjs
import mod from "../server/lib/quote-pdf.js";
const { parseSectionBody, parseInlineRuns } = mod;

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL  ${name}${extra ? "  — " + extra : ""}`); }
}
const runsText = (runs) => runs.map((r) => r.text).join("");
const anyBold = (runs) => runs.some((r) => r.bold);

// ---- parseInlineRuns ----
ok("empty inline → single empty run", (() => { const r = parseInlineRuns(""); return r.length === 1 && r[0].text === "" && !r[0].bold; })());

let r = parseInlineRuns("plain text");
ok("plain inline → one unstyled run", r.length === 1 && r[0].text === "plain text" && !r[0].bold && !r[0].italic && !r[0].underline);

r = parseInlineRuns("a **bold** b");
ok("bold pairs", r.some((x) => x.text === "bold" && x.bold) && runsText(r) === "a bold b");

r = parseInlineRuns("a __under__ b");
ok("underline pairs", r.some((x) => x.text === "under" && x.underline));

r = parseInlineRuns("a *it* b");
ok("italic pairs", r.some((x) => x.text === "it" && x.italic));

r = parseInlineRuns("**b __u__ b**");
ok("bold+underline nest", r.some((x) => x.bold && x.underline), JSON.stringify(r));

// Unmatched markers → literal, content preserved
r = parseInlineRuns("**bold with no closer");
ok("unmatched ** → literal, nothing swallowed", runsText(r) === "**bold with no closer" && !anyBold(r), JSON.stringify(r));

// Three single * — the first two pair (italic "b"), the third is unmatched
// and stays literal. Key guarantee: NO content is swallowed.
r = parseInlineRuns("a * b * c *");
ok("odd count of single * → content intact, trailing * literal",
  runsText(r).replace(/ /g, "") === "abc*" && r.some((x) => x.italic), JSON.stringify(r));

// Escapes
r = parseInlineRuns("\\*not italic\\*");
ok("escaped asterisks → literal", runsText(r) === "*not italic*" && !r.some((x) => x.italic), JSON.stringify(r));

r = parseInlineRuns("2 \\* 3 = 6");
ok("escaped middle asterisk literal", runsText(r) === "2 * 3 = 6");

// A literal 2*3 (single unmatched *) stays literal, no styling
r = parseInlineRuns("size 5*4 ft");
ok("lone unmatched * stays literal", runsText(r) === "size 5*4 ft" && !r.some((x) => x.italic));

// ---- parseSectionBody ----
ok("empty body → no blocks", parseSectionBody("").length === 0);
ok("blank-only body → no blocks", parseSectionBody("\n\n  \n").length === 0);

let b = parseSectionBody("First para line one\nline two\n\nSecond para");
ok("paragraph grouping (2 blocks)", b.length === 2 && b[0].type === "paragraph" && b[1].type === "paragraph", JSON.stringify(b.map((x) => x.type)));
ok("first paragraph keeps both lines", b[0].lines.length === 2);

b = parseSectionBody("- one\n- two\n  - sub");
ok("bullets + sub-bullet levels", b.length === 3 && b[0].type === "bullet" && b[0].level === 0 && b[2].level === 1, JSON.stringify(b.map((x) => x.type + x.level)));

b = parseSectionBody("- item with **bold** inside");
ok("bold nested inside a bullet", b[0].type === "bullet" && anyBold(b[0].runs));

// Numbered renumber + restart after interruption
b = parseSectionBody("1. a\n1. b\n1. c");
ok("numbered renumbers 1,2,3 regardless of typed digits", b.map((x) => x.index).join(",") === "1,2,3", JSON.stringify(b.map((x) => x.index)));

b = parseSectionBody("1. a\n1. b\n\nSome paragraph\n\n1. c");
ok("numbered run restarts at 1 after a paragraph", b.filter((x) => x.type === "numbered").map((x) => x.index).join(",") === "1,2,1", JSON.stringify(b.map((x) => x.type + (x.index ?? ""))));

b = parseSectionBody("1. top\n  1. sub\n  1. sub2\n1. top2");
const nums = b.map((x) => `${x.level}:${x.index}`).join(" ");
ok("nested numbering: parent 1, children a/b as 1,2, parent 2", nums === "0:1 1:1 1:2 0:2", nums);

// Line-scoped: a marker does not pair across a newline
b = parseSectionBody("**a\nb**");
const hasBoldAcross = b.some((blk) => blk.type === "paragraph" && blk.lines.some((ln) => anyBold(ln.runs)));
ok("markers do not pair across a newline", !hasBoldAcross, JSON.stringify(b));

// A single very long word doesn't throw
ok("long unbroken token doesn't throw", (() => { try { parseSectionBody("x".repeat(5000)); return true; } catch { return false; } })());

console.log(`\n${pass}/${pass + fail} parser checks passed`);
if (fail) process.exit(1);

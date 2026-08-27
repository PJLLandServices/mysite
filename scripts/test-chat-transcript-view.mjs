// AI chat transcripts — the conversation read-back.
//
//   node scripts/test-chat-transcript-view.mjs
//
// THE PROBLEM. js/chat-widget.js buildTranscript() flattens a chat into one
// string: "Customer: …" / "Patrick (AI): …" turns joined by a blank line.
// Both CRM surfaces printed that string straight out — /admin/chats into a
// pre-wrap div, the lead drawer into a <pre> — so a real conversation came
// back as an undifferentiated wall of text. server/crm-transcript.js parses
// the string back into turns and renders them as speaker bubbles.
//
// WHAT IS EASY TO GET WRONG, and what this file pins:
//
//   1. Turns are joined with "\n\n" but an AI reply CONTAINS "\n\n" of its
//      own (it writes paragraphs and bullet lists). Splitting naively on the
//      blank line shreds one reply into several fake turns attributed to the
//      wrong speaker. A block only opens a new turn if it carries a speaker
//      label; anything else continues the turn in progress.
//   2. The renderer emits HTML, and a transcript is customer-typed text.
//      Everything must be escaped, and a [label](javascript:…) link must not
//      survive as an anchor.
//   3. The row preview must show what the CUSTOMER said. Every transcript
//      opens with the widget's two scripted AI greetings, which are longer
//      than the preview budget, so a head-of-string slice made every row in
//      the dashboard read identically.
//
// Read-side only: nothing here changes what is stored or POSTed. The stored
// transcript format is exactly what buildTranscript() has always written.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---- Minimal DOM ------------------------------------------------------
// crm-transcript.js builds real elements. Rather than pull in a DOM
// library, stand up just enough of one to capture what it produces —
// which also keeps the escaping assertions honest, since textContent and
// innerHTML stay distinguishable.

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.className = "";
    this.hidden = false;
    this.children = [];
    this._text = "";
    this._html = "";
  }
  set textContent(v) { this._text = String(v); this._html = ""; this.children = []; }
  get textContent() { return this._text; }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  appendChild(child) { this.children.push(child); return child; }
  // Everything this subtree renders: markup we generated plus text we set.
  html() {
    return this._html + this._text + this.children.map((c) => c.html()).join("");
  }
  find(className) {
    const hits = [];
    const walk = (el) => {
      if (String(el.className).split(/\s+/).includes(className)) hits.push(el);
      el.children.forEach(walk);
    };
    walk(this);
    return hits;
  }
}

const win = { document: { createElement: (tag) => new El(tag) } };
const rendererSrc = fs.readFileSync(path.join(ROOT, "server/crm-transcript.js"), "utf8");
new Function("window", "document", rendererSrc)(win, win.document);
const { parse, render, buildPreview } = win.PJLTranscript;

// The widget's real opening, verbatim from js/chat-widget.js.
const GREETING_1 = "Patrick (AI): Hey, I'm Patrick from PJL Land Services 👋";
const GREETING_2 = "Patrick (AI): Tell me what's going on with your sprinkler system — describe it however feels natural, like you'd tell a neighbour. I'll come back with what's likely happening, what you can try yourself, and an honest read on whether you need a tech.";

// ---- 1. Turn splitting ------------------------------------------------
{
  const t = [GREETING_1, GREETING_2, "Customer: zone 4 won't come on", "Patrick (AI): Sounds like the valve."].join("\n\n");
  const p = parse(t);
  eq("four turns parsed", p.turns.length, 4);
  ok("speaker labels recognised", p.recognized === true);
  eq("roles in order", p.turns.map((x) => x.role).join(","), "ai,ai,customer,ai");
  eq("customer turns counted", p.counts.customer, 1);
  eq("ai turns counted", p.counts.ai, 3);
  eq("label stripped from the body", p.turns[2].paragraphs[0], "zone 4 won't come on");
}

// ---- 2. A multi-paragraph AI reply is ONE turn ------------------------
// The defect this whole file exists to prevent.
{
  const reply = "Patrick (AI): Two usual suspects:\n\n- a stuck valve running overnight\n- a cracked lateral\n\nCan you check the meter with everything off?";
  const t = ["Customer: my water bill doubled", reply, "Customer: meter spins with everything off"].join("\n\n");
  const p = parse(t);
  eq("blank lines inside a reply do not split it", p.turns.length, 3);
  eq("roles stay correct across the paragraph break", p.turns.map((x) => x.role).join(","), "customer,ai,customer");
  eq("the reply keeps all three of its paragraphs", p.turns[1].paragraphs.length, 3);
  eq("no phantom customer turn was invented", p.counts.customer, 2);
}

// ---- 3. Rendering: escaping and link safety ---------------------------
{
  const nasty = 'Customer: <img src=x onerror="alert(1)"> & "quoted"';
  const html = render(nasty).html();
  ok("script-ish markup is escaped", !html.includes("<img src=x"), html.slice(0, 160));
  ok("the angle bracket is entity-encoded", html.includes("&lt;img"));
  ok("the ampersand is entity-encoded", html.includes("&amp;"));
}
{
  const html = render("Patrick (AI): see [the guide](javascript:alert(1)) for more").html();
  ok("javascript: link is not rendered as an anchor", !html.includes("<a href=\"javascript"), html);
  ok("its label survives as plain text", html.includes("the guide"));
}
{
  const html = render("Patrick (AI): see [our pricing](/pricing.html) and [the blog](https://example.com)").html();
  ok("relative link renders as an anchor", html.includes('href="/pricing.html"'));
  ok("https link renders as an anchor", html.includes('href="https://example.com"'));
  ok("anchors open safely", html.includes('rel="noopener"'));
}
{
  const html = render("Patrick (AI): that's **very** likely the valve").html();
  ok("**bold** becomes <strong>", html.includes("<strong>very</strong>"), html);
}
{
  const html = render("Patrick (AI): check these:\n- the valve\n- the solenoid").html();
  ok("bullet lines become a real list", html.includes("<ul>") && html.includes("<li>the valve</li>"), html);
}

// ---- 4. Rendered structure -------------------------------------------
{
  const t = ["Customer: hello", "Patrick (AI): hi there"].join("\n\n");
  const root = render(t);
  eq("root carries the conversation class", root.className, "pjl-convo");
  eq("one bubble per turn", root.find("pjl-convo-bubble").length, 2);
  eq("customer turn is styled as such", root.find("pjl-convo-turn")[0].className, "pjl-convo-turn is-customer");
  eq("ai turn is styled as such", root.find("pjl-convo-turn")[1].className, "pjl-convo-turn is-ai");
}
{
  // A transcript with no labels at all must show its text, not vanish.
  const root = render("no speaker labels anywhere in this text");
  eq("unlabelled transcript falls back to plain", root.find("pjl-convo-plain").length, 1);
  ok("and keeps every word", root.html().includes("no speaker labels anywhere"));
}
{
  const root = render("");
  eq("an empty transcript says so", root.find("pjl-convo-empty").length, 1);
}

// ---- 5. Photo attachment markers -------------------------------------
{
  const p = parse("Customer: [attached 2 photos] here's the head");
  eq("attachment count lifted out", p.turns[0].attachments, 2);
  eq("marker removed from the body text", p.turns[0].paragraphs[0], "here's the head");
  const html = render("Customer: [attached 2 photos] here's the head").html();
  ok("attachment renders as its own chip", html.includes("pjl-convo-attachment") && html.includes("2 photos attached"), html);
}

// ---- 6. Degenerate input ---------------------------------------------
eq("null parses to nothing", parse(null).turns.length, 0);
eq("undefined parses to nothing", parse(undefined).counts.total, 0);
eq("null previews to empty", buildPreview(null), "");
eq("CRLF splits the same as LF", parse("Customer: hi\r\n\r\nPatrick (AI): hey").turns.length, 2);
eq("a colon mid-sentence does not open a turn",
  parse("Customer: the label says: Hunter PGP").turns.length, 1);

// ---- 7. The row preview ----------------------------------------------
// Both halves: the client helper and the server field that feeds it.
{
  const t = [GREETING_1, GREETING_2, "Customer: sprinkler head is geysering", "Patrick (AI): ok"].join("\n\n");
  eq("client preview skips the scripted greetings", buildPreview(t), "sprinkler head is geysering");
}

const serverSrc = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");
const previewBlock = serverSrc.match(/const CHAT_PREVIEW_CHARS[\s\S]*?\nfunction chatPreview\(transcript\) \{[\s\S]*?\n\}\n/);
ok("server.js still defines chatPreview", Boolean(previewBlock));
if (previewBlock) {
  const chatPreview = new Function(`${previewBlock[0]}\nreturn chatPreview;`)();
  const t = [GREETING_1, GREETING_2, "Customer: sprinkler head is geysering", "Patrick (AI): ok"].join("\n\n");
  eq("server preview is the customer's first line", chatPreview(t), "sprinkler head is geysering");

  // The old behaviour, pinned so it cannot come back: a head slice of this
  // transcript is pure boilerplate, identical for every chat in the store.
  const headSlice = t.slice(0, 240);
  ok("a head slice would have shown only the greetings",
    !headSlice.includes("geysering"), headSlice);

  const twoChats = [
    [GREETING_1, GREETING_2, "Customer: zone 4 is dead"].join("\n\n"),
    [GREETING_1, GREETING_2, "Customer: my bill doubled"].join("\n\n")
  ].map(chatPreview);
  ok("two different chats get two different previews", twoChats[0] !== twoChats[1], twoChats.join(" | "));

  eq("no customer turn yet falls back to the opening",
    chatPreview(GREETING_1), "Hey, I'm Patrick from PJL Land Services 👋");
  eq("empty transcript previews empty", chatPreview(""), "");
  eq("null transcript previews empty", chatPreview(null), "");
  ok("preview is capped", chatPreview(`Customer: ${"x".repeat(900)}`).length === 240);
}

// ---- 8. Source guards: both surfaces actually load the renderer -------
{
  const chatsHtml = fs.readFileSync(path.join(ROOT, "server/chats.html"), "utf8");
  ok("chats.html loads the conversation stylesheet", chatsHtml.includes("/crm/crm-transcript.css"));
  ok("chats.html loads the renderer", chatsHtml.includes("/crm/crm-transcript.js"));
  ok("chats.html loads the renderer BEFORE chats.js",
    chatsHtml.indexOf("/crm/crm-transcript.js") < chatsHtml.indexOf("/crm/chats.js"));
  ok("chats.html no longer renders the transcript as a pre-wrap blob",
    !/\.chat-transcript\s*\{[^}]*white-space:\s*pre-wrap/.test(chatsHtml));
  ok("chats.html no longer caps the transcript in a scroll window",
    !/\.chat-transcript\s*\{[^}]*max-height/.test(chatsHtml));

  const adminHtml = fs.readFileSync(path.join(ROOT, "server/admin.html"), "utf8");
  ok("admin.html loads the conversation stylesheet", adminHtml.includes("/crm/crm-transcript.css"));
  ok("admin.html loads the renderer", adminHtml.includes("/crm/crm-transcript.js"));
  ok("admin.html loads the renderer BEFORE admin.js",
    adminHtml.indexOf("/crm/crm-transcript.js") < adminHtml.indexOf("/crm/admin.js"));
  ok("the lead drawer transcript is no longer a <pre>",
    !adminHtml.includes('<pre id="detailTranscript"'));

  const crmCss = fs.readFileSync(path.join(ROOT, "server/crm.css"), "utf8");
  const detailRule = crmCss.match(/\.detail-transcript-body \{[^}]*\}/);
  ok("crm.css still styles the drawer container", Boolean(detailRule));
  if (detailRule) {
    ok("drawer transcript is no longer pre-wrap", !detailRule[0].includes("pre-wrap"), detailRule[0]);
    ok("drawer transcript is no longer a 360px porthole", !detailRule[0].includes("max-height"), detailRule[0]);
  }

  const adminJs = fs.readFileSync(path.join(ROOT, "server/admin.js"), "utf8");
  ok("admin.js renders the transcript through PJLTranscript",
    /renderTranscriptDetail[\s\S]{0,700}PJLTranscript\.render/.test(adminJs));

  const chatsJs = fs.readFileSync(path.join(ROOT, "server/chats.js"), "utf8");
  ok("chats.js renders the transcript through PJLTranscript",
    chatsJs.includes("window.PJLTranscript.render"));
  // The 60s poll rebuilds the list; without this an open transcript snapped
  // shut mid-read once a minute.
  ok("chats.js remembers which rows are open across a refresh",
    chatsJs.includes("openChats"));
  ok("chats.js skips the redraw when the poll brings nothing new",
    chatsJs.includes("listSignature"));

  ok("server.js feeds the dashboard the customer-first preview",
    serverSrc.includes("preview: chatPreview(c.transcript)"));
}

// ---- 9. Storage is untouched -----------------------------------------
// The whole change is read-side. If any of these move, the transcript
// format itself has changed and the widget must be re-checked.
{
  const widget = fs.readFileSync(path.join(ROOT, "js/chat-widget.js"), "utf8");
  ok("the widget still labels turns Customer / Patrick (AI)",
    widget.includes('m.role === "user" ? "Customer" : "Patrick (AI)"'));
  ok("the widget still joins turns with a blank line",
    widget.includes('lines.join("\\n\\n")'));
  ok("the POST upsert still stores the transcript verbatim",
    serverSrc.includes("const transcript = normalizeTranscriptBody(payload.transcript);"));
}

// ---- Report -----------------------------------------------------------

if (failures.length) {
  console.error(`chat transcript view: ${pass} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`chat transcript view: ${pass} assertions passed`);

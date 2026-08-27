// =============================================================
// PJL CRM — AI chat transcript parser + conversation renderer
// =============================================================
// The chat widget (js/chat-widget.js, buildTranscript) stores a
// conversation as ONE flat string:
//
//   Customer: my back zone won't come on
//
//   Patrick (AI): Sounds like a valve issue. Two things to check…
//
// Turns are joined with a blank line, each prefixed by the speaker.
// The CRM used to print that string straight into a <pre>, which is
// why long conversations read as one wall of text. This module turns
// the string back into turns so the CRM can lay it out the way it was
// actually spoken.
//
// Nothing here changes what is stored or sent — it is a read-side
// renderer only. The stored transcript format is untouched.
//
// Exposes window.PJLTranscript = { parse, render, buildPreview }.

(function (global) {
  "use strict";

  // Speaker labels. buildTranscript() writes exactly two: "Customer" and
  // "Patrick (AI)". The aliases cost nothing and keep an older or
  // hand-pasted transcript readable.
  //
  // CRITICAL — why these are scanned ANYWHERE, not only at a line start:
  // every transcript is stored through server.js normalizeString(), whose
  // `.replace(/\s+/g, " ")` collapses ALL whitespace, newlines included. A
  // transcript stored before that was fixed arrives here as ONE unbroken line:
  //
  //   "Patrick (AI): Hey, I'm Patrick… Customer: zone 4 is dead Patrick (AI): …"
  //
  // The blank lines buildTranscript() puts between turns do not survive the
  // write. Splitting on them recovers nothing and returns the whole
  // conversation as a single turn — exactly the wall of text this module
  // exists to undo. The labels are the only turn boundary that reaches
  // storage, so the labels are what we split on.
  //
  // The write path now preserves newlines (normalizeTranscriptBody), so new
  // transcripts keep their paragraph structure — but every transcript stored
  // before that fix is flat, and those must stay readable. Splitting on
  // labels handles both: paragraphs within a turn are recovered separately
  // below, and are simply absent in the flat case.
  //
  // Tradeoff: a customer who literally types "Customer: " mid-message gets a
  // false turn break. Rare, cosmetic, and the "Plain text" toggle always
  // shows the unmodified string.
  var CANONICAL_LABELS = "Customer|Patrick \\(AI\\)";
  var ALIAS_LABELS = "Assistant|AI|User|Visitor";

  function roleFor(label) {
    return /^(?:Customer|User|Visitor)$/.test(label) ? "customer" : "ai";
  }

  // Locate every speaker label. `anchored` restricts matches to the start of
  // a line — used only for the aliases, where a bare "AI:" or "User:"
  // mid-sentence is likelier to be prose than a real turn.
  function findTurnStarts(text, labelPattern, anchored) {
    var prefix = anchored ? "(?:^|\\n)[ \\t]*" : "(?:^|\\s)";
    var re = new RegExp(prefix + "(" + labelPattern + ")[ \\t]*:[ \\t]*", "g");
    var hits = [];
    var m;
    while ((m = re.exec(text)) !== null) {
      hits.push({ label: m[1], turnStart: m.index, bodyStart: m.index + m[0].length });
      // Resume right after the label so two adjacent turns both match.
      re.lastIndex = m.index + m[0].length;
    }
    return hits;
  }

  // "[attached 2 photos] " prefix written by buildTranscript for
  // multimodal customer messages.
  var ATTACHMENT_RE = /^\[attached (\d+) photos?\]\s*/i;

  var BULLET_RE = /^\s*[-•*]\s+/;
  var NUMBERED_RE = /^\s*\d+[.)]\s+/;

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Only let through link targets that can't execute script.
  function safeHref(url) {
    var raw = String(url || "").replace(/&amp;/g, "&").trim();
    if (!raw) return null;
    if (/^(https?:\/\/|mailto:|tel:)/i.test(raw)) return escapeHtml(raw);
    if (/^\/[^/]/.test(raw) || raw === "/") return escapeHtml(raw);
    return null; // javascript:, data:, protocol-relative, anything else
  }

  // Same light markdown the customer saw in the widget bubble:
  // [label](url) and **bold**. Everything is escaped first, so the
  // only HTML that survives is what we put back deliberately.
  function inlineHtml(text) {
    var out = escapeHtml(text);
    out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (whole, label, url) {
      var href = safeHref(url);
      if (!href) return label;
      return '<a href="' + href + '" target="_blank" rel="noopener">' + label + "</a>";
    });
    out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    return out;
  }

  // One paragraph of a turn -> HTML. Consecutive bullet or numbered
  // lines become a real list; everything else becomes a <p> with the
  // single line breaks preserved.
  function paragraphHtml(text) {
    var lines = String(text).split("\n");
    var out = [];
    var buffer = [];
    var mode = null; // "ul" | "ol" | "p"

    function flush() {
      if (!buffer.length) return;
      if (mode === "ul" || mode === "ol") {
        out.push(
          "<" + mode + ">" +
          buffer.map(function (li) { return "<li>" + inlineHtml(li) + "</li>"; }).join("") +
          "</" + mode + ">"
        );
      } else {
        out.push("<p>" + buffer.map(inlineHtml).join("<br>") + "</p>");
      }
      buffer = [];
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var next;
      var content;
      if (BULLET_RE.test(line)) {
        next = "ul";
        content = line.replace(BULLET_RE, "");
      } else if (NUMBERED_RE.test(line)) {
        next = "ol";
        content = line.replace(NUMBERED_RE, "");
      } else {
        if (!line.trim()) continue;
        next = "p";
        content = line;
      }
      if (next !== mode) { flush(); mode = next; }
      buffer.push(content);
    }
    flush();
    return out.join("");
  }

  // ---- Parsing -------------------------------------------------
  // Split the stored string into turns at the speaker labels, then recover
  // paragraphs inside each turn from any blank lines that survived. See the
  // note above for why labels — not newlines — are the split.
  function parse(raw) {
    var text = String(raw == null ? "" : raw).replace(/\r\n?/g, "\n").trim();
    var empty = { turns: [], recognized: false, counts: { customer: 0, ai: 0, total: 0 } };
    if (!text) return empty;

    var hits = findTurnStarts(text, CANONICAL_LABELS, false);
    if (!hits.length) hits = findTurnStarts(text, ALIAS_LABELS, true);
    if (!hits.length) return empty;

    var turns = [];

    // Anything before the first label — shouldn't happen, but keep it rather
    // than silently drop part of the conversation.
    var preamble = text.slice(0, hits[0].turnStart).trim();
    if (preamble) {
      turns.push({ role: "unknown", who: "Transcript", attachments: 0, paragraphs: [preamble] });
    }

    for (var i = 0; i < hits.length; i++) {
      var end = (i + 1 < hits.length) ? hits[i + 1].turnStart : text.length;
      var body = text.slice(hits[i].bodyStart, end).trim();
      var role = roleFor(hits[i].label);
      turns.push({
        role: role,
        who: role === "customer" ? "Customer" : "Patrick (AI)",
        attachments: 0,
        // Blank lines within a turn are real paragraphs when the write path
        // preserved them; a flat legacy transcript simply yields one.
        paragraphs: body.split(/\n{2,}/)
      });
    }

    var counts = { customer: 0, ai: 0, total: 0 };
    for (var t = 0; t < turns.length; t++) {
      var turn = turns[t];
      if (turn.paragraphs.length) {
        var first = turn.paragraphs[0];
        var att = first.match(ATTACHMENT_RE);
        if (att) {
          turn.attachments = Number(att[1]) || 0;
          turn.paragraphs[0] = first.replace(ATTACHMENT_RE, "");
        }
      }
      turn.paragraphs = turn.paragraphs.filter(function (para) { return para.trim().length > 0; });
      if (turn.role === "customer") counts.customer++;
      else if (turn.role === "ai") counts.ai++;
      counts.total++;
    }

    return { turns: turns, recognized: true, counts: counts };
  }


  // ---- Rendering -----------------------------------------------

  function attachmentChip(n) {
    return (
      '<span class="pjl-convo-attachment">' +
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>' +
      '<circle cx="12" cy="13" r="4"></circle></svg>' +
      escapeHtml(n + " photo" + (n === 1 ? "" : "s") + " attached") +
      "</span>"
    );
  }

  function renderTurn(turn, index) {
    var article = document.createElement("article");
    article.className = "pjl-convo-turn is-" + turn.role;

    var head = document.createElement("header");
    head.className = "pjl-convo-head";
    head.innerHTML =
      '<span class="pjl-convo-who">' + escapeHtml(turn.who) + "</span>" +
      '<span class="pjl-convo-turn-no">#' + index + "</span>";
    article.appendChild(head);

    var bubble = document.createElement("div");
    bubble.className = "pjl-convo-bubble";
    var html = "";
    if (turn.attachments > 0) html += attachmentChip(turn.attachments);
    for (var i = 0; i < turn.paragraphs.length; i++) {
      html += paragraphHtml(turn.paragraphs[i]);
    }
    // A turn that was nothing but a photo marker still needs a body.
    if (!html) html = "<p></p>";
    bubble.innerHTML = html;
    article.appendChild(bubble);

    return article;
  }

  // Returns an element ready to drop into the page. `raw` is the stored
  // transcript string. If it has no recognisable speaker labels we fall
  // back to the plain text rather than guessing — Patrick still sees
  // every word, just without the turn layout.
  function render(raw) {
    var parsed = parse(raw);
    var wrap = document.createElement("div");
    wrap.className = "pjl-convo";

    // No turns can mean two different things, and conflating them would hide
    // real text behind an "empty" message: either the transcript is genuinely
    // empty, or it has content we couldn't find a speaker label in. The second
    // case must still show every word.
    if (!parsed.turns.length) {
      var text = String(raw == null ? "" : raw).trim();
      var node = document.createElement("div");
      if (text) {
        node.className = "pjl-convo-plain";
        node.textContent = text;
      } else {
        node.className = "pjl-convo-empty";
        node.textContent = "(no transcript recorded for this chat)";
      }
      wrap.appendChild(node);
      return wrap;
    }

    for (var i = 0; i < parsed.turns.length; i++) {
      wrap.appendChild(renderTurn(parsed.turns[i], i + 1));
    }
    return wrap;
  }

  // First thing the customer actually said — a far more useful row
  // preview than the AI's fixed welcome message, which opens every
  // single transcript identically.
  function buildPreview(raw) {
    var parsed = parse(raw);
    for (var i = 0; i < parsed.turns.length; i++) {
      var turn = parsed.turns[i];
      if (turn.role !== "customer") continue;
      var text = turn.paragraphs.join(" ").replace(/\s+/g, " ").trim();
      if (turn.attachments && !text) text = "(sent " + turn.attachments + " photo" + (turn.attachments === 1 ? "" : "s") + ")";
      if (text) return text;
    }
    // No customer turn yet — fall back to whatever the transcript opens with.
    if (parsed.turns.length) {
      return parsed.turns[0].paragraphs.join(" ").replace(/\s+/g, " ").trim();
    }
    // No speaker labels at all. That is the NORMAL case for the list preview:
    // the server already extracted the customer's line, so it arrives here as
    // bare text. Return it rather than blanking the row.
    return String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
  }

  global.PJLTranscript = { parse: parse, render: render, buildPreview: buildPreview };
})(window);

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

  // The two labels buildTranscript() writes. The extra aliases cost
  // nothing and keep older or hand-pasted transcripts readable.
  var SPEAKERS = [
    { match: /^Patrick \(AI\)\s*:\s*/, role: "ai", who: "Patrick (AI)" },
    { match: /^Customer\s*:\s*/, role: "customer", who: "Customer" },
    { match: /^(?:Assistant|AI)\s*:\s*/, role: "ai", who: "Patrick (AI)" },
    { match: /^(?:User|Visitor)\s*:\s*/, role: "customer", who: "Customer" }
  ];

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
  // Split on blank lines, then decide per block: does it open with a
  // speaker label (new turn) or not (a following paragraph of the turn
  // already in progress)? That second case matters — the AI's replies
  // routinely contain their own blank lines, and splitting naively on
  // "\n\n" would shred one reply into several fake turns.
  function parse(raw) {
    var text = String(raw == null ? "" : raw).replace(/\r\n?/g, "\n").trim();
    if (!text) return { turns: [], recognized: false, counts: { customer: 0, ai: 0, total: 0 } };

    var blocks = text.split(/\n{2,}/);
    var turns = [];
    var recognized = false;

    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      if (!block.trim()) continue;
      var speaker = null;
      for (var s = 0; s < SPEAKERS.length; s++) {
        if (SPEAKERS[s].match.test(block)) { speaker = SPEAKERS[s]; break; }
      }
      if (speaker) {
        recognized = true;
        turns.push({
          role: speaker.role,
          who: speaker.who,
          attachments: 0,
          paragraphs: [block.replace(speaker.match, "")]
        });
      } else if (turns.length) {
        turns[turns.length - 1].paragraphs.push(block);
      } else {
        // Text before any speaker label — keep it rather than drop it.
        turns.push({ role: "unknown", who: "Transcript", attachments: 0, paragraphs: [block] });
      }
    }

    var counts = { customer: 0, ai: 0, total: 0 };
    for (var t = 0; t < turns.length; t++) {
      var turn = turns[t];
      // Lift the photo marker out of the text into its own chip.
      if (turn.paragraphs.length) {
        var first = turn.paragraphs[0];
        var att = first.match(ATTACHMENT_RE);
        if (att) {
          turn.attachments = Number(att[1]) || 0;
          turn.paragraphs[0] = first.replace(ATTACHMENT_RE, "");
        }
      }
      turn.paragraphs = turn.paragraphs.filter(function (p) { return p.trim().length > 0; });
      if (turn.role === "customer") counts.customer++;
      else if (turn.role === "ai") counts.ai++;
      counts.total++;
    }

    return { turns: turns, recognized: recognized, counts: counts };
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

    if (!parsed.turns.length) {
      var empty = document.createElement("div");
      empty.className = "pjl-convo-empty";
      empty.textContent = "(no transcript recorded for this chat)";
      wrap.appendChild(empty);
      return wrap;
    }

    if (!parsed.recognized) {
      var plain = document.createElement("div");
      plain.className = "pjl-convo-plain";
      plain.textContent = String(raw || "");
      wrap.appendChild(plain);
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
    return "";
  }

  global.PJLTranscript = { parse: parse, render: render, buildPreview: buildPreview };
})(window);

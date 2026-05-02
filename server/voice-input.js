// Voice-to-text helper — spec §4.3.3 rule #10 ("voice-to-text on every
// text field for tech speed"). Drop-in: any <input> or <textarea> with
// the `data-voice-input` attribute gets a mic button positioned top-
// right. Tap → live transcription appends to the field. Tap again to
// stop. Browser-only (Web Speech API): Chrome + Safari iOS 14.5+ + Edge
// support it; Firefox doesn't. Unsupported browsers get no mic button
// (silent degrade — the field still works, just no voice).
//
// Auto-wires existing fields at DOMContentLoaded AND watches for new
// fields added later (issue rows in the zone sheet, builder line item
// notes, etc.) via MutationObserver.

(function setupVoiceInput() {
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Speech) return;

  // Active recognizer — only one at a time. Stopping happens on tap of
  // the same mic, tap of a different mic (transfers focus), or after
  // 8s of silence.
  let activeRec = null;
  let activeField = null;
  let activeBtn = null;
  let appendStart = 0;

  function attachMic(field) {
    if (!field || field.dataset.voiceWired === "1") return;
    field.dataset.voiceWired = "1";
    // Wrap the field in a positioning container so the mic floats top-right
    // without interfering with the field's own padding/sizing.
    const wrapper = document.createElement("span");
    wrapper.className = "voice-input-wrap";
    field.parentNode.insertBefore(wrapper, field);
    wrapper.appendChild(field);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "voice-input-mic";
    btn.setAttribute("aria-label", "Dictate into this field");
    btn.title = "Dictate (tap, speak, tap again)";
    btn.innerHTML = "🎤";
    wrapper.appendChild(btn);
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      // Toggle off if THIS field is currently dictating.
      if (activeRec && activeField === field) {
        try { activeRec.stop(); } catch (_) {}
        return;
      }
      // Stop any other active recognizer first.
      if (activeRec) {
        try { activeRec.stop(); } catch (_) {}
      }
      startDictation(field, btn);
    });
  }

  function startDictation(field, btn) {
    const rec = new Speech();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-CA";
    appendStart = field.value ? field.value.length : 0;
    activeRec = rec;
    activeField = field;
    activeBtn = btn;
    btn.classList.add("is-listening");
    btn.innerHTML = "●";
    btn.setAttribute("aria-pressed", "true");

    let silenceTimer = null;
    function bumpSilence() {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => { try { rec.stop(); } catch (_) {} }, 8000);
    }
    bumpSilence();

    rec.onresult = (event) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += t;
        else interim += t;
      }
      // Append (don't replace) — preserves anything the tech already
      // typed before tapping the mic. Spaces are stripped/added so we
      // don't get double-spacing on multiple voice sessions.
      const before = field.value.slice(0, appendStart);
      const stitched = (before ? (before.replace(/\s+$/, "") + " ") : "") + (final + interim).trim();
      field.value = stitched;
      // Fire input event so debounced PATCHes / character counters
      // observe the change just like a typed edit.
      field.dispatchEvent(new Event("input", { bubbles: true }));
      bumpSilence();
    };
    rec.onerror = (event) => {
      // Permission denial / network error — surface to the user once,
      // then clean up. "no-speech" is normal silence-timeout, ignored.
      if (event.error && event.error !== "no-speech" && event.error !== "aborted") {
        console.warn("[voice-input]", event.error);
        alert("Voice input error: " + event.error + ". Microphone permission may need to be granted in your browser.");
      }
    };
    rec.onend = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      btn.classList.remove("is-listening");
      btn.innerHTML = "🎤";
      btn.setAttribute("aria-pressed", "false");
      if (activeRec === rec) {
        activeRec = null;
        activeField = null;
        activeBtn = null;
      }
    };

    try { rec.start(); }
    catch (err) {
      console.warn("[voice-input] start failed:", err?.message);
      btn.classList.remove("is-listening");
      btn.innerHTML = "🎤";
      activeRec = null;
      activeField = null;
      activeBtn = null;
    }
  }

  function wireExisting() {
    document.querySelectorAll("[data-voice-input]").forEach(attachMic);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireExisting);
  } else {
    wireExisting();
  }

  // Watch for dynamically-added fields (issue rows, builder lines, etc.)
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches && node.matches("[data-voice-input]")) attachMic(node);
        if (node.querySelectorAll) {
          node.querySelectorAll("[data-voice-input]").forEach(attachMic);
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();

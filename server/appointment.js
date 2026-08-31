// The customer's appointment page — stage 5 of docs/ASSIGNMENT_WRITER.md.
// One page, three choices: confirm, pick a different day, or cancel.
// The token in the URL is the credential; every call goes to
// /api/appointment/<token>.
(function appointmentPage() {
  const el = (id) => document.getElementById(id);
  const token = (location.pathname.match(/^\/a\/([A-Za-z0-9_-]{16,64})/) || [])[1] || "";
  const api = (suffix = "") => `/api/appointment/${encodeURIComponent(token)}${suffix}`;

  function fail(message) {
    el("loading").hidden = true;
    el("details").hidden = true;
    el("error").hidden = false;
    el("error").textContent = message;
  }

  function terminal(title, body) {
    el("loading").hidden = true;
    el("details").hidden = true;
    el("terminal").hidden = false;
    el("terminalTitle").textContent = title;
    el("terminalBody").textContent = body;
  }

  function render(a) {
    el("loading").hidden = true;
    el("error").hidden = true;

    if (a.state === "cancelled") {
      terminal("This appointment is cancelled.",
        "If that's a mistake — or you've changed your mind — call or text us and we'll sort it out.");
      return;
    }
    if (a.state === "completed" || a.state === "past") {
      terminal("This appointment has passed.",
        "Need anything else? Call or text us any time.");
      return;
    }

    el("details").hidden = false;
    el("hello").textContent = `Hi ${a.name},`;
    el("service").textContent = a.serviceLabel;
    el("dateLabel").textContent = a.dateLabel;
    el("bucketLabel").textContent = a.freeBucket
      ? "Free bucket — we'll call with an arrival time"
      : a.bucketLabel;
    el("street").textContent = a.street;
    el("priceRow").hidden = !a.priceLabel;
    el("priceLabel").textContent = a.priceLabel || "";

    const badge = el("badge");
    if (a.state === "responded") {
      badge.hidden = false;
      badge.textContent = a.freeBucket || a.respondedVia === "free_bucket"
        ? "Free bucket — our technician will call with a time"
        : a.respondedVia === "reschedule" ? "Rescheduled — you're all set"
        : a.respondedVia === "window" ? "Timing saved — you're all set"
        : "Confirmed — you're all set";
      el("confirmBtn").hidden = true;   // already answered
    } else {
      badge.hidden = true;
      el("confirmBtn").hidden = !a.canConfirm;
    }
    el("rescheduleBtn").hidden = !a.canReschedule;
    el("cancelBtn").hidden = !a.canCancel;
    el("windowBtn").hidden = !a.canSetWindow;
    fillWindowSelects(a.requestedWindow);
    el("reschedulePanel").hidden = true;
    el("cancelPanel").hidden = true;
    el("windowPanel").hidden = true;
    el("actions").hidden = false;
  }

  // Half-hour choices from 8:00 AM to 5:00 PM for the after/before rows.
  function fillWindowSelects(current) {
    const after = el("windowAfter");
    const before = el("windowBefore");
    if (after.options.length <= 1) {
      for (let m = 8 * 60; m <= 17 * 60; m += 30) {
        const hh = String(Math.floor(m / 60)).padStart(2, "0");
        const mm = String(m % 60).padStart(2, "0");
        const d = new Date(2000, 0, 1, Math.floor(m / 60), m % 60);
        const label = d.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
        for (const sel of [after, before]) {
          const opt = document.createElement("option");
          opt.value = `${hh}:${mm}`;
          opt.textContent = label;
          sel.appendChild(opt);
        }
      }
    }
    after.value = current?.notBefore || "";
    before.value = current?.notAfter || "";
  }

  async function load() {
    try {
      const r = await fetch(api(), { cache: "no-store" });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error((data.errors || ["We couldn't find that appointment."]).join(" "));
      render(data.appointment);
    } catch (error) {
      fail(error.message);
    }
  }

  async function post(suffix, body) {
    const r = await fetch(api(suffix), {
      method: suffix === "/reschedule" ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error((data.errors || ["That didn't go through."]).join(" "));
    return data;
  }

  el("confirmBtn").addEventListener("click", async () => {
    el("confirmBtn").disabled = true;
    try {
      const data = await post("/confirm");
      render(data.appointment);
    } catch (error) { fail(error.message); }
    finally { el("confirmBtn").disabled = false; }
  });

  // ---- Reschedule --------------------------------------------------

  el("rescheduleBtn").addEventListener("click", async () => {
    el("actions").hidden = true;
    el("cancelPanel").hidden = true;
    el("reschedulePanel").hidden = false;
    const list = el("slotList");
    list.innerHTML = '<p class="ap-loading">Finding days near you…</p>';
    try {
      const r = await fetch(api("/availability"), { cache: "no-store" });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error((data.errors || ["Couldn't load available days."]).join(" "));
      const days = (data.data?.days || []).filter((d) => d.slots && d.slots.length);
      list.innerHTML = "";
      if (!days.length) {
        list.innerHTML = '<p class="ap-note">No open days near you right now — call or text us and we\'ll find one together.</p>';
        return;
      }
      for (const day of days) {
        for (const slot of day.slots) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "ap-slot";
          b.innerHTML = `<strong>${day.label}</strong><span>${slot.timeLabel} · ${slot.bucketWindow}</span>`;
          b.addEventListener("click", async () => {
            if (!window.confirm(`Move your appointment to ${day.label}, ${slot.timeLabel.toLowerCase()}?`)) return;
            b.disabled = true;
            try {
              const done = await post("/reschedule", { start: slot.start });
              render(done.appointment);
            } catch (error) { fail(error.message); }
          });
          list.appendChild(b);
        }
      }
    } catch (error) {
      list.innerHTML = "";
      fail(error.message);
    }
  });
  el("rescheduleBack").addEventListener("click", () => {
    el("reschedulePanel").hidden = true;
    el("actions").hidden = false;
  });

  // ---- Free bucket -------------------------------------------------

  el("freeBucketBtn").addEventListener("click", async () => {
    if (!window.confirm("Join the Free Bucket? We'll fit your visit in when our crew is in your area, and our technician will call you with an approximate arrival time.")) return;
    el("freeBucketBtn").disabled = true;
    try {
      const data = await post("/free-bucket");
      render(data.appointment);
    } catch (error) { fail(error.message); }
    finally { el("freeBucketBtn").disabled = false; }
  });

  // ---- Timing window (after / before) ------------------------------

  el("windowBtn").addEventListener("click", () => {
    el("actions").hidden = true;
    el("reschedulePanel").hidden = true;
    el("cancelPanel").hidden = true;
    el("windowPanel").hidden = false;
  });
  el("windowBack").addEventListener("click", () => {
    el("windowPanel").hidden = true;
    el("actions").hidden = false;
  });
  el("windowSave").addEventListener("click", async () => {
    el("windowSave").disabled = true;
    try {
      const data = await post("/time-window", {
        notBefore: el("windowAfter").value || "",
        notAfter: el("windowBefore").value || ""
      });
      render(data.appointment);
    } catch (error) { fail(error.message); }
    finally { el("windowSave").disabled = false; }
  });

  // ---- Cancel ------------------------------------------------------

  el("cancelBtn").addEventListener("click", () => {
    el("actions").hidden = true;
    el("reschedulePanel").hidden = true;
    el("cancelPanel").hidden = false;
  });
  el("cancelBack").addEventListener("click", () => {
    el("cancelPanel").hidden = true;
    el("actions").hidden = false;
  });
  el("cancelConfirm").addEventListener("click", async () => {
    el("cancelConfirm").disabled = true;
    try {
      await post("/cancel", { reason: el("cancelReason").value.trim() });
      terminal("Your appointment is cancelled.",
        "Thanks for letting us know. If anything changes, call or text us and we'll get you back on the route.");
    } catch (error) { fail(error.message); }
    finally { el("cancelConfirm").disabled = false; }
  });

  if (!token) fail("This link is incomplete — please use the link from your text or email.");
  else load();
})();

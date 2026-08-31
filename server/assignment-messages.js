// Assignment message templates — stage 3 of docs/ASSIGNMENT_WRITER.md.
// Edit-and-preview only. NOTHING SENDS FROM THIS PAGE.
(function assignmentMessagesPage() {
  const el = (id) => document.getElementById(id);
  const seasonSelect = el("seasonSelect");
  const yearSelect = el("yearSelect");
  const customerSelect = el("customerSelect");
  const templateList = el("templateList");
  const toast = el("toast");

  const thisYear = new Date().getFullYear();
  for (let y = thisYear; y <= thisYear + 1; y++) {
    const opt = document.createElement("option");
    opt.value = String(y);
    opt.textContent = String(y);
    yearSelect.appendChild(opt);
  }
  yearSelect.value = String(thisYear);

  let templates = {};
  let rendered = {};      // key -> { subject?, body } for the chosen customer

  function showToast(message, tone = "ok") {
    toast.textContent = message;
    toast.className = `am-toast is-${tone}`;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.hidden = true; }, 3500);
  }

  // Rough SMS cost line: GSM-7 segments are 160 chars (153 concatenated).
  function smsMeter(text) {
    const length = String(text || "").length;
    const segments = length <= 160 ? 1 : Math.ceil(length / 153);
    return `${length} characters · ~${segments} SMS segment${segments === 1 ? "" : "s"}`;
  }

  async function loadTemplates() {
    const r = await fetch("/api/assignment-messages", { cache: "no-store" });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error((data.errors || ["Couldn't load the templates."]).join(" "));
    templates = data.templates;
    const legend = el("fieldLegend");
    legend.innerHTML = "";
    for (const [field, what] of Object.entries(data.mergeFields)) {
      const dt = document.createElement("dt");
      dt.textContent = `{${field}}`;
      const dd = document.createElement("dd");
      dd.textContent = what;
      legend.appendChild(dt);
      legend.appendChild(dd);
    }
    renderEditors();
  }

  async function loadPreview() {
    const wanted = customerSelect.value;
    const url = `/api/assignment-messages/preview/${seasonSelect.value}/${yearSelect.value}`
      + (wanted ? `?bookingId=${encodeURIComponent(wanted)}` : "");
    const r = await fetch(url, { cache: "no-store" });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error((data.errors || ["Couldn't render the preview."]).join(" "));
    rendered = data.messages || {};
    customerSelect.innerHTML = "";
    for (const c of data.candidates || []) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = `${c.customerName || c.code} — ${c.date} ${c.bucket}`;
      customerSelect.appendChild(opt);
    }
    if (data.chosenId) customerSelect.value = data.chosenId;
    el("previewNote").textContent = data.sample
      ? "No assigned bookings yet for this season — previewing with a sample customer."
      : `Previewing as ${data.context.name}, ${data.context.street}, ${data.context.date} (${data.context.bucket}). `
        + "The link shows as [appointment-link] until the send step builds each customer's real one.";
    updatePreviews();
  }

  function updatePreviews() {
    for (const key of Object.keys(templates)) {
      const box = document.querySelector(`[data-preview="${key}"]`);
      if (!box) continue;
      const msg = rendered[key];
      if (!msg) { box.textContent = ""; continue; }
      box.textContent = (msg.subject ? `Subject: ${msg.subject}\n\n` : "") + msg.body;
    }
  }

  const GROUPS = [
    { title: "Step 1 — The assignment (sent to everyone at the blast)", keys: ["assignment_email", "assignment_sms"] },
    { title: "Step 2 — Follow-up, 15 days before (non-responders only)", keys: ["followup_email", "followup_sms"] },
    { title: "Steps 3–5 — Your nudge, at 10 / 7 / 5 days (non-responders only)", keys: ["nudge_email", "nudge_sms"] },
    { title: "Step 6 — 24-hour reminder (text, sent to everyone)", keys: ["reminder24_sms"] }
  ];

  function renderEditors() {
    templateList.innerHTML = "";
    for (const group of GROUPS) {
      const section = document.createElement("section");
      section.className = "am-panel";
      const h = document.createElement("h2");
      h.className = "am-panel-title";
      h.textContent = group.title;
      section.appendChild(h);
      for (const key of group.keys) section.appendChild(editorFor(key));
      templateList.appendChild(section);
    }
    updatePreviews();
  }

  function editorFor(key) {
    const t = templates[key];
    const wrap = document.createElement("div");
    wrap.className = "am-editor";
    wrap.innerHTML = `
      <div class="am-editor-head">
        <strong>${t.channel === "sms" ? "Text message" : "Email"}</strong>
        <span class="am-source" data-source="${key}">${t.source === "custom"
          ? `Your wording${t.updatedAt ? ` · saved ${new Date(t.updatedAt).toLocaleDateString("en-CA")}` : ""}`
          : "Default wording"}</span>
      </div>
      ${t.hasSubject ? `<label class="am-label">Subject<input type="text" data-subject="${key}"></label>` : ""}
      <label class="am-label">Message<textarea data-body="${key}" rows="${t.channel === "sms" ? 4 : 12}"></textarea></label>
      ${t.channel === "sms" ? `<p class="am-meter" data-meter="${key}"></p>` : ""}
      <div class="am-editor-actions">
        <button type="button" class="pjl-btn pjl-btn-primary" data-save="${key}">Save wording</button>
        <button type="button" class="pjl-btn pjl-btn-outline" data-reset="${key}">Back to default</button>
      </div>
      <details class="am-preview">
        <summary>Preview for the selected customer</summary>
        <pre class="am-preview-box" data-preview="${key}"></pre>
      </details>
    `;
    const bodyEl = wrap.querySelector(`[data-body="${key}"]`);
    bodyEl.value = t.body || "";
    if (t.hasSubject) wrap.querySelector(`[data-subject="${key}"]`).value = t.subject || "";
    const meter = wrap.querySelector(`[data-meter="${key}"]`);
    const tickMeter = () => { if (meter) meter.textContent = smsMeter(bodyEl.value); };
    tickMeter();
    bodyEl.addEventListener("input", tickMeter);

    wrap.querySelector(`[data-save="${key}"]`).addEventListener("click", () => save(key, wrap, false));
    wrap.querySelector(`[data-reset="${key}"]`).addEventListener("click", () => save(key, wrap, true));
    return wrap;
  }

  async function save(key, wrap, reset) {
    const payload = reset
      ? { subject: "", body: "" }
      : {
          subject: wrap.querySelector(`[data-subject="${key}"]`)?.value || "",
          body: wrap.querySelector(`[data-body="${key}"]`)?.value || ""
        };
    try {
      const r = await fetch(`/api/assignment-messages/${key}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error((data.errors || ["Couldn't save."]).join(" "));
      templates[key] = { ...templates[key], ...data.template };
      wrap.querySelector(`[data-body="${key}"]`).value = data.template.body || "";
      const subjectEl = wrap.querySelector(`[data-subject="${key}"]`);
      if (subjectEl) subjectEl.value = data.template.subject || "";
      wrap.querySelector(`[data-source="${key}"]`).textContent =
        data.template.source === "custom" ? "Your wording · just saved" : "Default wording";
      showToast(reset ? "Back to the default wording." : "Saved.");
      await loadPreview();
    } catch (error) {
      showToast(error.message, "bad");
    }
  }

  seasonSelect.addEventListener("change", () => loadPreview().catch((e) => showToast(e.message, "bad")));
  yearSelect.addEventListener("change", () => loadPreview().catch((e) => showToast(e.message, "bad")));
  customerSelect.addEventListener("change", () => loadPreview().catch((e) => showToast(e.message, "bad")));

  el("logoutButton")?.addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/admin/login";
  });
  el("navToggle")?.addEventListener("click", () => {
    document.body.classList.toggle("pjl-nav-open");
  });

  loadTemplates()
    .then(() => loadPreview())
    .catch((error) => showToast(error.message, "bad"));
})();

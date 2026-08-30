// Season plan review — /admin/season-plan
//
// Three jobs, in the order they matter:
//   1. Import the generated plan and show what it resolved to.
//   2. Show what did NOT resolve, loudly. A property code with no record
//      behind it is a stop that will quietly not exist.
//   3. Probe an address, so the geography filter's arithmetic is visible
//      rather than a thing you have to trust.
//
// Moving a stop between days/buckets is the only edit offered. The plan
// is regenerated every season from live data, so a richer editor would
// be maintained for no one.

(function seasonPlanPage() {
  const el = (id) => document.getElementById(id);
  const seasonSelect = el("seasonSelect");
  const yearSelect = el("yearSelect");
  const planMeta = el("planMeta");
  const dayList = el("dayList");
  const emptyState = el("emptyState");
  const problemsPanel = el("problemsPanel");
  const problemsList = el("problemsList");
  const toast = el("toast");

  let current = null;

  // ---- Year options: this year and the next two. The plan is a
  // forward-looking artifact; there is no reason to offer history.
  const thisYear = new Date().getFullYear();
  for (let y = thisYear; y <= thisYear + 2; y++) {
    const opt = document.createElement("option");
    opt.value = String(y);
    opt.textContent = String(y);
    yearSelect.appendChild(opt);
  }
  yearSelect.value = String(thisYear);

  function showToast(message, tone = "ok") {
    toast.textContent = message;
    toast.className = `sp-toast is-${tone}`;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.hidden = true; }, 4200);
  }

  function base() {
    return `/api/season-plans/${seasonSelect.value}/${yearSelect.value}`;
  }

  // ---- Render ------------------------------------------------------

  function stopRow(stop, date, bucket, arrival) {
    const li = document.createElement("li");
    li.className = `sp-stop${stop.resolved ? "" : " is-unresolved"}`;

    // Stop number and arrival estimate. Both admin-facing only — the
    // customer is told a bucket and never a minute, which is what makes
    // reordering free. The number comes from the sequencer, not from the
    // row's position, so it stays true even if this list were ever
    // rendered in another order.
    const lead = document.createElement("div");
    lead.className = "sp-stop-lead";
    if (stop.stopNumber) {
      const n = document.createElement("span");
      n.className = "sp-stop-num";
      n.textContent = stop.stopNumber;
      n.setAttribute("aria-label", `Stop ${stop.stopNumber}`);
      lead.appendChild(n);
    }
    if (arrival) {
      const when = document.createElement("span");
      when.className = "sp-stop-time";
      when.textContent = arrival.arriveAt;
      when.title = `${arrival.driveMinutes} min drive, ${arrival.onSiteMinutes} min on site`;
      lead.appendChild(when);
    }
    if (lead.childNodes.length) li.appendChild(lead);

    const main = document.createElement("div");
    main.className = "sp-stop-main";
    const code = document.createElement("span");
    code.className = "sp-stop-code";
    code.textContent = stop.code;
    main.appendChild(code);

    const who = document.createElement("span");
    who.className = "sp-stop-who";
    // Address first, name second. One customer can hold many properties
    // (Willowridge has 14) so the address is the identifying fact — the
    // same reason the assignment message has to name the address.
    who.textContent = stop.resolved
      ? `${stop.address || "no address"}${stop.customerName ? ` — ${stop.customerName}` : ""}`
      : stop.problem;
    main.appendChild(who);
    li.appendChild(main);

    const meta = document.createElement("div");
    meta.className = "sp-stop-meta";
    if (stop.resolved) {
      const zones = document.createElement("span");
      zones.className = stop.zonesEstimated ? "sp-tag is-warn" : "sp-tag";
      zones.textContent = stop.zonesEstimated ? "zones unknown" : `${stop.zones} zones`;
      meta.appendChild(zones);
      if (stop.minutes) {
        const mins = document.createElement("span");
        mins.className = "sp-tag";
        mins.textContent = `${stop.minutes} min`;
        meta.appendChild(mins);
      }
      if (!stop.hasCoords) {
        const geo = document.createElement("span");
        geo.className = "sp-tag is-bad";
        geo.textContent = "no coordinates";
        meta.appendChild(geo);
      }
      meta.appendChild(moveControl(stop, date, bucket));
    }
    li.appendChild(meta);
    return li;
  }

  function moveControl(stop, fromDate, fromBucket) {
    const select = document.createElement("select");
    select.className = "sp-move";
    select.setAttribute("aria-label", `Move ${stop.code}`);
    const head = document.createElement("option");
    head.value = "";
    head.textContent = "Move to…";
    select.appendChild(head);
    for (const day of current.days) {
      for (const bucket of ["morning", "afternoon"]) {
        if (day.date === fromDate && bucket === fromBucket) continue;
        const opt = document.createElement("option");
        opt.value = `${day.date}|${bucket}`;
        opt.textContent = `${day.label || day.date} · ${bucket}`;
        select.appendChild(opt);
      }
    }
    select.addEventListener("change", async () => {
      if (!select.value) return;
      const [toDate, toBucket] = select.value.split("|");
      select.disabled = true;
      try {
        const response = await fetch(`${base()}/move`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ propertyCode: stop.code, toDate, toBucket })
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error((data.errors || ["Move failed."]).join(" "));
        render(data.plan);
        showToast(`${stop.code} moved to ${toDate} ${toBucket}.`);
      } catch (error) {
        showToast(error.message, "bad");
        select.disabled = false;
        select.value = "";
      }
    });
    return select;
  }

  function bucketBlock(day, bucket) {
    const stops = day[bucket];
    const wrap = document.createElement("div");
    wrap.className = "sp-bucket";

    const head = document.createElement("h4");
    head.className = "sp-bucket-head";
    const over = stops.length > current.bucketCap;
    head.innerHTML = `<span>${bucket === "morning" ? "Morning" : "Afternoon"}</span>`;
    const count = document.createElement("span");
    count.className = `sp-count${over ? " is-over" : ""}`;
    count.textContent = `${stops.length} / ${current.bucketCap}`;
    head.appendChild(count);
    wrap.appendChild(head);

    if (!stops.length) {
      const none = document.createElement("p");
      none.className = "sp-bucket-empty";
      none.textContent = "Open — room for standby or a new customer.";
      wrap.appendChild(none);
      return wrap;
    }
    const list = document.createElement("ul");
    list.className = "sp-stops";
    const arrivals = new Map((day.timeline || []).map((t) => [t.propertyCode, t]));
    stops.forEach((stop) => list.appendChild(stopRow(stop, day.date, bucket, arrivals.get(stop.code))));
    wrap.appendChild(list);
    return wrap;
  }

  function dayCard(day) {
    const card = document.createElement("section");
    card.className = "sp-day";

    const head = document.createElement("header");
    head.className = "sp-day-head";
    const title = document.createElement("div");
    title.innerHTML = `<h3>${day.label || "—"} · ${day.weekday}</h3>`;
    if (day.territory) {
      const t = document.createElement("p");
      t.className = "sp-day-territory";
      t.textContent = day.territory;
      title.appendChild(t);
    }
    head.appendChild(title);

    const stats = document.createElement("div");
    stats.className = "sp-day-stats";
    const total = document.createElement("span");
    total.className = `sp-count${day.counts.total > current.dayCap ? " is-over" : ""}`;
    total.textContent = `${day.counts.total} / ${current.dayCap} stops`;
    stats.appendChild(total);
    const hours = document.createElement("span");
    hours.className = "sp-tag";
    const h = Math.floor(day.onSiteMinutes / 60);
    const m = day.onSiteMinutes % 60;
    hours.textContent = `${h}h ${String(m).padStart(2, "0")}m on site`;
    stats.appendChild(hours);
    if (day.driveMinutes != null) {
      const drive = document.createElement("span");
      drive.className = "sp-tag";
      drive.textContent = `${day.driveMinutes} min driving`;
      stats.appendChild(drive);
    }
    if (day.homeAt) {
      const home = document.createElement("span");
      home.className = "sp-tag";
      home.textContent = `home ${day.homeAt}`;
      stats.appendChild(home);
    }
    // The noon rule, shown as a fact rather than buried in a warning list.
    if (day.morningEndsAt) {
      const overruns = (day.flags || []).some((f) => f.code === "morning_overruns");
      const am = document.createElement("span");
      am.className = overruns ? "sp-tag is-bad" : "sp-tag";
      am.textContent = `morning ends ${day.morningEndsAt}`;
      stats.appendChild(am);
    }
    // Route preview + the drive-it link. The list cannot be checked by
    // eye; a map can, which is how the last two routing defects were
    // actually found.
    const actions = document.createElement("div");
    actions.className = "sp-day-actions";
    const mapBtn = document.createElement("button");
    mapBtn.type = "button";
    mapBtn.className = "pjl-btn pjl-btn-outline sp-map-btn";
    mapBtn.textContent = "Preview route";
    mapBtn.addEventListener("click", () => window.PJLSeasonPlanMap.openMap(day, current));
    actions.appendChild(mapBtn);

    // Needs no API key, so it is offered even when the preview cannot be.
    const url = window.PJLSeasonPlanMap.directionsUrl(
      window.PJLSeasonPlanMap.stopsFor(day), current.routeOrigin);
    if (url) {
      const drive = document.createElement("a");
      drive.className = "pjl-btn pjl-btn-outline sp-map-btn";
      drive.href = url;
      drive.target = "_blank";
      drive.rel = "noopener";
      drive.textContent = "Open in Google Maps";
      actions.appendChild(drive);
    }
    stats.appendChild(actions);

    head.appendChild(stats);
    card.appendChild(head);

    const notes = [...(day.flags || []), ...(day.suggestions || [])];
    if (notes.length) {
      const strip = document.createElement("ul");
      strip.className = "sp-day-notes";
      for (const n of notes) {
        const li = document.createElement("li");
        li.className = n.code === "morning_overruns" ? "is-bad"
          : n.code === "bucket_move_suggested" ? "is-suggestion" : "";
        li.textContent = n.message;
        strip.appendChild(li);
      }
      card.appendChild(strip);
    }

    const buckets = document.createElement("div");
    buckets.className = "sp-buckets";
    buckets.appendChild(bucketBlock(day, "morning"));
    buckets.appendChild(bucketBlock(day, "afternoon"));
    card.appendChild(buckets);
    return card;
  }

  function render(plan) {
    current = plan;
    dayList.innerHTML = "";
    if (!plan) {
      planMeta.textContent = "No plan loaded for this season yet.";
      emptyState.hidden = false;
      emptyState.textContent = "Import the generated route plan to seed this season.";
      problemsPanel.hidden = true;
      return;
    }
    emptyState.hidden = true;

    const stamp = plan.updatedAt || plan.generatedAt;
    const when = stamp ? new Date(stamp).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "unknown";
    const drive = plan.driveMinutes
      ? ` · ${Math.round(plan.driveMinutes / 60)}h ${plan.driveMinutes % 60}m driving across the season`
      : "";
    const overrun = (plan.overrunDays || []).length
      ? ` · ${plan.overrunDays.length} day${plan.overrunDays.length === 1 ? "" : "s"} overrun the morning`
      : "";
    planMeta.textContent =
      `${plan.totalStops} stops across ${plan.days.length} route days${drive}${overrun} · updated ${when}`
      + (plan.updatedBy ? ` by ${plan.updatedBy}` : "");

    // The anchor, stated. A route pointed at the wrong start looks exactly
    // like a route pointed at the right one, so the only defence is saying
    // out loud where every day begins and ends.
    const origin = plan.routeOrigin;
    let anchor = document.getElementById("routeAnchor");
    if (!anchor) {
      anchor = document.createElement("p");
      anchor.id = "routeAnchor";
      anchor.className = "sp-anchor";
      planMeta.insertAdjacentElement("afterend", anchor);
    }
    if (origin && origin.resolved) {
      anchor.className = "sp-anchor";
      anchor.textContent = `Every day starts and ends at ${origin.formattedAddress || origin.address}.`;
    } else if (origin) {
      anchor.className = "sp-anchor is-bad";
      anchor.textContent = `Could not locate ${origin.address} — routes are anchored to the `
        + "Newmarket town centre instead, so the order of stops may be wrong. Check the address.";
    }

    problemsList.innerHTML = "";
    if (plan.problems && plan.problems.length) {
      problemsPanel.hidden = false;
      for (const p of plan.problems) {
        const li = document.createElement("li");
        li.innerHTML = `<strong>${p.code}</strong> <span class="sp-problem-where">${p.label || p.date}</span> — ${p.problem}`;
        problemsList.appendChild(li);
      }
    } else {
      problemsPanel.hidden = true;
    }

    plan.days.forEach((day) => dayList.appendChild(dayCard(day)));
  }

  async function load() {
    dayList.innerHTML = "";
    planMeta.textContent = "Loading…";
    try {
      const response = await fetch(base(), { cache: "no-store" });
      if (response.status === 404) { render(null); return; }
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error((data.errors || ["Couldn't load the plan."]).join(" "));
      render(data.plan);
    } catch (error) {
      planMeta.textContent = error.message;
      render(null);
    }
  }

  // ---- Probe -------------------------------------------------------

  el("probeForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const address = el("probeAddress").value.trim();
    const out = el("probeOut");
    if (!address) return;
    out.hidden = false;
    out.textContent = "Checking…";
    try {
      const response = await fetch(`${base()}/probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error((data.errors || ["Probe failed."]).join(" "));
      renderProbe(out, data);
    } catch (error) {
      out.textContent = error.message;
    }
  });

  function renderProbe(out, data) {
    out.innerHTML = "";
    const head = document.createElement("p");
    head.className = "sp-probe-head";
    head.textContent = data.filterSkipped
      ? `${data.address} — could not be geocoded, so the filter is skipped and every day is offered.`
      : `${data.address} — offered on ${data.routeDaysOffered} of ${data.routeDaysTotal} route days, `
        + `where inserting them costs ${data.thresholdMinutes} min of extra driving or less.`;
    out.appendChild(head);

    // Without this line the table reads as the whole answer, and a row of
    // "no" looks like the customer has been shut out of the season. They
    // have not: the filter only has an opinion about days that carry a
    // planned route.
    const rest = document.createElement("p");
    rest.className = "sp-probe-note";
    rest.textContent = "This table covers route days only. Every other open day in the season "
      + "has no planned route, so it is offered to this address as normal — a customer with no "
      + "route day still sees most of the calendar.";
    out.appendChild(rest);

    const table = document.createElement("table");
    table.className = "sp-probe-table";
    table.innerHTML = "<thead><tr><th>Route</th><th>Date</th><th>Stops</th><th>Added drive</th><th>Offered</th></tr></thead>";
    const body = document.createElement("tbody");
    for (const day of data.days) {
      const tr = document.createElement("tr");
      tr.className = day.offered ? "is-offered" : "";
      const added = day.addedDriveMinutes == null ? "—" : `${day.addedDriveMinutes} min`;
      tr.innerHTML = `<td>${day.label || "—"}</td><td>${day.date}</td><td>${day.points}</td>`
        + `<td class="sp-num">${added}</td><td>${day.offered ? "yes" : "no"}</td>`;
      body.appendChild(tr);
    }
    table.appendChild(body);
    out.appendChild(table);
  }

  // ---- Import ------------------------------------------------------

  const modal = el("importModal");
  const importText = el("importText");
  const importError = el("importError");

  function openImport() { modal.hidden = false; importError.hidden = true; importText.focus(); }
  function closeImport() { modal.hidden = true; }

  el("importBtn").addEventListener("click", openImport);
  el("importClose").addEventListener("click", closeImport);
  el("importCancel").addEventListener("click", closeImport);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeImport(); });

  el("importFile").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    importText.value = await file.text();
  });

  el("importSave").addEventListener("click", async () => {
    importError.hidden = true;
    let parsed;
    try {
      parsed = JSON.parse(importText.value);
    } catch (error) {
      importError.textContent = `That isn't valid JSON — ${error.message}`;
      importError.hidden = false;
      return;
    }
    try {
      const response = await fetch(base(), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed)
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error((data.errors || ["Import failed."]).join(" "));
      render(data.plan);
      closeImport();
      const warned = (data.warnings || []).length;
      showToast(warned
        ? `Imported with ${warned} warning${warned === 1 ? "" : "s"} — see Needs attention.`
        : "Plan imported.");
    } catch (error) {
      importError.textContent = error.message;
      importError.hidden = false;
    }
  });

  seasonSelect.addEventListener("change", load);
  yearSelect.addEventListener("change", load);
  load();
})();

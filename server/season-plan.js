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
    li.dataset.code = stop.code;

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

    // Street line first, the rest underneath. The panel is 360px wide, so a
    // full "90 Oriole Drive, East Gwillimbury, ON, Canada" on one line wraps
    // to three and a seven-stop day stops being scannable. One customer can
    // hold many properties (Willowridge has 14), so the address still leads —
    // it is the identifying fact, not the name.
    const main = document.createElement("div");
    main.className = "sp-stop-main";
    const parts = String(stop.address || "").split(",").map((x) => x.trim()).filter(Boolean);
    const street = document.createElement("span");
    street.className = "sp-stop-who";
    street.textContent = stop.resolved ? (parts[0] || "no address") : stop.problem;
    street.title = stop.resolved ? stop.address : stop.problem;
    main.appendChild(street);

    const sub = document.createElement("span");
    sub.className = "sp-stop-sub";
    // The property code goes in the tooltip, not the line: at this width it
    // was being ellipsised away mid-name anyway, and the name is what tells
    // you at a glance whose driveway this is.
    sub.textContent = [parts[1], stop.customerName].filter(Boolean).join(" · ");
    sub.title = [stop.code, stop.address].filter(Boolean).join(" — ");
    main.appendChild(sub);
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

    // The route, drawn on the day itself. Not behind a button and not in
    // another tab: the point is seeing eleven days' shape by scrolling.
    //
    // The map is the card and the stops float over it. It is a Leaflet map
    // on CARTO tiles, so it pans and zooms, costs nothing per load, and
    // carries OUR numbered pins — Google's static markers take a single
    // character, which is why stops past nine used to lose their number.
    const body = document.createElement("div");
    body.className = "sp-daybody";

    const mapBox = document.createElement("div");
    mapBox.className = "sp-map";
    body.appendChild(mapBox);

    const panel = document.createElement("div");
    panel.className = "sp-stoppanel";

    const panelHead = document.createElement("div");
    panelHead.className = "sp-stoppanel-head";
    const panelTitle = document.createElement("div");
    const h4 = document.createElement("h4");
    h4.textContent = `${day.counts.total} stop${day.counts.total === 1 ? "" : "s"}`;
    panelTitle.appendChild(h4);
    const when = document.createElement("p");
    when.className = "sp-stoppanel-when";
    const firstArrival = (day.timeline || [])[0];
    when.textContent = firstArrival && day.homeAt
      ? `${firstArrival.arriveAt} – ${day.homeAt}`
      : "not sequenced";
    panelTitle.appendChild(when);
    panelHead.appendChild(panelTitle);

    // Turn-by-turn handoff. The Maps URL API is free and needs no key, so
    // the day goes to a phone without us building anything.
    const openRoute = googleMapsLink(day);
    if (openRoute) {
      const link = document.createElement("a");
      link.className = "sp-open-route";
      link.href = openRoute;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Open route";
      panelHead.appendChild(link);
    }
    panel.appendChild(panelHead);

    const scroll = document.createElement("div");
    scroll.className = "sp-stoppanel-scroll";
    scroll.appendChild(bucketBlock(day, "morning"));
    scroll.appendChild(bucketBlock(day, "afternoon"));
    panel.appendChild(scroll);
    body.appendChild(panel);
    card.appendChild(body);

    // BUILT ON SCROLL, NOT ON LOAD. Eleven days rendering at once fired
    // eleven route requests in the same tick; the ones that lost that race
    // came back refused and the page finished half-drawn. One day at a
    // time, and only the days actually looked at.
    whenVisible(mapBox, () => drawDayMap(mapBox, scroll, day));

    return card;
  }

  // ---- Map ---------------------------------------------------------

  const CARTO_TILES = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
  const CARTO_ATTRIBUTION =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, '
    + '&copy; <a href="https://carto.com/attributions">CARTO</a>';

  function whenVisible(el, run) {
    if (typeof IntersectionObserver !== "function") { run(); return; }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.disconnect();
        run();
      }
    }, { rootMargin: "200px" });
    observer.observe(el);
  }

  // Stops in driving order that we can actually put a pin on. A stop with
  // no coordinates still belongs in the list — it is a real job — but it
  // cannot be drawn, and pretending otherwise would move the route.
  function mappableStops(day) {
    const byCode = new Map();
    for (const bucket of ["morning", "afternoon"]) {
      for (const stop of day[bucket] || []) byCode.set(stop.code, { stop, bucket });
    }
    return (day.timeline || []).map((t) => {
      const found = byCode.get(t.propertyCode);
      if (!found || !found.stop.coords || found.stop.coords.lat == null) return null;
      return {
        code: t.propertyCode,
        number: t.stopNumber,
        bucket: found.bucket,
        arriveAt: t.arriveAt,
        address: found.stop.address || t.address || "",
        customerName: found.stop.customerName || "",
        coords: found.stop.coords
      };
    }).filter(Boolean);
  }

  function googleMapsLink(day) {
    const stops = mappableStops(day);
    if (!stops.length) return null;
    const origin = current && current.routeOrigin;
    if (!origin || origin.lat == null) return null;
    const at = (c) => `${c.lat},${c.lng}`;
    const url = new URL("https://www.google.com/maps/dir/");
    url.searchParams.set("api", "1");
    url.searchParams.set("origin", at(origin));
    url.searchParams.set("destination", at(origin));
    // The Maps URL API takes at most nine waypoints. Our longest day is
    // nine stops, so this is at the limit rather than past it — but a
    // silently truncated route would be worse than a short one, so the
    // note says when it has been cut.
    url.searchParams.set("waypoints", stops.slice(0, 9).map((s) => at(s.coords)).join("|"));
    url.searchParams.set("travelmode", "driving");
    return url.toString();
  }

  function pinIcon(stop) {
    return L.divIcon({
      className: "",
      html: `<span class="sp-pin is-${stop.bucket === "morning" ? "am" : "pm"}">${stop.number}</span>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });
  }

  function drawDayMap(mapBox, listRoot, day) {
    if (typeof L === "undefined") {
      note(mapBox, "Map library did not load — check the connection and refresh.", true);
      return;
    }
    const stops = mappableStops(day);
    if (!stops.length) { note(mapBox, "No stop on this day has coordinates to draw.", true); return; }

    const map = L.map(mapBox, { scrollWheelZoom: false, zoomControl: true });
    L.tileLayer(CARTO_TILES, { attribution: CARTO_ATTRIBUTION, subdomains: "abcd", maxZoom: 19 })
      .addTo(map);

    const origin = current && current.routeOrigin;
    const points = [];
    if (origin && origin.lat != null) {
      L.marker([origin.lat, origin.lng], {
        icon: L.divIcon({ className: "", html: '<span class="sp-yard">Y</span>', iconSize: [22, 22], iconAnchor: [11, 11] }),
        title: `Yard — ${origin.formattedAddress || origin.address || ""}`
      }).addTo(map);
      points.push([origin.lat, origin.lng]);
    }

    const markers = new Map();
    for (const stop of stops) {
      const marker = L.marker([stop.coords.lat, stop.coords.lng], {
        icon: pinIcon(stop),
        title: `Stop ${stop.number} · ${stop.arriveAt || ""} · ${stop.address}`
      }).addTo(map);
      marker.bindPopup(
        `<strong>Stop ${stop.number}${stop.arriveAt ? ` · ${stop.arriveAt}` : ""}</strong><br>`
        + `${escapeHtml(stop.address)}${stop.customerName ? `<br>${escapeHtml(stop.customerName)}` : ""}`
      );
      markers.set(stop.code, marker);
      points.push([stop.coords.lat, stop.coords.lng]);
    }
    map.fitBounds(L.latLngBounds(points), { padding: [46, 46] });

    linkRowsToPins(listRoot, markers);
    drawRoadLine(map, day, mapBox);
  }

  // Hovering a row lights its pin and the other way round. Without it the
  // panel and the map are two lists that happen to share a card.
  function linkRowsToPins(listRoot, markers) {
    listRoot.querySelectorAll(".sp-stop").forEach((row) => {
      const marker = markers.get(row.dataset.code);
      if (!marker) return;
      const el = () => marker.getElement() && marker.getElement().querySelector(".sp-pin");
      const set = (on) => {
        row.classList.toggle("is-hot", on);
        const pin = el();
        if (pin) pin.classList.toggle("is-hot", on);
      };
      row.addEventListener("mouseenter", () => set(true));
      row.addEventListener("mouseleave", () => set(false));
      row.addEventListener("click", () => { marker.openPopup(); });
      marker.on("mouseover", () => set(true));
      marker.on("mouseout", () => set(false));
    });
  }

  async function drawRoadLine(map, day, mapBox) {
    const url = `/api/season-plans/${seasonSelect.value}/${yearSelect.value}/route-line/${day.date}`;
    try {
      const response = await fetch(url, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok || !Array.isArray(data.coords) || data.coords.length < 2) {
        note(mapBox, (data.errors || ["Could not draw the drive for this day."]).join(" "), true);
        return;
      }
      const straight = data.source !== "osrm";
      L.polyline(data.coords, {
        color: straight ? "#7A7A72" : "#1B4D2E",
        weight: straight ? 2 : 4,
        opacity: straight ? 0.7 : 0.8,
        dashArray: straight ? "6 6" : null,
        lineJoin: "round"
      }).addTo(map);
      // A straight line between stops is not a drive, and a map that shows
      // one without saying so is making a claim it cannot support.
      note(mapBox, straight
        ? `Straight hops, not roads: ${data.error || "the router did not answer."}`
        : "Y is the yard. Numbers are stops in driving order.", straight);
    } catch (error) {
      note(mapBox, `Could not draw the drive — ${error.message}`, true);
    }
  }

  function note(mapBox, text, bad) {
    let el = mapBox.parentElement.querySelector(".sp-map-note");
    if (!el) {
      el = document.createElement("p");
      el.className = "sp-map-note";
      mapBox.parentElement.appendChild(el);
    }
    el.className = bad ? "sp-map-note is-bad" : "sp-map-note";
    el.textContent = text;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
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

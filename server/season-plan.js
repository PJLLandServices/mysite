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

    let windowForm = null;
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
      const window = windowControl(stop, date);
      meta.appendChild(window.button);
      windowForm = window.form;
      meta.appendChild(nudgeControl(stop, date, bucket, arrival));
      meta.appendChild(moveControl(stop, date, bucket));
    }
    li.appendChild(meta);
    if (windowForm) li.appendChild(windowForm);
    return li;
  }

  // Two SEPARATE choices, not one bracket. "After 10:00" and "Before 12:00"
  // are independent things a customer says, and either can stand alone —
  // presenting them as a pair of bare inputs read as a range picker and
  // implied you had to give both.
  //
  // The form opens as its own full-width row rather than inside the meta
  // column: 168px cannot hold a labelled time field, and an absolutely
  // positioned popover would be clipped by the panel's own scrolling.
  function windowControl(stop, date) {
    const has = Boolean(stop.notBefore || stop.notAfter);

    const button = document.createElement("button");
    button.type = "button";
    button.className = has ? "sp-window-btn is-set" : "sp-window-btn";
    button.textContent = has
      ? [stop.notBefore ? `after ${stop.notBefore}` : "", stop.notAfter ? `before ${stop.notAfter}` : ""]
        .filter(Boolean).join(" · ")
      : "Time window";
    button.title = "When can this stop be done?";

    const form = document.createElement("form");
    form.className = "sp-window-form";
    form.hidden = true;

    const rows = {};
    for (const [field, label, hint] of [
      ["notBefore", "After", "do not arrive before this time"],
      ["notAfter", "Before", "must be done by this time"]
    ]) {
      const line = document.createElement("label");
      line.className = "sp-window-line";
      const name = document.createElement("span");
      name.className = "sp-window-label";
      name.textContent = label;
      const input = document.createElement("input");
      input.type = "time";
      input.step = 300;
      input.value = stop[field] || "";
      input.setAttribute("aria-label", `${label} — ${hint}, ${stop.code}`);
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "sp-window-clear";
      clear.textContent = "Clear";
      clear.addEventListener("click", () => { input.value = ""; input.focus(); });
      line.appendChild(name); line.appendChild(input); line.appendChild(clear);
      rows[field] = input;
      form.appendChild(line);
    }

    const foot = document.createElement("div");
    foot.className = "sp-window-foot";
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.className = "sp-window-cancel"; cancel.textContent = "Cancel";
    const save = document.createElement("button");
    save.type = "submit"; save.className = "sp-window-save"; save.textContent = "Save";
    foot.appendChild(cancel); foot.appendChild(save);
    form.appendChild(foot);

    const close = () => {
      form.hidden = true; button.hidden = false;
      rows.notBefore.value = stop.notBefore || "";
      rows.notAfter.value = stop.notAfter || "";
    };
    button.addEventListener("click", () => {
      form.hidden = false; button.hidden = true;
      rows.notBefore.focus();
    });
    cancel.addEventListener("click", close);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const notBefore = rows.notBefore.value;
      const notAfter = rows.notAfter.value;
      save.disabled = true;
      try {
        const response = await fetch(`${base()}/stop-window`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date, propertyCode: stop.code, notBefore, notAfter })
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error((data.errors || ["Failed."]).join(" "));
        render(data.plan);
        const said = [notBefore ? `after ${notBefore}` : "", notAfter ? `before ${notAfter}` : ""]
          .filter(Boolean).join(" and ");
        showToast(said ? `${stop.code}: ${said}.` : `${stop.code}: time window cleared.`);
      } catch (error) {
        showToast(error.message, "bad");
        save.disabled = false;
      }
    });

    return { button, form };
  }

  // Up/down inside the bucket. The first click hands the day to Patrick:
  // from then on the optimiser leaves it alone, because an order he set
  // that the next re-sequence quietly reverted would be worse than nothing.
  function nudgeControl(stop, date, bucket, arrival) {
    const wrap = document.createElement("span");
    wrap.className = "sp-nudge";
    for (const direction of ["up", "down"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sp-nudge-btn";
      button.textContent = direction === "up" ? "↑" : "↓";
      button.title = `Move ${stop.code} ${direction === "up" ? "earlier" : "later"} in the ${bucket}`;
      button.setAttribute("aria-label", button.title);
      button.addEventListener("click", async () => {
        wrap.querySelectorAll("button").forEach((b) => { b.disabled = true; });
        try {
          const response = await fetch(`${base()}/stop-order`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ date, bucket, propertyCode: stop.code, direction })
          });
          const data = await response.json();
          if (!response.ok || !data.ok) throw new Error((data.errors || ["Reorder failed."]).join(" "));
          render(data.plan);
          showToast(`${stop.code} moved ${direction === "up" ? "earlier" : "later"}.`);
        } catch (error) {
          showToast(error.message, "bad");
          wrap.querySelectorAll("button").forEach((b) => { b.disabled = false; });
        }
      });
      wrap.appendChild(button);
    }
    void arrival;
    return wrap;
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
    // The DATE, not just the weekday. It was missing, which was survivable
    // when a day could not move and is not now: you cannot reschedule a day
    // you cannot see the date of.
    title.innerHTML = `<h3>${day.label || "—"} · ${day.weekday}, ${prettyDate(day.date)}</h3>`;
    title.appendChild(rescheduleControl(day));
    if (day.manualOrder) title.appendChild(manualOrderNotice(day));
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
    // The map is the card and the stops float over it — a live Google map,
    // so it pans and zooms and reads like the map everyone already knows.
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

  // A hand-ordered day has to LOOK hand-ordered. Silently unoptimised is
  // how a day nobody remembers touching ends up driving badly all season.
  function manualOrderNotice(day) {
    const wrap = document.createElement("p");
    wrap.className = "sp-manual";
    const tag = document.createElement("span");
    tag.className = "sp-tag is-warn";
    tag.textContent = "ordered by hand";
    wrap.appendChild(tag);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "sp-manual-clear";
    button.textContent = "Back to automatic";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const response = await fetch(`${base()}/auto-order`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: day.date })
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error((data.errors || ["Failed."]).join(" "));
        render(data.plan);
        showToast(`${day.label || day.date} re-optimised.`);
      } catch (error) {
        showToast(error.message, "bad");
        button.disabled = false;
      }
    });
    wrap.appendChild(button);
    return wrap;
  }

  function prettyDate(date) {
    const [y, m, d] = String(date || "").split("-").map(Number);
    if (!y || !m || !d) return date || "—";
    return new Date(y, m - 1, d).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
  }

  // Re-dating a day. Only this day moves — the rest of the season keeps its
  // dates, because a warm Monday does not mean a warm Friday.
  function rescheduleControl(day) {
    const wrap = document.createElement("div");
    wrap.className = "sp-reschedule";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "sp-reschedule-open";
    button.textContent = "Reschedule";

    const form = document.createElement("form");
    form.className = "sp-reschedule-form";
    form.hidden = true;
    const input = document.createElement("input");
    input.type = "date";
    input.value = day.date;
    input.required = true;
    const go = document.createElement("button");
    go.type = "submit";
    go.className = "pjl-btn pjl-btn-primary sp-reschedule-go";
    go.textContent = "Move";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "sp-reschedule-cancel";
    cancel.textContent = "Cancel";
    form.appendChild(input); form.appendChild(go); form.appendChild(cancel);

    button.addEventListener("click", () => {
      form.hidden = false; button.hidden = true; input.focus();
    });
    cancel.addEventListener("click", () => {
      form.hidden = true; button.hidden = false; input.value = day.date;
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const toDate = input.value;
      if (!toDate || toDate === day.date) { cancel.click(); return; }
      go.disabled = true;
      try {
        const response = await fetch(`${base()}/day`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fromDate: day.date, toDate })
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error((data.errors || ["Move failed."]).join(" "));
        render(data.plan);
        const moved = data.moved || {};
        // Saturdays and Sundays are allowed but said out loud, because
        // landing on one by accident reads exactly like landing on one on
        // purpose until somebody drives out on a Sunday.
        const dm = data.dayMove || {};
        showToast(`${moved.label || "Day"} moved to ${prettyDate(toDate)}.`
          + (dm.moved ? ` ${dm.moved} booking${dm.moved === 1 ? "" : "s"} moved along` : "")
          + (dm.noticesQueued ? `, ${dm.noticesQueued} customer${dm.noticesQueued === 1 ? "" : "s"} will be re-notified` : "")
          + (dm.responsesReset ? `, ${dm.responsesReset} confirmation${dm.responsesReset === 1 ? "" : "s"} reset for the new date` : "")
          + (dm.moved ? "." : "")
          + (moved.weekend ? " That is a weekend." : ""), moved.weekend ? "warn" : "ok");
      } catch (error) {
        showToast(error.message, "bad");
        go.disabled = false;
      }
    });

    wrap.appendChild(button);
    wrap.appendChild(form);
    return wrap;
  }

  // ---- Map ---------------------------------------------------------
  //
  // Google Maps JavaScript API. The basemap, the labels and the road styling
  // are Google's, which is the point — this screen is read at a glance and a
  // desaturated substitute made it harder, not cleaner.
  //
  // The browser key comes from /api/maps-config rather than the HTML, and the
  // ROAD LINE is fetched from our own server, already cached: that keeps the
  // server key server-side and costs one Directions call per route change
  // instead of one per page view.

  let mapsPromise = null;
  function mapsReady() {
    if (mapsPromise) return mapsPromise;
    mapsPromise = (async () => {
      const response = await fetch("/api/maps-config", { cache: "no-store" });
      const config = await response.json();
      if (!config.ok || !config.available) {
        throw new Error(config.reason || "No Maps browser key is configured.");
      }
      await new Promise((resolve, reject) => {
        const callback = "__pjlMapsReady";
        window[callback] = () => { delete window[callback]; resolve(); };
        const script = document.createElement("script");
        script.async = true;
        // `places` is for the probe's address autocomplete. Libraries cannot
        // be added after the fact, and this is the only script load on the
        // page, so it has to be asked for here.
        script.src = "https://maps.googleapis.com/maps/api/js"
          + `?key=${encodeURIComponent(config.key)}&libraries=places`
          + `&v=weekly&callback=${callback}`;
        // A referrer-restricted key fails here and nowhere else, so the
        // message names that first — it is the likeliest cause by far.
        script.onerror = () => reject(new Error(
          "Google Maps did not load. Check the browser key's HTTP-referrer "
          + "restriction allows this domain, and that Maps JavaScript API is on its API list."));
        document.head.appendChild(script);
      });
      // coverage-checker.js drives every other address box on the site.
      // Reusing it means this field behaves identically to the ten others
      // rather than becoming a second implementation to keep in step. It
      // skips its full-checker half when that markup is absent, which it is
      // here, and wires any input.js-address-autocomplete.
      if (typeof window.initCoverageCheck === "function") {
        try { window.initCoverageCheck(); } catch (err) {
          console.warn("[season-plan] address autocomplete:", err && err.message);
        }
      }
    })();
    return mapsPromise;
  }

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

  // Stops in driving order that we can actually put a pin on. A stop with no
  // coordinates still belongs in the list — it is a real job — but it cannot
  // be drawn, and pretending otherwise would move the route.
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
        coords: { lat: Number(found.stop.coords.lat), lng: Number(found.stop.coords.lng) }
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
    // The Maps URL API takes at most nine waypoints. Our longest day is nine
    // stops, so this sits at the limit rather than past it.
    url.searchParams.set("waypoints", stops.slice(0, 9).map((s) => at(s.coords)).join("|"));
    url.searchParams.set("travelmode", "driving");
    return url.toString();
  }

  const AM_GREEN = "#1B4D2E";
  const PM_GREEN = "#4A8C5C";
  const HOT_AMBER = "#E07B24";

  function pinIcon(stop, hot) {
    return {
      path: google.maps.SymbolPath.CIRCLE,
      scale: hot ? 15 : 13,
      fillColor: stop.bucket === "morning" ? AM_GREEN : PM_GREEN,
      fillOpacity: 1,
      strokeColor: hot ? HOT_AMBER : "#ffffff",
      strokeWeight: hot ? 3 : 2
    };
  }

  function yardIcon() {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26">'
      + '<rect x="3" y="3" width="20" height="20" rx="5" fill="#0F1F14" stroke="#ffffff" stroke-width="2"/></svg>';
    return {
      url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
      anchor: new google.maps.Point(13, 13),
      labelOrigin: new google.maps.Point(13, 13)
    };
  }

  async function drawDayMap(mapBox, listRoot, day) {
    const stops = mappableStops(day);
    if (!stops.length) { note(mapBox, "No stop on this day has coordinates to draw.", true); return; }

    try {
      await mapsReady();
    } catch (error) {
      note(mapBox, error.message, true);
      return;
    }

    const map = new google.maps.Map(mapBox, {
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      // The page scrolls past eleven of these. Without cooperative gestures a
      // scroll over a map zooms it instead of moving the page.
      gestureHandling: "cooperative",
      zoom: 10,
      center: stops[0].coords
    });

    const bounds = new google.maps.LatLngBounds();
    const info = new google.maps.InfoWindow();
    const origin = current && current.routeOrigin;
    if (origin && origin.lat != null) {
      const yard = { lat: Number(origin.lat), lng: Number(origin.lng) };
      new google.maps.Marker({
        position: yard, map, icon: yardIcon(), zIndex: 1,
        label: { text: "Y", color: "#FAFAF5", fontSize: "11px", fontWeight: "700" },
        title: `Yard — ${origin.formattedAddress || origin.address || ""}`
      });
      bounds.extend(yard);
    }

    const markers = new Map();
    for (const stop of stops) {
      const marker = new google.maps.Marker({
        position: stop.coords, map, icon: pinIcon(stop, false), zIndex: 2,
        // Two digits fit here. Google's STATIC map markers take a single
        // character, which is why stops past nine used to lose their number.
        label: { text: String(stop.number), color: "#ffffff", fontSize: "12px", fontWeight: "700" },
        title: `Stop ${stop.number} · ${stop.arriveAt || ""} · ${stop.address}`
      });
      marker.addListener("click", () => {
        info.setContent(
          `<div style="font:13px/1.45 system-ui,sans-serif;max-width:230px">`
          + `<strong>Stop ${stop.number}${stop.arriveAt ? ` · ${stop.arriveAt}` : ""}</strong><br>`
          + `${escapeHtml(stop.address)}`
          + `${stop.customerName ? `<br>${escapeHtml(stop.customerName)}` : ""}</div>`
        );
        info.open({ map, anchor: marker });
      });
      markers.set(stop.code, { marker, stop });
      bounds.extend(stop.coords);
    }
    map.fitBounds(bounds, 48);

    linkRowsToPins(listRoot, markers);
    drawRoadLine(map, day, mapBox);
  }

  // Hovering a row lights its pin and the other way round. Without it the
  // panel and the map are two lists that happen to share a card.
  function linkRowsToPins(listRoot, markers) {
    listRoot.querySelectorAll(".sp-stop").forEach((row) => {
      const entry = markers.get(row.dataset.code);
      if (!entry) return;
      const set = (on) => {
        row.classList.toggle("is-hot", on);
        entry.marker.setIcon(pinIcon(entry.stop, on));
        entry.marker.setZIndex(on ? 5 : 2);
      };
      row.addEventListener("mouseenter", () => set(true));
      row.addEventListener("mouseleave", () => set(false));
      // A tap ANYWHERE in the row used to open the marker's info window —
      // including a tap on the time input, the arrows or the Move select.
      // On iOS that stole focus from the native picker sheet and closed it
      // the instant it appeared. Only bare parts of the row select the pin.
      row.addEventListener("click", (event) => {
        if (event.target.closest("button, select, input, a, label, form")) return;
        google.maps.event.trigger(entry.marker, "click");
      });
      entry.marker.addListener("mouseover", () => set(true));
      entry.marker.addListener("mouseout", () => set(false));
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
      const straight = data.source !== "google" && data.source !== "osrm";
      const path = data.coords.map(([lat, lng]) => ({ lat, lng }));
      new google.maps.Polyline({
        map, path,
        strokeColor: straight ? "#7A7A72" : AM_GREEN,
        strokeOpacity: straight ? 0 : 0.85,
        strokeWeight: straight ? 2 : 4,
        // Dashes are drawn as repeated symbols; a solid line with opacity 0
        // plus dot symbols is how the Maps API does a dashed path.
        icons: straight ? [{
          icon: { path: "M 0,-1 0,1", strokeOpacity: 0.8, strokeWeight: 2, scale: 3 },
          offset: "0", repeat: "12px"
        }] : undefined,
        zIndex: 1
      });
      // A straight line between stops is not a drive, and a map that shows one
      // without saying so is making a claim it cannot support.
      note(mapBox, straight
        ? `Straight hops, not roads — ${data.error || "no router answered."}`
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

  // The probe is above the day cards, so it would otherwise have no
  // autocomplete until a map scrolled into view. mapsReady() is memoised —
  // this is the same single script load, just started sooner. Loading the
  // library is not a billable map load; only `new google.maps.Map` is.
  mapsReady().catch((err) => {
    console.warn("[season-plan] maps unavailable, probe autocomplete off:", err && err.message);
  });

  // ---- Public booking window ---------------------------------------
  //
  // The season gate's opening/closing dates, editable in place. Saved
  // values live on the server's data disk and override seasons.json;
  // "Back to defaults" clears them. The two bounds are independent —
  // clearing one date and saving reverts just that bound.

  const windowForm = el("bookingWindowForm");
  const windowNote = el("bookingWindowNote");
  const windowStatus = el("bookingWindowStatus");
  const windowFrom = el("bookingWindowFrom");
  const windowThrough = el("bookingWindowThrough");

  function prettyYmd(ymd) {
    const [y, m, d] = String(ymd || "").split("-").map(Number);
    if (!y) return ymd;
    return new Date(y, m - 1, d).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
  }

  async function loadBookingWindow() {
    windowNote.textContent = "Loading…";
    windowForm.hidden = true;
    windowStatus.hidden = true;
    try {
      const response = await fetch(`/api/seasons/${seasonSelect.value}/${yearSelect.value}/booking-window`,
        { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error((data.errors || ["Couldn't load the booking window."]).join(" "));
      renderBookingWindow(data);
    } catch (error) {
      windowNote.textContent = error.message;
    }
  }

  function renderBookingWindow(data) {
    const eff = data.effective;
    const custom = Boolean(data.override);
    windowNote.textContent =
      `Customers can book ${prettyYmd(eff.publicBookingFrom)} – ${prettyYmd(eff.publicBookingThrough)}. `
      + `Days outside this window are hidden from the booking page. Trucks are serviceable `
      + `${prettyYmd(data.defaults.serviceableFrom)} – ${prettyYmd(data.defaults.serviceableThrough)}, `
      + `so the window has to stay inside that.`;
    windowFrom.value = eff.publicBookingFrom;
    windowThrough.value = eff.publicBookingThrough;
    windowFrom.min = data.defaults.serviceableFrom;
    windowFrom.max = data.defaults.serviceableThrough;
    windowThrough.min = data.defaults.serviceableFrom;
    windowThrough.max = data.defaults.serviceableThrough;
    windowForm.hidden = false;
    windowStatus.hidden = false;
    windowStatus.textContent = custom
      ? `Set here${data.override.updatedAt ? ` on ${prettyYmd(data.override.updatedAt.slice(0, 10))}` : ""} — `
        + `defaults would be ${prettyYmd(data.defaults.publicBookingFrom)} – ${prettyYmd(data.defaults.publicBookingThrough)}.`
      : "Using the defaults.";
  }

  async function saveBookingWindow(body) {
    const buttons = [el("bookingWindowSave"), el("bookingWindowReset")];
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const response = await fetch(`/api/seasons/${seasonSelect.value}/${yearSelect.value}/booking-window`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error((data.errors || ["Couldn't save."]).join(" "));
      renderBookingWindow(data);
      showToast("Booking window saved.");
    } catch (error) {
      showToast(error.message, "bad");
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  }

  windowForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveBookingWindow({
      publicBookingFrom: windowFrom.value || "",
      publicBookingThrough: windowThrough.value || ""
    });
  });
  el("bookingWindowReset").addEventListener("click", () => {
    saveBookingWindow({ publicBookingFrom: "", publicBookingThrough: "" });
  });

  // ---- Assignment preflight (stage 0, read-only) -------------------

  el("preflightBtn").addEventListener("click", async () => {
    const button = el("preflightBtn");
    const out = el("preflightOut");
    button.disabled = true;
    out.hidden = false;
    out.textContent = "Checking every planned stop…";
    try {
      const response = await fetch(`/api/assignments/${seasonSelect.value}/${yearSelect.value}/preflight`,
        { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error((data.errors || ["Preflight failed."]).join(" "));
      renderPreflight(out, data);
    } catch (error) {
      out.innerHTML = "";
      const p = document.createElement("p");
      p.className = "sp-preflight-bad";
      p.textContent = error.message;
      out.appendChild(p);
    } finally {
      button.disabled = false;
    }
  });

  function renderPreflight(out, data) {
    out.innerHTML = "";
    const s = data.summary;
    const words = data.outcomes || {};

    const head = document.createElement("p");
    head.className = "sp-preflight-summary";
    head.textContent =
      `${s.stops} planned stops · ${s.ready} would be sent`
      + (s.readyPartial ? ` (${s.readyPartial} on one channel only)` : "")
      + (s.settled ? ` · ${s.settled} already booked themselves` : "")
      + ` · ${s.skipped} would be skipped`;
    out.appendChild(head);

    const rows = data.days.flatMap((d) => d.stops);
    const problems = rows.filter((r) => r.outcome === "skipped");
    const partials = rows.filter((r) => r.outcome === "ready" && r.partial);

    // Skips first — they are the action list. Ready rows are the happy
    // majority and listing them all would bury the seven that need a fix.
    if (problems.length) {
      out.appendChild(preflightHeading("Would be skipped — fix or accept before sending"));
      const ul = document.createElement("ul");
      ul.className = "sp-preflight-list";
      for (const r of problems) ul.appendChild(skipRowFor(r, words));
      out.appendChild(ul);
    }

    if (partials.length) {
      out.appendChild(preflightHeading("Deliverable on one channel only"));
      const ul = document.createElement("ul");
      ul.className = "sp-preflight-list";
      for (const r of partials) {
        const li = document.createElement("li");
        li.className = "is-partial";
        li.innerHTML = `<strong>${r.label || r.date}</strong> — `
          + `${escapeHtml(r.address ? r.address.split(",")[0] : r.code)} — `
          + `${r.channels[0] === "email" ? "email only" : "text only"}: `
          + `${escapeHtml(words[r.partial] || r.partial)}`;
        ul.appendChild(li);
      }
      out.appendChild(ul);
    }

    if (!problems.length && !partials.length) {
      const p = document.createElement("p");
      p.className = "sp-preflight-clean";
      p.textContent = "Every planned stop is reachable on both channels. Nothing to fix.";
      out.appendChild(p);
    }
  }

  // One skipped-stop row, shared by the preflight and the assign
  // result. The address links to the property record when we have one —
  // "no zone count" and friends are fixed THERE, so the skip list is
  // the to-do list and each row is one tap from its fix.
  function skipRowFor(r, words) {
    const li = document.createElement("li");
    li.className = "is-skip";
    const who = `${escapeHtml(r.address ? r.address.split(",")[0] : r.code)}`
      + `${r.customerName ? ` (${escapeHtml(r.customerName)})` : ""}`;
    li.innerHTML = `<strong>${r.label || r.date} · ${prettyDate(r.date)}</strong> — `
      + (r.propertyId
        ? `<a href="/admin/property/${encodeURIComponent(r.propertyId)}" target="_blank" rel="noopener">${who}</a>`
        : who)
      + ` — ${escapeHtml(words[r.reason] || r.reason)}`;
    return li;
  }

  function preflightHeading(text) {
    const h = document.createElement("h3");
    h.className = "sp-preflight-h";
    h.textContent = text;
    return h;
  }

  // ---- Assign / undo (stage 2) -------------------------------------
  //
  // Both buttons are two-press: the first press arms and renames the
  // button, the second within 8 seconds fires. A single stray tap on a
  // phone must never book (or delete) a season's appointments.

  function armTwice(button, armedLabel, run) {
    const original = button.textContent;
    let armed = null;
    button.addEventListener("click", async () => {
      if (!armed) {
        button.textContent = armedLabel;
        button.classList.add("is-armed");
        armed = setTimeout(() => {
          button.textContent = original;
          button.classList.remove("is-armed");
          armed = null;
        }, 8000);
        return;
      }
      clearTimeout(armed);
      armed = null;
      button.textContent = original;
      button.classList.remove("is-armed");
      await run();
    });
  }

  async function runAssignAction(action, busyText) {
    const out = el("preflightOut");
    const buttons = [el("preflightBtn"), el("assignBtn"), el("unassignBtn")];
    buttons.forEach((b) => { b.disabled = true; });
    out.hidden = false;
    out.textContent = busyText;
    try {
      const response = await fetch(
        `/api/assignments/${seasonSelect.value}/${yearSelect.value}/${action}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error((data.errors || [`Couldn't ${action}.`]).join(" "));
      if (action === "assign") renderAssignResult(out, data);
      else renderUnassignResult(out, data);
      load();   // day cards show booked state
    } catch (error) {
      out.innerHTML = "";
      const p = document.createElement("p");
      p.className = "sp-preflight-bad";
      p.textContent = error.message;
      out.appendChild(p);
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  }

  armTwice(el("assignBtn"), "Press again to book every ready stop",
    () => runAssignAction("assign", "Creating bookings… nothing is being sent."));
  armTwice(el("unassignBtn"), "Press again to remove untouched assignment bookings",
    () => runAssignAction("unassign", "Removing untouched assignment bookings…"));

  // ---- The blast + cadence status (stage 4) ------------------------
  //
  // The blast REALLY SENDS. Two-press armed like assign/undo, admin-only
  // server-side, and interlocked until the appointment page (stage 5)
  // is live — the server refuses with a plain sentence until then.

  armTwice(el("blastBtn"), "Press again to MESSAGE every assigned customer", async () => {
    const out = el("preflightOut");
    const button = el("blastBtn");
    button.disabled = true;
    out.hidden = false;
    out.textContent = "Sending the assignment blast…";
    try {
      const response = await fetch(`/api/assignments/${seasonSelect.value}/${yearSelect.value}/blast`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error((data.errors || ["The blast failed."]).join(" "));
      out.innerHTML = "";
      const p = document.createElement("p");
      p.className = "sp-preflight-summary";
      p.textContent = `${data.blasted} customers messaged · ${data.alreadyBlasted} were already messaged`
        + ` · ${data.skipped.length} skipped · ${data.errors.length} errors.`;
      out.appendChild(p);
      loadCadenceStatus();
    } catch (error) {
      out.innerHTML = "";
      const p = document.createElement("p");
      p.className = "sp-preflight-bad";
      p.textContent = error.message;
      out.appendChild(p);
    } finally {
      button.disabled = false;
    }
  });

  async function loadCadenceStatus() {
    const line = el("cadenceStatus");
    try {
      const response = await fetch(`/api/assignments/${seasonSelect.value}/${yearSelect.value}/cadence-status`,
        { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) { line.hidden = true; return; }
      const s = data.summary;
      line.hidden = false;
      if (!s.bookings) {
        line.textContent = "No assignment bookings yet — nothing to message.";
      } else {
        line.textContent =
          `${s.bookings} assigned · ${s.blasted} messaged · ${s.responded} responded`
          + (data.appointmentPageReady ? "" : " · sending locked until the appointment page is live");
      }
    } catch { line.hidden = true; }
  }
  loadCadenceStatus();

  function renderAssignResult(out, data) {
    out.innerHTML = "";
    const s = data.summary;
    const words = data.outcomes || {};
    const head = document.createElement("p");
    head.className = "sp-preflight-summary";
    head.textContent =
      `${s.created} appointments booked · ${s.settled} already had their own booking`
      + ` · ${s.skipped} skipped — and no messages were sent.`
      + (data.timesSynced ? ` ${data.timesSynced} existing appointment times re-anchored to the route.` : "");
    out.appendChild(head);

    const rows = data.days.flatMap((d) => d.stops);
    const problems = rows.filter((r) => r.outcome === "skipped");
    if (problems.length) {
      out.appendChild(preflightHeading("Skipped — not booked"));
      const ul = document.createElement("ul");
      ul.className = "sp-preflight-list";
      for (const r of problems) ul.appendChild(skipRowFor(r, words));
      out.appendChild(ul);
    } else {
      const p = document.createElement("p");
      p.className = "sp-preflight-clean";
      p.textContent = "Every eligible stop is now a confirmed appointment.";
      out.appendChild(p);
    }
  }

  function renderUnassignResult(out, data) {
    out.innerHTML = "";
    const s = data.summary;
    const head = document.createElement("p");
    head.className = "sp-preflight-summary";
    head.textContent = s.found === 0
      ? "No assignment bookings exist for this season — nothing to undo."
      : `${s.removed} assignment bookings removed · ${s.kept} kept because someone has touched them.`;
    out.appendChild(head);
    if (data.kept && data.kept.length) {
      out.appendChild(preflightHeading("Kept — changed since assignment"));
      const ul = document.createElement("ul");
      ul.className = "sp-preflight-list";
      for (const k of data.kept) {
        const li = document.createElement("li");
        li.className = "is-partial";
        li.textContent = `${k.bookingId} (${k.code}, ${prettyDate(k.date)}) — ${k.reason.replace(/_/g, " ")}`;
        ul.appendChild(li);
      }
      out.appendChild(ul);
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

  const loadAll = () => { load(); loadBookingWindow(); };
  seasonSelect.addEventListener("change", loadAll);
  yearSelect.addEventListener("change", loadAll);
  loadAll();
})();

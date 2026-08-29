// Warranty claim detail — the tool Patrick works a claim from.
//
// The action picker carries the outcomes the brief names: approve (which
// also raises the repair work order), under review, contact customer,
// return email with questions, book for service call, resolved, denied.
// Picking one opens a confirm panel rather than firing immediately: every
// one of these emails the customer, and two of them (deny, questions)
// require writing to them.
//
// The eighth outcome, `converted`, is deliberately NOT a button here. A
// warranty visit becomes chargeable on the WORK ORDER, by the person who
// attended and can say why — this page only reports it.
//
// Deny and info_requested REQUIRE a note; the server enforces the same
// rule, so this is a courtesy check, not the control.
(function () {
  var STATUS_LABELS = {
    received: "Received",
    under_review: "Under review",
    info_requested: "Info requested",
    contact_customer: "Contacting customer",
    service_booked: "Service call booked",
    approved: "Approved — work order raised",
    resolved: "Resolved",
    denied: "Denied",
    disputed: "Disputed",
    converted: "Converted to paid service call"
  };

  // Per-action copy for the confirm panel. `noteRequired` mirrors the
  // server's NOTE_REQUIRED_STATUSES; `noteLabel` says who the text is
  // for, because "note" means something different on a denial (the
  // customer reads it verbatim) than on a review flip.
  var ACTIONS = {
    approved: {
      title: "Approve claim & raise work order",
      help: "Accepts the claim and creates a service visit at the linked property with the call-out fee waived under warranty. The work order carries this claim number and the prior job it's honouring, so the tech on site knows what they're fixing free of charge.",
      noteLabel: "Optional message to the customer",
      noteRequired: false
    },
    under_review: {
      title: "Mark under review",
      help: "The customer is told their claim is being reviewed against the original work order and invoice.",
      noteLabel: "Optional message to the customer",
      noteRequired: false
    },
    contact_customer: {
      title: "Contact customer",
      help: "Emails the customer that PJL will contact them directly at the first available time.",
      noteLabel: "Optional message to the customer",
      noteRequired: false
    },
    info_requested: {
      title: "Return email with questions",
      help: "Sends your questions with the subject RE: Warranty Claim File Number — their reply threads to it.",
      noteLabel: "Your questions for the customer (required)",
      noteRequired: true
    },
    service_booked: {
      title: "Book for service call",
      help: "Creates a warranty booking link tagged to this claim and emails it to the customer so they can pick a slot against real availability.",
      noteLabel: "Optional message to include with the booking link",
      noteRequired: false
    },
    resolved: {
      title: "Mark resolved",
      help: "Closes the claim. The customer is told it has been resolved.",
      noteLabel: "Optional closing message",
      noteRequired: false
    },
    denied: {
      title: "Deny warranty claim",
      help: "The customer receives this explanation verbatim, plus the option to dispute (which requires them to accept a service-call fee condition).",
      noteLabel: "Why this claim is denied — the customer reads this (required)",
      noteRequired: true
    }
  };

  var claimId = decodeURIComponent(
    (location.pathname.match(/^\/admin\/warranty-claim\/([^/]+)\/?$/) || [])[1] || ""
  );

  var state = { claim: null, context: null, pendingAction: null };

  var loadingEl = document.getElementById("wcdLoading");
  var errorEl   = document.getElementById("wcdError");
  var contentEl = document.getElementById("wcdContent");

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function fmtDateTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" });
  }

  function fmtWait(hours) {
    if (hours == null) return "—";
    if (hours < 24) return hours + "h";
    var days = Math.floor(hours / 24);
    var rem = hours % 24;
    return days + "d" + (rem ? " " + rem + "h" : "");
  }

  function money(n) {
    return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(Number(n) || 0);
  }

  function showError(message) {
    loadingEl.hidden = true;
    contentEl.hidden = true;
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  // ---- Rendering -------------------------------------------------------

  function renderHeader(claim) {
    $("wcdNumber").textContent = claim.id;
    $("wcdHeadMeta").textContent =
      "Filed " + fmtDateTime(claim.createdAt) + " · Last moved " + fmtDateTime(claim.lastStatusAt);

    var badge = $("wcdBadge");
    badge.textContent = STATUS_LABELS[claim.status] || claim.status;
    badge.dataset.status = claim.status;

    $("wcdWait").textContent = claim.open ? "Waiting " + fmtWait(claim.hoursSinceStatus) : "Closed";

    var banner = $("wcdStaleBanner");
    if (claim.stale) {
      $("wcdStaleText").textContent =
        "It has been " + fmtWait(claim.hoursSinceStatus) + " since this claim last moved. We promised the customer 24 hours.";
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }

  function renderCustomer(claim) {
    $("wcdName").textContent = claim.claimant.name || "—";
    $("wcdAddress").textContent = claim.claimant.address || "—";
    $("wcdInvoiceRef").textContent = claim.invoiceRef || "—";

    var phoneCell = $("wcdPhone");
    phoneCell.textContent = "";
    if (claim.claimant.phone) {
      var tel = document.createElement("a");
      tel.href = "tel:" + claim.claimant.phone.replace(/[^\d+]/g, "");
      tel.textContent = claim.claimant.phone;
      phoneCell.appendChild(tel);
    } else { phoneCell.textContent = "—"; }

    var emailCell = $("wcdEmail");
    emailCell.textContent = "";
    if (claim.claimant.email) {
      var mail = document.createElement("a");
      // Pre-threaded subject so a manual reply carries the file number too.
      mail.href = "mailto:" + claim.claimant.email +
        "?subject=" + encodeURIComponent("RE: Warranty Claim File Number — " + claim.id);
      mail.textContent = claim.claimant.email;
      emailCell.appendChild(mail);
    } else { emailCell.textContent = "—"; }
  }

  function renderClaimBody(claim) {
    $("wcdDescription").textContent = claim.description || "—";

    var wrap = $("wcdFilesWrap");
    var list = $("wcdFiles");
    list.textContent = "";
    if (claim.attachments && claim.attachments.length) {
      claim.attachments.forEach(function (att) {
        var li = el("li", "wcd-file");
        var a = document.createElement("a");
        a.href = "/api/warranty-claims/" + encodeURIComponent(claim.id) + "/file/" + encodeURIComponent(att.n);
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = (att.kind === "invoice" ? "📄 Invoice — " : "📷 ") + (att.filename || ("File " + att.n));
        li.appendChild(a);
        li.appendChild(el("span", "wcd-file-size", Math.round((att.bytes || 0) / 1000) + " KB"));
        list.appendChild(li);
      });
      wrap.hidden = false;
    } else {
      wrap.hidden = true;
    }
  }

  // The repair work order raised by approving this claim, with its LIVE
  // waiver state. If a tech lifted the waiver on site this card is where
  // Patrick sees the visit is now chargeable.
  function renderWorkOrder(claim, context) {
    var card = $("wcdWorkOrderCard");
    var wo = context && context.workOrder;
    if (!wo) {
      if (context && context.workOrderMissing) {
        $("wcdWorkOrderMeta").textContent =
          "Work order " + context.workOrderMissing + " was raised for this claim but no longer exists.";
        $("wcdWoWaiver").textContent = "";
        $("wcdWorkOrderLink").hidden = true;
        card.hidden = false;
        return;
      }
      card.hidden = true;
      return;
    }

    $("wcdWorkOrderMeta").textContent = [
      wo.id,
      (wo.status || "").replace(/_/g, " "),
      wo.address,
      wo.scheduledFor ? "scheduled " + fmtDateTime(wo.scheduledFor) : "",
      wo.locked ? "signed & locked" : ""
    ].filter(Boolean).join(" · ");

    var box = $("wcdWoWaiver");
    box.textContent = "";
    if (wo.converted) {
      var conv = el("div", "wcd-wo-converted");
      conv.appendChild(el("strong", null, "Converted to a chargeable service call"));
      conv.appendChild(el("span", "wcd-sub",
        fmtDateTime(wo.converted.at) + " · by " + (wo.converted.by || "—")));
      conv.appendChild(el("span", "wcd-wo-reason", wo.converted.reason || ""));
      box.appendChild(conv);
    } else if (wo.feeWaived) {
      box.appendChild(el("div", "wcd-wo-waived",
        "Call-out fee waived under warranty — this visit is free of charge."));
    } else {
      // Waiver gone with no conversion record: only reachable by editing
      // the WO's waiver directly on a claim-raised WO. Flag it rather
      // than rendering a blank space.
      box.appendChild(el("div", "wcd-wo-converted",
        "The warranty waiver is no longer on this work order, but no conversion reason was recorded. Check the work order history."));
    }

    var linkEl = $("wcdWorkOrderLink");
    linkEl.hidden = false;
    linkEl.href = "/admin/work-order/" + encodeURIComponent(wo.id);
    card.hidden = false;
  }

  function renderDispute(claim) {
    var card = $("wcdDisputeCard");
    if (!claim.dispute) { card.hidden = true; return; }
    $("wcdDisputeMeta").textContent = "Disputed " + fmtDateTime(claim.dispute.raisedAt);
    $("wcdDenialReason").textContent = (claim.denial && claim.denial.reason) || "—";
    $("wcdDisputeReason").textContent = claim.dispute.reason || "(no reason given)";
    card.hidden = false;
  }

  function renderHistory(claim) {
    var list = $("wcdHistory");
    list.textContent = "";
    (claim.history || []).slice().reverse().forEach(function (h) {
      var li = el("li", "wcd-history-item");
      li.appendChild(el("span", "wcd-history-label",
        (h.from ? (STATUS_LABELS[h.from] || h.from) + " → " : "") + (STATUS_LABELS[h.to] || h.to || h.action)));
      li.appendChild(el("span", "wcd-history-meta",
        fmtDateTime(h.ts) + " · by " + (h.by || "system") + (h.notified ? " · customer emailed" : "")));
      if (h.note) li.appendChild(el("span", "wcd-history-note", h.note));
      list.appendChild(li);
    });
  }

  function renderCrossCheck(claim, context) {
    var link = claim.link || {};
    var conf = link.confidence || "none";
    var confEl = $("wcdConfidence");
    confEl.textContent = conf === "strong" ? "Strong match — invoice and customer agree"
                       : conf === "partial" ? "Partial match — verify before deciding"
                       : "No match found in the CRM";
    confEl.className = "wcd-crosscheck-conf wcd-conf--" + conf;

    $("wcdUnverified").hidden = (link.matchedBy || []).indexOf("invoice_id_unverified") === -1;

    var custCell = $("wcdMatchCustomer");
    custCell.textContent = "";
    if (context && context.customer) {
      var ca = document.createElement("a");
      ca.href = "/admin/customer/" + encodeURIComponent(context.customer.id);
      ca.textContent = context.customer.name || context.customer.id;
      custCell.appendChild(ca);
    } else { custCell.textContent = "No match"; }

    var propCell = $("wcdMatchProperty");
    propCell.textContent = "";
    if (context && context.property) {
      var pa = document.createElement("a");
      pa.href = "/admin/property/" + encodeURIComponent(context.property.id);
      pa.textContent = context.property.address || context.property.id;
      propCell.appendChild(pa);
    } else if ((link.matchedBy || []).indexOf("property_ambiguous") !== -1) {
      propCell.textContent = "Several properties on this customer — pick one manually";
    } else { propCell.textContent = "No match"; }

    var invCell = $("wcdMatchInvoice");
    invCell.textContent = "";
    if (context && context.invoice) {
      var ia = document.createElement("a");
      ia.href = "/admin/invoice/" + encodeURIComponent(context.invoice.id);
      ia.textContent = context.invoice.id + " · " + money(context.invoice.total) + " · " + fmtDate(context.invoice.issuedAt);
      invCell.appendChild(ia);
    } else { invCell.textContent = "No match"; }

    $("wcdMatchedBy").textContent = (link.matchedBy || []).join(", ") || "nothing";
  }

  function renderWarranty(claim) {
    var box = $("wcdWarranty");
    box.textContent = "";
    var w = (claim.link && claim.link.warranty) || null;

    if (!w) {
      box.appendChild(el("p", "wcd-warranty-state wcd-warranty-state--unknown",
        "No warranty window could be computed — no matching work order or service record was found."));
      return;
    }
    if (w.active === true) {
      box.appendChild(el("p", "wcd-warranty-state wcd-warranty-state--in", "In warranty"));
    } else if (w.active === false) {
      box.appendChild(el("p", "wcd-warranty-state wcd-warranty-state--out", "Outside the warranty window"));
    } else {
      box.appendChild(el("p", "wcd-warranty-state wcd-warranty-state--unknown",
        "Undetermined" + (w.unknownReason ? " (" + w.unknownReason.replace(/_/g, " ") + ")" : "")));
    }

    var dl = el("dl", "wcd-dl wcd-dl--tight");
    function row(label, value) {
      var d = document.createElement("div");
      d.appendChild(el("dt", null, label));
      d.appendChild(el("dd", null, value));
      dl.appendChild(d);
    }
    row("Work type", w.workOrderType || "—");
    row("Term", w.months ? w.months + " months" : "—");
    row("Completed", fmtDate(w.completedAt));
    row("Expires", fmtDate(w.expiresAt));
    row("Source", (w.source || "").replace(/_/g, " ") || "—");
    box.appendChild(dl);
  }

  function renderSideLists(context) {
    var srCard = $("wcdHistoryCard");
    var srList = $("wcdServiceRecords");
    srList.textContent = "";
    if (context && context.serviceRecords && context.serviceRecords.length) {
      context.serviceRecords.forEach(function (r) {
        var li = el("li", "wcd-service-record");
        li.appendChild(el("strong", null, fmtDate(r.completedAt) + " · " + (r.woType || "").replace(/_/g, " ")));
        if (r.summary) li.appendChild(el("span", "wcd-sub", r.summary));
        if (r.warrantyExpiresAt) {
          li.appendChild(el("span", "wcd-sub", "Warranty to " + fmtDate(r.warrantyExpiresAt)));
        }
        srList.appendChild(li);
      });
      srCard.hidden = false;
    } else { srCard.hidden = true; }

    var invCard = $("wcdOtherInvoicesCard");
    var invList = $("wcdOtherInvoices");
    invList.textContent = "";
    if (context && context.otherInvoices && context.otherInvoices.length) {
      context.otherInvoices.forEach(function (inv) {
        var li = document.createElement("li");
        var a = document.createElement("a");
        a.href = "/admin/invoice/" + encodeURIComponent(inv.id);
        a.textContent = inv.id + " · " + money(inv.total) + " · " + fmtDate(inv.issuedAt);
        li.appendChild(a);
        invList.appendChild(li);
      });
      invCard.hidden = false;
    } else { invCard.hidden = true; }
  }

  function render(payload) {
    state.claim = payload.claim;
    state.context = payload.context;

    renderHeader(payload.claim);
    renderCustomer(payload.claim);
    renderClaimBody(payload.claim);
    renderDispute(payload.claim);
    renderHistory(payload.claim);
    renderWorkOrder(payload.claim, payload.context);
    renderCrossCheck(payload.claim, payload.context);
    renderWarranty(payload.claim);
    renderSideLists(payload.context);

    var statusLink = $("wcdStatusLink");
    if (payload.statusUrl) {
      statusLink.href = payload.statusUrl;
      statusLink.hidden = false;
    }

    // One claim, one repair work order. Once it exists, approving again
    // would 409 server-side — hide the button rather than offering an
    // action that cannot succeed.
    var approveBtn = document.querySelector('[data-action="approved"]');
    if (approveBtn) approveBtn.hidden = Boolean(payload.claim.workOrderId);

    loadingEl.hidden = true;
    contentEl.hidden = false;
  }

  // ---- Actions ---------------------------------------------------------

  function openConfirm(action) {
    var spec = ACTIONS[action];
    if (!spec) return;
    state.pendingAction = action;
    $("wcdConfirmTitle").textContent = spec.title;
    $("wcdConfirmHelp").textContent = spec.help;
    $("wcdNoteLabel").textContent = spec.noteLabel;
    $("wcdNote").value = "";
    $("wcdNotify").checked = true;
    $("wcdActionErrors").hidden = true;
    $("wcdResult").hidden = true;
    $("wcdConfirm").hidden = false;
    $("wcdConfirm").scrollIntoView({ behavior: "smooth", block: "center" });
    $("wcdNote").focus();

    document.querySelectorAll("[data-action]").forEach(function (btn) {
      btn.classList.toggle("is-selected", btn.getAttribute("data-action") === action);
    });
  }

  function closeConfirm() {
    state.pendingAction = null;
    $("wcdConfirm").hidden = true;
    document.querySelectorAll("[data-action]").forEach(function (btn) {
      btn.classList.remove("is-selected");
    });
  }

  function showActionError(message) {
    var box = $("wcdActionErrors");
    box.textContent = message;
    box.hidden = false;
  }

  function showResult(message, tone) {
    var box = $("wcdResult");
    box.textContent = message;
    box.className = "wcd-result wcd-result--" + (tone || "ok");
    box.hidden = false;
  }

  async function submitAction() {
    var action = state.pendingAction;
    var spec = ACTIONS[action];
    if (!spec) return;

    var note = $("wcdNote").value.trim();
    var notify = $("wcdNotify").checked;

    if (spec.noteRequired && note.length < 10) {
      showActionError("This action sends your message to the customer, so it can't be blank (at least 10 characters).");
      return;
    }

    var btn = $("wcdConfirmBtn");
    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = "Working…";

    try {
      // "Book for service call" has its own route: it mints a booking
      // session before moving the status, so it can't be expressed as a
      // plain PATCH.
      // Two actions do more than flip a status and so have their own
      // routes: booking mints a session, and approving creates the repair
      // work order. Everything else is a plain PATCH.
      var ownRoute = action === "service_booked" ? "book"
                   : action === "approved" ? "approve"
                   : null;
      var url = ownRoute
        ? "/api/warranty-claims/" + encodeURIComponent(claimId) + "/" + ownRoute
        : "/api/warranty-claims/" + encodeURIComponent(claimId);
      var method = ownRoute ? "POST" : "PATCH";
      var body = ownRoute
        ? { note: note, notifyCustomer: notify }
        : { status: action, note: note, notifyCustomer: notify };

      var res = await fetch(url, {
        method: method,
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(body)
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) {
        throw new Error((data.errors && data.errors[0]) || ("Request failed (" + res.status + ")."));
      }

      closeConfirm();

      // Re-fetch rather than patching from the response: the detail view
      // rebuilds its cross-check context on every read, and a stale
      // sidebar next to a fresh status is worse than a second round trip.
      await load({ silent: true });

      var msg = spec.title + " — done.";
      if (data.workOrder && data.workOrder.id) {
        msg += " Work order " + data.workOrder.id + " raised, call-out fee waived under warranty.";
      }
      if (data.bookingUrl) msg += " Booking link: " + data.bookingUrl;
      if (notify) {
        // The server reports the send result separately from the status
        // change on purpose: a mail failure must not look like the status
        // change failed, and vice versa.
        msg += data.emailed && data.emailed.ok
          ? " Customer emailed."
          : " ⚠️ The status changed but the customer email did NOT send" +
            (data.emailed && data.emailed.error ? " (" + data.emailed.error + ")" : "") +
            " — contact them another way.";
      } else {
        msg += " Customer was not emailed.";
      }
      showResult(msg, (notify && !(data.emailed && data.emailed.ok)) ? "warn" : "ok");
    } catch (err) {
      showActionError(String(err && err.message ? err.message : "Something went wrong."));
      btn.disabled = false;
      btn.textContent = original;
      return;
    }
    btn.disabled = false;
    btn.textContent = original;
  }

  async function load(opts) {
    var silent = opts && opts.silent;
    if (!claimId) { showError("No claim number in the URL."); return; }
    if (!silent) { loadingEl.hidden = false; }
    try {
      var res = await fetch("/api/warranty-claims/" + encodeURIComponent(claimId), { cache: "no-store" });
      if (res.status === 401 || res.status === 403) { location.href = "/login"; return; }
      var data = await res.json();
      if (!res.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Claim not found.");
      render(data);
    } catch (err) {
      showError(String(err && err.message ? err.message : "Could not load this claim."));
    }
  }

  // ---- Wiring ----------------------------------------------------------

  var picker = $("wcdActionPicker");
  if (picker) {
    picker.addEventListener("click", function (event) {
      var btn = event.target.closest("[data-action]");
      if (!btn) return;
      openConfirm(btn.getAttribute("data-action"));
    });
  }
  var cancelBtn = $("wcdCancelBtn");
  if (cancelBtn) cancelBtn.addEventListener("click", closeConfirm);
  var confirmBtn = $("wcdConfirmBtn");
  if (confirmBtn) confirmBtn.addEventListener("click", submitAction);

  var recheckBtn = $("wcdRecheckBtn");
  if (recheckBtn) {
    recheckBtn.addEventListener("click", async function () {
      recheckBtn.disabled = true;
      var original = recheckBtn.textContent;
      recheckBtn.textContent = "Checking…";
      try {
        var res = await fetch("/api/warranty-claims/" + encodeURIComponent(claimId) + "/recheck", { method: "POST" });
        var data = await res.json();
        if (!res.ok || !data.ok) throw new Error("Re-check failed.");
        render({ claim: data.claim, context: data.context, statusUrl: $("wcdStatusLink").href });
      } catch (err) {
        showResult("Couldn't re-run the cross-check.", "warn");
      }
      recheckBtn.disabled = false;
      recheckBtn.textContent = original;
    });
  }

  load();
})();

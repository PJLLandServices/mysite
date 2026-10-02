"use strict";

// The project Overview (2026-10-02) — stage 6 of the Project Workspace, a
// read-only command centre over the five tabs before it.
//
// It does no business arithmetic. Every figure below is COPIED from the
// read model of the tab it summarises — the same object that tab's own
// GET route returns — so the Overview cannot disagree with the tab:
//
//   tasks         projects.computeProjectMetrics        (GET …/metrics)
//   dailyRecords  daily-records describeProject         (GET …/daily-records)
//   materials     project-materials describeProject     (GET …/materials)
//   changeOrders  change-orders-view describeChangeOrders (GET …/change-orders)
//   financials    financials-view describeFinancials    (GET …/financials)
//   status        projects.completionPreflight blockers + next-action.js
//
// Where this file chooses, it chooses WHICH rows to show (the first few of
// a list the tab already ordered) — never what a number is. Server routes
// build the inputs with the same builder functions their tabs use
// (server.js project*Model).

const { nextAction, BLOCKER_TAB } = require("./next-action");
const financialsView = require("./financials-view");

const STAGE_LABELS = { planning: "Planning", active: "Active", complete: "Complete", archived: "Archived" };

// How many rows of a list the Overview shows before "see the tab". A
// decision screen, not a second copy of the records.
const PREVIEW_ROWS = 3;

function tabHref(projectId, tab) {
  return `/app/projects/${encodeURIComponent(projectId)}/${tab}`;
}

function describeOverview({
  project,
  metrics,
  dailyRecords,
  materials,
  changeOrders,
  financials,
  preflight,
  linkedQuote = null,
  design = null
}) {
  const id = project.id;
  const blockers = (preflight && preflight.blockers) || [];
  const billing = financialsView.billingSummary(financials);

  // ── Days ──────────────────────────────────────────────────────────
  // The last LOGGED day is the Daily Records tab's own row for it.
  const latestDay = dailyRecords.lastWorkWoId
    ? (dailyRecords.days || []).find((d) => d.woId === dailyRecords.lastWorkWoId) || null
    : null;
  // The journal, newest first — the latest note or update anyone logged.
  const latestEntry = (project.journalEntries || [])
    .slice()
    .sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")))[0] || null;
  // Problems still needing attention, in the tab's own order (newest
  // discovery first); `needsAttention` is project-problems' one rule.
  const attention = (dailyRecords.problems || []).filter((p) => p.needsAttention);

  return {
    projectId: id,

    status: {
      stage: project.status || "planning",
      stageLabel: STAGE_LABELS[project.status] || STAGE_LABELS.planning,
      // The Tasks tab's figure (computeProjectMetrics).
      percentComplete: metrics.percentComplete,
      hasTasks: metrics.totalTasks > 0,
      nextAction: nextAction({
        project,
        progress: metrics,
        quote: linkedQuote,
        invoice: billing.actionInvoice,
        design,
        blockers
      }),
      // What the completion route itself refuses on — the same list the
      // Change Orders and Financials tabs show their own slices of.
      blockers: blockers.map((b) => ({
        key: b.key,
        message: b.message,
        tab: BLOCKER_TAB[b.key] || null,
        href: BLOCKER_TAB[b.key] ? tabHref(id, BLOCKER_TAB[b.key]) : `/admin/project/${encodeURIComponent(id)}`
      }))
    },

    tasks: {
      total: metrics.totalTasks,
      done: metrics.doneTasks,
      open: metrics.openTasks,
      archived: metrics.archivedTasks,
      percentComplete: metrics.percentComplete,
      // The task record has no due date and no "blocked" status, so the
      // Overview cannot say a task is overdue or blocked — and says so
      // rather than implying "none".
      tracksDueDates: false,
      href: tabHref(id, "tasks")
    },

    dailyRecords: {
      daysLogged: dailyRecords.daysLogged,
      lastWorkDate: dailyRecords.lastWorkDate,
      totalPersonHours: dailyRecords.totalPersonHours,
      correctedDays: dailyRecords.correctedDays,
      latestDay: latestDay ? {
        woId: latestDay.woId,
        workDate: latestDay.workDate,
        personHours: latestDay.personHours,
        hoursCorrected: latestDay.hoursCorrected,
        openSession: latestDay.openSession,
        notes: latestDay.notes
      } : null,
      openProblems: dailyRecords.openProblems,
      problems: attention.slice(0, PREVIEW_ROWS).map((p) => ({
        id: p.id, title: p.title, status: p.status, discoveredWorkDate: p.discovery.workDate
      })),
      latestEntry: latestEntry ? { ts: latestEntry.ts, by: latestEntry.by || null, note: latestEntry.note || "" } : null,
      href: tabHref(id, "records")
    },

    materials: {
      // The tab's own summary, field for field. There is deliberately no
      // project-wide "required" or "ordered" figure here — the Materials
      // tab keeps required per list (lists can disagree) and does not
      // model ordered quantities at all.
      listCount: materials.summary.listCount,
      skuCount: materials.summary.skuCount,
      receivedUnits: materials.summary.receivedUnits,
      usedUnits: materials.summary.usedUnits,
      balanceUnits: materials.summary.balanceUnits,
      exceptionCount: materials.summary.exceptionCount,
      exceptions: (materials.exceptions || []).slice(0, PREVIEW_ROWS).map((e) => ({
        kind: e.kind, sku: e.sku || null, name: e.name || null, detail: e.detail || ""
      })),
      href: tabHref(id, "materials")
    },

    changeOrders: {
      total: changeOrders.summary.total,
      open: changeOrders.summary.open,
      awaitingOffice: changeOrders.summary.awaitingOffice,
      awaitingCustomer: changeOrders.summary.awaitingCustomer,
      awaitingSignature: changeOrders.summary.awaitingSignature,
      signed: changeOrders.summary.signed,
      // The signed agreement and any unsigned revision —
      // projects.describeAgreement, through the tab's model.
      agreement: {
        governing: changeOrders.agreement.governing,
        pending: changeOrders.agreement.pending,
        netChangeTotal: changeOrders.agreement.netChangeTotal
      },
      holds: changeOrders.holds,
      billingBlocked: changeOrders.billingBlocked,
      href: tabHref(id, "changes")
    },

    financials: {
      billingMode: financials.billingMode,
      billingModeLabel: financials.billingModeLabel,
      contract: financials.contract,
      pendingRevision: financials.pendingRevision,
      totals: financials.totals,
      deposit: financials.deposit,
      reconciliation: financials.reconciliation,
      holds: financials.holds,
      // The header's Billing line — the same billingSummary.
      billing: { kind: billing.kind, hint: billing.hint },
      href: tabHref(id, "financials")
    }
  };
}

module.exports = { describeOverview, STAGE_LABELS, PREVIEW_ROWS };

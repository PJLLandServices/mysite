// Projects index — Phase 2.
// Card list of every project. Reuses the material-lists index pattern
// (filter pills, search, "+ New" inline form, card layout). Card shows
// a chip with WO count and a chip with attached material-list count
// (the latter requires a follow-up fetch — done lazily after card render).

const els = {
  container: document.getElementById("projectsContainer"),
  empty: document.getElementById("projectsEmpty"),
  newButton: document.getElementById("newProjectButton"),
  newForm: document.getElementById("newProjectForm"),
  newName: document.getElementById("newProjectName"),
  newCustomerName: document.getElementById("newProjectCustomerName"),
  newCustomerEmail: document.getElementById("newProjectCustomerEmail"),
  newAddress: document.getElementById("newProjectAddress"),
  newDescription: document.getElementById("newProjectDescription"),
  newError: document.getElementById("newProjectError"),
  newSave: document.getElementById("newProjectSave"),
  newCancel: document.getElementById("newProjectCancel"),
  search: document.getElementById("projectSearch"),
  includeArchived: document.getElementById("includeArchived"),
  filterButtons: document.querySelectorAll("[data-status-filter]")
};

const STATUS_LABELS = {
  planning: "Planning",
  active: "Active",
  complete: "Complete",
  archived: "Archived"
};

let currentStatus = "";
let cachedProjects = [];
// Cached material-list counts keyed by projectId. Filled by a single
// /api/material-lists fetch after projects render so the cards can show
// "3 lists" without N+1 round-trips.
let mlCountByProject = new Map();

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
}

async function loadProjects() {
  const params = new URLSearchParams();
  if (currentStatus) params.set("status", currentStatus);
  if (els.includeArchived.checked) params.set("includeArchived", "1");
  const r = await fetch(`/api/projects?${params.toString()}`, { cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  cachedProjects = (data.ok && Array.isArray(data.projects)) ? data.projects : [];
  // Fetch material-list counts in one shot. Includes archived so the chip
  // doesn't lie when the user has archived lists.
  try {
    const mlR = await fetch("/api/material-lists?includeArchived=1", { cache: "no-store" });
    const mlData = await mlR.json().catch(() => ({}));
    const lists = (mlData.ok && Array.isArray(mlData.lists)) ? mlData.lists : [];
    mlCountByProject = new Map();
    for (const ml of lists) {
      if (ml.parentType === "project" && ml.parentId) {
        mlCountByProject.set(ml.parentId, (mlCountByProject.get(ml.parentId) || 0) + 1);
      }
    }
  } catch {
    mlCountByProject = new Map();
  }
  renderProjects();
}

function applySearch(items) {
  const q = els.search.value.trim().toLowerCase();
  if (!q) return items;
  return items.filter((p) => {
    const haystack = [p.id, p.name, p.customerName, p.customerEmail, p.address, p.description].map((v) => String(v || "").toLowerCase()).join(" ");
    return haystack.includes(q);
  });
}

function renderProjects() {
  const items = applySearch(cachedProjects);
  if (!items.length) {
    els.container.innerHTML = "";
    els.empty.hidden = false;
    return;
  }
  els.empty.hidden = true;
  els.container.innerHTML = items.map((p) => {
    const woCount = (p.workOrderIds || []).length;
    const mlCount = mlCountByProject.get(p.id) || 0;
    const customerLine = p.customerName || p.customerEmail || "—";
    const addressLine = p.address ? ` &middot; ${escapeHtml(p.address)}` : "";
    return `
      <li class="ml-card${p.status === "archived" ? " is-archived" : ""}">
        <a class="ml-card-link" href="/admin/project/${encodeURIComponent(p.id)}">
          <div class="ml-card-head">
            <h3 class="ml-card-name">${escapeHtml(p.name || "(untitled project)")}</h3>
            <span class="ml-card-id">${escapeHtml(p.id)}</span>
            <span class="proj-status proj-status--${escapeHtml(p.status)}">${escapeHtml(STATUS_LABELS[p.status] || p.status)}</span>
          </div>
          <div class="ml-card-meta">
            <strong>${escapeHtml(customerLine)}</strong>${addressLine}
            <br>Updated ${escapeHtml(fmtDate(p.updatedAt))}${p.startedAt ? ` &middot; active since ${escapeHtml(fmtDate(p.startedAt))}` : ""}
          </div>
          <div class="proj-card-chips">
            <span class="proj-chip">
              <span class="proj-chip-num ${woCount === 0 ? "proj-chip-num--zero" : ""}">${woCount}</span>
              ${woCount === 1 ? "work order" : "work orders"}
            </span>
            <span class="proj-chip">
              <span class="proj-chip-num ${mlCount === 0 ? "proj-chip-num--zero" : ""}">${mlCount}</span>
              ${mlCount === 1 ? "material list" : "material lists"}
            </span>
            ${p.sourceQuoteId ? `<span class="proj-chip">from ${escapeHtml(p.sourceQuoteId)}</span>` : ""}
          </div>
        </a>
      </li>
    `;
  }).join("");
}

function openNewForm() {
  els.newError.hidden = true;
  els.newError.textContent = "";
  els.newForm.hidden = false;
  els.newForm.scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => els.newName.focus(), 200);
}
function closeNewForm() {
  els.newForm.hidden = true;
  els.newForm.reset();
  els.newError.hidden = true;
}
async function saveNew(event) {
  event.preventDefault();
  const name = els.newName.value.trim();
  if (!name) {
    els.newError.textContent = "Project name is required.";
    els.newError.hidden = false;
    els.newName.focus();
    return;
  }
  els.newSave.disabled = true;
  try {
    const r = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        customerName: els.newCustomerName.value,
        customerEmail: els.newCustomerEmail.value,
        address: els.newAddress.value,
        description: els.newDescription.value
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      els.newError.textContent = (data.errors && data.errors[0]) || `HTTP ${r.status}`;
      els.newError.hidden = false;
      return;
    }
    location.href = `/admin/project/${encodeURIComponent(data.project.id)}`;
  } catch (err) {
    els.newError.textContent = err.message || "Couldn't create project.";
    els.newError.hidden = false;
  } finally {
    els.newSave.disabled = false;
  }
}

// Event wiring
els.newButton.addEventListener("click", openNewForm);
els.newCancel.addEventListener("click", closeNewForm);
els.newForm.addEventListener("submit", saveNew);
els.search.addEventListener("input", () => renderProjects());
els.includeArchived.addEventListener("change", loadProjects);
els.filterButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    currentStatus = btn.dataset.statusFilter || "";
    els.filterButtons.forEach((b) => b.classList.toggle("is-active", b === btn));
    loadProjects();
  });
});

loadProjects();

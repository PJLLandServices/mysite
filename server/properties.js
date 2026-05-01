// Properties index — list every property in the CRM with quick-filter
// search. Click a card to open the property profile editor.

const grid = document.getElementById("propertiesGrid");
const empty = document.getElementById("propertiesEmpty");
const search = document.getElementById("propertySearch");
const countEl = document.getElementById("propertiesCount");
const logoutButton = document.getElementById("logoutButton");

let properties = [];

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function searchableProperty(p) {
  return [
    p.customerName,
    p.customerEmail,
    p.customerPhone,
    p.address,
    p.system?.controllerLocation,
    p.system?.controllerBrand
  ].join(" ").toLowerCase();
}

function render() {
  const query = search.value.trim().toLowerCase();
  const filtered = query
    ? properties.filter((p) => searchableProperty(p).includes(query))
    : properties;

  countEl.textContent = filtered.length === properties.length
    ? `${properties.length} ${properties.length === 1 ? "property" : "properties"}`
    : `${filtered.length} of ${properties.length}`;

  grid.innerHTML = "";
  if (!filtered.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  filtered.forEach((p) => {
    const link = document.createElement("a");
    link.href = `/admin/property/${encodeURIComponent(p.id)}`;
    link.className = "property-card";
    const zoneCount = (p.system?.zones || []).length;
    const valveBoxCount = (p.system?.valveBoxes || []).length;
    const bookingCount = (p.leadIds || []).length;
    link.innerHTML = `
      <strong>${escapeHtml(p.customerName) || "Unnamed customer"}</strong>
      <span class="property-card-address">${escapeHtml(p.address) || "(no address on file)"}</span>
      <span class="property-card-email">${escapeHtml(p.customerEmail) || "—"}</span>
      <div class="property-card-stats">
        <span><strong>${zoneCount}</strong> zone${zoneCount === 1 ? "" : "s"}</span>
        <span><strong>${valveBoxCount}</strong> valve box${valveBoxCount === 1 ? "" : "es"}</span>
        <span><strong>${bookingCount}</strong> booking${bookingCount === 1 ? "" : "s"}</span>
      </div>
    `;
    grid.appendChild(link);
  });
}

search.addEventListener("input", render);

logoutButton.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.assign("/login");
});

async function init() {
  try {
    const response = await fetch("/api/properties", { cache: "no-store" });
    const data = await response.json();
    properties = (data.ok ? data.properties : []) || [];
    // Most-recently-updated first.
    properties.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    render();
  } catch {
    grid.innerHTML = `<p style="color:#a92e2e;">Couldn't load properties. Refresh the page.</p>`;
  }
}

init();

// /admin/users — admin-only per-user account management.
//
// Calls /api/users (GET/POST/PATCH/DELETE) and /api/users/:id/reset-password.
// The 403 fallback for techs is handled server-side; if a tech gets here
// somehow they'll see "Admin access is required" from the API and an
// empty table.

const usersBody = document.getElementById("usersBody");
const usersStatus = document.getElementById("usersStatus");
const addBtn = document.getElementById("addUserButton");
const modal = document.getElementById("userModal");
const modalTitle = document.getElementById("userModalTitle");
const form = document.getElementById("userForm");
const formError = document.getElementById("userFormError");
const cancelBtn = document.getElementById("userCancelButton");
const passwordField = document.getElementById("passwordField");
const logoutBtn = document.getElementById("logoutButton");

let currentUsers = [];
let me = null;

function setStatus(text, kind = "info") {
  usersStatus.textContent = text || "";
  usersStatus.style.color = kind === "error" ? "#8A1F0F" : "#1B4D2E";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });
}

function rowHtml(user) {
  const isSelf = me && me.id === user.id;
  const statusBadge = user.disabled
    ? `<span style="padding:3px 8px; border-radius:999px; background:#F4DAD3; color:#8A1F0F; font-size:12px;">Disabled</span>`
    : `<span style="padding:3px 8px; border-radius:999px; background:#D6EADA; color:#1B4D2E; font-size:12px;">Active</span>`;
  const roleBadge = user.role === "admin"
    ? `<span style="padding:3px 8px; border-radius:999px; background:#1B4D2E; color:#fff; font-size:12px;">Admin</span>`
    : `<span style="padding:3px 8px; border-radius:999px; background:#E07B24; color:#fff; font-size:12px;">Tech</span>`;
  const toggleLabel = user.disabled ? "Enable" : "Disable";
  return `
    <tr data-id="${escapeHtml(user.id)}" style="border-top:1px solid #ECEAE0;">
      <td style="padding:12px; font-family:monospace; font-size:13px;">${escapeHtml(user.id)}</td>
      <td style="padding:12px;">${escapeHtml(user.name)}${isSelf ? ' <span style="font-size:11px; color:#888;">(you)</span>' : ""}</td>
      <td style="padding:12px;">${escapeHtml(user.email)}</td>
      <td style="padding:12px;">${roleBadge}</td>
      <td style="padding:12px; font-size:13px; color:#555;">${escapeHtml(fmtDate(user.lastLoginAt))}</td>
      <td style="padding:12px;">${statusBadge}</td>
      <td style="padding:12px; text-align:right;">
        <button type="button" data-action="edit" class="pjl-btn pjl-btn-outline" style="padding:6px 10px;">Edit</button>
        <button type="button" data-action="reset" class="pjl-btn pjl-btn-outline" style="padding:6px 10px;">Reset password</button>
        <button type="button" data-action="toggle" class="pjl-btn pjl-btn-outline" style="padding:6px 10px;">${toggleLabel}</button>
        <button type="button" data-action="delete" class="pjl-btn pjl-btn-outline" style="padding:6px 10px; color:#8A1F0F; border-color:#F5BFB6;">Delete</button>
      </td>
    </tr>
  `;
}

async function loadUsers() {
  try {
    const [usersRes, sessionRes] = await Promise.all([
      fetch("/api/users", { credentials: "same-origin" }),
      fetch("/api/session", { credentials: "same-origin" })
    ]);
    if (usersRes.status === 403) {
      usersBody.innerHTML = `<tr><td colspan="7" style="padding:24px; text-align:center;">Admin access is required to view this page.</td></tr>`;
      addBtn.disabled = true;
      return;
    }
    const usersData = await usersRes.json();
    if (!usersRes.ok || !usersData.ok) throw new Error((usersData.errors || ["Couldn't load users."]).join(" "));
    const sessionData = await sessionRes.json().catch(() => ({}));
    me = sessionData.user || null;
    currentUsers = usersData.users || [];
    if (!currentUsers.length) {
      usersBody.innerHTML = `<tr><td colspan="7" style="padding:24px; text-align:center;">No users yet — click "+ Add user" above.</td></tr>`;
      return;
    }
    usersBody.innerHTML = currentUsers.map(rowHtml).join("");
  } catch (err) {
    setStatus(err.message || "Couldn't load users.", "error");
  }
}

function openModal({ mode, user }) {
  formError.hidden = true;
  formError.textContent = "";
  form.reset();
  form.elements.userId.value = user?.id || "";
  form.elements.email.value = user?.email || "";
  form.elements.name.value = user?.name || "";
  form.elements.role.value = user?.role || "admin";
  if (mode === "edit") {
    modalTitle.textContent = `Edit ${user.name}`;
    form.elements.email.disabled = true;
    passwordField.hidden = true;
    form.elements.password.required = false;
  } else {
    modalTitle.textContent = "Add user";
    form.elements.email.disabled = false;
    passwordField.hidden = false;
    form.elements.password.required = true;
  }
  modal.hidden = false;
}

function closeModal() {
  modal.hidden = true;
}

addBtn?.addEventListener("click", () => openModal({ mode: "create" }));
cancelBtn?.addEventListener("click", closeModal);
modal?.addEventListener("click", (event) => {
  if (event.target === modal) closeModal();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  formError.hidden = true;
  const userId = form.elements.userId.value;
  const payload = {
    email: form.elements.email.value.trim(),
    name: form.elements.name.value.trim(),
    role: form.elements.role.value
  };
  try {
    let res, data;
    if (userId) {
      // Edit — only name + role allowed.
      res = await fetch(`/api/users/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: payload.name, role: payload.role })
      });
    } else {
      payload.password = form.elements.password.value;
      res = await fetch("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
    }
    data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error((data.errors || ["Save failed."]).join(" "));
    closeModal();
    await loadUsers();
    setStatus(userId ? "User updated." : "User created.");
  } catch (err) {
    formError.textContent = err.message;
    formError.hidden = false;
  }
});

usersBody.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const tr = button.closest("tr[data-id]");
  if (!tr) return;
  const id = tr.dataset.id;
  const user = currentUsers.find((u) => u.id === id);
  if (!user) return;
  const action = button.dataset.action;

  if (action === "edit") {
    openModal({ mode: "edit", user });
    return;
  }

  if (action === "reset") {
    if (!confirm(`Email a password-reset link to ${user.email}?`)) return;
    button.disabled = true;
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(id)}/reset-password`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error((data.errors || ["Reset failed."]).join(" "));
      setStatus(data.emailSent ? `Reset link emailed to ${user.email}.` : `Reset issued for ${user.email} — email delivery may have been skipped (check Gmail config).`);
    } catch (err) {
      setStatus(err.message || "Reset failed.", "error");
    } finally {
      button.disabled = false;
    }
    return;
  }

  if (action === "toggle") {
    const next = !user.disabled;
    if (next && !confirm(`Disable ${user.name}? They won't be able to sign in until you re-enable.`)) return;
    button.disabled = true;
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disabled: next })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error((data.errors || ["Update failed."]).join(" "));
      await loadUsers();
      setStatus(next ? `${user.name} disabled.` : `${user.name} re-enabled.`);
    } catch (err) {
      setStatus(err.message || "Update failed.", "error");
    } finally {
      button.disabled = false;
    }
    return;
  }

  if (action === "delete") {
    if (!confirm(`Delete ${user.name} (${user.email}) permanently? This cannot be undone.`)) return;
    button.disabled = true;
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error((data.errors || ["Delete failed."]).join(" "));
      await loadUsers();
      setStatus(`${user.name} deleted.`);
    } catch (err) {
      setStatus(err.message || "Delete failed.", "error");
    } finally {
      button.disabled = false;
    }
    return;
  }
});

logoutBtn?.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.assign("/login");
});

loadUsers();

// /reset-password?t=<mt_id> — admin/tech password reset page.
//
// On load we GET /api/reset-password/verify?t=<id>; on success we render
// the form (showing whose account this is). Submit POSTs the new
// password and the token together to /api/reset-password, then bounces
// to /login on success.

const stateEl = document.getElementById("resetState");
const params = new URLSearchParams(window.location.search);
const token = params.get("t") || "";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInvalid(reason) {
  const message = reason === "expired"
    ? "This reset link has expired (links are valid for 30 minutes)."
    : reason === "used"
      ? "This reset link has already been used."
      : "This reset link is no longer valid.";
  stateEl.innerHTML = `
    <p class="login-copy">${escapeHtml(message)}</p>
    <p class="login-copy">Ask an admin to issue a fresh link from <a href="/admin/users" style="color:#F59B4A;">/admin/users</a>.</p>
    <p class="login-copy"><a href="/login" style="color:#F59B4A;">Back to sign-in</a></p>
  `;
}

function renderForm(user) {
  stateEl.innerHTML = `
    <p class="login-copy">Resetting password for <strong>${escapeHtml(user.email)}</strong> (${escapeHtml(user.name || "")}).</p>
    <form id="resetForm" class="login-form">
      <label>
        <span>New password (min 10 characters)</span>
        <input type="password" name="newPassword" minlength="10" autocomplete="new-password" required autofocus>
      </label>
      <label>
        <span>Confirm new password</span>
        <input type="password" name="confirmPassword" minlength="10" autocomplete="new-password" required>
      </label>
      <p id="resetError" class="login-error" hidden></p>
      <button type="submit">Set new password <span aria-hidden="true">&rarr;</span></button>
    </form>
  `;
  const form = document.getElementById("resetForm");
  const error = document.getElementById("resetError");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    const fd = new FormData(form);
    const newPassword = String(fd.get("newPassword") || "");
    const confirmPassword = String(fd.get("confirmPassword") || "");
    if (newPassword !== confirmPassword) {
      error.textContent = "The two passwords don't match.";
      error.hidden = false;
      return;
    }
    if (newPassword.length < 10) {
      error.textContent = "Password must be at least 10 characters.";
      error.hidden = false;
      return;
    }
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      const res = await fetch("/api/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, newPassword })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error((data.errors || ["Reset failed."]).join(" "));
      stateEl.innerHTML = `
        <p class="login-copy">Password updated. Redirecting to sign-in…</p>
      `;
      setTimeout(() => window.location.assign("/login"), 1200);
    } catch (err) {
      error.textContent = err.message || "Reset failed.";
      error.hidden = false;
      button.disabled = false;
    }
  });
}

async function init() {
  if (!token) {
    renderInvalid("missing");
    return;
  }
  try {
    const res = await fetch(`/api/reset-password/verify?t=${encodeURIComponent(token)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok || !data.valid) {
      renderInvalid(data.reason);
      return;
    }
    renderForm({ email: data.email, name: data.name });
  } catch {
    renderInvalid("error");
  }
}

init();

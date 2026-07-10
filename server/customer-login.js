// /portal/login — customer magic-link request page.
//
// The form POSTs to /api/portal/request-link which always returns 200
// regardless of match outcome (no enumeration). We replace the form with
// the always-on confirmation panel as soon as the request resolves —
// success OR failure looks identical to the user. Error display is
// reserved for "no identifier entered" client-side validation.

const form = document.getElementById("portalLoginForm");
const error = document.getElementById("portalLoginError");
const confirmPanel = document.getElementById("portalLoginConfirm");

// Surface ?error=expired from a stale magic-link click. The brief calls
// out a "friendly expired/used message" — we render it inline above the
// form so the customer can re-request a fresh link without leaving the
// page.
const params = new URLSearchParams(window.location.search);
if (params.get("error") === "expired") {
  error.textContent = "That login link has expired or already been used. Enter your details below to get a fresh one.";
  error.hidden = false;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  const button = form.querySelector("button");
  const fd = new FormData(form);
  const identifier = String(fd.get("identifier") || "").trim();
  if (!identifier) {
    error.textContent = "Please enter your email, phone, or address.";
    error.hidden = false;
    return;
  }
  button.disabled = true;
  try {
    await fetch("/api/portal/request-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier })
    });
  } catch {
    // Even on a network blip we still show the same confirmation —
    // the brief is explicit about not leaking match-vs-no-match.
  }
  form.hidden = true;
  confirmPanel.hidden = false;
});

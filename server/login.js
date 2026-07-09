// /login — the unified sign-in door (brief §11, Jul 2026).
//
// One form, two audiences. POST /api/login decides server-side:
//   • staff email + correct password → session cookie + { ok, role } —
//     we redirect to /admin (or the ?next= deep link).
//   • EVERYTHING else (blank password, wrong password, unknown email,
//     customer email) → the server routes into the customer magic-link
//     path and returns the generic { ok, magicLink } response. We show
//     the "check your email" panel. The response is identical across
//     those branches on purpose — no enumeration of staff emails.
const loginForm = document.getElementById("loginForm");
const loginError = document.getElementById("loginError");
const magicConfirm = document.getElementById("loginMagicConfirm");

function nextUrl() {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") ? next : "/admin";
}

// Surface ?error=expired from a stale customer magic-link click (the
// verify endpoint redirects here now that /portal/login is retired).
const params = new URLSearchParams(window.location.search);
if (params.get("error") === "expired") {
  loginError.textContent = "That sign-in link has expired or already been used. Enter your email below to get a fresh one.";
  loginError.hidden = false;
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = loginForm.querySelector("button");
  const formData = new FormData(loginForm);
  button.disabled = true;
  loginError.hidden = true;

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: formData.get("email"),
        password: formData.get("password")
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error((data.errors || ["Unable to log in."]).join(" "));
    if (data.magicLink) {
      // Customer (or anything that isn't a valid staff login): the
      // server may have emailed a sign-in link. Same panel either way.
      loginForm.hidden = true;
      if (magicConfirm) magicConfirm.hidden = false;
      return;
    }
    window.location.assign(nextUrl());
  } catch (error) {
    loginError.textContent = error.message || "Unable to log in.";
    loginError.hidden = false;
  } finally {
    button.disabled = false;
  }
});

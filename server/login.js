const loginForm = document.getElementById("loginForm");
const loginError = document.getElementById("loginError");

function nextUrl() {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") ? next : "/admin";
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
      body: JSON.stringify({ password: formData.get("password") })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error((data.errors || ["Unable to log in."]).join(" "));
    window.location.assign(nextUrl());
  } catch (error) {
    loginError.textContent = error.message || "Unable to log in.";
    loginError.hidden = false;
  } finally {
    button.disabled = false;
  }
});

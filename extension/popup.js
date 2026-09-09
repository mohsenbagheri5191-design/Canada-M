/**
 * Toolbar popup.
 *
 * Shows whether the account can work right now and opens the dashboard. It
 * asks the service worker and never touches a token, a table or a formula.
 */

document.getElementById("open").onclick = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  window.close();
};

const MESSAGES = {
  account_disabled: "Access turned off",
  account_expired: "Access period ended",
  no_profile: "No access on this account",
  kill_switch: "Down for maintenance",
  quota_exceeded: "Monthly quota reached",
  network_error: "Cannot reach the server",
};

chrome.runtime.sendMessage({ type: "AUTH_STATE" }, (response) => {
  const dot = document.getElementById("dot");
  const state = document.getElementById("state");

  if (chrome.runtime.lastError) {
    dot.className = "dot off";
    state.textContent = "Extension is starting up";
    return;
  }

  if (response?.ok && response.signedIn) {
    const quota = response.quota;
    dot.className = "dot on";
    state.textContent = quota
      ? `${response.profile.email} · ${Number(quota.remaining).toLocaleString()} left`
      : response.profile.email;
    return;
  }

  const code = response?.error?.code;
  dot.className = response?.signedIn ? "dot off" : "dot";
  state.textContent = MESSAGES[code] ?? (response?.signedIn ? "Access blocked" : "Not signed in");
});

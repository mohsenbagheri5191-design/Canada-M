/**
 * The gate.
 *
 * Owns every state the user can be in before the workspace is usable, and
 * exposes window.amrSession so the dashboards can ask "am I allowed to work?"
 * without knowing anything about tokens.
 *
 * This file never sees a credential. It posts an email and password to the
 * service worker once, and from then on receives only profile and quota facts.
 *
 * The states, all of which the brief asked for:
 *   signed out        -> login form
 *   disabled          -> blocked screen, cannot be cleared by re-logging in
 *   expired           -> blocked screen with the expiry date
 *   no profile        -> blocked screen (authenticated but never invited)
 *   quota exhausted   -> workspace stays usable, actions refuse with a message
 *   kill switch on    -> maintenance screen for everyone, admins included
 *   network / server  -> retry screen, credentials kept
 */

const send = (message) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      // A dead service worker surfaces here rather than as a rejected promise.
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: {
            code: "network_error",
            message: chrome.runtime.lastError.message,
          },
        });
        return;
      }
      resolve(response);
    });
  });

const $ = (id) => document.getElementById(id);

/** Shared, read-only view of the session for the rest of the UI. */
window.amrSession = {
  profile: null,
  quota: null,
  ready: false,
  isAdmin: false,
};

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

function buildGate() {
  const gate = document.createElement("div");
  gate.id = "amrGate";
  gate.innerHTML = `
    <div class="amrCard">
      <div class="amrBrand">
        <img src="icon48.png" alt="">
        <div>
          <b>Amazon Market Research Pro</b>
          <small>Invite-only access</small>
        </div>
      </div>
      <div id="amrGateBody"></div>
    </div>`;
  document.body.prepend(gate);

  const bar = document.createElement("div");
  bar.id = "amrAccountBar";
  bar.hidden = true;
  bar.innerHTML = `
    <span class="amrWho">
      <i class="amrDot"></i>
      <span>Signed in as <b id="amrEmail">-</b></span>
      <span class="amrRole" id="amrRole" hidden>admin</span>
    </span>
    <span class="amrQuota">
      <span id="amrQuotaText">-</span>
      <span class="amrQuotaTrack" id="amrQuotaTrack"><i style="width:0%"></i></span>
      <button id="amrSignOut" type="button">Sign out</button>
    </span>`;
  document.body.prepend(bar);

  const toast = document.createElement("div");
  toast.id = "amrToast";
  toast.hidden = true;
  document.body.appendChild(toast);

  $("amrSignOut").addEventListener("click", async () => {
    await send({ type: "AUTH_SIGN_OUT" });
    window.amrSession.ready = false;
    showLogin();
  });
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function gateBody(html) {
  $("amrGate").hidden = false;
  $("amrAccountBar").hidden = true;
  document.body.classList.add("amrLocked");
  $("amrGateBody").innerHTML = html;
}

function showLogin(notice = null) {
  gateBody(`
    <h1>Sign in</h1>
    <p>Your administrator creates every account. There is no public sign-up.</p>
    <div class="amrNotice error" id="amrError" ${notice ? "" : "hidden"}>${
      notice ? escapeHtml(notice) : ""
    }</div>
    <form id="amrForm" autocomplete="on">
      <div class="amrField">
        <label for="amrEmailInput">Email</label>
        <input id="amrEmailInput" type="email" autocomplete="username" required>
      </div>
      <div class="amrField">
        <label for="amrPassInput">Password</label>
        <input id="amrPassInput" type="password" autocomplete="current-password" required>
      </div>
      <button class="amrSubmit" id="amrSubmit" type="submit">Sign in</button>
    </form>
    <p class="amrFoot">Lost your password? Ask your administrator to reset it.</p>`);

  const form = $("amrForm");
  const submit = $("amrSubmit");
  const error = $("amrError");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    submit.disabled = true;
    submit.textContent = "Signing in...";
    error.hidden = true;
    for (const input of form.querySelectorAll("input")) input.disabled = true;

    const response = await send({
      type: "AUTH_SIGN_IN",
      email: $("amrEmailInput").value,
      password: $("amrPassInput").value,
    });

    if (response?.ok) {
      applySession(response);
      return;
    }

    // A blocked account signs in successfully and is then refused. Show the
    // reason rather than the login form, which would just fail again.
    const code = response?.error?.code;
    if (isBlockingCode(code)) {
      showBlocked(response.error);
      return;
    }

    submit.disabled = false;
    submit.textContent = "Sign in";
    for (const input of form.querySelectorAll("input")) input.disabled = false;
    error.textContent = response?.error?.message ?? "Sign in failed.";
    error.hidden = false;
    $("amrPassInput").value = "";
    $("amrPassInput").focus();
  });

  $("amrEmailInput").focus();
}

const BLOCKING_CODES = new Set([
  "account_disabled",
  "account_expired",
  "no_profile",
  "kill_switch",
]);

const isBlockingCode = (code) => BLOCKING_CODES.has(code);

function showBlocked(error) {
  const presets = {
    account_disabled: {
      icon: "\u{1F512}",
      title: "Access turned off",
      tone: "error",
    },
    account_expired: {
      icon: "\u{23F1}",
      title: "Access period ended",
      tone: "warn",
    },
    no_profile: {
      icon: "\u{1F6AB}",
      title: "No access on this account",
      tone: "error",
    },
    kill_switch: {
      icon: "\u{1F527}",
      title: "Down for maintenance",
      tone: "info",
    },
  };

  const preset = presets[error.code] ?? {
    icon: "\u{26A0}",
    title: "Cannot continue",
    tone: "error",
  };

  const expiry = error.detail?.expiredAt
    ? `<p class="amrFoot">Access ended ${new Date(error.detail.expiredAt).toLocaleDateString()}.</p>`
    : "";

  gateBody(`
    <div class="amrBlockedIcon">${preset.icon}</div>
    <h1>${escapeHtml(preset.title)}</h1>
    <div class="amrNotice ${preset.tone}">${escapeHtml(error.message)}</div>
    <div class="amrActions">
      <button type="button" id="amrRetry">Try again</button>
      <button type="button" id="amrBack">Sign out</button>
    </div>
    ${expiry}`);

  // The kill switch is temporary, so retrying is the useful action. A disabled
  // account needs an administrator, so retrying will not help but is harmless.
  $("amrRetry").addEventListener("click", () => {
    gateBody(`<h1>Checking...</h1><div class="amrNotice info">Contacting the server.</div>`);
    boot();
  });

  $("amrBack").addEventListener("click", async () => {
    await send({ type: "AUTH_SIGN_OUT" });
    showLogin();
  });
}

function showUnreachable(message) {
  gateBody(`
    <div class="amrBlockedIcon">\u{1F4E1}</div>
    <h1>Cannot reach the server</h1>
    <div class="amrNotice error">${escapeHtml(message)}</div>
    <p class="amrFoot">You are still signed in. This is usually a connection problem.</p>
    <div class="amrActions">
      <button type="button" id="amrRetry">Retry</button>
      <button type="button" id="amrBack">Sign out</button>
    </div>`);

  $("amrRetry").addEventListener("click", boot);
  $("amrBack").addEventListener("click", async () => {
    await send({ type: "AUTH_SIGN_OUT" });
    showLogin();
  });
}

// ---------------------------------------------------------------------------
// Signed-in state
// ---------------------------------------------------------------------------

function applySession(payload) {
  window.amrSession.profile = payload.profile ?? null;
  window.amrSession.quota = payload.quota ?? null;
  window.amrSession.ready = true;
  window.amrSession.isAdmin = payload.profile?.role === "admin";

  $("amrGate").hidden = true;
  $("amrAccountBar").hidden = false;
  document.body.classList.remove("amrLocked");

  $("amrEmail").textContent = payload.profile?.email ?? "-";
  $("amrRole").hidden = payload.profile?.role !== "admin";

  renderQuota(payload.quota);

  // Lets the dashboards start work only once the gate has cleared.
  document.dispatchEvent(
    new CustomEvent("amr:ready", { detail: window.amrSession }),
  );
}

function renderQuota(quota) {
  if (!quota) return;
  window.amrSession.quota = quota;

  const used = Number(quota.used) || 0;
  const limit = Number(quota.limit) || 0;

  // Number(undefined) is NaN, and `??` does not catch NaN, so derive the
  // fallback explicitly rather than letting NaN reach the width calculation.
  const reported = Number(quota.remaining);
  const remaining = Number.isFinite(reported)
    ? Math.max(0, reported)
    : Math.max(0, limit - used);

  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

  $("amrQuotaText").textContent =
    `${remaining.toLocaleString()} of ${limit.toLocaleString()} requests left`;

  const track = $("amrQuotaTrack");
  track.querySelector("i").style.width = `${pct}%`;
  track.classList.toggle("low", remaining > 0 && pct >= 85);
  track.classList.toggle("out", remaining === 0);
}

/** Called by the dashboards after any server call that returns a quota block. */
window.amrUpdateQuota = renderQuota;

// ---------------------------------------------------------------------------
// Mid-session interruptions
// ---------------------------------------------------------------------------

let toastTimer = null;

function toast(title, message, tone = "error") {
  const el = $("amrToast");
  el.className = tone;
  el.innerHTML = `<b>${escapeHtml(title)}</b>${escapeHtml(message)}`;
  el.hidden = false;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 9000);
}

/**
 * The single place the dashboards report a failed server call.
 *
 * Decides whether the failure ends the session (back to the gate) or is just
 * this one action failing (a toast). Returns a short message for inline status
 * lines so each caller does not re-derive its own wording.
 */
window.amrHandleError = function handleError(error) {
  const code = error?.code ?? "server_error";
  const message = error?.message ?? "Something went wrong.";

  if (code === "needs_login") {
    window.amrSession.ready = false;
    showLogin("Your session ended. Please sign in again.");
    return message;
  }

  if (isBlockingCode(code)) {
    window.amrSession.ready = false;
    showBlocked({ code, message, detail: error?.detail });
    return message;
  }

  if (code === "quota_exceeded") {
    // Deliberately not a gate: the user keeps everything already on screen and
    // can still export it. Only new requests are refused.
    renderQuota({
      used: error?.detail?.used ?? 0,
      limit: error?.detail?.limit ?? 0,
      remaining: 0,
    });
    toast("Monthly quota reached", message, "warn");
    return message;
  }

  if (code === "network_error") {
    toast("Connection problem", message, "error");
    return message;
  }

  toast("Request failed", message, "error");
  return message;
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  const response = await send({ type: "AUTH_STATE" });

  if (response?.ok && response.signedIn) {
    applySession(response);
    return;
  }

  const code = response?.error?.code;

  if (response?.signedIn && isBlockingCode(code)) {
    showBlocked(response.error);
    return;
  }

  if (code === "network_error") {
    // Only show the unreachable screen if there are credentials worth keeping;
    // otherwise a first-run user should just see the login form.
    const identity = await send({ type: "AUTH_IDENTITY" });
    if (identity?.identity) {
      showUnreachable(response.error.message);
      return;
    }
  }

  showLogin();
}

function start() {
  buildGate();
  gateBody(`<h1>Checking access...</h1><div class="amrNotice info">Contacting the server.</div>`);
  boot();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}

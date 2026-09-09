/**
 * Admin console.
 *
 * Plain ES2022 in one file, no framework. It does four things: sign in, list
 * and edit users, read usage, and flip global settings. Everything privileged
 * happens in an Edge Function that re-verifies the caller is an active admin;
 * this file only asks.
 *
 * Session handling is deliberately simpler than the extension's. The access
 * token lives in sessionStorage, which dies with the tab, and there is no
 * refresh token kept anywhere: an admin session that outlives the tab is a
 * liability, and signing in again costs one form.
 */

(() => {
  "use strict";

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.AMR_CONFIG;
  const AUTH_URL = `${SUPABASE_URL}/auth/v1`;
  const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;
  const TOKEN_KEY = "amr.admin.token";

  const $ = (id) => document.getElementById(id);

  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));

  const fmtNum = new Intl.NumberFormat("en-CA");

  const fmtDate = (value) =>
    value ? new Date(value).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric",
    }) : "—";

  const fmtDateTime = (value) =>
    value ? new Date(value).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    }) : "—";

  /** Days since a timestamp, for the "last active" column. */
  function relativeDays(value) {
    if (!value) return "never";
    const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return `${days} days ago`;
    return fmtDate(value);
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  let token = sessionStorage.getItem(TOKEN_KEY) || "";
  let me = null;
  let users = [];
  let settings = null;
  let editingUserId = null;

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  class AdminError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  async function callFunction(name, body = {}) {
    let response;
    try {
      response = await fetch(`${FUNCTIONS_URL}/${name}`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new AdminError("network_error", "Could not reach the server.");
    }

    // No refresh token is kept, so an expired admin session means signing in
    // again rather than a silent renewal.
    if (response.status === 401) {
      signOut("Your session expired. Please sign in again.");
      throw new AdminError("needs_login", "Session expired.");
    }

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new AdminError(
        payload?.error?.code ?? "server_error",
        payload?.error?.message ?? `Request failed (${response.status}).`,
      );
    }
    return payload;
  }

  const adminUsers = (body) => callFunction("admin-users", body);
  const adminUsage = (body) => callFunction("admin-usage", body);

  // -------------------------------------------------------------------------
  // Toast
  // -------------------------------------------------------------------------

  let toastTimer = null;

  function toast(message, tone = "ok") {
    const el = $("toast");
    el.className = tone;
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 4500);
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const button = $("loginButton");
    const error = $("loginError");

    button.disabled = true;
    button.textContent = "Signing in…";
    error.hidden = true;

    try {
      const response = await fetch(`${AUTH_URL}/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          email: $("email").value.trim(),
          password: $("password").value,
        }),
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          response.status === 400
            ? "That email and password do not match an account."
            : body.error_description || body.msg || "Sign in failed.",
        );
      }

      token = body.access_token;
      sessionStorage.setItem(TOKEN_KEY, token);

      // Authenticating is not the same as being an admin. This is where a
      // non-admin who guessed the URL is turned away.
      await enterConsole();
    } catch (err) {
      // A non-admin gets 403 not_admin from the first admin call. Say so
      // plainly rather than implying the password was wrong.
      error.textContent = err.code === "not_admin"
        ? "That account is not an administrator."
        : err.message;
      error.hidden = false;
      token = "";
      sessionStorage.removeItem(TOKEN_KEY);
      $("password").value = "";
    } finally {
      button.disabled = false;
      button.textContent = "Sign in";
    }
  });

  function signOut(message) {
    token = "";
    me = null;
    sessionStorage.removeItem(TOKEN_KEY);

    $("app").hidden = true;
    $("gate").hidden = false;
    document.body.classList.add("locked");

    if (message) {
      $("loginError").textContent = message;
      $("loginError").hidden = false;
    }
  }

  $("signOut").addEventListener("click", () => signOut());

  async function enterConsole() {
    // Doubles as the admin check: admin-users refuses a non-admin with 403.
    const [{ users: list }, { settings: config }] = await Promise.all([
      adminUsers({ op: "list" }),
      adminUsers({ op: "settings.get" }),
    ]);

    users = list;
    settings = config;
    me = users.find((u) => u.role === "admin" && u.email === $("email").value.trim().toLowerCase())
      ?? null;

    $("gate").hidden = true;
    $("app").hidden = false;
    document.body.classList.remove("locked");
    $("whoami").textContent = me?.email ?? "Administrator";

    renderKillBanner();
    renderUsers();
    renderSettings();
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  document.querySelectorAll(".tabs button").forEach((button) => {
    button.addEventListener("click", async () => {
      document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".view").forEach((v) => (v.hidden = true));

      button.classList.add("active");
      $(`view-${button.dataset.view}`).hidden = false;

      try {
        if (button.dataset.view === "usage") await loadUsage();
        if (button.dataset.view === "audit") await loadAudit();
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  const STATUS_LABEL = {
    active: "Active",
    disabled: "Disabled",
    expired: "Expired",
  };

  function renderUsers() {
    const active = users.filter((u) => u.effective_status === "active").length;
    $("userCount").textContent =
      `${users.length} account${users.length === 1 ? "" : "s"}, ${active} active`;

    $("usersTable").innerHTML = `
      <thead><tr>
        <th>User</th><th>Role</th><th>Status</th><th>Quota this month</th>
        <th>Expires</th><th>Last active</th><th></th>
      </tr></thead>
      <tbody>${users.map(renderUserRow).join("")}</tbody>`;

    $("usersTable").querySelectorAll("[data-act]").forEach((button) => {
      button.addEventListener("click", () => onUserAction(button.dataset.act, button.dataset.id));
    });
  }

  function renderUserRow(user) {
    const used = Number(user.month_usage) || 0;
    const limit = Number(user.monthly_request_quota) || 0;
    const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
    const isSelf = me && user.id === me.id;

    // Quota bar turns amber near the limit and red at it, so the row that
    // needs attention is visible without reading the numbers.
    const barClass = limit > 0 && used >= limit ? "out" : pct >= 85 ? "low" : "";

    return `
      <tr class="${user.effective_status !== "active" ? "inactive" : ""}">
        <td>
          <div class="userCell">
            <b>${esc(user.full_name || user.email)}</b>
            ${user.full_name ? `<small>${esc(user.email)}</small>` : ""}
            ${user.notes ? `<small class="note">${esc(user.notes)}</small>` : ""}
          </div>
        </td>
        <td><span class="badge ${user.role}">${esc(user.role)}</span></td>
        <td><span class="status ${esc(user.effective_status)}">${
          STATUS_LABEL[user.effective_status] ?? esc(user.effective_status)
        }</span></td>
        <td>
          <div class="quotaCell">
            <span>${fmtNum.format(used)} / ${fmtNum.format(limit)}</span>
            <i class="bar ${barClass}"><b style="width:${pct}%"></b></i>
          </div>
        </td>
        <td>${fmtDate(user.access_expires_at)}</td>
        <td>${relativeDays(user.last_active_at)}</td>
        <td class="actions">
          <button data-act="edit" data-id="${user.id}" type="button">Edit</button>
          <button data-act="password" data-id="${user.id}" type="button">Reset password</button>
          ${
            isSelf
              ? ""
              : user.status === "disabled"
              ? `<button data-act="enable" data-id="${user.id}" class="ok" type="button">Enable</button>`
              : `<button data-act="disable" data-id="${user.id}" class="warn" type="button">Disable</button>`
          }
          ${isSelf ? "" : `<button data-act="delete" data-id="${user.id}" class="danger" type="button">Delete</button>`}
        </td>
      </tr>`;
  }

  async function onUserAction(action, userId) {
    const user = users.find((u) => u.id === userId);
    if (!user) return;

    try {
      if (action === "edit") return openUserDialog(user);

      if (action === "password") {
        const password = prompt(
          `New password for ${user.email}\n\nAt least 12 characters. You will need to pass it to them yourself.`,
          generatePassword(),
        );
        if (password === null) return;

        await adminUsers({ op: "reset-password", userId, password });
        toast(`Password reset for ${user.email}.`);
        return;
      }

      if (action === "disable" || action === "enable") {
        await adminUsers({ op: action, userId });
        toast(`${user.email} ${action === "disable" ? "disabled" : "enabled"}. Takes effect on their next request.`);
        return refreshUsers();
      }

      if (action === "delete") {
        if (!confirm(
          `Delete ${user.email}?\n\nThis removes the account and its usage history. ` +
          `The audit log entry survives. This cannot be undone.`,
        )) return;

        await adminUsers({ op: "delete", userId });
        toast(`${user.email} deleted.`);
        return refreshUsers();
      }
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function refreshUsers() {
    const { users: list } = await adminUsers({ op: "list" });
    users = list;
    renderUsers();
  }

  // -------------------------------------------------------------------------
  // User dialog
  // -------------------------------------------------------------------------

  function generatePassword() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    return "Amr-" + [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  }

  $("genPassword").addEventListener("click", () => {
    $("uPassword").value = generatePassword();
  });

  $("newUser").addEventListener("click", () => openUserDialog(null));
  $("cancelUser").addEventListener("click", () => $("userDialog").close());

  function openUserDialog(user) {
    editingUserId = user?.id ?? null;

    $("userDialogTitle").textContent = user ? `Edit ${user.email}` : "Create user";
    $("saveUser").textContent = user ? "Save changes" : "Create user";
    $("userError").hidden = true;

    // Email is the account identity in Supabase Auth; changing it is a
    // different operation than editing a profile, so it is read-only on edit.
    $("uEmail").value = user?.email ?? "";
    $("uEmail").readOnly = Boolean(user);

    $("passwordField").hidden = Boolean(user);
    $("uPassword").value = user ? "" : generatePassword();
    $("uPassword").required = !user;

    $("uName").value = user?.full_name ?? "";
    $("uRole").value = user?.role ?? "user";
    $("uQuota").value = user?.monthly_request_quota ?? settings?.default_monthly_quota ?? 1000;
    $("uExpiry").value = user?.access_expires_at
      ? new Date(user.access_expires_at).toISOString().slice(0, 10)
      : "";
    $("uNotes").value = user?.notes ?? "";

    $("userDialog").showModal();
  }

  $("userForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const button = $("saveUser");
    const error = $("userError");
    button.disabled = true;
    error.hidden = true;

    // A date input gives a local calendar day; expiry should mean the end of
    // that day rather than midnight at its start.
    const expiryValue = $("uExpiry").value;
    const accessExpiresAt = expiryValue
      ? new Date(`${expiryValue}T23:59:59`).toISOString()
      : null;

    const payload = {
      fullName: $("uName").value.trim() || null,
      role: $("uRole").value,
      quota: Number($("uQuota").value),
      accessExpiresAt,
      notes: $("uNotes").value.trim() || null,
    };

    try {
      if (editingUserId) {
        await adminUsers({ op: "update", userId: editingUserId, ...payload });
        toast("Changes saved.");
      } else {
        const password = $("uPassword").value;
        await adminUsers({
          op: "create",
          email: $("uEmail").value.trim(),
          password,
          ...payload,
        });
        // Shown once, here, because nothing stores it and there is no reset email.
        toast(`Created ${$("uEmail").value.trim()}. Password: ${password}`, "ok");
      }

      $("userDialog").close();
      await refreshUsers();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  });

  // -------------------------------------------------------------------------
  // Usage
  // -------------------------------------------------------------------------

  async function loadUsage() {
    const days = Number($("usageDays").value) || 30;
    const { summary } = await adminUsage({ days, recent: 0 });
    renderUsage(summary);
  }

  $("usageDays").addEventListener("change", () => {
    loadUsage().catch((err) => toast(err.message, "error"));
  });

  function renderUsage(summary) {
    const t = summary.totals;

    $("usageKpis").innerHTML = [
      ["Total calls", fmtNum.format(t.total_calls)],
      ["Billable calls", fmtNum.format(t.billable_calls)],
      ["Active users", fmtNum.format(t.active_users)],
      ["Products scored", fmtNum.format(t.total_items)],
      ["Failed calls", fmtNum.format(t.failed_calls)],
      ["Avg. response", `${fmtNum.format(t.avg_duration_ms)} ms`],
    ].map(([label, value]) =>
      `<div class="kpi"><span>${label}</span><b>${value}</b></div>`
    ).join("");

    renderTimeSeries(summary.perDay);

    $("usageByUser").innerHTML = barList(
      summary.perUser.map((u) => [u.email, u.calls]),
      (row) => fmtNum.format(row),
    ) || emptyState("No calls in this window.");

    $("usageTopRefs").innerHTML = barList(
      summary.topReferences.map((r) => [r.reference, r.calls]),
      (row) => fmtNum.format(row),
    ) || emptyState("No ASINs or keywords recorded yet.");

    $("usageByEndpoint").innerHTML = barList(
      summary.perEndpoint.map((e) => [e.endpoint, e.calls]),
      (row) => fmtNum.format(row),
    ) || emptyState("No calls in this window.");
  }

  const emptyState = (text) => `<p class="empty">${esc(text)}</p>`;

  function barList(entries, format) {
    if (!entries.length) return "";
    const max = Math.max(...entries.map((e) => e[1])) || 1;

    return entries.slice(0, 12).map(([label, value]) =>
      `<div class="barRow">
        <span title="${esc(label)}">${esc(label)}</span>
        <i class="bar"><b style="width:${(value / max) * 100}%"></b></i>
        <em>${format(value)}</em>
      </div>`
    ).join("");
  }

  /**
   * Calls-per-day as an inline SVG column chart.
   *
   * Days with no calls are filled in as zero, so a gap in usage reads as a gap
   * rather than silently compressing the axis.
   */
  function renderTimeSeries(perDay) {
    if (!perDay.length) {
      $("usageChart").innerHTML = emptyState("No calls in this window.");
      return;
    }

    const byDay = new Map(perDay.map((d) => [d.day, d.calls]));
    const start = new Date(perDay[0].day);
    const end = new Date(perDay[perDay.length - 1].day);

    const days = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      days.push([key, byDay.get(key) ?? 0]);
    }

    const max = Math.max(...days.map((d) => d[1])) || 1;
    const width = 900;
    const height = 200;
    const barWidth = Math.max(2, width / days.length - 2);

    const bars = days.map(([day, calls], i) => {
      const x = (i * width) / days.length;
      const barHeight = (calls / max) * (height - 30);
      return `<rect x="${x}" y="${height - 20 - barHeight}" width="${barWidth}" ` +
        `height="${barHeight}" rx="2" fill="#0f766e"><title>${day}: ${calls} calls</title></rect>`;
    }).join("");

    $("usageChart").innerHTML =
      `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">` +
      `${bars}<line x1="0" y1="${height - 20}" x2="${width}" y2="${height - 20}" ` +
      `stroke="currentColor" opacity=".2"/></svg>` +
      `<div class="axis"><span>${days[0][0]}</span><span>peak ${fmtNum.format(max)}/day</span>` +
      `<span>${days[days.length - 1][0]}</span></div>`;
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  function renderSettings() {
    if (!settings) return;
    $("killSwitch").checked = Boolean(settings.kill_switch);
    $("killMessage").value = settings.kill_switch_message ?? "";
    $("defaultQuota").value = settings.default_monthly_quota ?? 1000;
    $("allowedOrigins").value = settings.allowed_origins ?? "";
  }

  function renderKillBanner() {
    $("killBanner").hidden = !settings?.kill_switch;
  }

  async function saveSettings(patch, message) {
    try {
      await adminUsers({ op: "settings.update", ...patch });
      ({ settings } = await adminUsers({ op: "settings.get" }));
      renderSettings();
      renderKillBanner();
      toast(message);
    } catch (err) {
      toast(err.message, "error");
    }
  }

  $("saveKill").addEventListener("click", () => {
    const on = $("killSwitch").checked;

    if (on && !confirm(
      "Turn on the kill switch?\n\nEvery user is blocked from the product " +
      "immediately, including you. This console keeps working so you can turn it back off.",
    )) {
      $("killSwitch").checked = false;
      return;
    }

    saveSettings(
      { killSwitch: on, killSwitchMessage: $("killMessage").value.trim() },
      on ? "Kill switch is ON. Everyone is blocked." : "Kill switch is off.",
    );
  });

  $("killOff").addEventListener("click", () => {
    saveSettings({ killSwitch: false }, "Kill switch is off.");
  });

  $("saveDefaults").addEventListener("click", () => {
    saveSettings(
      { defaultQuota: Number($("defaultQuota").value) },
      "Default quota saved.",
    );
  });

  $("saveOrigins").addEventListener("click", () => {
    saveSettings(
      { allowedOrigins: $("allowedOrigins").value.trim() },
      "CORS allowlist saved. It takes up to 30 seconds to propagate.",
    );
  });

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  async function loadAudit() {
    const { entries } = await adminUsers({ op: "audit", limit: 200 });

    $("auditTable").innerHTML = `
      <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>
      <tbody>${
        entries.map((e) => `
          <tr>
            <td>${fmtDateTime(e.created_at)}</td>
            <td>${esc(e.actor_email ?? "—")}</td>
            <td><span class="badge action">${esc(e.action)}</span></td>
            <td>${esc(e.target_email ?? "—")}</td>
            <td><code>${esc(JSON.stringify(e.details ?? {}))}</code></td>
          </tr>`).join("") ||
        '<tr><td colspan="5" class="empty">No administrative actions recorded yet.</td></tr>'
      }</tbody>`;
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  if (token) {
    // A token left in sessionStorage from a reload. Prove it still works and
    // still belongs to an admin before showing anything.
    enterConsole().catch(() => signOut());
  }
})();

/**
 * admin-users - the control plane.
 *
 * Every operation re-verifies is_admin() against a freshly read profile row
 * before touching anything. A valid JWT is not enough; a valid JWT belonging
 * to an active admin is.
 *
 * The kill switch deliberately does NOT gate this function. If it did, turning
 * the switch on would be a one-way door: the only way back would be editing
 * the row by hand in the Supabase console.
 *
 * Account creation goes through auth.admin.createUser with email_confirm set,
 * which is what makes the product invite-only. There is no signup endpoint and
 * no password-reset email flow to abuse: the admin sets passwords directly.
 */

import { serveApi, readJson, jsonResponse } from "../_shared/handler.ts";
import { authenticate } from "../_shared/auth.ts";
import { adminClient } from "../_shared/supabase.ts";
import { logAudit } from "../_shared/usage.ts";
import { ApiError, ErrorCode } from "../_shared/errors.ts";

const MIN_PASSWORD_LENGTH = 12;
const MAX_QUOTA = 1_000_000;

interface Body {
  op?: string;
  userId?: string;
  email?: string;
  password?: string;
  fullName?: string | null;
  role?: string;
  status?: string;
  notes?: string | null;
  quota?: number;
  accessExpiresAt?: string | null;
  killSwitch?: boolean;
  killSwitchMessage?: string;
  defaultQuota?: number;
  limit?: number;
}

function requireString(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new ApiError(ErrorCode.BAD_REQUEST, `\`${field}\` is required.`);
  }
  return text;
}

function validEmail(value: unknown): string {
  const email = requireString(value, "email").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(ErrorCode.BAD_REQUEST, "That email address is not valid.");
  }
  return email;
}

function validPassword(value: unknown): string {
  const password = String(value ?? "");
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ApiError(
      ErrorCode.BAD_REQUEST,
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  return password;
}

function validRole(value: unknown, fallback: "admin" | "user" = "user"): "admin" | "user" {
  if (value === undefined || value === null || value === "") return fallback;
  const role = String(value).toLowerCase();
  if (role !== "admin" && role !== "user") {
    throw new ApiError(ErrorCode.BAD_REQUEST, "`role` must be 'admin' or 'user'.");
  }
  return role;
}

function validQuota(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const quota = Number(value);
  if (!Number.isFinite(quota) || quota < 0 || quota > MAX_QUOTA) {
    throw new ApiError(
      ErrorCode.BAD_REQUEST,
      `\`quota\` must be between 0 and ${MAX_QUOTA}.`,
    );
  }
  return Math.trunc(quota);
}

function validExpiry(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(ErrorCode.BAD_REQUEST, "`accessExpiresAt` is not a valid date.");
  }
  return date.toISOString();
}

serveApi(async (req, headers) => {
  // requireAdmin, and no kill-switch enforcement: see the note above.
  const ctx = await authenticate(req, {
    requireAdmin: true,
    enforceKillSwitch: false,
  });

  const admin = adminClient();
  const body = await readJson<Body>(req);
  const op = String(body.op ?? "").toLowerCase();

  const actor = { actorId: ctx.userId, actorEmail: ctx.profile.email };

  switch (op) {
    // -----------------------------------------------------------------------
    case "list": {
      const { data, error } = await admin.rpc("admin_user_list");
      if (error) throw new Error(`user list failed: ${error.message}`);
      return jsonResponse({ users: data ?? [] }, 200, headers);
    }

    // -----------------------------------------------------------------------
    case "create": {
      const email = validEmail(body.email);
      const password = validPassword(body.password);
      const role = validRole(body.role);
      const quota = validQuota(body.quota, ctx.settings.default_monthly_quota);
      const expiresAt = validExpiry(body.accessExpiresAt);

      // email_confirm: true because there is no inbox round trip in an
      // invite-only product. The admin hands over the temporary password.
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });

      if (createError || !created?.user) {
        const message = createError?.message ?? "unknown error";
        // Surface the one failure an admin can act on; keep the rest opaque.
        if (/already been registered|already exists/i.test(message)) {
          throw new ApiError(
            ErrorCode.BAD_REQUEST,
            "An account with that email already exists.",
          );
        }
        throw new Error(`createUser failed: ${message}`);
      }

      const { error: profileError } = await admin.from("profiles").insert({
        id: created.user.id,
        email,
        full_name: body.fullName ?? null,
        role,
        status: "active",
        created_by: ctx.userId,
        notes: body.notes ?? null,
        access_expires_at: expiresAt,
        monthly_request_quota: quota,
      });

      if (profileError) {
        // Roll back the auth user so a failed insert cannot leave an orphan
        // that can authenticate but has no profile (and no audit trail).
        await admin.auth.admin.deleteUser(created.user.id).catch(() => {});
        throw new Error(`profile insert failed: ${profileError.message}`);
      }

      await logAudit({
        ...actor,
        action: "user.created",
        targetUserId: created.user.id,
        targetEmail: email,
        details: { role, quota, accessExpiresAt: expiresAt },
      });

      return jsonResponse({ userId: created.user.id, email }, 200, headers);
    }

    // -----------------------------------------------------------------------
    case "update": {
      const userId = requireString(body.userId, "userId");

      const { data: target, error: readError } = await admin
        .from("profiles")
        .select("id, email, role")
        .eq("id", userId)
        .maybeSingle();
      if (readError) throw new Error(`profile read failed: ${readError.message}`);
      if (!target) throw new ApiError(ErrorCode.BAD_REQUEST, "No such user.");

      const patch: Record<string, unknown> = {};
      if (body.fullName !== undefined) patch.full_name = body.fullName;
      if (body.notes !== undefined) patch.notes = body.notes;
      if (body.role !== undefined) patch.role = validRole(body.role);
      if (body.quota !== undefined) patch.monthly_request_quota = validQuota(body.quota, 0);
      if (body.accessExpiresAt !== undefined) {
        patch.access_expires_at = validExpiry(body.accessExpiresAt);
      }
      if (body.status !== undefined) {
        const status = String(body.status).toLowerCase();
        if (!["active", "disabled", "expired"].includes(status)) {
          throw new ApiError(
            ErrorCode.BAD_REQUEST,
            "`status` must be active, disabled or expired.",
          );
        }
        patch.status = status;
      }

      if (Object.keys(patch).length === 0) {
        throw new ApiError(ErrorCode.BAD_REQUEST, "Nothing to update.");
      }

      // Guard against locking yourself out of your own admin dashboard.
      if (
        userId === ctx.userId &&
        ((patch.role !== undefined && patch.role !== "admin") ||
          (patch.status !== undefined && patch.status !== "active"))
      ) {
        throw new ApiError(
          ErrorCode.BAD_REQUEST,
          "You cannot remove your own admin access. Ask another admin to do it.",
        );
      }

      const { error } = await admin.from("profiles").update(patch).eq("id", userId);
      if (error) throw new Error(`profile update failed: ${error.message}`);

      await logAudit({
        ...actor,
        action: "user.updated",
        targetUserId: userId,
        targetEmail: target.email,
        details: patch,
      });

      return jsonResponse({ ok: true }, 200, headers);
    }

    // -----------------------------------------------------------------------
    case "disable":
    case "enable": {
      const userId = requireString(body.userId, "userId");
      const disabling = op === "disable";

      if (disabling && userId === ctx.userId) {
        throw new ApiError(ErrorCode.BAD_REQUEST, "You cannot disable your own account.");
      }

      const { data: target } = await admin
        .from("profiles")
        .select("email")
        .eq("id", userId)
        .maybeSingle();
      if (!target) throw new ApiError(ErrorCode.BAD_REQUEST, "No such user.");

      const { error } = await admin
        .from("profiles")
        .update({ status: disabling ? "disabled" : "active" })
        .eq("id", userId);
      if (error) throw new Error(`status change failed: ${error.message}`);

      // No token revocation needed: authenticate() re-reads status on every
      // request, so an existing access token stops working immediately.
      await logAudit({
        ...actor,
        action: disabling ? "user.disabled" : "user.enabled",
        targetUserId: userId,
        targetEmail: target.email,
      });

      return jsonResponse({ ok: true, status: disabling ? "disabled" : "active" }, 200, headers);
    }

    // -----------------------------------------------------------------------
    case "delete": {
      const userId = requireString(body.userId, "userId");
      if (userId === ctx.userId) {
        throw new ApiError(ErrorCode.BAD_REQUEST, "You cannot delete your own account.");
      }

      const { data: target } = await admin
        .from("profiles")
        .select("email")
        .eq("id", userId)
        .maybeSingle();

      // profiles and usage_events both cascade from auth.users, so deleting
      // the auth user is sufficient. The audit entry survives because
      // audit_log stores the email as text rather than only a foreign key.
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw new Error(`delete failed: ${error.message}`);

      await logAudit({
        ...actor,
        action: "user.deleted",
        targetUserId: userId,
        targetEmail: target?.email ?? null,
      });

      return jsonResponse({ ok: true }, 200, headers);
    }

    // -----------------------------------------------------------------------
    case "reset-password": {
      const userId = requireString(body.userId, "userId");
      const password = validPassword(body.password);

      const { data: target } = await admin
        .from("profiles")
        .select("email")
        .eq("id", userId)
        .maybeSingle();
      if (!target) throw new ApiError(ErrorCode.BAD_REQUEST, "No such user.");

      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) throw new Error(`password reset failed: ${error.message}`);

      // The password itself is never written to the audit log.
      await logAudit({
        ...actor,
        action: "user.password_reset",
        targetUserId: userId,
        targetEmail: target.email,
      });

      return jsonResponse({ ok: true }, 200, headers);
    }

    // -----------------------------------------------------------------------
    case "settings.get": {
      const { data, error } = await admin
        .from("app_settings")
        .select("kill_switch, kill_switch_message, default_monthly_quota, allowed_origins, updated_at, updated_by")
        .eq("id", true)
        .single();
      if (error) throw new Error(`settings read failed: ${error.message}`);
      return jsonResponse({ settings: data }, 200, headers);
    }

    case "settings.update": {
      const patch: Record<string, unknown> = { updated_by: ctx.userId };

      if (body.killSwitch !== undefined) patch.kill_switch = Boolean(body.killSwitch);
      if (body.killSwitchMessage !== undefined) {
        patch.kill_switch_message = requireString(body.killSwitchMessage, "killSwitchMessage");
      }
      if (body.defaultQuota !== undefined) {
        patch.default_monthly_quota = validQuota(body.defaultQuota, 0);
      }

      if (Object.keys(patch).length === 1) {
        throw new ApiError(ErrorCode.BAD_REQUEST, "Nothing to update.");
      }

      const { error } = await admin.from("app_settings").update(patch).eq("id", true);
      if (error) throw new Error(`settings update failed: ${error.message}`);

      await logAudit({
        ...actor,
        action: body.killSwitch !== undefined ? "settings.kill_switch" : "settings.updated",
        details: patch,
      });

      return jsonResponse({ ok: true }, 200, headers);
    }

    // -----------------------------------------------------------------------
    case "audit": {
      const limit = Math.max(1, Math.min(Number(body.limit) || 100, 500));
      const { data, error } = await admin
        .from("audit_log")
        .select("id, actor_email, action, target_email, details, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`audit read failed: ${error.message}`);
      return jsonResponse({ entries: data ?? [] }, 200, headers);
    }

    // -----------------------------------------------------------------------
    default:
      throw new ApiError(
        ErrorCode.BAD_REQUEST,
        "Unknown `op`. Expected one of: list, create, update, disable, enable, delete, reset-password, settings.get, settings.update, audit.",
        { received: op },
      );
  }
});

/**
 * Request authentication and authorisation.
 *
 * Every Edge Function funnels through `authenticate()`, which answers one
 * question: may this exact request, right now, do work? It re-reads the
 * profile from the database on every call rather than trusting anything
 * inside the JWT, which is what makes "disable a user and their very next
 * request fails" true without waiting for their token to expire.
 */

import { adminClient } from "./supabase.ts";
import { ApiError, ErrorCode } from "./errors.ts";

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  role: "admin" | "user";
  status: "active" | "disabled" | "expired";
  notes: string | null;
  access_expires_at: string | null;
  monthly_request_quota: number;
  last_active_at: string | null;
  created_at: string;
}

export interface AppSettings {
  kill_switch: boolean;
  kill_switch_message: string;
  default_monthly_quota: number;
}

export interface AuthContext {
  userId: string;
  profile: Profile;
  settings: AppSettings;
}

export interface AuthOptions {
  /**
   * Whether the global kill switch blocks this endpoint.
   *
   * True for product endpoints. False for the admin-* control plane: if the
   * kill switch also blocked the admin API, turning it on would be a one-way
   * door with no way back short of editing the row in the Supabase console.
   */
  enforceKillSwitch?: boolean;
  /** Reject anyone whose profile role is not 'admin'. */
  requireAdmin?: boolean;
}

function bearerToken(req: Request): string {
  const header = req.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new ApiError(
      ErrorCode.MISSING_TOKEN,
      "Sign in to use Amazon Market Research Pro.",
    );
  }
  return match[1].trim();
}

export async function loadSettings(): Promise<AppSettings> {
  const { data, error } = await adminClient()
    .from("app_settings")
    .select("kill_switch, kill_switch_message, default_monthly_quota")
    .eq("id", true)
    .single();

  if (error || !data) {
    throw new Error(`app_settings unreadable: ${error?.message ?? "no row"}`);
  }
  return data as AppSettings;
}

/**
 * Verifies the caller and returns everything downstream code needs.
 *
 * Order is deliberate. Identity is established first so that a kill switch or
 * a disabled account is never reported to an anonymous caller: an attacker
 * probing with a junk token learns only that the token is junk.
 */
export async function authenticate(
  req: Request,
  options: AuthOptions = {},
): Promise<AuthContext> {
  const { enforceKillSwitch = true, requireAdmin = false } = options;
  const admin = adminClient();
  const token = bearerToken(req);

  // 1. Is the JWT real, unexpired, and issued by this project?
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData?.user) {
    throw new ApiError(
      ErrorCode.INVALID_TOKEN,
      "Your session has expired. Please sign in again.",
    );
  }
  const user = userData.user;

  // 2. Does an invited profile exist? An auth.users row on its own grants
  //    nothing: access requires a profile the admin explicitly created.
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select(
      "id, email, full_name, role, status, notes, access_expires_at, monthly_request_quota, last_active_at, created_at",
    )
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) throw new Error(`profile lookup failed: ${profileError.message}`);
  if (!profile) {
    throw new ApiError(
      ErrorCode.NO_PROFILE,
      "This account has no access. Contact your administrator.",
    );
  }
  const typed = profile as Profile;

  // 3. Global kill switch, checked before per-account state so that during
  //    maintenance every user sees the same maintenance message.
  const settings = await loadSettings();
  if (enforceKillSwitch && settings.kill_switch) {
    throw new ApiError(ErrorCode.KILL_SWITCH, settings.kill_switch_message);
  }

  // 4. Per-account state. Expiry is evaluated live rather than by a cron job,
  //    so an account goes dark the moment its expiry passes.
  if (typed.status === "disabled") {
    throw new ApiError(
      ErrorCode.ACCOUNT_DISABLED,
      "Your access has been turned off. Contact your administrator.",
    );
  }

  const expired = typed.access_expires_at !== null &&
    new Date(typed.access_expires_at).getTime() <= Date.now();

  if (expired || typed.status === "expired") {
    throw new ApiError(
      ErrorCode.ACCOUNT_EXPIRED,
      "Your access period has ended. Contact your administrator.",
      typed.access_expires_at ? { expiredAt: typed.access_expires_at } : undefined,
    );
  }

  // 5. Admin gate. Checked against the freshly-read profile row, never
  //    against a claim in the token, so demoting an admin takes effect
  //    immediately.
  if (requireAdmin && typed.role !== "admin") {
    throw new ApiError(
      ErrorCode.NOT_ADMIN,
      "This action requires an administrator account.",
    );
  }

  return { userId: user.id, profile: typed, settings };
}

/** Billable calls used this UTC month, via the month_usage() SQL helper. */
export async function monthUsage(userId: string): Promise<number> {
  const { data, error } = await adminClient().rpc("month_usage", {
    p_user_id: userId,
  });
  if (error) throw new Error(`quota lookup failed: ${error.message}`);
  return Number(data ?? 0);
}

export interface QuotaState {
  used: number;
  limit: number;
  remaining: number;
}

/**
 * Enforces the monthly quota. Throws 403 quota_exceeded when the account has
 * already spent its allowance, and returns the state so the caller can echo
 * it back to the UI.
 */
export async function enforceQuota(ctx: AuthContext): Promise<QuotaState> {
  const limit = ctx.profile.monthly_request_quota;
  const used = await monthUsage(ctx.userId);
  const remaining = Math.max(0, limit - used);

  if (used >= limit) {
    throw new ApiError(
      ErrorCode.QUOTA_EXCEEDED,
      `You have used all ${limit.toLocaleString()} of this month's requests. Your quota resets on the 1st.`,
      { used, limit, remaining: 0 },
    );
  }

  return { used, limit, remaining };
}

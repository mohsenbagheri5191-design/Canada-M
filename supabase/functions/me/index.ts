/**
 * me - who am I, and what am I allowed to do right now?
 *
 * The extension calls this on open and after every sign-in. It is the single
 * source of truth for the gate: if this returns anything other than 200, the
 * dashboards stay locked and the UI renders the matching state.
 *
 * The kill switch is enforced here as well as on research, so maintenance mode
 * is visible the moment the extension opens rather than on first search.
 */

import { serveApi, jsonResponse } from "../_shared/handler.ts";
import { authenticate, monthUsage } from "../_shared/auth.ts";
import { logUsage } from "../_shared/usage.ts";

serveApi(async (req, headers) => {
  const startedAt = Date.now();
  const ctx = await authenticate(req);

  const used = await monthUsage(ctx.userId);
  const limit = ctx.profile.monthly_request_quota;

  // Checking your own profile is free: it would be perverse to charge a user
  // for asking whether they have any quota left.
  await logUsage({
    userId: ctx.userId,
    endpoint: "me",
    responseStatus: 200,
    durationMs: Date.now() - startedAt,
    billable: false,
  });

  return jsonResponse(
    {
      profile: {
        id: ctx.profile.id,
        email: ctx.profile.email,
        fullName: ctx.profile.full_name,
        role: ctx.profile.role,
        status: ctx.profile.status,
        accessExpiresAt: ctx.profile.access_expires_at,
        createdAt: ctx.profile.created_at,
      },
      quota: {
        used,
        limit,
        remaining: Math.max(0, limit - used),
        // Quota windows are UTC calendar months; this is when the counter zeroes.
        resetsAt: new Date(
          Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1),
        ).toISOString(),
      },
      settings: {
        // Always false in a 200 response (a true kill switch throws a 503
        // before reaching here), but sent so the client has one shape to read.
        killSwitch: ctx.settings.kill_switch,
      },
    },
    200,
    headers,
  );
});

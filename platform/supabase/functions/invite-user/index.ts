/**
 * Invite a user.
 *
 * This is the only place in the system that holds the service role key, and it
 * holds it because creating an auth account is the one thing row-level security
 * cannot delegate: there is no row yet to be permitted.
 *
 * That makes the authorisation check here load-bearing rather than defensive.
 * The function runs with a key that bypasses RLS entirely, so it must decide
 * for itself who the caller is and what they may do — and it does that by
 * taking the caller's own JWT, asking the database who that is *as them*, and
 * refusing anything the answer does not support.
 *
 * Two rules follow from that:
 *
 *   · The caller may only invite into their own organisation. A super_admin may
 *     name any organisation; nobody else may name one at all.
 *   · The caller may not grant a role above their own. An org_admin may create
 *     designers and app_users; a designer may create app_users; nobody creates
 *     a super_admin here.
 *
 * The new account's role and organisation go into **app_metadata**, never
 * user_metadata: user_metadata is whatever the signup request said, and the
 * provisioning trigger refuses to read authority out of it.
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, apikey",
  "access-control-allow-methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

/** Roles a caller of each role is allowed to hand out. */
const GRANTABLE: Record<string, string[]> = {
  super_admin: ["org_admin", "designer", "viewer", "app_user"],
  org_admin: ["designer", "viewer", "app_user"],
  designer: ["app_user"],
};

const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) return json({ error: "unauthorized" }, 401);

  // Who is calling? Asked of the database with the caller's own token, so the
  // answer is whatever RLS would give them and not what they claim.
  const me = await fetch(
    `${SUPABASE_URL}/rest/v1/app_users?select=id,email,role,organization_id,status&limit=1`,
    { headers: { apikey: ANON_KEY, authorization: auth } },
  );
  if (!me.ok) return json({ error: "unauthorized" }, 401);

  const rows = await me.json().catch(() => []);
  const caller = Array.isArray(rows) ? rows[0] : null;
  if (!caller || caller.status !== "active") return json({ error: "unauthorized" }, 401);

  const grantable = GRANTABLE[caller.role] ?? [];
  if (grantable.length === 0) return json({ error: "forbidden", message: "Your role cannot invite people." }, 403);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request", message: "Expected a JSON body." }, 400);
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  const role = String(body.role ?? "app_user");
  const fullName = String(body.full_name ?? "").trim();
  const wantedOrg = body.organization_id ? String(body.organization_id) : null;

  if (!EMAIL.test(email)) return json({ error: "bad_request", message: "That does not look like an email address." }, 400);
  if (!grantable.includes(role)) {
    return json({ error: "forbidden", message: `Your role cannot grant \"${role}\".` }, 403);
  }

  // Only a super_admin may invite into an organisation other than their own.
  let organizationId = caller.organization_id;
  if (wantedOrg && wantedOrg !== caller.organization_id) {
    if (caller.role !== "super_admin") {
      return json({ error: "forbidden", message: "You can only invite people into your own organisation." }, 403);
    }
    organizationId = wantedOrg;
  }
  if (!organizationId) {
    return json({ error: "bad_request", message: "No organisation to invite into." }, 400);
  }

  const redirectTo = typeof body.redirect_to === "string" && body.redirect_to.startsWith("https://")
    ? body.redirect_to
    : undefined;

  // The service role starts here and goes no further than this call.
  const invited = await fetch(`${SUPABASE_URL}/auth/v1/invite`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      email,
      data: fullName ? { full_name: fullName } : {},
      // app_metadata is the half the invited person cannot influence, which is
      // why the provisioning trigger reads authority only from here.
      app_metadata: {
        app_role: role,
        organization_id: organizationId,
        must_change_password: true,
        invited_by: caller.id,
      },
      ...(redirectTo ? { redirect_to: redirectTo } : {}),
    }),
  });

  const result = await invited.json().catch(() => ({}));

  if (!invited.ok) {
    const message = String(result.msg ?? result.message ?? "");
    if (invited.status === 422 || /already been registered|already exists/i.test(message)) {
      return json({ error: "already_exists", message: "That email already has an account." }, 409);
    }
    console.error("invite failed", invited.status, message);
    return json({ error: "invite_failed", message: "The invitation could not be sent." }, 502);
  }

  // Audited with the caller's token, so the row is attributed to them and is
  // subject to the same policies as anything else they write.
  await fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
    method: "POST",
    headers: { apikey: ANON_KEY, authorization: auth, "content-type": "application/json", prefer: "return=minimal" },
    body: JSON.stringify({
      actor_id: caller.id,
      actor_email: caller.email,
      organization_id: organizationId,
      action: "user.invite",
      entity_type: "AppUser",
      entity_id: result.id ?? null,
      phrase: `invited ${email} as ${role}`,
    }),
  }).catch(() => {});

  return json({ ok: true, id: result.id ?? null, email, role, organization_id: organizationId });
});

/**
 * Service-role Supabase client.
 *
 * SUPABASE_SERVICE_ROLE_KEY exists only as an Edge Function secret. It is the
 * one credential that bypasses Row Level Security, so it never appears in the
 * extension bundle, the admin dashboard, or any committed file. If it leaks,
 * every table is readable and writable by whoever holds it.
 *
 * The three variables read here are injected automatically by the Edge
 * Function runtime; nothing needs to set them by hand.
 */

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

let cached: SupabaseClient | null = null;

/**
 * Admin client, memoised across invocations of a warm instance.
 *
 * Auth persistence is off deliberately: a module-level client shared between
 * requests must never hold a session, or one caller's token could bleed into
 * the next caller's queries.
 */
export function adminClient(): SupabaseClient {
  if (cached) return cached;

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !serviceKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.",
    );
  }

  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

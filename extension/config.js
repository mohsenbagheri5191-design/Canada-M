/**
 * The entire contents of the extension bundle that count as configuration.
 *
 * Both values below are public by design. The anon key is a JWT that says
 * nothing except "this request is unauthenticated"; it opens no table, because
 * Row Level Security denies the anon role on every one of them, and it opens
 * no Edge Function, because each one verifies a real user JWT before doing
 * work. Publishing it is expected: Supabase ships it to browsers by design.
 *
 * What is NOT here, and must never be added:
 *   - the service role key                (Edge Function secret only)
 *   - any scoring coefficient or threshold (supabase/functions/research/scoring.ts)
 *   - any third-party API key
 *
 * If you are reading this file looking for the formulas, they are not in the
 * bundle. See SECURITY.md.
 */

export const SUPABASE_URL = "https://ftwkxuqqnbtuegabxxnj.supabase.co";

export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ0d2t4dXFxbmJ0dWVnYWJ4eG5qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4Mjk4NzMsImV4cCI6MjEwNDQwNTg3M30.U-rq83swyVQkTwfvWdjX8-_tRdQd9RCoCMTkaJUpgR0";

/** Where the Edge Functions live. */
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

/** Supabase Auth (GoTrue) endpoints used for sign-in and token refresh. */
export const AUTH_URL = `${SUPABASE_URL}/auth/v1`;

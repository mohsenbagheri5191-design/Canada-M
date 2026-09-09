/**
 * Admin console configuration.
 *
 * Same two public values the extension carries, for the same reason: the anon
 * key authenticates nothing on its own. Privilege comes from the JWT minted
 * when an administrator signs in, and every admin-* Edge Function re-checks
 * that JWT's profile row before acting.
 *
 * The service role key must never appear in this file. If it did, anyone who
 * opened this page would hold a credential that bypasses Row Level Security on
 * every table.
 */

window.AMR_CONFIG = {
  SUPABASE_URL: "https://ftwkxuqqnbtuegabxxnj.supabase.co",
  SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ0d2t4dXFxbmJ0dWVnYWJ4eG5qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4Mjk4NzMsImV4cCI6MjEwNDQwNTg3M30.U-rq83swyVQkTwfvWdjX8-_tRdQd9RCoCMTkaJUpgR0",
};

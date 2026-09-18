/**
 * Runtime configuration.
 *
 * The publishable key authenticates nothing on its own — every table has RLS,
 * so what a caller can read is decided by the JWT they present. It is safe in
 * client code. The service role key is the opposite and must never appear here.
 *
 * Overridable at runtime by a `window.__APP_CONFIG__` set before this module
 * loads, so a self-hosted tenant can point the same build at its own project
 * without a rebuild.
 */

const defaults = {
  supabaseUrl: "https://sxsbeavdmfuznigslfnp.supabase.co",
  supabaseKey: "sb_publishable_BALtodXYHyXJ41amq26zhA_17o7gMTI",

  /** How long a cached layout is served before a revalidation is awaited. */
  layoutFreshMs: 5 * 60 * 1000,

  /** Telemetry batching. */
  telemetryBatchSize: 20,
  telemetryFlushMs: 15_000,
  telemetryMaxQueue: 200,
};

export const config = Object.freeze({ ...defaults, ...(globalThis.__APP_CONFIG__ ?? {}) });

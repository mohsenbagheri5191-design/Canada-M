/**
 * Shared setup for the browser suites.
 *
 * Every suite drives a real Chromium against the repository's own files,
 * served by stub.mjs — which also stands in for the Supabase endpoints with
 * payloads captured from the live database. Nothing here needs network access
 * or credentials, so the suites run the same on a laptop, in CI, or in a
 * sandbox that blocks *.supabase.co.
 */

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** The repository root, so the stub can serve app/ and dashboard/ from it. */
export const ROOT = join(here, "..", "..");

/** Screenshots land here. Ignored by git. */
export const OUT = join(here, ".out");
mkdirSync(OUT, { recursive: true });

/**
 * Launch Chromium. Uses Playwright's own browser unless CHROMIUM_PATH points
 * at another one — some sandboxes ship a browser and forbid downloading one.
 */
export const launch = () =>
  chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

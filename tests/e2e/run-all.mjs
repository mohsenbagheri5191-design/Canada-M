/**
 * Run every browser suite in turn and report one line each.
 *
 *   cd tests/e2e && npm install && npm test
 *
 * Each suite starts its own copy of the stub on its own port, so they cannot
 * interfere, and each exits non-zero on any failed check.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const suites = [
  ["app.test.mjs", "sign-in, theme, built-in layout, cache-first, routing, telemetry, preview, error boundary"],
  ["data.test.mjs", "binding real rows, the query built, the allowlist boundary, writes and rollback, Repeater"],
  ["outbox.test.mjs", "offline writes: refused vs unreachable, reload survival, drain, de-duplication"],
  ["dashboard.test.mjs", "every block and screen template renders through the shared registry"],
  ["studio.test.mjs", "all 8 dashboard tabs load; insert a block; the typed item editor"],
];

let failed = 0;
for (const [file, what] of suites) {
  const run = spawnSync(process.execPath, [file], { cwd: here, encoding: "utf8", env: process.env });
  const ok = run.status === 0;
  if (!ok) failed += 1;
  const tally = (run.stdout.match(/(\d+)\/(\d+) checks passed/) ?? [])[0] ?? (ok ? "passed" : "failed");
  console.log(`${ok ? "PASS" : "FAIL"}  ${file.padEnd(20)} ${tally.padEnd(20)} ${what}`);
  if (!ok) {
    const tail = (run.stdout + run.stderr).trim().split("\n").slice(-15).join("\n");
    console.log(tail.replace(/^/gm, "      "));
  }
}

console.log(failed ? `\n${failed} suite(s) failed` : "\nall suites passed");
process.exit(failed ? 1 : 0);

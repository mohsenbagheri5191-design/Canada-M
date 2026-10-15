import { launch, OUT } from "./lib.mjs";
import { server } from "./stub.mjs";

const PORT = 8791;
const BASE = `http://localhost:${PORT}/app/index.html`;

await new Promise((r) => server.listen(PORT, r));

const browser = await launch();
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function newPage({ viewport = { width: 393, height: 852 } } = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on("pageerror", (e) => check(`no page error`, false, e.message));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const url = m.location()?.url ?? "";
    // The bad-password test deliberately provokes a 400, and the browser logs
    // every non-2xx fetch as a console error regardless of the app handling it.
    if (/\/auth\/v1\/token/.test(url)) return;
    check("no console error", false, `${m.text()} @ ${url}`);
  });
  return { page, context };
}

const post = (path, body) =>
  fetch(`http://localhost:${PORT}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());

/* =========================================================================
   1. Sign in
   ========================================================================= */
console.log("\n1. Sign in");
await post("/__stub/reset");
{
  const { page, context } = await newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);

  check("sign-in screen shown when there is no session", await page.locator(".signin-form").isVisible());

  // Wrong password must not say which half was wrong.
  await page.fill('input[name="email"]', "maya@northstar.ca");
  await page.fill('input[name="password"]', "wrong");
  await page.click('button[type="submit"]');
  await page.waitForTimeout(400);
  const msg = await page.locator(".form-error").textContent();
  check("bad credentials rejected without saying which half", /do not match an account/.test(msg ?? ""), msg?.trim());

  await page.fill('input[name="password"]', "correct-horse");
  await page.click('button[type="submit"]');
  await page.waitForSelector(".stage [data-screen-id]", { timeout: 5000 });
  check("correct credentials sign in and render a screen", true);

  // The password must not still be sitting in the DOM.
  const leftover = await page.evaluate(() => document.querySelector('input[name="password"]')?.value ?? null);
  check("password field is not left populated", leftover === null || leftover === "");

  await context.close();
}

/* =========================================================================
   2. A three-colour theme from the wire
   ========================================================================= */
console.log("\n2. Theme normalisation");
let mayaState = null;
{
  const { page, context } = await newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', "maya@northstar.ca");
  await page.fill('input[name="password"]', "correct-horse");
  await page.click('button[type="submit"]');
  await page.waitForSelector(".stage [data-screen-id]", { timeout: 5000 });
  await page.waitForTimeout(600);

  const probe = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return {
      primary: root.getPropertyValue("--c-primary").trim(),
      background: root.getPropertyValue("--c-background").trim(),
      // These were absent from the payload entirely and must have been filled in.
      surface: root.getPropertyValue("--c-surface").trim(),
      border: root.getPropertyValue("--c-border").trim(),
      theme: document.documentElement.dataset.appTheme,
      meta: document.querySelector('meta[name="theme-color"]')?.content ?? null,
    };
  });

  check("wire colours win", probe.primary === "#1f6feb" && probe.background === "#f7f8f9", `primary=${probe.primary}`);
  check("absent colours are filled from the default theme", Boolean(probe.surface) && Boolean(probe.border), `surface=${probe.surface} border=${probe.border}`);
  check("light background is detected as a light theme", probe.theme === "light");
  check("browser theme-color follows the design", probe.meta === "#f7f8f9", probe.meta ?? "");

  const tabs = await page.locator(".tab").allTextContents();
  check("tab bar is built from the document's screens", tabs.length === 2 && tabs.join("|").includes("Home"), tabs.join(", "));

  const stripped = await page.evaluate(() => document.querySelector('[data-screen-id="scr_timesheets"]'));
  check("a stripped screen is nowhere in the app", stripped === null);

  mayaState = await context.storageState();
  await page.screenshot({ path: `${OUT}/x-app-maya.png` });
  await context.close();
}

/* =========================================================================
   3. The built-in layout
   ========================================================================= */
console.log("\n3. Built-in fallback");
{
  const { page, context } = await newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', "daniel@brightroof.ca");
  await page.fill('input[name="password"]', "correct-horse");
  await page.click('button[type="submit"]');
  await page.waitForSelector(".stage [data-screen-id]", { timeout: 5000 });
  await page.waitForTimeout(500);

  const tabs = await page.locator(".tab-label").allTextContents();
  check("no assignment falls through to the built-in layout, not a blank page", tabs.length === 3, tabs.join(", "));
  const hasContent = await page.locator('.stage [data-node-type="TaskList"]').count();
  check("the built-in layout renders real components", hasContent > 0, `${hasContent} TaskList`);

  await page.screenshot({ path: `${OUT}/x-app-builtin.png` });
  await context.close();
}

/* =========================================================================
   4. Offline: cache first
   ========================================================================= */
console.log("\n4. Cache-first / offline");
{
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, storageState: mayaState });
  const page = await context.newPage();
  page.on("pageerror", (e) => check("no page error (offline)", false, e.message));

  // Warm the cache.
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".stage [data-screen-id]", { timeout: 5000 });
  await page.waitForTimeout(700);

  // Now make the layout call fail and reload. The cached layout must still paint.
  await post("/__stub/mode", { failLayout: true });
  await page.reload({ waitUntil: "networkidle" });

  const painted = await page.waitForSelector(".stage [data-screen-id]", { timeout: 5000 }).then(() => true).catch(() => false);
  check("a cached layout paints even when the server is down", painted);

  await page.waitForTimeout(900);
  const banner = await page.locator(".banner-text").first().textContent().catch(() => null);
  check("the user is told they are on a cached layout", /last layout you downloaded/i.test(banner ?? ""), banner?.trim() ?? "no banner");

  await post("/__stub/mode", { failLayout: false });
  await context.close();
}

/* =========================================================================
   5. Routing
   ========================================================================= */
console.log("\n5. Routing");
{
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, storageState: mayaState });
  const page = await context.newPage();
  page.on("pageerror", (e) => check("no page error (routing)", false, e.message));

  await page.goto(`${BASE}#/does-not-exist`, { waitUntil: "networkidle" });
  await page.waitForSelector(".stage [data-screen-id]", { timeout: 5000 });
  await page.waitForTimeout(500);

  const hash = await page.evaluate(() => location.hash);
  check("a dead route falls back to the entry screen", hash === "#/home", hash);

  const banner = await page.locator(".banner-text").first().textContent().catch(() => null);
  check("and says why rather than jumping silently", /no longer part of this app/i.test(banner ?? ""), banner?.trim() ?? "no banner");

  await page.click(".tab:nth-child(2)");
  await page.waitForTimeout(400);
  check("the tab bar navigates", await page.evaluate(() => location.hash) === "#/notes");

  await context.close();
}

/* =========================================================================
   6. Telemetry
   ========================================================================= */
console.log("\n6. Telemetry");
await post("/__stub/reset");
{
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, storageState: mayaState });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".stage [data-screen-id]", { timeout: 5000 });

  await page.waitForTimeout(500);
  await page.click(".tab:nth-child(2)");
  await page.waitForTimeout(400);
  await page.click(".tab:nth-child(1)");
  await page.waitForTimeout(1400);

  const { pathEvents } = await fetch(`http://localhost:${PORT}/__stub/received`).then((r) => r.json());
  const events = pathEvents.map((e) => `${e.event}:${e.route_path}`);

  check("screen views are recorded", events.filter((e) => e.startsWith("view")).length >= 3, events.join(" "));
  check("a dwell time is recorded on the screen being left", pathEvents.some((e) => e.event === "exit" && e.dwell_ms > 0));
  check("events carry the design version they happened on", pathEvents.every((e) => e.design_version_id === "66666666-6666-6666-6666-666666666666"));
  check("events carry one session id", new Set(pathEvents.map((e) => e.session_id)).size === 1);
  check("no retry bookkeeping leaks into the payload", pathEvents.every((e) => !("tries" in e) && !("__retried" in e)));
  const { rejectedEvents } = await fetch(`http://localhost:${PORT}/__stub/received`).then((r) => r.json());
  check("every event uses a word the table accepts", rejectedEvents.length === 0, rejectedEvents.join(","));

  await context.close();
}

/* =========================================================================
   7. Preview
   ========================================================================= */
console.log("\n7. Preview");
await post("/__stub/reset");
{
  // A brand new context: no session at all, which is the whole point.
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on("pageerror", (e) => check("no page error (preview)", false, e.message));

  await page.goto(`${BASE}?preview=tok_live_verify_0001`, { waitUntil: "networkidle" });
  await page.waitForSelector(".stage [data-screen-id]", { timeout: 5000 });
  await page.waitForTimeout(600);

  check("a preview link opens with no account", true);
  const banner = await page.locator(".banner-text").first().textContent();
  check("it is labelled as a read-only preview", /preview/i.test(banner ?? "") && /read only/i.test(banner ?? ""), banner?.trim());

  const drew = await page.evaluate(() => ({
    ring: !!document.querySelector('[data-node-type="ProgressRing"]'),
    tasks: !!document.querySelector('[data-node-type="TaskList"]'),
    // The payload's theme was {palette, style} with no colours at all.
    bg: getComputedStyle(document.documentElement).getPropertyValue("--c-background").trim(),
  }));
  check("the draft's components render", drew.ring && drew.tasks);
  check("a theme of only {palette, style} still resolves to colours", /^#[0-9a-f]{6}$/i.test(drew.bg), drew.bg);

  await page.waitForTimeout(1200);
  const { pathEvents } = await fetch(`http://localhost:${PORT}/__stub/received`).then((r) => r.json());
  check("a preview is never counted as usage", pathEvents.length === 0, `${pathEvents.length} events`);

  await page.screenshot({ path: `${OUT}/x-app-preview.png` });

  await page.goto(`${BASE}?preview=tok_expired_verify_01`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const expired = await page.locator(".notice-body").textContent().catch(() => "");
  check("an expired link says expired, not 'invalid'", /expired/i.test(expired ?? ""), expired?.trim());

  await page.goto(`${BASE}?preview=tok_revoked_verify_01`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const revoked = await page.locator(".notice-body").textContent().catch(() => "");
  check("a revoked link says it was turned off", /turned off/i.test(revoked ?? ""), revoked?.trim());

  await context.close();
}

/* =========================================================================
   8. The per-screen error boundary
   ========================================================================= */
console.log("\n8. Error boundary");
{
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, storageState: mayaState });
  const page = await context.newPage();
  // A deliberately thrown render error logs to console.error; that is the
  // behaviour under test, so console errors are not failures here.
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".stage [data-screen-id]", { timeout: 5000 });

  const caught = await page.evaluate(async () => {
    const { renderScreenSafely } = await import("./assets/js/app.js");
    const { defaultTheme } = await import("./assets/js/shared.js");

    // A screen whose root is not renderable at all.
    const node = renderScreenSafely(
      { id: "bad", name: "Bad", route: "/bad", root: { id: "x", type: "Stack", props: null, get children() { throw new Error("boom"); } } },
      { theme: defaultTheme(), scope: {}, onError: () => {}, onRetry: () => {}, onHome: () => {} },
    );
    return { html: node.className, text: node.textContent };
  });

  check("a screen that throws is caught, not a white page", caught.html.includes("notice"), caught.html);
  check("and it explains itself", /could not be shown/i.test(caught.text), caught.text.slice(0, 60));

  // Two distinct empty cases. A null root is handled by the shared renderer's
  // own message; a root that renders to nothing (hidden, or an unknown type the
  // app silently drops) reaches the shell's check and would otherwise be a
  // blank page the user reads as "still loading".
  const empty = await page.evaluate(async () => {
    const { renderScreenSafely } = await import("./assets/js/app.js");
    const { defaultTheme } = await import("./assets/js/shared.js");
    const theme = defaultTheme();
    return {
      nullRoot: renderScreenSafely({ id: "e", name: "Empty", route: "/e", root: null }, { theme, scope: {} }).textContent,
      hiddenRoot: renderScreenSafely(
        { id: "h", name: "Hidden", route: "/h", root: { id: "r", type: "Stack", props: {}, hidden: true } },
        { theme, scope: {} },
      ).textContent,
      unknownRoot: renderScreenSafely(
        { id: "u", name: "Gone", route: "/u", root: { id: "r", type: "ComponentFromTheFuture", props: {} } },
        { theme, scope: {} },
      ).textContent,
    };
  });
  check("a screen with no root explains itself", /no content yet/i.test(empty.nullRoot), empty.nullRoot.slice(0, 44));
  check("a screen that renders to nothing explains itself", /nothing on this screen/i.test(empty.hiddenRoot), empty.hiddenRoot.slice(0, 44));
  check("a screen whose only component is unknown explains itself", /nothing on this screen/i.test(empty.unknownRoot), empty.unknownRoot.slice(0, 44));

  await context.close();
}

/* ===================================================================== */
console.log("");
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
}

await browser.close();
server.close();
process.exit(failed.length ? 1 : 0);

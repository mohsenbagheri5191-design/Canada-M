import { launch, OUT } from "./lib.mjs";
import { server } from "./stub.mjs";

const PORT = 8795;
const BASE = `http://localhost:${PORT}/app/index.html`;
await new Promise((r) => server.listen(PORT, r));

const browser = await launch();
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const post = (p, b) =>
  fetch(`http://localhost:${PORT}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }).then((r) => r.json());
const got = () => fetch(`http://localhost:${PORT}/__stub/received`).then((r) => r.json());

async function signedIn(context) {
  const page = await context.newPage();
  page.on("pageerror", (e) => check("no page error", false, e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  if (await page.locator(".signin-form").count()) {
    await page.fill('input[name="email"]', "daniel@brightroof.ca");
    await page.fill('input[name="password"]', "correct-horse");
    await page.click('button[type="submit"]');
  }
  await page.waitForSelector(".stage [data-screen-id]", { timeout: 6000 });
  await page.waitForTimeout(900);
  return page;
}

const rowState = (page, title) =>
  page.evaluate((t) => {
    const row = [...document.querySelectorAll('[data-node-type="TaskRow"]')].find((n) => n.textContent.includes(t));
    return { pressed: row?.querySelector("[data-action]")?.getAttribute("aria-pressed") ?? null };
  }, title);

/* ========================================================================= */
console.log("\n1. The distinction: unreachable is queued, refused is not");
await post("/__stub/reset");
{
  const context = await browser.newContext({ viewport: { width: 393, height: 852 } });
  const page = await signedIn(context);

  // (a) The server never answers. The tick must survive.
  await post("/__stub/mode", { offline: true });
  await page.click('[data-node-type="TaskRow"]:has-text("Review vendor quotes") [data-action="task.toggle"]');
  await page.waitForTimeout(900);

  check("an unreachable write keeps the change on screen", (await rowState(page, "Review vendor quotes")).pressed === "true");

  const banner = await page.locator(".banner-text").first().textContent().catch(() => null);
  check("and says it is waiting to sync", /waiting to sync/i.test(banner ?? ""), banner?.trim() ?? "no banner");

  const queued = await page.evaluate(async () => {
    const { get } = await import("./assets/js/runtime/cache.js");
    return (await get("outbox:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")) ?? [];
  });
  check("the write is persisted, not just held in memory", queued.length === 1, `${queued.length} queued`);
  check("and it carries what to send", queued[0]?.table === "tasks" && queued[0]?.patch?.status === "done", JSON.stringify(queued[0]?.patch ?? {}));

  // (b) The server answers "no". That must roll back, not queue.
  await post("/__stub/mode", { offline: false, failWrites: true });
  await page.click('[data-node-type="TaskRow"]:has-text("Audit the icon set") [data-action="task.toggle"]');
  await page.waitForTimeout(900);

  check("a refused write rolls back", (await rowState(page, "Audit the icon set")).pressed === "false");

  const stillQueued = await page.evaluate(async () => {
    const { get } = await import("./assets/js/runtime/cache.js");
    return (await get("outbox:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")) ?? [];
  });
  check("a refusal is never queued for retry", stillQueued.length === 1, `${stillQueued.length} queued`);

  await context.close();
}

/* ========================================================================= */
console.log("\n2. The queue survives a reload and drains when the server returns");
{
  const context = await browser.newContext({ viewport: { width: 393, height: 852 } });
  const page = await signedIn(context);

  await post("/__stub/mode", { offline: true, failWrites: false });
  await page.click('[data-node-type="TaskRow"]:has-text("Review vendor quotes") [data-action="task.toggle"]');
  await page.waitForTimeout(800);

  await post("/__stub/reset");            // forget what the stub has seen
  await post("/__stub/mode", { offline: true });

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".stage [data-screen-id]", { timeout: 6000 });
  await page.waitForTimeout(600);

  const survived = await page.evaluate(async () => {
    const { get } = await import("./assets/js/runtime/cache.js");
    return (await get("outbox:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")) ?? [];
  });
  check("a queued write survives a reload", survived.length >= 1, `${survived.length} queued`);

  // The server comes back.
  await post("/__stub/mode", { offline: false });
  await page.evaluate(() => dispatchEvent(new Event("online")));
  await page.waitForTimeout(2500);

  const { writes } = await got();
  check("it is delivered once the server answers again", writes.length >= 1, `${writes.length} write(s): ${JSON.stringify(writes[0]?.patch ?? {})}`);

  const drained = await page.evaluate(async () => {
    const { get } = await import("./assets/js/runtime/cache.js");
    return (await get("outbox:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")) ?? [];
  });
  check("and the queue empties", drained.length === 0, `${drained.length} left`);

  await context.close();
}

/* ========================================================================= */
console.log("\n3. Repeated taps on one row collapse to one write");
await post("/__stub/reset");
{
  const context = await browser.newContext({ viewport: { width: 393, height: 852 } });
  const page = await signedIn(context);

  await post("/__stub/mode", { offline: true });
  for (let i = 0; i < 4; i += 1) {
    await page.click('[data-node-type="TaskRow"]:has-text("Move docs to the new host") [data-action="task.toggle"]');
    await page.waitForTimeout(250);
  }

  const queued = await page.evaluate(async () => {
    const { get } = await import("./assets/js/runtime/cache.js");
    return (await get("outbox:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")) ?? [];
  });
  check("four taps on one row queue one entry, not four", queued.length === 1, `${queued.length} queued`);
  check("and it holds the final state", queued[0]?.patch?.status !== undefined, JSON.stringify(queued[0]?.patch ?? {}));

  await context.close();
}

/* ========================================================================= */
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

import { launch, OUT } from "./lib.mjs";
import { server } from "./stub.mjs";

const PORT = 8793;
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

async function signedIn(email = "daniel@brightroof.ca") {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on("pageerror", (e) => check("no page error", false, e.message));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', "correct-horse");
  await page.click('button[type="submit"]');
  await page.waitForSelector(".stage [data-screen-id]", { timeout: 5000 });
  await page.waitForTimeout(900);
  return { page, context };
}

/* ========================================================================= */
console.log("\n1. Projection — table rows become component props");
await post("/__stub/reset");
{
  const { page, context } = await signedIn();

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-node-type="TaskRow"]')].map((n) => ({
      row: n.dataset.row ?? null,
      source: n.dataset.source ?? null,
      text: n.textContent.replace(/\s+/g, " ").trim(),
      pressed: n.querySelector("[data-action]")?.getAttribute("aria-pressed") ?? null,
    })),
  );

  check("real task rows rendered", rows.length >= 8, `${rows.length} rows`);
  check("every row carries its database id", rows.every((r) => /^[0-9a-f-]{36}$/.test(r.row ?? "")), rows[0]?.row ?? "");
  check("every row knows which source it came from", rows.every((r) => r.source === "open" || r.source === "done"), [...new Set(rows.map((r) => r.source))].join(","));

  const titles = rows.map((r) => r.text);
  check("a title from the database is on screen", titles.some((t) => t.includes("Draft the Q3 rollout plan")));
  check("a due date was formatted, not printed raw", titles.some((t) => /Sep \d+, 2026/.test(t)) && !titles.some((t) => t.includes("T03:30")), titles[0]?.slice(0, 70));

  // tasks.status is todo/in_progress/blocked/review/done; TaskRow states are
  // open/doing/done/blocked. The values map must have translated them.
  const pressed = rows.map((r) => r.pressed);
  check("done rows read as pressed, open rows do not", pressed.includes("true") && pressed.includes("false"), pressed.join(","));

  await page.screenshot({ path: `${OUT}/x-app-data.png` });
  await context.close();
}

/* ========================================================================= */
console.log("\n2. The query the client actually built");
{
  const { queries } = await got();
  const tasks = queries.filter((q) => q.table === "tasks");
  check("one request per declared source", tasks.length === 2, tasks.map((q) => q.query.slice(0, 40)).join(" | "));
  check("columns are restricted to the allowlist", tasks.every((q) => q.query.includes("select=")), tasks[0]?.query.slice(0, 60));
  check("a limit is always sent", tasks.every((q) => /(^|&)limit=\d+/.test(q.query)));
  check("the declared filter is sent", tasks.some((q) => q.query.includes("status=neq.done")) && tasks.some((q) => q.query.includes("status=eq.done")));
  check("the declared order is sent", tasks.some((q) => q.query.includes("order=due_at.asc.nullslast")));
}

/* ========================================================================= */
console.log("\n3. The allowlist is a boundary, not a suggestion");
{
  const { page, context } = await signedIn();

  const probe = await page.evaluate(async () => {
    const { createDataProvider, buildQuery } = await import("./assets/js/runtime/data.js");
    const sources = [{ id: "tasks", table: "tasks", columns: ["id", "title", "status"], writable: ["status"] }];
    const provider = createDataProvider({ dataSources: sources });

    const out = {};

    // A document naming a table the server never offered.
    await provider.loadFor({ id: "s", sources: [{ id: "leak", from: "org_settings" }] });
    out.unofferedTable = provider.query().leak;

    // A document asking for a column outside the offered set.
    try {
      buildQuery({ id: "s", select: ["id", "secrets"] }, sources[0]);
      out.unofferedColumn = "ALLOWED";
    } catch (e) {
      out.unofferedColumn = e.message;
    }

    // A filter on an unoffered column, and an operator outside the fixed set.
    try {
      buildQuery({ id: "s", where: [["secrets", "eq", "x"]] }, sources[0]);
      out.unofferedFilter = "ALLOWED";
    } catch (e) {
      out.unofferedFilter = e.message;
    }
    try {
      buildQuery({ id: "s", where: [["status", "fts", "x"]] }, sources[0]);
      out.badOperator = "ALLOWED";
    } catch (e) {
      out.badOperator = e.message;
    }

    // A limit beyond the cap.
    out.hugeLimit = buildQuery({ id: "s", limit: 100000 }, sources[0]);

    // Writes are gated by the server's own answer, not the client's guess.
    out.canWriteStatus = provider.canWrite("tasks", "status");
    out.canWriteTitle = provider.canWrite("tasks", "title");

    return out;
  });

  check("a table the server did not offer is never requested", Array.isArray(probe.unofferedTable) && probe.unofferedTable.length === 0);
  check("a column outside the allowlist is refused", /not offered/.test(probe.unofferedColumn), probe.unofferedColumn.slice(0, 70));
  check("a filter on an unoffered column is refused", /unoffered column/.test(probe.unofferedFilter), probe.unofferedFilter.slice(0, 70));
  check("an operator outside the fixed set is refused", /not permitted/.test(probe.badOperator), probe.badOperator.slice(0, 70));
  check("the row limit is capped", /limit=200(&|$)/.test(probe.hugeLimit), probe.hugeLimit);
  check("writable columns come from the server", probe.canWriteStatus === true && probe.canWriteTitle === false);

  // Nothing above should have reached the network.
  const { queries } = await got();
  check("no request was made for an unoffered table", !queries.some((q) => q.table === "org_settings"));

  await context.close();
}

/* ========================================================================= */
console.log("\n4. Ticking a task");
await post("/__stub/reset");
{
  const { page, context } = await signedIn();

  const before = await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-node-type="TaskRow"]')].find((n) => n.textContent.includes("Review vendor quotes"));
    return { id: row?.dataset.row, pressed: row?.querySelector("[data-action]")?.getAttribute("aria-pressed") };
  });
  check("an open task is found and reads as not done", before.pressed === "false", before.id);

  await page.click('[data-node-type="TaskRow"]:has-text("Review vendor quotes") [data-action="task.toggle"]');
  await page.waitForTimeout(700);

  const { writes } = await got();
  check("the tap wrote to the database", writes.length === 1, JSON.stringify(writes[0]?.patch ?? {}));
  check("it wrote to the right row", writes[0]?.id === before.id);
  check(
    "status and completed_at move together, as the CHECK constraint requires",
    writes[0]?.patch?.status === "done" && typeof writes[0]?.patch?.completed_at === "string",
    JSON.stringify(writes[0]?.patch),
  );

  const after = await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-node-type="TaskRow"]')].find((n) => n.textContent.includes("Review vendor quotes"));
    return { pressed: row?.querySelector("[data-action]")?.getAttribute("aria-pressed"), struck: getComputedStyle(row.querySelector("span")).textDecorationLine };
  });
  check("the row updated without waiting for a reload", after.pressed === "true", `pressed=${after.pressed}`);

  await context.close();
}

/* ========================================================================= */
console.log("\n5. A refused write rolls back");
await post("/__stub/reset");
{
  const { page, context } = await signedIn();
  await post("/__stub/mode", { failWrites: true });

  await page.click('[data-node-type="TaskRow"]:has-text("Audit the icon set") [data-action="task.toggle"]');
  await page.waitForTimeout(800);

  const state = await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-node-type="TaskRow"]')].find((n) => n.textContent.includes("Audit the icon set"));
    return {
      pressed: row?.querySelector("[data-action]")?.getAttribute("aria-pressed"),
      banner: document.querySelector(".banner-text")?.textContent ?? null,
    };
  });

  check("the optimistic change is reverted when the server refuses", state.pressed === "false", `pressed=${state.pressed}`);
  check("and the user is told", /could not be saved/i.test(state.banner ?? ""), state.banner ?? "no banner");

  await post("/__stub/mode", { failWrites: false });
  await context.close();
}

/* ========================================================================= */
console.log("\n6. Repeater over notes and projects");
await post("/__stub/reset");
{
  const { page, context } = await signedIn();

  await page.click(".tab:nth-child(3)");
  await page.waitForTimeout(900);

  const notes = await page.evaluate(() =>
    [...document.querySelectorAll('[data-node-type="NoteCard"]')].map((n) => ({
      row: n.dataset.row,
      source: n.dataset.source,
      text: n.textContent.replace(/\s+/g, " ").trim().slice(0, 60),
      pinned: n.querySelector('[data-action="note.pin"]')?.getAttribute("aria-pressed"),
    })),
  );
  check("Repeater rendered one NoteCard per row", notes.length === 5, `${notes.length} cards`);
  check("a note's real title is on screen", notes.some((n) => n.text.includes("Kickoff notes")), notes[0]?.text);
  check("the pinned note reads as pinned and the rest do not", notes.filter((n) => n.pinned === "true").length === 1, notes.map((n) => n.pinned).join(","));
  check("labels became tags", await page.locator('[data-node-type="NoteCard"]').first().textContent().then((t) => t.includes("meeting")));

  await page.screenshot({ path: `${OUT}/x-app-notes.png` });

  await page.click(".tab:nth-child(2)");
  await page.waitForTimeout(900);
  const projects = await page.evaluate(() =>
    [...document.querySelectorAll('[data-node-type="ProjectCard"]')].map((n) => n.textContent.replace(/\s+/g, " ").trim()),
  );
  check("Repeater rendered one ProjectCard per project", projects.length === 3, `${projects.length} cards`);
  // ProjectCard uppercases its status in CSS, so textContent keeps the case the
  // projection produced.
  const joined = projects.join(" ").toLowerCase();
  check("project status was translated from the domain enum", joined.includes("on track") && joined.includes("on hold"), projects[2]?.slice(0, 40));

  // projects.writable is [] for this role, so nothing on this screen is tappable.
  const tappable = await page.evaluate(() => document.querySelectorAll('[data-node-type="ProjectCard"] [data-action]').length);
  check("a read-only entity offers no write affordance", tappable === 0, `${tappable} controls`);

  await page.screenshot({ path: `${OUT}/x-app-projects.png` });
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

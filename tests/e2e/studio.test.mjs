import { launch, OUT } from "./lib.mjs";

import { server } from "./stub.mjs";

const PORT = 8798;
const BASE = `http://localhost:${PORT}/dashboard/index.html`;
await new Promise((r) => server.listen(PORT, r));

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const log = [];
page.on("pageerror", (e) => log.push(`[pageerror] ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") log.push(`[console] ${m.text()}`); });

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(900);

const tabs = ["overview", "studio", "library", "assignments", "paths", "appdata", "features", "rules"];
for (const tab of tabs) {
  await page.evaluate((t) => { window.location.hash = `#/${t}`; }, tab);
  await page.waitForTimeout(700);
}
console.log(`visited ${tabs.length} tabs`);

// Back into the studio, open a design, and drive the Insert palette.
await page.evaluate(() => { window.location.hash = "#/studio"; });
await page.waitForTimeout(1500);

// The Insert panel is one of five inspector tabs and is not open by default.
await page.evaluate(() => {
  [...document.querySelectorAll(".seg-btn, .panel-tab, [data-panel]")].find((n) => n.textContent.trim() === "Insert")?.click();
});
await page.waitForTimeout(900);

const groups = await page.evaluate(() => {
  const headings = [...document.querySelectorAll(".palette-group, .section, h3, .section-head")]
    .map((n) => n.textContent.trim())
    .filter((t) => /Tasks & projects|Notes & labels/.test(t));
  return { headings: [...new Set(headings.map((t) => t.slice(0, 24)))], cards: document.querySelectorAll(".palette-card").length };
});
console.log(`insert palette: ${groups.cards} cards; new group headings ${groups.headings.length ? "present" : "MISSING"}`);

// Find a "Task list" block card in the Insert panel and click it, then read
// back whether a TaskList landed on the canvas and the inspector edits it.
const inserted = await page.evaluate(async () => {
  const cards = [...document.querySelectorAll("button, .palette-card, .block-card, [role='button']")];
  // A card's text begins with its live miniature's content, so match anywhere.
  const card = cards.find((n) => (n.textContent ?? "").includes("Today's tasks"));
  if (!card) return { ok: false, why: "no \"Today's tasks\" card in the Insert panel" };
  card.click();
  await new Promise((r) => setTimeout(r, 700));
  const node = document.querySelector('.device [data-node-type="TaskList"]');
  return { ok: Boolean(node), why: node ? "" : "clicked but no TaskList on the canvas" };
});
console.log(`inserting "Today's tasks": ${inserted.ok ? "landed on the canvas" : `FAILED — ${inserted.why}`}`);

if (inserted.ok) {
  // Select the inserted node on the canvas the way a person would, then open
  // the Style panel where the item editor lives.
  const box = await page.locator('.device [data-node-type="TaskList"]').first().boundingBox();
  await page.mouse.click(box.x + 8, box.y + 8);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    [...document.querySelectorAll(".seg-btn, .panel-tab, [data-panel]")].find((n) => n.textContent.trim() === "Style")?.click();
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/x-ui-insert.png` });

  // The typed item editor: a task's State should be a <select>, and Done on a
  // checklist should be a switch — not a text box that writes "true".
  const typed = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".action-card")];
    const selects = cards.flatMap((c) => [...c.querySelectorAll("select")]).length;
    const switches = cards.flatMap((c) => [...c.querySelectorAll("input[type=checkbox], .switch, [role=switch]")]).length;
    const moves = cards.flatMap((c) => [...c.querySelectorAll("button[data-tip='Move up'], button[data-tip='Move down']")]).length;
    const heads = cards.map((c) => c.querySelector(".action-card-head .spacer, .action-card-head span")?.textContent?.trim()).filter(Boolean);
    return { cards: cards.length, selects, switches, moves, heads: heads.slice(0, 4) };
  });
  console.log(`item editor: ${typed.cards} rows, ${typed.selects} selects, ${typed.moves} reorder buttons`);
  console.log(`row headers read: ${JSON.stringify(typed.heads)}`);
}

console.log("");
console.log(log.length ? `ERRORS:\n${log.join("\n")}` : "no page errors across the whole pass");

await browser.close();
server.close();
process.exit(log.length || !inserted.ok ? 1 : 0);

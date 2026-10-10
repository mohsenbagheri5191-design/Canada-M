import { launch, OUT } from "./lib.mjs";

import { server } from "./stub.mjs";

const PORT = 8797;
const BASE = `http://localhost:${PORT}/dashboard/index.html`;
await new Promise((r) => server.listen(PORT, r));

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const log = [];
page.on("pageerror", (e) => log.push(`[pageerror] ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") log.push(`[console] ${m.text()}`); });

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);

const result = await page.evaluate(async () => {
  const { renderScreen } = await import("./assets/js/render/renderer.js");
  const { makeTheme } = await import("./assets/js/data/styles.js");
  const { registry, categories } = await import("./assets/js/data/registry.js");
  const { blocks, blockGroups, screenTemplates } = await import("./assets/js/data/presets.js");

  const problems = [];
  const theme = makeTheme("graphite", "flat");

  // A block or template referring to a component that does not exist is a
  // dead entry in the Insert panel; walk every tree and check every type.
  const walk = (node, seen) => {
    if (!node) return;
    if (!registry[node.type]) seen.push(node.type);
    for (const child of node.children ?? []) walk(child, seen);
  };

  for (const group of blockGroups) {
    if (!blocks.some((b) => b.group === group.key)) problems.push(`block group "${group.key}" has no blocks`);
  }
  for (const block of blocks) {
    if (!blockGroups.some((g) => g.key === block.group)) problems.push(`block "${block.key}" has an unknown group "${block.group}"`);
  }

  const keys = new Set();
  for (const block of [...blocks, ...screenTemplates]) {
    if (keys.has(block.key)) problems.push(`duplicate preset key "${block.key}"`);
    keys.add(block.key);
  }

  // Render each one for real and count what the renderer refused to draw.
  let seed = 0;
  const stamp = (node) => {
    if (!node) return node;
    node.id = `p${seed++}`;
    (node.children ?? []).forEach(stamp);
    return node;
  };

  const host = document.createElement("div");
  Object.assign(host.style, { position: "fixed", left: "-9999px", top: "0", width: "393px" });
  document.body.appendChild(host);

  const render = (label, tree) => {
    const missing = [];
    walk(tree, missing);
    if (missing.length) {
      problems.push(`${label}: unknown component(s) ${[...new Set(missing)].join(", ")}`);
      return;
    }
    const screen = { id: `s${seed}`, name: label, route: `/${seed++}`, root: stamp(tree) };
    let node;
    try {
      node = renderScreen(screen, { theme, scope: {}, editable: false });
    } catch (error) {
      problems.push(`${label}: renderScreen threw — ${error.message}`);
      return;
    }
    host.replaceChildren(node);
    const failed = [...node.querySelectorAll("[data-render-error]")].map((n) => n.getAttribute("data-node-type"));
    if (failed.length) problems.push(`${label}: render fallback on ${[...new Set(failed)].join(", ")}`);
    if (node.getBoundingClientRect().height < 10) problems.push(`${label}: collapsed to nothing`);
  };

  for (const block of blocks) {
    try {
      render(`block ${block.key}`, block.tree());
    } catch (error) {
      problems.push(`block ${block.key}: tree() threw — ${error.message}`);
    }
  }
  for (const template of screenTemplates) {
    if (template.key === "blank") continue;
    try {
      render(`screen ${template.key}`, template.tree());
    } catch (error) {
      problems.push(`screen ${template.key}: tree() threw — ${error.message}`);
    }
  }

  host.remove();

  // Every registry component should be reachable from at least one preset, or
  // the palette offers something nobody has a starting point for.
  const used = new Set();
  for (const source of [...blocks, ...screenTemplates]) {
    try {
      const collect = (node) => {
        if (!node) return;
        used.add(node.type);
        (node.children ?? []).forEach(collect);
      };
      collect(source.tree());
    } catch { /* already reported above */ }
  }
  const orphans = Object.keys(registry).filter((t) => !used.has(t));

  return {
    problems,
    counts: { blocks: blocks.length, screens: screenTemplates.length, components: Object.keys(registry).length, categories: categories.length },
    orphans,
  };
});

console.log(log.length ? log.join("\n") : "no page errors");
console.log("");
console.log(`  ${result.counts.components} components in ${result.counts.categories} categories`);
console.log(`  ${result.counts.blocks} blocks, ${result.counts.screens} screen templates`);
console.log(`  components with no preset: ${result.orphans.length ? result.orphans.join(", ") : "none"}`);
console.log("");
if (result.problems.length) {
  console.log("PROBLEMS:");
  for (const p of result.problems) console.log(`  - ${p}`);
} else {
  console.log("every block and screen template rendered clean");
}

await browser.close();
server.close();
process.exit(result.problems.length || log.length ? 1 : 0);

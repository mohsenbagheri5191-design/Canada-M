/**
 * The application shell: rail, top bar, routing, command palette, shortcuts.
 *
 * Tabs are lazy ES module imports. Each exports `mount(host, ctx)` and may
 * return a teardown function. The shell owns nothing inside a tab.
 */

import { el, mount, on, $, delegate } from "./dom.js";
import { icon } from "./icons.js";
import { Store, persist, bus } from "./store.js";
import { fuzzy, hueOf, fmt } from "./util.js";
import { menu, modal, toast, initTooltips, searchField, closePopover } from "./ui.js";
import { db } from "../data/db.js";

/* ---------------------------------------------------------------------------
   Tabs
   --------------------------------------------------------------------------- */

export const TABS = [
  { key: "overview", label: "Overview", glyph: "overview", group: "Admin", load: () => import("../tabs/overview.js") },
  { key: "studio", label: "Design Studio", glyph: "studio", group: "Design", load: () => import("../tabs/studio.js"), full: true },
  { key: "library", label: "Design Library", glyph: "library", group: "Design", load: () => import("../tabs/library.js") },
  { key: "assignments", label: "Assignments", glyph: "assignments", group: "Design", load: () => import("../tabs/assignments.js") },
  { key: "paths", label: "Paths", glyph: "paths", group: "Admin", load: () => import("../tabs/paths.js") },
  { key: "appdata", label: "App Data", glyph: "appdata", group: "App", load: () => import("../tabs/appdata.js") },
  { key: "features", label: "Features", glyph: "features", group: "App", load: () => import("../tabs/features.js") },
  { key: "rules", label: "Rules", glyph: "rules", group: "App", load: () => import("../tabs/rules.js") },
];

const GROUPS = ["Admin", "Design", "App"];

/* ---------------------------------------------------------------------------
   Global app state
   --------------------------------------------------------------------------- */

export const app = new Store({
  tab: "overview",
  params: {},
  org: persist.read("org", null),
  theme: persist.read("theme", "dark"),
  density: persist.read("density", "comfortable"),
  railExpanded: persist.read("railExpanded", false),
  user: null,
});

/* ---------------------------------------------------------------------------
   Boot
   --------------------------------------------------------------------------- */

export function boot() {
  const users = db.users.list();
  app.set((s) => {
    s.user = users.find((u) => u.role === "super_admin") ?? users[0];
    if (!s.org) s.org = db.orgs.list()[0]?.id ?? null;
  });

  applyTheme(app.get("theme"));
  applyDensity(app.get("density"));
  initTooltips();

  const root = $("#app");
  const rail = buildRail();
  const main = el("main.main", buildTopbar(), el("div.page#page"));
  mount(root, rail, main);

  installShortcuts();
  installRouter();

  window.addEventListener("hashchange", () => routeFromHash());
  routeFromHash();
}

/* ---------------------------------------------------------------------------
   Rail
   --------------------------------------------------------------------------- */

function buildRail() {
  const nav = el("nav.rail-nav");

  for (const group of GROUPS) {
    const tabs = TABS.filter((t) => t.group === group);
    if (!tabs.length) continue;
    nav.appendChild(el("div.rail-group-label", group));
    for (const tab of tabs) {
      nav.appendChild(
        el(
          "button.rail-item",
          {
            type: "button",
            dataset: { tab: tab.key },
            "data-tip": tab.label,
            "data-tip-place": "right-start",
            onclick: () => go(tab.key),
          },
          icon(tab.glyph),
          el("span", tab.label),
        ),
      );
    }
  }

  const user = app.get("user");

  const rail = el(
    "aside.rail",
    { dataset: { expanded: String(app.get("railExpanded")) } },
    el(
      "div.rail-brand",
      el("span.rail-mark", icon("sparkle")),
      el("div.rail-name", el("b", "CanadaServices"), el("small", "Control")),
    ),
    nav,
    el(
      "div.rail-foot",
      el(
        "button.rail-item",
        {
          type: "button",
          "data-tip": "Collapse or expand the rail",
          "data-tip-place": "right-start",
          onclick: () => {
            const next = rail.dataset.expanded !== "true";
            rail.dataset.expanded = String(next);
            persist.write("railExpanded", next);
            app.set((s) => {
              s.railExpanded = next;
            });
          },
        },
        icon("chevronRight"),
        el("span", "Collapse"),
      ),
      el(
        "button.rail-user",
        {
          type: "button",
          onclick: (event) => openUserMenu(event.currentTarget),
        },
        el("span.avatar", { style: { "--hue": hueOf(user?.email ?? "") } }, fmt.initials(user?.full_name ?? "?")),
        el("div.col", el("b.truncate", user?.full_name ?? "—"), el("small.truncate", "Super admin")),
      ),
    ),
  );

  // Rotate the collapse chevron with the rail state.
  new MutationObserver(() => {
    const chev = rail.querySelector(".rail-foot .rail-item svg");
    if (chev) chev.style.transform = rail.dataset.expanded === "true" ? "rotate(180deg)" : "";
  }).observe(rail, { attributes: true, attributeFilter: ["data-expanded"] });

  return rail;
}

function openUserMenu(anchor) {
  menu(anchor, [
    { label: "Theme", header: true },
    {
      label: app.get("theme") === "dark" ? "Switch to light" : "Switch to dark",
      icon: app.get("theme") === "dark" ? "sun" : "moon",
      shortcut: "⇧D",
      onSelect: () => toggleTheme(),
    },
    {
      label: app.get("density") === "compact" ? "Comfortable density" : "Compact density",
      icon: "rows",
      onSelect: () => toggleDensity(),
    },
    "-",
    { label: "Keyboard shortcuts", icon: "keyboard", shortcut: "?", onSelect: () => showShortcuts() },
    { label: "Command palette", icon: "command", shortcut: "⌘K", onSelect: () => openPalette() },
    "-",
    {
      label: "Reset demo data",
      icon: "refresh",
      onSelect: () => {
        db.reseed();
        toast("Demo data reset", { tone: "success", detail: "Every design, record and assignment is back to its seed state." });
        routeFromHash(true);
      },
    },
    { label: "Sign out", icon: "logout", tone: "danger", onSelect: () => toast("Sign-out is wired to the auth provider in production.", { tone: "info" }) },
  ], { placement: "top-start", minWidth: 220 });
}

/* ---------------------------------------------------------------------------
   Top bar
   --------------------------------------------------------------------------- */

function buildTopbar() {
  const crumbs = el("div.crumbs#crumbs");

  const orgButton = el("button.org-switch#orgSwitch", { type: "button", onclick: (e) => openOrgMenu(e.currentTarget) });
  paintOrgButton(orgButton);

  const search = el(
    "button.search-trigger",
    { type: "button", onclick: () => openPalette() },
    icon("search"),
    el("span.spacer", { style: { textAlign: "left" } }, "Search or jump to…"),
    el("kbd.key", "⌘K"),
  );

  app.subscribe(() => paintOrgButton(orgButton));

  return el(
    "header.topbar",
    crumbs,
    el("div.spacer"),
    search,
    el("div.vr"),
    orgButton,
    el(
      "button.btn.icon.ghost",
      { type: "button", "data-tip": "Theme", "data-tip-key": "⇧D", onclick: () => toggleTheme() },
      icon(app.get("theme") === "dark" ? "sun" : "moon"),
    ),
    el(
      "button.btn.icon.ghost",
      { type: "button", "data-tip": "Keyboard shortcuts", "data-tip-key": "?", onclick: () => showShortcuts() },
      icon("keyboard"),
    ),
  );
}

function paintOrgButton(button) {
  const org = db.orgs.get(app.get("org"));
  mount(
    button,
    el("span.org-mark", { style: { "--hue": hueOf(org?.slug ?? "") } }, (org?.name ?? "?").slice(0, 1)),
    el("span.truncate", org?.name ?? "All organisations"),
    icon("chevronUpDown"),
  );
  button.style.setProperty("--hue", hueOf(org?.slug ?? ""));
}

function openOrgMenu(anchor) {
  const orgs = db.orgs.list();
  menu(
    anchor,
    [
      { label: "Organisation", header: true },
      ...orgs.map((org) => ({
        label: org.name,
        icon: org.status === "suspended" ? "lock" : "org",
        checked: org.id === app.get("org"),
        onSelect: () => {
          app.set((s) => {
            s.org = org.id;
          });
          persist.write("org", org.id);
          routeFromHash(true);
          toast(`Switched to ${org.name}`, { tone: "info", duration: 2000 });
        },
      })),
      "-",
      {
        label: "New organisation",
        icon: "plus",
        onSelect: () => newOrgDialog(),
      },
    ],
    { minWidth: 240 },
  );
}

function newOrgDialog() {
  modal((close) => {
    let name = "";
    let region = "ON";
    let plan = "Starter";

    return {
      title: "New organisation",
      subtitle: "Creates a tenant with features off by default.",
      body: [
        el("div.field", el("label", "Name"), el("input.input", { placeholder: "Acme Field Services", oninput: (e) => (name = e.target.value) })),
        el(
          "div.field-grid-2",
          el("div.field", el("label", "Region"), el("select.select", { onchange: (e) => (region = e.target.value) }, ...["ON", "BC", "AB", "QC", "NS", "MB", "SK"].map((r) => el("option", { value: r }, r)))),
          el("div.field", el("label", "Plan"), el("select.select", { onchange: (e) => (plan = e.target.value) }, ...["Starter", "Growth", "Scale"].map((p) => el("option", { value: p }, p)))),
        ),
      ],
      footer: [
        el("div.spacer"),
        el("button.btn.subtle", { onclick: () => close() }, "Cancel"),
        el(
          "button.btn.primary",
          {
            onclick: () => {
              if (!name.trim()) return toast("Give the organisation a name", { tone: "warning" });
              const org = db.orgs.create({ name: name.trim(), region, plan });
              app.set((s) => {
                s.org = org.id;
              });
              persist.write("org", org.id);
              close();
              toast(`${org.name} created`, { tone: "success", detail: "Jobs and Completion reports are on; everything else is off." });
              routeFromHash(true);
            },
          },
          "Create",
        ),
      ],
    };
  });
}

/** Tabs call this to publish their breadcrumb trail. */
export function setCrumbs(items) {
  const host = $("#crumbs");
  if (!host) return;
  const nodes = [];
  items.forEach((item, i) => {
    if (i) nodes.push(el("span.sep", "/"));
    nodes.push(
      item.onSelect
        ? el("button.crumb", { type: "button", onclick: item.onSelect }, item.label)
        : el(`span.crumb${i === items.length - 1 ? ".current" : ""}`, item.label),
    );
  });
  mount(host, ...nodes);
}

/* ---------------------------------------------------------------------------
   Routing
   --------------------------------------------------------------------------- */

let teardown = null;
let currentTab = null;

export function go(tab, params = {}) {
  const query = new URLSearchParams(params).toString();
  window.location.hash = `#/${tab}${query ? `?${query}` : ""}`;
}

function routeFromHash(force = false) {
  const raw = window.location.hash.replace(/^#\/?/, "") || "overview";
  const [path, query] = raw.split("?");
  const key = TABS.some((t) => t.key === path) ? path : "overview";
  const params = Object.fromEntries(new URLSearchParams(query ?? ""));

  app.set((s) => {
    s.tab = key;
    s.params = params;
  });

  for (const item of document.querySelectorAll(".rail-item[data-tab]")) {
    item.classList.toggle("active", item.dataset.tab === key);
  }

  if (!force && key === currentTab && Object.keys(params).length === 0) return;
  renderTab(key, params);
}

async function renderTab(key, params) {
  const host = $("#page");
  if (!host) return;

  try {
    teardown?.();
  } catch (error) {
    console.error("[shell] tab teardown threw", error);
  }
  teardown = null;
  currentTab = key;

  const tab = TABS.find((t) => t.key === key);
  mount(host, el("div", { style: { padding: "var(--s-5)" } }, loadingSkeleton()));

  try {
    const module = await tab.load();
    mount(host);
    teardown = module.mount(host, { app, db, go, setCrumbs, params }) ?? null;
  } catch (error) {
    console.error(`[shell] failed to mount "${key}"`, error);
    mount(
      host,
      el(
        "div",
        { style: { padding: "var(--s-8)" } },
        el(
          "div.callout.danger",
          icon("alert"),
          el("div", el("b", `The ${tab.label} tab failed to load.`), el("div", { style: { marginTop: "4px" } }, String(error.message))),
        ),
      ),
    );
  }
}

function loadingSkeleton() {
  return el(
    "div.col",
    { style: { gap: "var(--s-4)" } },
    el("div.skeleton", { style: { height: "22px", width: "220px" } }),
    el(
      "div",
      { style: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--s-3)" } },
      ...Array.from({ length: 4 }, () => el("div.skeleton", { style: { height: "78px" } })),
    ),
    el("div.skeleton", { style: { height: "240px" } }),
  );
}

function installRouter() {
  // Clicking a [data-go] element anywhere navigates. Saves wiring in tabs.
  delegate(document, "[data-go]", "click", (_event, node) => {
    const [tab, query] = node.dataset.go.split("?");
    go(tab, Object.fromEntries(new URLSearchParams(query ?? "")));
  });
}

/* ---------------------------------------------------------------------------
   Theme and density
   --------------------------------------------------------------------------- */

function applyTheme(value) {
  document.documentElement.dataset.theme = value;
}

function applyDensity(value) {
  document.documentElement.dataset.density = value;
}

export function toggleTheme() {
  const next = app.get("theme") === "dark" ? "light" : "dark";
  app.set((s) => {
    s.theme = next;
  });
  persist.write("theme", next);
  applyTheme(next);
  bus.emit("theme:changed", next);

  const button = document.querySelector('.topbar .btn.icon[data-tip="Theme"]');
  if (button) mount(button, icon(next === "dark" ? "sun" : "moon"));
}

export function toggleDensity() {
  const next = app.get("density") === "compact" ? "comfortable" : "compact";
  app.set((s) => {
    s.density = next;
  });
  persist.write("density", next);
  applyDensity(next);
  toast(`${next === "compact" ? "Compact" : "Comfortable"} density`, { tone: "info", duration: 1600 });
}

/* ---------------------------------------------------------------------------
   Command palette
   --------------------------------------------------------------------------- */

const paletteExtras = new Set();

/** Tabs register contextual commands while mounted. Returns a disposer. */
export function registerCommands(commands) {
  const entry = { commands };
  paletteExtras.add(entry);
  return () => paletteExtras.delete(entry);
}

function baseCommands() {
  const commands = [];

  for (const tab of TABS) {
    commands.push({
      id: `go.${tab.key}`,
      label: `Go to ${tab.label}`,
      glyph: tab.glyph,
      group: "Navigate",
      run: () => go(tab.key),
    });
  }

  for (const org of db.orgs.list()) {
    commands.push({
      id: `org.${org.id}`,
      label: `Switch to ${org.name}`,
      glyph: "org",
      group: "Organisation",
      run: () => {
        app.set((s) => {
          s.org = org.id;
        });
        persist.write("org", org.id);
        routeFromHash(true);
      },
    });
  }

  for (const design of db.designs.list()) {
    commands.push({
      id: `design.${design.id}`,
      label: `Open ${design.name} in the studio`,
      glyph: "studio",
      group: "Designs",
      run: () => go("studio", { design: design.id }),
    });
  }

  commands.push(
    { id: "theme", label: "Toggle theme", glyph: "moon", group: "View", hint: "⇧D", run: () => toggleTheme() },
    { id: "density", label: "Toggle density", glyph: "rows", group: "View", run: () => toggleDensity() },
    { id: "shortcuts", label: "Keyboard shortcuts", glyph: "keyboard", group: "Help", hint: "?", run: () => showShortcuts() },
    { id: "new.design", label: "New design", glyph: "plus", group: "Create", hint: "C then D", run: () => go("library", { create: "1" }) },
    { id: "new.user", label: "New user", glyph: "user", group: "Create", hint: "C then U", run: () => go("paths", { create: "1" }) },
    { id: "new.collection", label: "New collection", glyph: "appdata", group: "Create", run: () => go("appdata", { create: "1" }) },
    { id: "new.rule", label: "New rule", glyph: "rules", group: "Create", run: () => go("rules", { create: "1" }) },
  );

  return commands;
}

let paletteOpen = false;

export function openPalette(initial = "") {
  if (paletteOpen) return;
  paletteOpen = true;
  closePopover();

  const commands = [...baseCommands(), ...[...paletteExtras].flatMap((e) => e.commands)];

  const list = el("div.palette-list");
  const input = el("input", {
    type: "text",
    placeholder: "Search commands, designs, organisations…",
    value: initial,
    autocomplete: "off",
    spellcheck: false,
    oninput: () => paint(),
  });

  let cursor = 0;
  let visible = [];

  function paint() {
    const q = input.value.trim();
    visible = commands
      .map((c) => ({ command: c, match: fuzzy(q, `${c.group} ${c.label}`) }))
      .filter((r) => r.match.hit)
      .sort((a, b) => b.match.score - a.match.score)
      .slice(0, 40)
      .map((r) => r.command);

    cursor = 0;
    if (!visible.length) {
      mount(list, el("div", { style: { padding: "22px", textAlign: "center", color: "var(--text-tertiary)", fontSize: "var(--fs-12)" } }, "No matching command"));
      return;
    }

    let lastGroup = null;
    const nodes = [];
    visible.forEach((command, i) => {
      if (command.group !== lastGroup) {
        lastGroup = command.group;
        nodes.push(el("div.menu-label", command.group));
      }
      nodes.push(
        el(
          "button.menu-item",
          {
            type: "button",
            dataset: { index: i },
            onclick: () => run(command),
            onpointerenter: () => setCursor(i),
          },
          icon(command.glyph || "chevronRight"),
          el("span.truncate", command.label),
          command.hint && el("span.hint", command.hint),
        ),
      );
    });
    mount(list, ...nodes);
    setCursor(0);
  }

  function setCursor(index) {
    cursor = index;
    for (const row of list.querySelectorAll(".menu-item")) {
      row.classList.toggle("cursor", Number(row.dataset.index) === index);
    }
    list.querySelector(".menu-item.cursor")?.scrollIntoView({ block: "nearest" });
  }

  function run(command) {
    close();
    try {
      command.run();
    } catch (error) {
      console.error("[palette] command threw", error);
      toast("That command failed", { tone: "danger", detail: error.message });
    }
  }

  const scrim = el(
    "div.palette-scrim",
    {
      onpointerdown: (event) => {
        if (event.target === scrim) close();
      },
    },
    el(
      "div.palette",
      { role: "dialog", "aria-modal": "true", "aria-label": "Command palette" },
      el("div.palette-input", icon("search"), input),
      list,
      el(
        "div.palette-foot",
        el("span.row", el("kbd.key", "↑"), el("kbd.key", "↓"), "navigate"),
        el("span.row", el("kbd.key", "↵"), "run"),
        el("span.row", el("kbd.key", "esc"), "close"),
        el("span.spacer"),
        el("span", `${commands.length} commands`),
      ),
    ),
  );

  const offKey = on(document, "keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((cursor + 1) % Math.max(visible.length, 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((cursor - 1 + visible.length) % Math.max(visible.length, 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (visible[cursor]) run(visible[cursor]);
    }
  });

  function close() {
    offKey();
    scrim.remove();
    paletteOpen = false;
  }

  document.body.appendChild(scrim);
  paint();
  input.focus();
  input.select();
}

/* ---------------------------------------------------------------------------
   Shortcuts
   --------------------------------------------------------------------------- */

const SHORTCUTS = [
  {
    group: "Global",
    items: [
      { keys: ["⌘", "K"], label: "Command palette" },
      { keys: ["?"], label: "This sheet" },
      { keys: ["⇧", "D"], label: "Toggle theme" },
      { keys: ["1", "…", "8"], label: "Jump to a tab" },
      { keys: ["Esc"], label: "Close the top layer" },
    ],
  },
  {
    group: "Create",
    items: [
      { keys: ["C", "D"], label: "New design" },
      { keys: ["C", "U"], label: "New user" },
      { keys: ["C", "A"], label: "New assignment" },
      { keys: ["C", "R"], label: "New rule" },
    ],
  },
  {
    group: "Design Studio",
    items: [
      { keys: ["⌘", "Z"], label: "Undo" },
      { keys: ["⌘", "⇧", "Z"], label: "Redo" },
      { keys: ["⌘", "D"], label: "Duplicate selection" },
      { keys: ["⌘", "C"], label: "Copy selection" },
      { keys: ["⌘", "V"], label: "Paste" },
      { keys: ["⌫"], label: "Delete selection" },
      { keys: ["⌘", "0"], label: "Reset zoom" },
      { keys: ["⌘", "1"], label: "Fit to screen" },
      { keys: ["⌘", "G"], label: "Wrap in a stack" },
      { keys: ["⌘", "S"], label: "Save now" },
      { keys: ["⌘", "↵"], label: "Publish" },
      { keys: ["Esc"], label: "Clear selection" },
      { keys: ["↑", "↓"], label: "Move selection in its parent" },
      { keys: ["Tab"], label: "Select next sibling" },
    ],
  },
  {
    group: "Tables",
    items: [
      { keys: ["/"], label: "Focus search" },
      { keys: ["⌘", "A"], label: "Select all rows" },
      { keys: ["⇧", "Click"], label: "Select a range" },
      { keys: ["E"], label: "Export the current view" },
    ],
  },
];

let chord = null;
let chordTimer = null;

function installShortcuts() {
  on(document, "keydown", (event) => {
    const target = event.target;
    const typing =
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable || target.tagName === "SELECT");

    const meta = event.metaKey || event.ctrlKey;

    if (meta && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openPalette();
      return;
    }

    if (typing) return;

    if (event.key === "?" || (event.shiftKey && event.key === "/")) {
      event.preventDefault();
      showShortcuts();
      return;
    }

    if (event.shiftKey && event.key.toLowerCase() === "d" && !meta) {
      event.preventDefault();
      toggleTheme();
      return;
    }

    // Number keys jump between tabs.
    const number = Number(event.key);
    if (!meta && !event.shiftKey && number >= 1 && number <= TABS.length) {
      event.preventDefault();
      go(TABS[number - 1].key);
      return;
    }

    // "C" opens a create chord.
    if (!meta && event.key.toLowerCase() === "c" && !chord) {
      chord = "c";
      clearTimeout(chordTimer);
      chordTimer = setTimeout(() => {
        chord = null;
      }, 1400);
      return;
    }

    if (chord === "c") {
      chord = null;
      clearTimeout(chordTimer);
      const map = { d: () => go("library", { create: "1" }), u: () => go("paths", { create: "1" }), a: () => go("assignments", { create: "1" }), r: () => go("rules", { create: "1" }) };
      const action = map[event.key.toLowerCase()];
      if (action) {
        event.preventDefault();
        action();
      }
    }
  });
}

export function showShortcuts() {
  modal(
    () => ({
      title: "Keyboard shortcuts",
      subtitle: "Everything meaningful in the product has one.",
      body: el(
        "div.shortcut-grid",
        ...SHORTCUTS.map((group) =>
          el(
            "section",
            el("h3", group.group),
            ...group.items.map((item) =>
              el(
                "div.shortcut-row",
                el("span", item.label),
                el("span.keys", ...item.keys.map((k) => el("kbd.key", k))),
              ),
            ),
          ),
        ),
      ),
    }),
    { width: "wide" },
  );
}

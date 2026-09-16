/**
 * Presets.
 *
 * Four kinds, and they are the difference between a toy editor and one someone
 * will actually build a screen in:
 *
 *   blocks     composed subtrees — a whole hero, stat row or job card
 *   screens    complete screens, ready to rename and rewire
 *   styles     one-click property sets applied to the current selection
 *   themes     full token sets
 *
 * Blocks are written as plain trees with no ids. The studio assigns ids on
 * insert, so the same preset can be dropped a hundred times without collision.
 */

/* ---------------------------------------------------------------------------
   Tree shorthand
   --------------------------------------------------------------------------- */

const n = (type, props = {}, children = null) => ({
  type,
  props,
  ...(children ? { children } : {}),
});

const pad = (t, r = t, b = t, l = r) => ({ top: t, right: r, bottom: b, left: l });

/* ---------------------------------------------------------------------------
   Blocks
   --------------------------------------------------------------------------- */

export const blockGroups = [
  { key: "headers", name: "Headers", glyph: "nav" },
  { key: "hero", name: "Hero & summary", glyph: "sparkle" },
  { key: "stats", name: "Stats", glyph: "chart" },
  { key: "lists", name: "Lists & records", glyph: "list" },
  { key: "detail", name: "Detail", glyph: "card" },
  { key: "forms", name: "Forms", glyph: "input" },
  { key: "actions", name: "Actions & CTA", glyph: "button" },
  { key: "feedback", name: "States", glyph: "info" },
  { key: "nav", name: "Navigation", glyph: "flow" },
];

export const blocks = [
  /* ===== Headers ========================================================= */
  {
    key: "header-simple",
    group: "headers",
    name: "Title header",
    description: "Back action, title, avatar.",
    tags: ["top", "bar", "title"],
    tree: () => n("Header", { title: "Job detail", showBack: true, showAvatar: true, size: { height: 56 } }),
  },
  {
    key: "header-greeting",
    group: "headers",
    name: "Greeting header",
    description: "Personal welcome with a date line.",
    tags: ["home", "welcome"],
    tree: () =>
      n("Stack", { direction: "horizontal", gap: 12, align: "center", padding: pad(0, 0, 4, 0) }, [
        n("Stack", { direction: "vertical", gap: 2, size: { width: "fill" } }, [
          n("Text", { text: "Tuesday, 16 September", fontSize: 12, color: "{{theme.colors.textTertiary}}" }),
          n("Heading", { text: "Good morning, Maya", level: 1, fontSize: 24, fontWeight: 650 }),
        ]),
        n("Avatar", { name: "Maya Chen", size: { width: 40, height: 40 }, ring: true }),
      ]),
  },
  {
    key: "header-search",
    group: "headers",
    name: "Header with search",
    description: "Title above a search field.",
    tags: ["search", "filter"],
    tree: () =>
      n("Stack", { direction: "vertical", gap: 12 }, [
        n("Header", { title: "Jobs", showBack: false, showAvatar: true, size: { height: 48 } }),
        n("Input", { label: "", placeholder: "Search jobs, customers, addresses", size: { width: "fill", height: 44 }, radius: 12 }),
        n("ChipRow", { items: ["All", "Today", "Scheduled", "Blocked"], selectedIndex: 0 }),
      ]),
  },

  /* ===== Hero ============================================================ */
  {
    key: "hero-job",
    group: "hero",
    name: "Job hero",
    description: "Status, customer, service and location.",
    tags: ["summary", "detail", "job"],
    tree: () =>
      n("Card", { padding: pad(18), radius: 18, gap: 12, shadow: "sm" }, [
        n("Stack", { direction: "horizontal", gap: 8, align: "center" }, [
          n("Badge", { text: "Scheduled", tone: "primary", glyph: "clock" }),
          n("Spacer", { grow: true }),
          n("Text", { text: "#CS-1048", fontSize: 12, color: "{{theme.colors.textTertiary}}" }),
        ]),
        n("Heading", { text: "Avery Wilson", level: 2, fontSize: 22, fontWeight: 650 }),
        n("Text", { text: "Solar installation · Mississauga, ON", fontSize: 14, color: "{{theme.colors.textSecondary}}" }),
        n("Divider", { margin: pad(4, 0) }),
        n("Stack", { direction: "horizontal", gap: 20 }, [
          n("StatTile", { label: "Window", value: "09:00", background: "transparent", borderWidth: 0, padding: pad(0), radius: 0 }),
          n("StatTile", { label: "Duration", value: "3h", background: "transparent", borderWidth: 0, padding: pad(0), radius: 0 }),
          n("StatTile", { label: "Crew", value: "2", background: "transparent", borderWidth: 0, padding: pad(0), radius: 0 }),
        ]),
      ]),
  },
  {
    key: "hero-progress",
    group: "hero",
    name: "Progress hero",
    description: "A headline number with a completion bar.",
    tags: ["route", "progress", "summary"],
    tree: () =>
      n("Card", { padding: pad(18), radius: 18, gap: 14 }, [
        n("Stack", { direction: "horizontal", gap: 12, align: "center" }, [
          n("Icon", { name: "target", size: 22, color: "{{theme.colors.primary}}", background: "{{theme.colors.surfaceSunken}}", padding: pad(10), radius: 14 }),
          n("Stack", { direction: "vertical", gap: 1, size: { width: "fill" } }, [
            n("Text", { text: "Today's route", fontSize: 12, color: "{{theme.colors.textTertiary}}" }),
            n("Heading", { text: "7 of 11 complete", level: 2, fontSize: 19, fontWeight: 620 }),
          ]),
        ]),
        n("ProgressBar", { value: 0.64, label: "", showValue: false, height: 8 }),
      ]),
  },
  {
    key: "hero-media",
    group: "hero",
    name: "Media hero",
    description: "Image with an overlaid title block.",
    tags: ["image", "banner"],
    tree: () =>
      n("Stack", { direction: "vertical", gap: 12 }, [
        n("Image", { ratio: "16 / 9", radius: 18, size: { width: "fill" } }),
        n("Heading", { text: "Rooftop array, phase two", level: 2, fontSize: 20 }),
        n("Text", { text: "Eighteen panels, south face. Inverter swap included.", fontSize: 14 }),
      ]),
  },

  /* ===== Stats =========================================================== */
  {
    key: "stats-3",
    group: "stats",
    name: "Three-up stats",
    description: "A row of three KPI tiles.",
    tags: ["kpi", "metrics"],
    tree: () =>
      n("Grid", { columns: 3, gap: 10 }, [
        n("StatTile", { label: "Open", value: "12", glyph: "list" }),
        n("StatTile", { label: "Today", value: "4", glyph: "calendar" }),
        n("StatTile", { label: "Blocked", value: "1", glyph: "alert" }),
      ]),
  },
  {
    key: "stats-2-delta",
    group: "stats",
    name: "Two-up with change",
    description: "Two tiles carrying a delta.",
    tags: ["kpi", "trend"],
    tree: () =>
      n("Grid", { columns: 2, gap: 10 }, [
        n("StatTile", { label: "Completed", value: "38", delta: "+12%", glyph: "checkCircle" }),
        n("StatTile", { label: "Avg. on site", value: "2h 14m", delta: "-8%", glyph: "clock" }),
      ]),
  },
  {
    key: "stats-banner",
    group: "stats",
    name: "Stat banner",
    description: "One number, stated large.",
    tags: ["kpi", "single"],
    tree: () =>
      n("StatTile", {
        label: "Points balance",
        value: "4,280",
        delta: "+140 this week",
        glyph: "star",
        align: "center",
        padding: pad(22),
        radius: 18,
      }),
  },

  /* ===== Lists =========================================================== */
  {
    key: "list-jobs",
    group: "lists",
    name: "Job list",
    description: "Icon, title, subtitle, time, chevron.",
    tags: ["records", "rows", "schedule"],
    tree: () =>
      n("Stack", { direction: "vertical", gap: 10 }, [
        n("Stack", { direction: "horizontal", gap: 8, align: "center" }, [
          n("Heading", { text: "Today", level: 3, fontSize: 15, fontWeight: 600 }),
          n("Spacer", { grow: true }),
          n("Text", { text: "See all", fontSize: 13, color: "{{theme.colors.primary}}" }),
        ]),
        n("List", {}),
      ]),
  },
  {
    key: "list-plain",
    group: "lists",
    name: "Plain rows",
    description: "Borderless rows for a settings-style list.",
    tags: ["settings", "menu"],
    tree: () =>
      n("List", {
        showIcon: false,
        borderWidth: 0,
        background: "transparent",
        gap: 0,
        rowPadding: 14,
        items: [
          { title: "Notifications", subtitle: "", meta: "On" },
          { title: "Offline mode", subtitle: "", meta: "Auto" },
          { title: "Units", subtitle: "", meta: "Metric" },
        ],
      }),
  },
  {
    key: "list-timeline",
    group: "lists",
    name: "Activity timeline",
    description: "Ordered events with a spine.",
    tags: ["history", "events"],
    tree: () =>
      n("Card", { padding: pad(16), gap: 14 }, [
        n("Heading", { text: "Activity", level: 3, fontSize: 15 }),
        n("Timeline", {}),
      ]),
  },
  {
    key: "list-grid-cards",
    group: "lists",
    name: "Card grid",
    description: "Two-column tappable tiles.",
    tags: ["grid", "tiles", "menu"],
    tree: () =>
      n("Grid", { columns: 2, gap: 10 }, [
        n("Card", { padding: pad(16), gap: 8, radius: 16 }, [
          n("Icon", { name: "zap", size: 20, color: "{{theme.colors.primary}}" }),
          n("Heading", { text: "Start job", level: 3, fontSize: 15 }),
          n("Text", { text: "Begin the next stop", fontSize: 12 }),
        ]),
        n("Card", { padding: pad(16), gap: 8, radius: 16 }, [
          n("Icon", { name: "file", size: 20, color: "{{theme.colors.primary}}" }),
          n("Heading", { text: "Reports", level: 3, fontSize: 15 }),
          n("Text", { text: "Submit and review", fontSize: 12 }),
        ]),
      ]),
  },

  /* ===== Detail ========================================================== */
  {
    key: "detail-facts",
    group: "detail",
    name: "Fact sheet",
    description: "Label and value pairs in a card.",
    tags: ["record", "fields"],
    tree: () =>
      n("Card", { padding: pad(16), gap: 12 }, [
        n("Heading", { text: "Details", level: 3, fontSize: 15 }),
        n("Stack", { direction: "horizontal", gap: 12 }, [
          n("Text", { text: "Address", fontSize: 13, color: "{{theme.colors.textTertiary}}", size: { width: 110 } }),
          n("Text", { text: "482 Lakeshore Rd W", fontSize: 13, color: "{{theme.colors.text}}" }),
        ]),
        n("Divider", {}),
        n("Stack", { direction: "horizontal", gap: 12 }, [
          n("Text", { text: "Contact", fontSize: 13, color: "{{theme.colors.textTertiary}}", size: { width: 110 } }),
          n("Text", { text: "(905) 555-0142", fontSize: 13, color: "{{theme.colors.text}}" }),
        ]),
        n("Divider", {}),
        n("Stack", { direction: "horizontal", gap: 12 }, [
          n("Text", { text: "Equipment", fontSize: 13, color: "{{theme.colors.textTertiary}}", size: { width: 110 } }),
          n("Text", { text: "18 × 400W panel, 1 × inverter", fontSize: 13, color: "{{theme.colors.text}}" }),
        ]),
      ]),
  },
  {
    key: "detail-map",
    group: "detail",
    name: "Map with address",
    description: "Location preview above the address line.",
    tags: ["location", "map"],
    tree: () =>
      n("Card", { padding: pad(0), gap: 0, radius: 18 }, [
        n("Map", { caption: "Mississauga, ON", pins: 1, size: { width: "fill", height: 170 }, radius: 0 }),
        n("Stack", { direction: "horizontal", gap: 12, align: "center", padding: pad(14) }, [
          n("Icon", { name: "mapPin", size: 18, color: "{{theme.colors.primary}}" }),
          n("Stack", { direction: "vertical", gap: 1, size: { width: "fill" } }, [
            n("Text", { text: "482 Lakeshore Rd W", fontSize: 14, color: "{{theme.colors.text}}", fontWeight: 500 }),
            n("Text", { text: "22 min away", fontSize: 12 }),
          ]),
          n("Button", { label: "Navigate", variant: "secondary", size: { width: "hug", height: 36 }, fontSize: 13, radius: 10 }),
        ]),
      ]),
  },
  {
    key: "detail-checklist",
    group: "detail",
    name: "Checklist",
    description: "Toggle rows for on-site steps.",
    tags: ["tasks", "steps"],
    tree: () =>
      n("Card", { padding: pad(16), gap: 14 }, [
        n("Heading", { text: "Site checklist", level: 3, fontSize: 15 }),
        n("Toggle", { label: "Roof access confirmed", value: true }),
        n("Divider", {}),
        n("Toggle", { label: "Isolator installed", value: true }),
        n("Divider", {}),
        n("Toggle", { label: "Customer walkthrough", value: false }),
      ]),
  },

  /* ===== Forms =========================================================== */
  {
    key: "form-basic",
    group: "forms",
    name: "Two-field form",
    description: "Labelled fields with a submit action.",
    tags: ["capture", "input"],
    tree: () =>
      n("Stack", { direction: "vertical", gap: 16 }, [
        n("Input", { label: "Customer name", placeholder: "Full name", required: true }),
        n("Input", { label: "Phone", placeholder: "(000) 000-0000", inputType: "tel" }),
        n("Select", { label: "Job type", options: ["Installation", "Inspection", "Repair"], value: "Installation" }),
        n("Button", { label: "Create job", variant: "primary" }),
      ]),
  },
  {
    key: "form-report",
    group: "forms",
    name: "Report form",
    description: "Notes, photo and confirmation.",
    tags: ["submit", "notes"],
    tree: () =>
      n("Stack", { direction: "vertical", gap: 16 }, [
        n("Heading", { text: "Completion report", level: 2, fontSize: 19 }),
        n("Input", { label: "Notes", placeholder: "What was done on site", size: { width: "fill", height: 88 } }),
        n("Image", { ratio: "4 / 3", radius: 14 }),
        n("Toggle", { label: "Customer signed off", description: "Required before submitting", value: false }),
        n("ButtonRow", { gap: 10 }, [
          n("Button", { label: "Save draft", variant: "secondary" }),
          n("Button", { label: "Submit", variant: "primary" }),
        ]),
      ]),
  },
  {
    key: "form-settings",
    group: "forms",
    name: "Settings group",
    description: "Toggles with descriptions.",
    tags: ["preferences", "toggles"],
    tree: () =>
      n("Card", { padding: pad(16), gap: 16 }, [
        n("Toggle", { label: "Arrival notifications", description: "Text the customer when you are 15 minutes out", value: true }),
        n("Divider", {}),
        n("Toggle", { label: "Offline capture", description: "Queue reports when signal drops", value: true }),
        n("Divider", {}),
        n("Toggle", { label: "Share location", description: "Only while a job is active", value: false }),
      ]),
  },

  /* ===== Actions ========================================================= */
  {
    key: "cta-primary",
    group: "actions",
    name: "Primary action",
    description: "One full-width button.",
    tags: ["button", "submit"],
    tree: () => n("Button", { label: "Start workflow", variant: "primary", glyph: "play" }),
  },
  {
    key: "cta-pair",
    group: "actions",
    name: "Action pair",
    description: "Secondary and primary side by side.",
    tags: ["buttons", "confirm"],
    tree: () =>
      n("ButtonRow", { gap: 10 }, [
        n("Button", { label: "Reschedule", variant: "secondary" }),
        n("Button", { label: "Start", variant: "primary" }),
      ]),
  },
  {
    key: "cta-sticky",
    group: "actions",
    name: "Sticky footer",
    description: "A bordered action bar for the bottom of a screen.",
    tags: ["footer", "bar"],
    tree: () =>
      n("Stack", { direction: "vertical", gap: 10, padding: pad(14), background: "{{theme.colors.surface}}", borderWidth: 1, borderColor: "{{theme.colors.border}}", radius: 0 }, [
        n("Stack", { direction: "horizontal", gap: 8, align: "center" }, [
          n("Text", { text: "Total", fontSize: 13 }),
          n("Spacer", { grow: true }),
          n("Heading", { text: "$1,840.00", level: 3, fontSize: 17 }),
        ]),
        n("Button", { label: "Confirm and dispatch", variant: "primary" }),
      ]),
  },
  {
    key: "cta-danger",
    group: "actions",
    name: "Destructive action",
    description: "A warning above a danger button.",
    tags: ["delete", "cancel"],
    tree: () =>
      n("Stack", { direction: "vertical", gap: 12 }, [
        n("Callout", { title: "This cannot be undone", body: "Cancelling releases the slot and notifies the customer.", tone: "danger", glyph: "alert" }),
        n("Button", { label: "Cancel job", variant: "danger" }),
      ]),
  },

  /* ===== Feedback ======================================================== */
  {
    key: "state-empty",
    group: "feedback",
    name: "Empty state",
    description: "Icon, message and one clear action.",
    tags: ["blank", "zero"],
    tree: () => n("EmptyState", {}),
  },
  {
    key: "state-warning",
    group: "feedback",
    name: "Warning callout",
    description: "An inline notice with a tone.",
    tags: ["alert", "notice"],
    tree: () => n("Callout", {}),
  },
  {
    key: "state-success",
    group: "feedback",
    name: "Success panel",
    description: "Confirmation after a submit.",
    tags: ["done", "confirm"],
    tree: () =>
      n("Stack", { direction: "vertical", gap: 16, align: "center", padding: pad(28, 20) }, [
        n("Icon", { name: "checkCircle", size: 44, color: "{{theme.colors.success}}" }),
        n("Heading", { text: "Report submitted", level: 2, fontSize: 20, align: "center" }),
        n("Text", { text: "Dispatch has been notified. You can head to the next stop.", fontSize: 14, align: "center" }),
        n("Button", { label: "Next job", variant: "primary" }),
      ]),
  },
  {
    key: "state-loading",
    group: "feedback",
    name: "Skeleton rows",
    description: "Placeholder shapes while data loads.",
    tags: ["loading", "placeholder"],
    tree: () =>
      n("Stack", { direction: "vertical", gap: 10 }, [
        n("Card", { padding: pad(14), gap: 8 }, [
          n("Stack", { direction: "horizontal", gap: 10, align: "center" }, [
            n("Icon", { name: "box", size: 28, color: "{{theme.colors.border}}" }),
            n("Stack", { direction: "vertical", gap: 6, size: { width: "fill" } }, [
              n("Divider", { thickness: 10, color: "{{theme.colors.surfaceSunken}}", margin: pad(0), inset: 0 }),
              n("Divider", { thickness: 8, color: "{{theme.colors.surfaceSunken}}", margin: pad(0), inset: 40 }),
            ]),
          ]),
        ]),
      ]),
  },

  /* ===== Navigation ====================================================== */
  {
    key: "nav-tabbar",
    group: "nav",
    name: "Tab bar",
    description: "Four-item bottom navigation.",
    tags: ["bottom", "tabs"],
    tree: () => n("TabBar", {}),
  },
  {
    key: "nav-chips",
    group: "nav",
    name: "Filter chips",
    description: "A scrolling row of filters.",
    tags: ["filter", "segment"],
    tree: () => n("ChipRow", {}),
  },
  {
    key: "nav-breadcrumb",
    group: "nav",
    name: "Back link",
    description: "A single back affordance above content.",
    tags: ["back", "return"],
    tree: () =>
      n("Stack", { direction: "horizontal", gap: 6, align: "center" }, [
        n("Icon", { name: "chevronLeft", size: 16, color: "{{theme.colors.primary}}" }),
        n("Text", { text: "All jobs", fontSize: 14, color: "{{theme.colors.primary}}", fontWeight: 500 }),
      ]),
  },
];

/* ---------------------------------------------------------------------------
   Screen templates
   --------------------------------------------------------------------------- */

export const screenTemplates = [
  {
    key: "blank",
    name: "Blank",
    description: "An empty vertical stack.",
    glyph: "square",
    tree: () => n("Stack", { direction: "vertical", gap: 16, padding: pad(20, 16, 32, 16), background: "{{theme.colors.background}}", size: { width: "fill", height: "fill" } }, []),
  },
  {
    key: "home",
    name: "Home",
    description: "Greeting, stats, today's list, tab bar.",
    glyph: "overview",
    tree: () =>
      n("Stack", { direction: "vertical", gap: 18, padding: pad(20, 16, 24, 16), background: "{{theme.colors.background}}", size: { width: "fill", height: "fill" } }, [
        blockByKey("header-greeting").tree(),
        blockByKey("hero-progress").tree(),
        blockByKey("stats-3").tree(),
        blockByKey("list-jobs").tree(),
      ]),
  },
  {
    key: "detail",
    name: "Record detail",
    description: "Hero, map, checklist and actions.",
    glyph: "card",
    tree: () =>
      n("Stack", { direction: "vertical", gap: 16, padding: pad(12, 16, 28, 16), background: "{{theme.colors.background}}", size: { width: "fill", height: "fill" } }, [
        n("Header", { title: "Job detail", showBack: true, showAvatar: false }),
        blockByKey("hero-job").tree(),
        blockByKey("detail-map").tree(),
        blockByKey("detail-checklist").tree(),
        blockByKey("cta-pair").tree(),
      ]),
  },
  {
    key: "list",
    name: "List screen",
    description: "Search, filters and rows.",
    glyph: "list",
    tree: () =>
      n("Stack", { direction: "vertical", gap: 16, padding: pad(16, 16, 24, 16), background: "{{theme.colors.background}}", size: { width: "fill", height: "fill" } }, [
        blockByKey("header-search").tree(),
        n("List", {}),
      ]),
  },
  {
    key: "form",
    name: "Form screen",
    description: "A capture screen with a submit action.",
    glyph: "input",
    tree: () =>
      n("Stack", { direction: "vertical", gap: 18, padding: pad(12, 16, 28, 16), background: "{{theme.colors.background}}", size: { width: "fill", height: "fill" } }, [
        n("Header", { title: "New job", showBack: true, showAvatar: false }),
        blockByKey("form-basic").tree(),
      ]),
  },
  {
    key: "profile",
    name: "Profile",
    description: "Identity block, stats and settings.",
    glyph: "user",
    tree: () =>
      n("Stack", { direction: "vertical", gap: 18, padding: pad(16, 16, 28, 16), background: "{{theme.colors.background}}", size: { width: "fill", height: "fill" } }, [
        n("Stack", { direction: "vertical", gap: 10, align: "center", padding: pad(16, 0) }, [
          n("Avatar", { name: "Maya Chen", size: { width: 72, height: 72 }, ring: true }),
          n("Heading", { text: "Maya Chen", level: 2, fontSize: 20, align: "center" }),
          n("Text", { text: "Lead technician · Northstar Solar", fontSize: 13, align: "center" }),
        ]),
        blockByKey("stats-2-delta").tree(),
        blockByKey("form-settings").tree(),
        n("Button", { label: "Sign out", variant: "ghost" }),
      ]),
  },
  {
    key: "success",
    name: "Confirmation",
    description: "A terminal success screen.",
    glyph: "checkCircle",
    tree: () =>
      n("Stack", { direction: "vertical", gap: 16, justify: "center", padding: pad(24, 20), background: "{{theme.colors.background}}", size: { width: "fill", height: "fill" } }, [
        blockByKey("state-success").tree(),
      ]),
  },
  {
    key: "empty",
    name: "Empty screen",
    description: "A zero-data state with one action.",
    glyph: "box",
    tree: () =>
      n("Stack", { direction: "vertical", gap: 16, justify: "center", padding: pad(24, 20), background: "{{theme.colors.background}}", size: { width: "fill", height: "fill" } }, [
        n("EmptyState", {}),
      ]),
  },
];

function blockByKey(key) {
  const found = blocks.find((b) => b.key === key);
  if (!found) throw new Error(`preset block "${key}" is missing`);
  return found;
}

/* ---------------------------------------------------------------------------
   Style presets
   Applied to whichever props the selected component actually declares, so a
   preset can be dropped on anything without writing props it does not own.
   --------------------------------------------------------------------------- */

export const stylePresetGroups = [
  {
    key: "elevation",
    name: "Elevation",
    presets: [
      { key: "flat", name: "Flat", props: { shadow: "none", borderWidth: 1, borderColor: "{{theme.colors.border}}" } },
      { key: "raised", name: "Raised", props: { shadow: "sm", borderWidth: 1, borderColor: "{{theme.colors.border}}" } },
      { key: "floating", name: "Floating", props: { shadow: "lg", borderWidth: 0 } },
      { key: "sunken", name: "Sunken", props: { shadow: "inset", borderWidth: 0, background: "{{theme.colors.surfaceSunken}}" } },
    ],
  },
  {
    key: "corners",
    name: "Corners",
    presets: [
      { key: "square", name: "Square", props: { radius: 0 } },
      { key: "soft", name: "Soft", props: { radius: 8 } },
      { key: "round", name: "Round", props: { radius: 16 } },
      { key: "pill", name: "Pill", props: { radius: 999 } },
    ],
  },
  {
    key: "density",
    name: "Density",
    presets: [
      { key: "tight", name: "Tight", props: { padding: pad(8), gap: 6 } },
      { key: "regular", name: "Regular", props: { padding: pad(14), gap: 12 } },
      { key: "roomy", name: "Roomy", props: { padding: pad(22), gap: 18 } },
      { key: "none", name: "Flush", props: { padding: pad(0), gap: 0 } },
    ],
  },
  {
    key: "type",
    name: "Type scale",
    presets: [
      { key: "caption", name: "Caption", props: { fontSize: 12, fontWeight: 500, lineHeight: 1.4, letterSpacing: 0, color: "{{theme.colors.textTertiary}}" } },
      { key: "body", name: "Body", props: { fontSize: 14, fontWeight: 400, lineHeight: 1.5, letterSpacing: 0, color: "{{theme.colors.textSecondary}}" } },
      { key: "lead", name: "Lead", props: { fontSize: 16, fontWeight: 500, lineHeight: 1.45, letterSpacing: -0.005, color: "{{theme.colors.text}}" } },
      { key: "title", name: "Title", props: { fontSize: 20, fontWeight: 620, lineHeight: 1.25, letterSpacing: -0.015, color: "{{theme.colors.text}}" } },
      { key: "display", name: "Display", props: { fontSize: 28, fontWeight: 680, lineHeight: 1.15, letterSpacing: -0.025, color: "{{theme.colors.text}}" } },
      { key: "overline", name: "Overline", props: { fontSize: 11, fontWeight: 600, letterSpacing: 0.08, transform: "uppercase", color: "{{theme.colors.textTertiary}}" } },
    ],
  },
  {
    key: "emphasis",
    name: "Emphasis",
    presets: [
      { key: "surface", name: "Surface", props: { background: "{{theme.colors.surface}}", borderWidth: 1, borderColor: "{{theme.colors.border}}" } },
      { key: "accent", name: "Accent", props: { background: "{{theme.colors.primarySoft}}", borderWidth: 1, borderColor: "{{theme.colors.primary}}" } },
      { key: "inverse", name: "Inverse", props: { background: "{{theme.colors.text}}", color: "{{theme.colors.background}}", borderWidth: 0 } },
      { key: "clear", name: "Clear", props: { background: "transparent", borderWidth: 0, shadow: "none" } },
    ],
  },
];

/**
 * The subset of a preset a given component can actually take.
 *
 * This returns a patch, not a merged props object, because the editor may be
 * writing into a breakpoint or state override — where writing back every prop
 * would turn the whole component into an override of itself.
 */
export function stylePresetPatch(presetProps, declaredKeys) {
  const patch = {};
  for (const [key, value] of Object.entries(presetProps)) {
    if (!declaredKeys || declaredKeys.has(key)) patch[key] = structuredClone(value);
  }
  return patch;
}

/* ---------------------------------------------------------------------------
   Theme presets
   --------------------------------------------------------------------------- */

const baseTypography = {
  fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  baseSize: 14,
  scale: { caption: 12, body: 14, lead: 16, title: 20, display: 28 },
};

export const themePresets = [
  {
    key: "field-light",
    name: "Field Light",
    description: "High contrast for outdoor screens.",
    theme: {
      colors: {
        background: "#f7f8f9",
        surface: "#ffffff",
        surfaceSunken: "#eef0f2",
        border: "#dfe3e7",
        text: "#101418",
        textSecondary: "#4c555f",
        textTertiary: "#7b858f",
        primary: "#0b7a63",
        primarySoft: "#e3f3ef",
        onPrimary: "#ffffff",
        success: "#1d8a4b",
        warning: "#b4700a",
        danger: "#c8372f",
        info: "#1d6fd1",
      },
      typography: baseTypography,
      radius: { control: 12, panel: 16, pill: 999 },
      spacing: { base: 4, gap: 12, padding: 16 },
    },
  },
  {
    key: "night-ops",
    name: "Night Ops",
    description: "Dark, low glare, for evening routes.",
    theme: {
      colors: {
        background: "#0c0f12",
        surface: "#151a1f",
        surfaceSunken: "#1d242b",
        border: "#28313a",
        text: "#eef2f5",
        textSecondary: "#a2aeb9",
        textTertiary: "#6f7d89",
        primary: "#2fd9b3",
        primarySoft: "#123029",
        onPrimary: "#04140f",
        success: "#48d17c",
        warning: "#f0b247",
        danger: "#f2645c",
        info: "#5aa4f5",
      },
      typography: baseTypography,
      radius: { control: 12, panel: 16, pill: 999 },
      spacing: { base: 4, gap: 12, padding: 16 },
    },
  },
  {
    key: "maple",
    name: "Maple",
    description: "Warm, Canadian-service palette.",
    theme: {
      colors: {
        background: "#fdfbf9",
        surface: "#ffffff",
        surfaceSunken: "#f4efeb",
        border: "#e6ddd6",
        text: "#1b1512",
        textSecondary: "#5a4c45",
        textTertiary: "#8d7c73",
        primary: "#c0392b",
        primarySoft: "#fbeae7",
        onPrimary: "#ffffff",
        success: "#2e7d4f",
        warning: "#b8791c",
        danger: "#a52921",
        info: "#2a5fa8",
      },
      typography: baseTypography,
      radius: { control: 10, panel: 14, pill: 999 },
      spacing: { base: 4, gap: 12, padding: 16 },
    },
  },
  {
    key: "slate",
    name: "Slate",
    description: "Neutral and quiet; content carries the colour.",
    theme: {
      colors: {
        background: "#fafafa",
        surface: "#ffffff",
        surfaceSunken: "#f0f0f1",
        border: "#e2e2e4",
        text: "#18181b",
        textSecondary: "#52525b",
        textTertiary: "#8a8a93",
        primary: "#3f3f46",
        primarySoft: "#ececee",
        onPrimary: "#ffffff",
        success: "#15803d",
        warning: "#a16207",
        danger: "#b91c1c",
        info: "#1d4ed8",
      },
      typography: { ...baseTypography, fontFamily: "'IBM Plex Sans', Inter, system-ui, sans-serif" },
      radius: { control: 8, panel: 12, pill: 999 },
      spacing: { base: 4, gap: 10, padding: 14 },
    },
  },
  {
    key: "high-contrast",
    name: "High contrast",
    description: "Built to clear AA everywhere, including small text.",
    theme: {
      colors: {
        background: "#ffffff",
        surface: "#ffffff",
        surfaceSunken: "#f0f0f0",
        border: "#000000",
        text: "#000000",
        textSecondary: "#1f1f1f",
        textTertiary: "#404040",
        primary: "#00437a",
        primarySoft: "#dceaf7",
        onPrimary: "#ffffff",
        success: "#0f6b2f",
        warning: "#7a4a00",
        danger: "#a30000",
        info: "#00437a",
      },
      typography: { ...baseTypography, baseSize: 15 },
      radius: { control: 6, panel: 8, pill: 999 },
      spacing: { base: 4, gap: 12, padding: 16 },
    },
  },
  {
    key: "midnight",
    name: "Midnight",
    description: "Deep blue-black with a cool accent.",
    theme: {
      colors: {
        background: "#080b14",
        surface: "#111624",
        surfaceSunken: "#19203312",
        border: "#232b42",
        text: "#eef1f8",
        textSecondary: "#9aa3bd",
        textTertiary: "#66708c",
        primary: "#6d8dff",
        primarySoft: "#18203c",
        onPrimary: "#070a14",
        success: "#41cf87",
        warning: "#efb54d",
        danger: "#ef6470",
        info: "#6d8dff",
      },
      typography: baseTypography,
      radius: { control: 14, panel: 18, pill: 999 },
      spacing: { base: 4, gap: 14, padding: 18 },
    },
  },
];

/** The theme a brand-new design starts from. */
export const defaultTheme = () => structuredClone(themePresets[0].theme);

/* ---------------------------------------------------------------------------
   Device presets for the canvas
   --------------------------------------------------------------------------- */

export const devices = [
  { key: "iphone-15", name: "iPhone 15", width: 393, height: 852, notch: true, radius: 46 },
  { key: "iphone-15-pro-max", name: "iPhone 15 Pro Max", width: 430, height: 932, notch: true, radius: 50 },
  { key: "iphone-se", name: "iPhone SE", width: 375, height: 667, notch: false, radius: 22 },
  { key: "pixel-8", name: "Pixel 8", width: 412, height: 915, notch: false, radius: 34 },
  { key: "android-compact", name: "Android compact", width: 360, height: 780, notch: false, radius: 28 },
  { key: "ipad-mini", name: "iPad mini", width: 744, height: 1133, notch: false, radius: 24 },
  { key: "custom", name: "Custom", width: 400, height: 860, notch: false, radius: 28 },
];

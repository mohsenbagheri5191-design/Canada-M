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
  { key: "tasks", name: "Tasks & projects", glyph: "listChecks" },
  { key: "notes", name: "Notes & labels", glyph: "note" },
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

  /* ===== Tasks & projects ================================================ */
  {
    key: "tasks-today",
    group: "tasks",
    name: "Today's tasks",
    description: "A grouped task list with a completion bar.",
    tags: ["task", "todo", "today", "list"],
    tree: () => n("TaskList", { title: "Today", showCount: true, showProgress: true }),
  },
  {
    key: "tasks-grouped",
    group: "tasks",
    name: "Grouped by day",
    description: "Three task groups under one heading.",
    tags: ["task", "agenda", "week"],
    tree: () =>
      n("Stack", { direction: "vertical", gap: 20 }, [
        n("TaskList", {
          title: "Today",
          items: [
            { title: "Draft the Q3 rollout plan", state: "doing", priority: "high", due: "Today", assignee: "Maya Chen" },
            { title: "Review vendor quotes", state: "open", priority: "medium", due: "Today", assignee: "Sam Okafor" },
          ],
        }),
        n("TaskList", {
          title: "Tomorrow",
          showProgress: false,
          items: [
            { title: "Send the budget summary", state: "open", priority: "low", due: "Thu", assignee: "" },
            { title: "Waiting on legal sign-off", state: "blocked", priority: "urgent", due: "Thu", assignee: "Leo Dubois" },
          ],
        }),
        n("TaskList", {
          title: "Later",
          showProgress: false,
          items: [{ title: "Plan the retro", state: "open", priority: "none", due: "Next week", assignee: "" }],
        }),
      ]),
  },
  {
    key: "tasks-row",
    group: "tasks",
    name: "Single task row",
    description: "One task on its own, for a custom grouping.",
    tags: ["task", "row", "checkbox"],
    tree: () => n("TaskRow", { priority: "high", assignee: "Maya Chen" }),
  },
  {
    key: "tasks-board",
    group: "tasks",
    name: "Board",
    description: "Columns of cards that scroll sideways.",
    tags: ["kanban", "board", "columns", "sprint"],
    tree: () => n("KanbanBoard", {}),
  },
  {
    key: "tasks-project-card",
    group: "tasks",
    name: "Project card",
    description: "Progress ring, team and due date.",
    tags: ["project", "progress", "summary"],
    tree: () => n("ProjectCard", {}),
  },
  {
    key: "tasks-project-list",
    group: "tasks",
    name: "Project list",
    description: "Three projects, each with its own state.",
    tags: ["project", "portfolio", "list"],
    tree: () =>
      n("Stack", { direction: "vertical", gap: 10 }, [
        n("ProjectCard", { showRing: false }),
        n("ProjectCard", {
          name: "Website Refresh",
          client: "Internal",
          status: "At risk",
          statusTone: "warning",
          progress: 0.34,
          taskCount: "9 of 26 tasks",
          due: "21 Oct",
          members: ["Sam Okafor", "Ana Ruiz"],
          accent: "{{theme.colors.warning}}",
          showRing: false,
        }),
        n("ProjectCard", {
          name: "Certification Audit",
          client: "Brightroof",
          status: "Blocked",
          statusTone: "danger",
          progress: 0.12,
          taskCount: "3 of 24 tasks",
          due: "8 Nov",
          members: ["Priya Raman"],
          accent: "{{theme.colors.danger}}",
          showRing: false,
        }),
      ]),
  },
  {
    key: "tasks-sprint-hero",
    group: "tasks",
    name: "Sprint summary",
    description: "A ring beside the counts it summarises.",
    tags: ["sprint", "progress", "ring", "hero"],
    tree: () =>
      n("Card", { padding: pad(18), gap: 0, radius: 18 }, [
        n("Stack", { direction: "horizontal", gap: 18, align: "center" }, [
          n("ProgressRing", { value: 0.72, label: "", caption: "", diameter: 78, thickness: 8, align: "left" }),
          n("Stack", { direction: "vertical", gap: 6, size: { width: "fill" } }, [
            n("Heading", { text: "Sprint 14", level: 3, fontSize: 17, fontWeight: 650 }),
            n("Text", { text: "18 of 26 tasks · 4 days left", fontSize: 13, color: "{{theme.colors.textSecondary}}" }),
            n("AvatarGroup", { names: ["Maya Chen", "Sam Okafor", "Priya Raman", "Leo Dubois", "Ana Ruiz"], max: 4, avatarSize: 26, label: "" }),
          ]),
        ]),
      ]),
  },
  {
    key: "tasks-checklist",
    group: "tasks",
    name: "Subtask checklist",
    description: "Acceptance criteria with a done count.",
    tags: ["checklist", "subtask", "criteria"],
    tree: () => n("Checklist", {}),
  },
  {
    key: "tasks-detail-head",
    group: "tasks",
    name: "Task detail head",
    description: "Title, labels, assignee and due date.",
    tags: ["task", "detail", "header"],
    tree: () =>
      n("Stack", { direction: "vertical", gap: 14 }, [
        n("Stack", { direction: "horizontal", gap: 8, align: "center" }, [
          n("Badge", { text: "In progress", tone: "primary", glyph: "circleDot" }),
          n("Spacer", { grow: true }),
          n("Text", { text: "PRJ-214", fontSize: 12, color: "{{theme.colors.textTertiary}}" }),
        ]),
        n("Heading", { text: "Draft the Q3 rollout plan", level: 1, fontSize: 23, fontWeight: 660, lineHeight: 1.25 }),
        n("TagList", { variant: "soft", items: [{ text: "planning", color: "{{theme.colors.primary}}" }, { text: "q3", color: "{{theme.colors.info}}" }] }),
        n("Divider", {}),
        n("Stack", { direction: "horizontal", gap: 20, align: "center" }, [
          n("Stack", { direction: "vertical", gap: 4 }, [
            n("Text", { text: "Assignee", fontSize: 11, color: "{{theme.colors.textTertiary}}", transform: "uppercase", letterSpacing: 0.04 }),
            n("AvatarGroup", { names: ["Maya Chen"], max: 1, avatarSize: 26, label: "Maya Chen" }),
          ]),
          n("Spacer", { grow: true }),
          n("Stack", { direction: "vertical", gap: 4, align: "end" }, [
            n("Text", { text: "Due", fontSize: 11, color: "{{theme.colors.textTertiary}}", transform: "uppercase", letterSpacing: 0.04 }),
            n("Text", { text: "Thu 24 Sep", fontSize: 13, fontWeight: 600 }),
          ]),
        ]),
      ]),
  },

  /* ===== Notes & labels ================================================== */
  {
    key: "notes-grid",
    group: "notes",
    name: "Note grid",
    description: "Two columns of note previews.",
    tags: ["note", "grid", "cards"],
    tree: () =>
      n("Grid", { columns: 2, gap: 10 }, [
        n("NoteCard", { accent: "{{theme.colors.primary}}" }),
        n("NoteCard", {
          title: "Vendor comparison",
          body: "Three quotes in. The middle one covers install, the cheapest does not.",
          tags: ["research"],
          pinned: false,
          meta: "Yesterday",
          accent: "{{theme.colors.info}}",
        }),
        n("NoteCard", {
          title: "Reading list",
          body: "Server-driven UI at scale; the Airbnb write-up and the Spotify follow-up.",
          tags: ["links"],
          pinned: false,
          meta: "Mon",
          accent: "",
        }),
        n("NoteCard", {
          title: "Retro — sprint 13",
          body: "Kept: short standups. Dropped: the mid-week review nobody attended.",
          tags: ["retro", "team"],
          pinned: false,
          meta: "Last week",
          accent: "{{theme.colors.warning}}",
        }),
      ]),
  },
  {
    key: "notes-list",
    group: "notes",
    name: "Note list",
    description: "Full-width notes, pinned first.",
    tags: ["note", "list", "pinned"],
    tree: () =>
      n("Stack", { direction: "vertical", gap: 10 }, [
        n("Text", { text: "Pinned", fontSize: 11, color: "{{theme.colors.textTertiary}}", transform: "uppercase", letterSpacing: 0.04, fontWeight: 600 }),
        n("NoteCard", { accent: "{{theme.colors.primary}}" }),
        n("Text", { text: "All notes", fontSize: 11, color: "{{theme.colors.textTertiary}}", transform: "uppercase", letterSpacing: 0.04, fontWeight: 600, margin: pad(8, 0, 0, 0) }),
        n("NoteCard", {
          title: "Vendor comparison",
          body: "Three quotes in. The middle one covers install, the cheapest does not.",
          tags: ["research"],
          pinned: false,
          meta: "Yesterday",
          accent: "",
          showAccentBar: false,
        }),
        n("NoteCard", {
          title: "Retro — sprint 13",
          body: "Kept: short standups. Dropped: the mid-week review nobody attended.",
          tags: ["retro", "team"],
          pinned: false,
          meta: "Last week",
          accent: "",
          showAccentBar: false,
        }),
      ]),
  },
  {
    key: "notes-body",
    group: "notes",
    name: "Note body",
    description: "A typed document: headings, lists, quote, code.",
    tags: ["note", "editor", "rich text", "document"],
    tree: () => n("RichText", {}),
  },
  {
    key: "notes-editor-head",
    group: "notes",
    name: "Note editor head",
    description: "Title, meta line and labels above a body.",
    tags: ["note", "editor", "header"],
    tree: () =>
      n("Stack", { direction: "vertical", gap: 12 }, [
        n("Heading", { text: "Kickoff notes — 14 Sep", level: 1, fontSize: 24, fontWeight: 660, lineHeight: 1.22 }),
        n("Stack", { direction: "horizontal", gap: 8, align: "center" }, [
          n("Text", { text: "Edited 2h ago · Maya Chen", fontSize: 12, color: "{{theme.colors.textTertiary}}" }),
          n("Spacer", { grow: true }),
          n("Icon", { name: "pin", size: 15, color: "{{theme.colors.primary}}" }),
        ]),
        n("TagList", { variant: "soft", items: [{ text: "meeting", color: "{{theme.colors.primary}}" }, { text: "scope", color: "{{theme.colors.info}}" }] }),
        n("Divider", { margin: pad(2, 0) }),
        n("RichText", {}),
      ]),
  },
  {
    key: "notes-labels",
    group: "notes",
    name: "Label row",
    description: "Coloured labels in three variants.",
    tags: ["label", "tag", "chip"],
    tree: () => n("TagList", {}),
  },
  {
    key: "notes-search",
    group: "notes",
    name: "Search and scopes",
    description: "A search field with scope chips under it.",
    tags: ["search", "filter", "scope"],
    tree: () => n("SearchBar", { showScopes: true }),
  },
  {
    key: "notes-sections",
    group: "notes",
    name: "Collapsible sections",
    description: "Accordion panels, the first one open.",
    tags: ["accordion", "collapse", "faq"],
    tree: () => n("Accordion", {}),
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
  {
    key: "detail-files",
    group: "detail",
    name: "Files",
    description: "Attachments on a record.",
    tags: ["files", "attachments", "upload"],
    tree: () =>
      n("Stack", { direction: "vertical", gap: 10 }, [
        n("Stack", { direction: "horizontal", gap: 8, align: "center" }, [
          n("Heading", { text: "Files", level: 3, fontSize: 15, size: { width: "fill" } }),
          n("Text", { text: "3", fontSize: 12, color: "{{theme.colors.textTertiary}}" }),
        ]),
        n("AttachmentList", {}),
      ]),
  },
  {
    key: "detail-discussion",
    group: "detail",
    name: "Discussion",
    description: "Comments with a composer at the end.",
    tags: ["comments", "activity", "thread"],
    tree: () => n("CommentThread", {}),
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

  /* --- Projects, tasks and notes ----------------------------------------- */
  {
    key: "today",
    name: "Today",
    description: "Sprint summary, then what is due.",
    glyph: "listChecks",
    tree: () =>
      n("Stack", { direction: "vertical", gap: 18, padding: pad(20, 16, 24, 16), background: "{{theme.colors.background}}", size: { width: "fill", height: "fill" } }, [
        blockByKey("header-greeting").tree(),
        blockByKey("tasks-sprint-hero").tree(),
        blockByKey("tasks-grouped").tree(),
      ]),
  },
  {
    key: "board",
    name: "Board",
    description: "A sprint board with a filter bar.",
    glyph: "kanban",
    tree: () =>
      n("Stack", { direction: "vertical", gap: 16, padding: pad(16, 16, 24, 16), background: "{{theme.colors.background}}", size: { width: "fill", height: "fill" } }, [
        n("Header", { title: "Sprint 14", showBack: true, showAvatar: true, size: { height: 48 } }),
        n("ChipRow", { items: ["All", "Mine", "Unassigned", "Blocked"], selectedIndex: 0 }),
        n("KanbanBoard", {}),
      ]),
  },
  {
    key: "projects",
    name: "Projects",
    description: "Every project with its state and progress.",
    glyph: "layers",
    tree: () =>
      n("Stack", { direction: "vertical", gap: 16, padding: pad(16, 16, 24, 16), background: "{{theme.colors.background}}", size: { width: "fill", height: "fill" } }, [
        n("Header", { title: "Projects", showBack: false, showAvatar: true, size: { height: 48 } }),
        n("SearchBar", { placeholder: "Search projects", showFilter: true }),
        blockByKey("tasks-project-list").tree(),
      ]),
  },
  {
    key: "task-detail",
    name: "Task detail",
    description: "Head, checklist, files and discussion.",
    glyph: "checkSquare",
    tree: () =>
      n("Stack", { direction: "vertical", gap: 18, padding: pad(12, 16, 28, 16), background: "{{theme.colors.background}}", size: { width: "fill", height: "fill" } }, [
        n("Header", { title: "Task", showBack: true, showAvatar: false }),
        blockByKey("tasks-detail-head").tree(),
        n("Checklist", {}),
        blockByKey("detail-files").tree(),
        n("CommentThread", {}),
      ]),
  },
  {
    key: "notes",
    name: "Notes",
    description: "Search, scopes and a grid of notes.",
    glyph: "note",
    tree: () =>
      n("Stack", { direction: "vertical", gap: 16, padding: pad(16, 16, 24, 16), background: "{{theme.colors.background}}", size: { width: "fill", height: "fill" } }, [
        n("Header", { title: "Notes", showBack: false, showAvatar: true, size: { height: 48 } }),
        n("SearchBar", { placeholder: "Search notes", showScopes: true, scopes: ["All", "Pinned", "Shared", "Archive"], scopeIndex: 0 }),
        blockByKey("notes-grid").tree(),
      ]),
  },
  {
    key: "note-detail",
    name: "Note",
    description: "A single note, open for reading.",
    glyph: "text",
    tree: () =>
      n("Stack", { direction: "vertical", gap: 14, padding: pad(12, 18, 32, 18), background: "{{theme.colors.background}}", size: { width: "fill", height: "fill" } }, [
        n("Header", { title: "", showBack: true, showAvatar: false, size: { height: 44 } }),
        blockByKey("notes-editor-head").tree(),
      ]),
  },
  {
    key: "planner",
    name: "Planner",
    description: "A month grid above the day's tasks.",
    glyph: "monthGrid",
    tree: () =>
      n("Stack", { direction: "vertical", gap: 18, padding: pad(16, 16, 24, 16), background: "{{theme.colors.background}}", size: { width: "fill", height: "fill" } }, [
        n("Header", { title: "Planner", showBack: false, showAvatar: true, size: { height: 48 } }),
        n("MiniCalendar", {}),
        n("TaskList", { title: "Thursday 17", showProgress: false }),
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
   Themes

   Palettes, visual styles and their pairings now live in data/styles.js, so a
   theme is a palette plus a style rather than one fixed blob. Re-exported here
   because everything already imports them from this module.
   --------------------------------------------------------------------------- */

export {
  themePresets,
  defaultTheme,
  appPalettes,
  appStyles,
  makeTheme,
  getStyle,
  createSurfaceResolver,
} from "./styles.js";


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

/**
 * The data layer.
 *
 * Everything the dashboard reads or writes goes through this module. It is
 * backed by a seeded in-memory store persisted to localStorage, shaped exactly
 * like the API contract in the brief, so replacing it with real fetch calls is
 * a change to this file and nothing else.
 *
 * Each exported group mirrors an endpoint family:
 *   db.orgs        /api/v1/organizations
 *   db.users       /api/v1/users
 *   db.designs     /api/v1/designs, /api/v1/versions
 *   db.assignments /api/v1/assignments
 *   db.paths       /api/v1/paths
 *   db.entities    /api/v1/entities, /api/v1/collections
 *   db.features    /api/v1/features
 *   db.rules       /api/v1/rules
 *   db.audit       /api/v1/audit
 */

import { persist, clone, bus } from "../core/store.js";
import { uid, seededRandom, slug } from "../core/util.js";
import { defaultTheme, screenTemplates, themePresets } from "./presets.js";

/* ---------------------------------------------------------------------------
   Seed
   --------------------------------------------------------------------------- */

const rand = seededRandom("canada-services-2026");
const pick = (list) => list[Math.floor(rand() * list.length)];
const ago = (days, hours = 0) => new Date(Date.now() - days * 864e5 - hours * 36e5).toISOString();

const FIRST = ["Maya", "Daniel", "Sarah", "Noah", "Priya", "Liam", "Chloe", "Omar", "Ava", "Ethan", "Zoe", "Marcus", "Ines", "Tomas", "Hana", "Ben", "Leila", "Jonas", "Rosa", "Kwame"];
const LAST = ["Chen", "Kim", "Malik", "Patel", "Raman", "Tremblay", "Dubois", "Haddad", "Nguyen", "Okafor", "Silva", "Brennan", "Kowalski", "Ito", "Moreau", "Singh", "Lindqvist", "Costa", "Abara", "Reyes"];

function seed() {
  const now = Date.now();

  /* --- Organisations --------------------------------------------------- */
  const orgs = [
    { id: "org_northstar", name: "Northstar Solar", slug: "northstar", status: "active", plan: "Scale", region: "ON", created_at: ago(420) },
    { id: "org_brightroof", name: "BrightRoof Services", slug: "brightroof", status: "active", plan: "Growth", region: "BC", created_at: ago(310) },
    { id: "org_lakeside", name: "Lakeside Mechanical", slug: "lakeside", status: "active", plan: "Growth", region: "ON", created_at: ago(240) },
    { id: "org_prairie", name: "Prairie Field Ops", slug: "prairie", status: "active", plan: "Starter", region: "AB", created_at: ago(150) },
    { id: "org_maritime", name: "Maritime Utilities", slug: "maritime", status: "suspended", plan: "Starter", region: "NS", created_at: ago(95) },
  ];

  /* --- Users ------------------------------------------------------------ */
  const users = [
    {
      id: "usr_root",
      organization_id: null,
      email: "ops@canadaservices.ca",
      full_name: "Platform Operations",
      role: "super_admin",
      status: "active",
      last_login_at: ago(0, 1),
      created_at: ago(500),
      session_count: 412,
    },
  ];

  const roleMix = ["org_admin", "designer", "app_user", "app_user", "app_user", "app_user", "viewer", "app_user"];
  for (const org of orgs) {
    const count = org.id === "org_northstar" ? 14 : org.id === "org_brightroof" ? 9 : org.id === "org_lakeside" ? 7 : org.id === "org_prairie" ? 5 : 3;
    for (let i = 0; i < count; i += 1) {
      const first = pick(FIRST);
      const last = pick(LAST);
      const role = i === 0 ? "org_admin" : roleMix[i % roleMix.length];
      const status = org.status === "suspended" ? "suspended" : rand() > 0.9 ? "invited" : "active";
      users.push({
        id: uid("usr"),
        organization_id: org.id,
        email: `${first.toLowerCase()}.${last.toLowerCase()}@${org.slug}.ca`,
        full_name: `${first} ${last}`,
        role,
        status,
        last_login_at: status === "invited" ? null : ago(Math.floor(rand() * 14), Math.floor(rand() * 20)),
        created_at: ago(Math.floor(rand() * 200) + 20),
        session_count: Math.floor(rand() * 180),
      });
    }
  }

  /* --- Designs and versions --------------------------------------------- */
  const designs = [];
  const versions = [];

  const makeDesign = ({ id, org, name, description, status, versionCount, publishedIndex, screens, themeKey }) => {
    // A missing key used to fall through to preset zero, which made every
    // seeded design look identical and hid the typo. Say so instead.
    const preset = themePresets.find((t) => t.key === themeKey);
    if (!preset) console.warn(`seed: unknown theme preset "${themeKey}" on ${id}`);
    const designTheme = (preset ?? themePresets[0]).theme;
    designs.push({
      id,
      organization_id: org,
      name,
      description,
      status,
      created_by: users[1].id,
      created_at: ago(120),
      updated_at: ago(Math.floor(rand() * 8)),
    });

    for (let v = 1; v <= versionCount; v += 1) {
      const isPublished = v === publishedIndex;
      const isDraft = v === versionCount && publishedIndex !== versionCount;
      versions.push({
        id: `${id}_v${v}`,
        design_id: id,
        version_number: v,
        label: v === publishedIndex ? "Current live" : v === versionCount && isDraft ? "Working draft" : `Revision ${v}`,
        schema_version: 1,
        status: isPublished ? "published" : isDraft ? "draft" : "archived",
        document: {
          schemaVersion: 1,
          designId: id,
          versionNumber: v,
          screens: screens(v),
        },
        theme: clone(designTheme),
        published_at: isPublished ? ago(6) : null,
        published_by: isPublished ? users[1].id : null,
        created_at: ago(90 - v * 8),
      });
    }
  };

  // Routes are derived from the template key and de-duplicated, because a
  // duplicate path is exactly what the publish validator refuses and seeded
  // data should not ship already failing its own rules.
  const buildScreens = (keys) => () => {
    const taken = new Set();
    return keys.map((key, i) => {
      const template = screenTemplates.find((t) => t.key === key) ?? screenTemplates[0];
      let route = i === 0 ? "/home" : `/${key}`;
      let suffix = 2;
      while (taken.has(route)) route = `/${key}-${suffix++}`;
      taken.add(route);

      return {
        id: `scr_${key}_${i}`,
        name: template.name,
        route,
        isEntry: i === 0,
        requiresRole: null,
        transition: "slide",
        root: withIds(template.tree()),
      };
    });
  };

  makeDesign({
    id: "dsg_fieldops",
    org: "org_northstar",
    name: "Solar Field Ops",
    description: "The default technician experience: route, job detail, completion report.",
    status: "published",
    versionCount: 4,
    publishedIndex: 3,
    screens: buildScreens(["home", "list", "detail", "form"]),
    themeKey: "graphite-flat",
  });

  makeDesign({
    id: "dsg_compact",
    org: "org_northstar",
    name: "Compact Technician",
    description: "A denser variant for crews on smaller devices.",
    status: "published",
    versionCount: 4,
    publishedIndex: 4,
    screens: buildScreens(["list", "detail", "profile"]),
    themeKey: "carbon-flat",
  });

  makeDesign({
    id: "dsg_roofing",
    org: "org_brightroof",
    name: "Roofing Inspection",
    description: "Photo-first inspection flow with a sign-off step.",
    status: "published",
    versionCount: 3,
    publishedIndex: 3,
    screens: buildScreens(["form", "success", "home"]),
    themeKey: "slate-glass",
  });

  makeDesign({
    id: "dsg_mech",
    org: "org_lakeside",
    name: "Mechanical Service",
    description: "Service calls with parts tracking.",
    status: "published",
    versionCount: 2,
    publishedIndex: 2,
    screens: buildScreens(["detail", "list", "home"]),
    themeKey: "amber-soft",
  });

  makeDesign({
    id: "dsg_followup",
    org: "org_northstar",
    name: "Service Follow-up",
    description: "Post-install check-in. Not yet published.",
    status: "draft",
    versionCount: 1,
    publishedIndex: 0,
    screens: buildScreens(["profile", "form"]),
    themeKey: "midnight-elevated",
  });

  makeDesign({
    id: "dsg_prairie",
    org: "org_prairie",
    name: "Prairie Starter",
    description: "The stock layout new organisations begin on.",
    status: "published",
    versionCount: 1,
    publishedIndex: 1,
    screens: buildScreens(["empty", "detail"]),
    themeKey: "hc-light",
  });

  /* --- Routes ------------------------------------------------------------ */
  const routes = [];
  for (const version of versions) {
    for (const screen of version.document.screens) {
      routes.push({
        id: uid("rt"),
        design_version_id: version.id,
        path: screen.route,
        screen_node_id: screen.id,
        is_entry: screen.isEntry,
        requires_role: screen.requiresRole ?? null,
      });
    }
  }

  /* --- Assignments ------------------------------------------------------- */
  const assignments = [
    { id: uid("asg"), design_version_id: "dsg_fieldops_v3", scope: "organization", organization_id: "org_northstar", user_id: null, priority: 10, starts_at: null, ends_at: null, enabled: true, created_at: ago(30), created_by: users[0].id },
    { id: uid("asg"), design_version_id: "dsg_compact_v4", scope: "user", organization_id: "org_northstar", user_id: users.find((u) => u.organization_id === "org_northstar" && u.role === "app_user")?.id, priority: 90, starts_at: null, ends_at: null, enabled: true, created_at: ago(12), created_by: users[0].id },
    { id: uid("asg"), design_version_id: "dsg_roofing_v3", scope: "organization", organization_id: "org_brightroof", user_id: null, priority: 10, starts_at: null, ends_at: null, enabled: true, created_at: ago(25), created_by: users[0].id },
    { id: uid("asg"), design_version_id: "dsg_mech_v2", scope: "organization", organization_id: "org_lakeside", user_id: null, priority: 10, starts_at: null, ends_at: null, enabled: true, created_at: ago(20), created_by: users[0].id },
    { id: uid("asg"), design_version_id: "dsg_prairie_v1", scope: "organization", organization_id: "org_prairie", user_id: null, priority: 10, starts_at: null, ends_at: null, enabled: true, created_at: ago(18), created_by: users[0].id },
  ].filter((a) => a.scope === "organization" || a.user_id);

  /* --- Features ---------------------------------------------------------- */
  const features = [
    {
      id: "ftr_jobs",
      key: "jobs",
      name: "Jobs",
      description: "The core scheduling and dispatch surface.",
      icon: "list",
      origin: "code",
      status: "published",
      depends_on: [],
      manifest: {
        key: "jobs",
        version: 4,
        screens: ["scr_home_0", "scr_list_1", "scr_detail_2"],
        routes: [{ path: "/jobs", screen: "scr_list_1", isEntry: false }],
        collections: ["jobs"],
        navigation: [{ label: "Jobs", icon: "list", route: "/jobs", position: 1 }],
        permissions: { view: ["app_user"], manage: ["org_admin"] },
      },
      settings_schema: {
        autoAssign: { type: "boolean", default: false, label: "Auto-assign new jobs" },
        dayStart: { type: "text", default: "07:00", label: "Route day starts at" },
        maxStops: { type: "number", default: 12, min: 1, max: 40, label: "Maximum stops per route" },
      },
      created_at: ago(400),
    },
    {
      id: "ftr_reports",
      key: "reports",
      name: "Completion reports",
      description: "On-site capture, photos and customer sign-off.",
      icon: "file",
      origin: "code",
      status: "published",
      depends_on: ["jobs"],
      manifest: { key: "reports", version: 3, screens: ["scr_form_3"], routes: [{ path: "/report", screen: "scr_form_3" }], collections: ["reports"], navigation: [], permissions: { view: ["app_user"], manage: ["org_admin"] } },
      settings_schema: {
        requireSignature: { type: "boolean", default: true, label: "Require customer signature" },
        requirePhoto: { type: "boolean", default: true, label: "Require at least one photo" },
        retentionDays: { type: "number", default: 365, min: 30, max: 2555, label: "Keep reports for (days)" },
      },
      created_at: ago(380),
    },
    {
      id: "ftr_rewards",
      key: "rewards",
      name: "Rewards",
      description: "Points, tiers and redemptions for technicians.",
      icon: "gift",
      origin: "composed",
      status: "published",
      depends_on: ["jobs"],
      manifest: { key: "rewards", version: 2, screens: [], routes: [{ path: "/rewards", screen: "scr_profile_2" }], collections: ["rewards", "redemptions"], navigation: [{ label: "Rewards", icon: "gift", route: "/rewards", position: 3 }], permissions: { view: ["app_user"], manage: ["org_admin"] } },
      settings_schema: {
        pointsPerJob: { type: "number", default: 10, min: 0, max: 500, label: "Points per completed job" },
        expiryDays: { type: "number", default: 365, min: 30, max: 1095, label: "Points expire after (days)" },
        showLeaderboard: { type: "boolean", default: false, label: "Show the crew leaderboard" },
      },
      created_at: ago(200),
    },
    {
      id: "ftr_followups",
      key: "followups",
      name: "Service follow-ups",
      description: "Scheduled check-ins after an install.",
      icon: "calendarClock",
      origin: "composed",
      status: "published",
      depends_on: ["jobs", "reports"],
      manifest: { key: "followups", version: 1, screens: [], routes: [{ path: "/followups", screen: "scr_list_1" }], collections: ["followups"], navigation: [{ label: "Follow-ups", icon: "calendarClock", route: "/followups", position: 4 }], permissions: { view: ["app_user"], manage: ["org_admin"] } },
      settings_schema: {
        delayDays: { type: "number", default: 30, min: 1, max: 365, label: "Days after completion" },
        channel: { type: "select", default: "push", options: ["push", "email", "sms"], label: "Reminder channel" },
      },
      created_at: ago(90),
    },
    {
      id: "ftr_offline",
      key: "offline",
      name: "Offline sync",
      description: "Queue work with no signal and reconcile on reconnect.",
      icon: "cloud",
      origin: "code",
      status: "published",
      depends_on: [],
      manifest: { key: "offline", version: 2, screens: [], routes: [], collections: [], navigation: [], permissions: { view: ["app_user"], manage: ["super_admin"] } },
      settings_schema: {
        queueLimit: { type: "number", default: 50, min: 5, max: 500, label: "Maximum queued actions" },
      },
      created_at: ago(300),
    },
    {
      id: "ftr_payments",
      key: "payments",
      name: "On-site payments",
      description: "Card capture at the door. Needs a provider integration.",
      icon: "dollar",
      origin: "code",
      status: "draft",
      depends_on: ["jobs"],
      manifest: { key: "payments", version: 1, screens: [], routes: [], collections: ["payments"], navigation: [], permissions: { view: ["app_user"], manage: ["org_admin"] } },
      settings_schema: {
        provider: { type: "select", default: "none", options: ["none", "stripe", "square"], label: "Payment provider" },
        currency: { type: "select", default: "CAD", options: ["CAD", "USD"], label: "Currency" },
      },
      created_at: ago(20),
    },
  ];

  const featureAssignments = [];
  for (const org of orgs) {
    for (const feature of features) {
      const on =
        feature.key === "jobs" ||
        feature.key === "reports" ||
        (feature.key === "offline" && org.id !== "org_prairie") ||
        (feature.key === "rewards" && ["org_northstar", "org_brightroof"].includes(org.id)) ||
        (feature.key === "followups" && org.id === "org_northstar");

      featureAssignments.push({
        id: uid("fas"),
        feature_id: feature.id,
        organization_id: org.id,
        enabled: Boolean(on) && feature.status === "published",
        settings: Object.fromEntries(Object.entries(feature.settings_schema ?? {}).map(([k, v]) => [k, v.default])),
        updated_at: ago(Math.floor(rand() * 30)),
        updated_by: users[0].id,
      });
    }
  }

  /* --- Collections and records ------------------------------------------- */
  const collections = [
    {
      id: "col_jobs",
      organization_id: null,
      feature_id: "ftr_jobs",
      key: "jobs",
      name: "Jobs",
      origin: "native",
      title_field: "customer",
      field_schema: [
        { key: "reference", label: "Reference", type: "text", required: true, unique: true },
        { key: "customer", label: "Customer", type: "text", required: true },
        { key: "service", label: "Service", type: "select", options: ["Installation", "Inspection", "Repair", "Maintenance"], required: true },
        { key: "status", label: "Status", type: "select", options: ["Scheduled", "In progress", "Blocked", "Complete"], required: true },
        { key: "city", label: "City", type: "text" },
        { key: "scheduled_at", label: "Scheduled", type: "datetime" },
        { key: "value", label: "Value", type: "currency" },
        { key: "priority", label: "Priority", type: "select", options: ["Low", "Normal", "High"] },
        { key: "notes", label: "Notes", type: "longtext" },
      ],
      created_at: ago(400),
    },
    {
      id: "col_customers",
      organization_id: null,
      feature_id: "ftr_jobs",
      key: "customers",
      name: "Customers",
      origin: "native",
      title_field: "name",
      field_schema: [
        { key: "name", label: "Name", type: "text", required: true },
        { key: "email", label: "Email", type: "text" },
        { key: "phone", label: "Phone", type: "text" },
        { key: "city", label: "City", type: "text" },
        { key: "since", label: "Customer since", type: "date" },
        { key: "active", label: "Active", type: "boolean" },
      ],
      created_at: ago(400),
    },
    {
      id: "col_reports",
      organization_id: null,
      feature_id: "ftr_reports",
      key: "reports",
      name: "Completion reports",
      origin: "native",
      title_field: "job_reference",
      field_schema: [
        { key: "job_reference", label: "Job", type: "text", required: true },
        { key: "technician", label: "Technician", type: "text" },
        { key: "submitted_at", label: "Submitted", type: "datetime" },
        { key: "signed", label: "Signed off", type: "boolean" },
        { key: "duration_min", label: "Minutes on site", type: "number" },
        { key: "summary", label: "Summary", type: "longtext" },
      ],
      created_at: ago(380),
    },
    {
      id: "col_rewards",
      organization_id: "org_northstar",
      feature_id: "ftr_rewards",
      key: "rewards",
      name: "Rewards catalogue",
      origin: "collection",
      title_field: "name",
      field_schema: [
        { key: "name", label: "Reward", type: "text", required: true },
        { key: "cost", label: "Points", type: "number", required: true },
        { key: "category", label: "Category", type: "select", options: ["Gear", "Time off", "Gift card"] },
        { key: "available", label: "Available", type: "boolean" },
        { key: "image", label: "Image", type: "image" },
      ],
      created_at: ago(120),
    },
    {
      id: "col_followups",
      organization_id: "org_northstar",
      feature_id: "ftr_followups",
      key: "followups",
      name: "Follow-ups",
      origin: "collection",
      title_field: "customer",
      field_schema: [
        { key: "customer", label: "Customer", type: "text", required: true },
        { key: "due", label: "Due", type: "date", required: true },
        { key: "channel", label: "Channel", type: "select", options: ["Push", "Email", "SMS"] },
        { key: "state", label: "State", type: "select", options: ["Pending", "Sent", "Answered", "Missed"] },
        { key: "score", label: "Satisfaction", type: "number" },
      ],
      created_at: ago(80),
    },
  ];

  const CITIES = ["Mississauga", "Brampton", "Oakville", "Burlington", "Hamilton", "Vaughan", "Markham", "Surrey", "Burnaby", "Calgary", "Halifax"];
  const SERVICES = ["Installation", "Inspection", "Repair", "Maintenance"];
  const STATUSES = ["Scheduled", "In progress", "Blocked", "Complete"];

  const records = [];
  const addRecord = (collection_id, organization_id, data) => {
    records.push({
      id: uid("rec"),
      collection_id,
      organization_id,
      data,
      created_by: users[0].id,
      created_at: ago(Math.floor(rand() * 60)),
      updated_at: ago(Math.floor(rand() * 10)),
      deleted_at: null,
    });
  };

  for (let i = 0; i < 148; i += 1) {
    const org = pick(orgs.slice(0, 4));
    const first = pick(FIRST);
    const last = pick(LAST);
    addRecord("col_jobs", org.id, {
      reference: `CS-${1000 + i}`,
      customer: `${first} ${last}`,
      service: pick(SERVICES),
      status: pick(STATUSES),
      city: pick(CITIES),
      scheduled_at: new Date(now + (rand() * 20 - 8) * 864e5).toISOString(),
      value: Math.round((rand() * 6400 + 380) / 10) * 10,
      priority: pick(["Low", "Normal", "Normal", "High"]),
      notes: "",
    });
  }

  for (let i = 0; i < 62; i += 1) {
    const org = pick(orgs.slice(0, 4));
    const first = pick(FIRST);
    const last = pick(LAST);
    addRecord("col_customers", org.id, {
      name: `${first} ${last}`,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@example.ca`,
      phone: `(905) 555-0${100 + (i % 899)}`,
      city: pick(CITIES),
      since: new Date(now - (rand() * 1400 + 90) * 864e5).toISOString().slice(0, 10),
      active: rand() > 0.18,
    });
  }

  for (let i = 0; i < 74; i += 1) {
    const org = pick(orgs.slice(0, 4));
    addRecord("col_reports", org.id, {
      job_reference: `CS-${1000 + Math.floor(rand() * 148)}`,
      technician: `${pick(FIRST)} ${pick(LAST)}`,
      submitted_at: new Date(now - rand() * 30 * 864e5).toISOString(),
      signed: rand() > 0.15,
      duration_min: Math.round(45 + rand() * 210),
      summary: "",
    });
  }

  for (const reward of [
    { name: "Insulated work jacket", cost: 1800, category: "Gear", available: true },
    { name: "Half day off", cost: 3200, category: "Time off", available: true },
    { name: "$50 fuel card", cost: 900, category: "Gift card", available: true },
    { name: "Premium tool set", cost: 5400, category: "Gear", available: false },
    { name: "$100 grocery card", cost: 1750, category: "Gift card", available: true },
  ]) {
    addRecord("col_rewards", "org_northstar", { ...reward, image: "" });
  }

  for (let i = 0; i < 28; i += 1) {
    addRecord("col_followups", "org_northstar", {
      customer: `${pick(FIRST)} ${pick(LAST)}`,
      due: new Date(now + (rand() * 40 - 10) * 864e5).toISOString().slice(0, 10),
      channel: pick(["Push", "Email", "SMS"]),
      state: pick(["Pending", "Pending", "Sent", "Answered", "Missed"]),
      score: Math.round(rand() * 5),
    });
  }

  /* --- Rules ------------------------------------------------------------- */
  const rules = [
    {
      id: "rul_welcome",
      organization_id: "org_northstar",
      name: "Welcome new technicians",
      trigger: { type: "user.created", collectionKey: null },
      conditions: { all: [{ left: "$user.role", op: "==", right: "app_user" }] },
      actions: [
        { type: "send_email", params: { template: "welcome", to: "{{user.email}}" } },
        { type: "notify_admin", params: { message: "New technician onboarded" } },
      ],
      enabled: true,
      created_at: ago(64),
      created_by: users[0].id,
    },
    {
      id: "rul_blocked",
      organization_id: "org_northstar",
      name: "Escalate blocked jobs",
      trigger: { type: "record.updated", collectionKey: "jobs", field: "status" },
      conditions: { all: [{ left: "$record.status", op: "==", right: "Blocked" }] },
      actions: [
        { type: "notify_admin", params: { message: "Job {{record.reference}} is blocked" } },
        { type: "set_field", params: { field: "priority", value: "High" } },
      ],
      enabled: true,
      created_at: ago(40),
      created_by: users[1].id,
    },
    {
      id: "rul_followup",
      organization_id: "org_northstar",
      name: "Schedule 30-day follow-up",
      trigger: { type: "record.created", collectionKey: "reports" },
      conditions: { all: [{ left: "$record.signed", op: "==", right: true }] },
      actions: [{ type: "create_record", params: { collection: "followups", data: "{ customer, due: +30d }" } }],
      enabled: true,
      created_at: ago(30),
      created_by: users[1].id,
    },
    {
      id: "rul_webhook",
      organization_id: "org_brightroof",
      name: "Push completions to ERP",
      trigger: { type: "record.created", collectionKey: "reports" },
      conditions: { all: [] },
      actions: [{ type: "call_webhook", params: { url: "https://erp.brightroof.ca/hooks/report", method: "POST" } }],
      enabled: false,
      created_at: ago(18),
      created_by: users[0].id,
      disabled_reason: "Auto-disabled after 5 consecutive failures",
    },
    {
      id: "rul_weekly",
      organization_id: "org_lakeside",
      name: "Weekly summary to dispatch",
      trigger: { type: "schedule", cadence: "weekly", at: "Mon 07:00" },
      conditions: { all: [] },
      actions: [{ type: "send_email", params: { template: "weekly-summary", to: "dispatch@lakeside.ca" } }],
      enabled: true,
      created_at: ago(55),
      created_by: users[0].id,
    },
  ];

  const ruleRuns = [];
  for (const rule of rules) {
    const count = rule.id === "rul_webhook" ? 8 : 6 + Math.floor(rand() * 10);
    for (let i = 0; i < count; i += 1) {
      const failed = rule.id === "rul_webhook" ? i < 5 : rand() > 0.9;
      ruleRuns.push({
        id: uid("run"),
        rule_id: rule.id,
        status: failed ? "failed" : rand() > 0.94 ? "skipped" : "success",
        input: { recordId: uid("rec"), trigger: rule.trigger.type },
        output: failed ? null : { delivered: true },
        error: failed ? "HTTP 502 from https://erp.brightroof.ca/hooks/report" : null,
        duration_ms: Math.round(40 + rand() * 900),
        occurred_at: ago(Math.floor(rand() * 14), Math.floor(rand() * 24)),
      });
    }
  }

  /* --- Telemetry --------------------------------------------------------- */
  const pathEvents = [];
  const appUsers = users.filter((u) => u.role === "app_user" && u.status === "active");
  const ROUTES = ["/home", "/list", "/detail", "/form", "/profile", "/success"];

  for (const user of appUsers) {
    const sessions = 2 + Math.floor(rand() * 5);
    for (let s = 0; s < sessions; s += 1) {
      const day = Math.floor(rand() * 14);
      const steps = 2 + Math.floor(rand() * 5);
      let clock = day * 864e5 + Math.floor(rand() * 8) * 36e5;
      for (let i = 0; i < steps; i += 1) {
        const route = i === 0 ? "/home" : pick(ROUTES);
        clock -= Math.floor(12000 + rand() * 180000);
        pathEvents.push({
          id: pathEvents.length + 1,
          user_id: user.id,
          design_version_id: null,
          route_path: route,
          event: rand() > 0.82 ? "action" : "view",
          node_id: null,
          metadata: { session: `s${s}`, dwell_ms: Math.round(4000 + rand() * 90000) },
          occurred_at: new Date(now - clock).toISOString(),
        });
      }
      if (rand() > 0.88) {
        pathEvents.push({
          id: pathEvents.length + 1,
          user_id: user.id,
          design_version_id: null,
          route_path: pick(ROUTES),
          event: "error",
          node_id: null,
          metadata: { message: "Render fallback used" },
          occurred_at: new Date(now - clock).toISOString(),
        });
      }
    }
  }

  /* --- Audit ------------------------------------------------------------- */
  const AUDIT_ACTIONS = [
    ["design.publish", "Design", "published Solar Field Ops v3"],
    ["assignment.create", "Assignment", "assigned Compact Technician v4 to Daniel Kim"],
    ["user.create", "User", "created an account for Priya Raman"],
    ["feature.toggle", "Feature", "enabled Rewards for BrightRoof Services"],
    ["collection.create", "Collection", "created the Follow-ups collection"],
    ["record.bulk_update", "Record", "updated 24 job records"],
    ["rule.disable", "Rule", "auto-disabled Push completions to ERP"],
    ["design.rollback", "Design", "rolled Roofing Inspection back to v2"],
    ["org.settings", "Organisation", "updated Northstar Solar settings"],
    ["user.suspend", "User", "suspended an account at Maritime Utilities"],
  ];

  const auditLog = [];
  for (let i = 0; i < 46; i += 1) {
    const [action, entity, phrase] = pick(AUDIT_ACTIONS);
    const actor = pick(users.filter((u) => ["super_admin", "org_admin", "designer"].includes(u.role)));
    auditLog.push({
      id: i + 1,
      actor_id: actor.id,
      actor_name: actor.full_name,
      action,
      entity_type: entity,
      entity_id: uid("ent"),
      phrase,
      before: null,
      after: null,
      ip: `24.${Math.floor(rand() * 250)}.${Math.floor(rand() * 250)}.${Math.floor(rand() * 250)}`,
      occurred_at: ago(Math.floor(rand() * 9), Math.floor(rand() * 24)),
    });
  }
  auditLog.sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));

  /* --- Per-organisation settings ----------------------------------------- */
  const orgSettings = Object.fromEntries(
    orgs.map((org) => [
      org.id,
      {
        appName: org.name,
        supportEmail: `support@${org.slug}.ca`,
        supportPhone: "(800) 555-0199",
        locale: "en-CA",
        timezone: org.region === "BC" ? "America/Vancouver" : org.region === "AB" ? "America/Edmonton" : org.region === "NS" ? "America/Halifax" : "America/Toronto",
        legalUrl: `https://${org.slug}.ca/terms`,
        privacyUrl: `https://${org.slug}.ca/privacy`,
        defaultTheme: "field-light",
        maxUsers: org.plan === "Scale" ? 250 : org.plan === "Growth" ? 100 : 25,
        maxRecords: org.plan === "Scale" ? 500000 : org.plan === "Growth" ? 100000 : 20000,
        notifyPush: true,
        notifyEmail: true,
        notifySms: org.plan === "Scale",
      },
    ]),
  );

  return {
    orgs,
    users,
    designs,
    versions,
    routes,
    assignments,
    features,
    featureAssignments,
    collections,
    records,
    rules,
    ruleRuns,
    pathEvents,
    auditLog,
    orgSettings,
    meta: { seededAt: new Date().toISOString(), version: 1 },
  };
}

/** Assign stable ids to a preset tree. */
function withIds(node) {
  node.id = uid("n");
  if (Array.isArray(node.children)) node.children.forEach(withIds);
  return node;
}

/* ---------------------------------------------------------------------------
   Store bootstrap
   --------------------------------------------------------------------------- */

const SAVE_KEY = "db";

let state = persist.read(SAVE_KEY);
if (!state || state.meta?.version !== 1) {
  state = seed();
  persist.write(SAVE_KEY, state);
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persist.write(SAVE_KEY, state), 400);
}

/** Write an audit entry. Every mutation in the product calls this. */
function audit(action, entityType, phrase, extra = {}) {
  const entry = {
    id: (state.auditLog[0]?.id ?? 0) + 1,
    actor_id: state.users[0].id,
    actor_name: state.users[0].full_name,
    action,
    entity_type: entityType,
    entity_id: extra.entityId ?? null,
    phrase,
    before: extra.before ?? null,
    after: extra.after ?? null,
    ip: "127.0.0.1",
    occurred_at: new Date().toISOString(),
  };
  state.auditLog.unshift(entry);
  save();
  bus.emit("audit:appended", entry);
  return entry;
}

/* ---------------------------------------------------------------------------
   Public API
   --------------------------------------------------------------------------- */

export const db = {
  get raw() {
    return state;
  },

  reseed() {
    state = seed();
    persist.write(SAVE_KEY, state);
    bus.emit("db:reseeded");
  },

  audit,
  save,

  /* --- Organisations ---------------------------------------------------- */
  orgs: {
    list: () => clone(state.orgs),
    get: (id) => clone(state.orgs.find((o) => o.id === id) ?? null),
    settings: (id) => clone(state.orgSettings[id] ?? {}),
    updateSettings(id, patch) {
      state.orgSettings[id] = { ...(state.orgSettings[id] ?? {}), ...patch };
      audit("org.settings", "Organisation", `updated ${state.orgs.find((o) => o.id === id)?.name} settings`, { entityId: id });
      return clone(state.orgSettings[id]);
    },
    create(input) {
      const org = {
        id: uid("org"),
        name: input.name,
        slug: input.slug || slug(input.name),
        status: "active",
        plan: input.plan || "Starter",
        region: input.region || "ON",
        created_at: new Date().toISOString(),
      };
      state.orgs.push(org);
      state.orgSettings[org.id] = { appName: org.name, supportEmail: `support@${org.slug}.ca`, locale: "en-CA", timezone: "America/Toronto", defaultTheme: "field-light", maxUsers: 25, maxRecords: 20000, notifyPush: true, notifyEmail: true, notifySms: false };
      for (const feature of state.features) {
        state.featureAssignments.push({
          id: uid("fas"),
          feature_id: feature.id,
          organization_id: org.id,
          enabled: ["jobs", "reports"].includes(feature.key),
          settings: Object.fromEntries(Object.entries(feature.settings_schema ?? {}).map(([k, v]) => [k, v.default])),
          updated_at: new Date().toISOString(),
          updated_by: state.users[0].id,
        });
      }
      audit("org.create", "Organisation", `created ${org.name}`, { entityId: org.id });
      return clone(org);
    },
    update(id, patch) {
      const org = state.orgs.find((o) => o.id === id);
      if (!org) return null;
      Object.assign(org, patch);
      audit("org.update", "Organisation", `updated ${org.name}`, { entityId: id });
      return clone(org);
    },
  },

  /* --- Users ------------------------------------------------------------- */
  users: {
    list({ org = null, role = null, status = null, q = "" } = {}) {
      let rows = state.users;
      if (org) rows = rows.filter((u) => u.organization_id === org);
      if (role) rows = rows.filter((u) => u.role === role);
      if (status) rows = rows.filter((u) => u.status === status);
      if (q) {
        const needle = q.toLowerCase();
        rows = rows.filter((u) => `${u.full_name} ${u.email}`.toLowerCase().includes(needle));
      }
      return clone(rows);
    },
    get: (id) => clone(state.users.find((u) => u.id === id) ?? null),
    create(input) {
      const user = {
        id: uid("usr"),
        organization_id: input.organization_id ?? null,
        email: input.email,
        full_name: input.full_name ?? "",
        role: input.role ?? "app_user",
        status: input.invite === false ? "active" : "invited",
        last_login_at: null,
        created_at: new Date().toISOString(),
        session_count: 0,
      };
      state.users.push(user);
      audit("user.create", "User", `created an account for ${user.full_name || user.email}`, { entityId: user.id });
      return clone(user);
    },
    update(id, patch) {
      const user = state.users.find((u) => u.id === id);
      if (!user) return null;
      const before = clone(user);
      Object.assign(user, patch);
      audit("user.update", "User", `updated ${user.full_name || user.email}`, { entityId: id, before, after: clone(user) });
      return clone(user);
    },
    remove(id) {
      const index = state.users.findIndex((u) => u.id === id);
      if (index === -1) return false;
      const [user] = state.users.splice(index, 1);
      state.assignments = state.assignments.filter((a) => a.user_id !== id);
      audit("user.delete", "User", `deleted ${user.full_name || user.email}`, { entityId: id });
      return true;
    },
    createMany(rows) {
      const created = rows.map((row) => ({
        id: uid("usr"),
        organization_id: row.organization_id ?? null,
        email: row.email,
        full_name: row.full_name ?? "",
        role: row.role ?? "app_user",
        status: "invited",
        last_login_at: null,
        created_at: new Date().toISOString(),
        session_count: 0,
      }));
      state.users.push(...created);
      audit("user.bulk_create", "User", `imported ${created.length} accounts`);
      return clone(created);
    },
  },

  /* --- Designs ----------------------------------------------------------- */
  designs: {
    list({ org = null, status = null, q = "" } = {}) {
      let rows = state.designs;
      if (org) rows = rows.filter((d) => d.organization_id === org);
      if (status) rows = rows.filter((d) => d.status === status);
      if (q) {
        const needle = q.toLowerCase();
        rows = rows.filter((d) => `${d.name} ${d.description}`.toLowerCase().includes(needle));
      }
      return clone(rows);
    },
    get: (id) => clone(state.designs.find((d) => d.id === id) ?? null),
    versions: (designId) => clone(state.versions.filter((v) => v.design_id === designId).sort((a, b) => a.version_number - b.version_number)),
    version: (id) => clone(state.versions.find((v) => v.id === id) ?? null),

    create(input) {
      const design = {
        id: uid("dsg"),
        organization_id: input.organization_id ?? null,
        name: input.name,
        description: input.description ?? "",
        status: "draft",
        created_by: state.users[0].id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      state.designs.push(design);

      const template = screenTemplates.find((t) => t.key === (input.template ?? "home")) ?? screenTemplates[0];
      const version = {
        id: `${design.id}_v1`,
        design_id: design.id,
        version_number: 1,
        label: "Working draft",
        schema_version: 1,
        status: "draft",
        document: {
          schemaVersion: 1,
          designId: design.id,
          versionNumber: 1,
          screens: [
            {
              id: uid("scr"),
              name: template.name,
              route: "/home",
              isEntry: true,
              requiresRole: null,
              transition: "slide",
              root: withIds(template.tree()),
            },
          ],
        },
        theme: input.theme ? clone(input.theme) : defaultTheme(),
        published_at: null,
        published_by: null,
        created_at: new Date().toISOString(),
      };
      state.versions.push(version);
      audit("design.create", "Design", `created ${design.name}`, { entityId: design.id });
      return { design: clone(design), version: clone(version) };
    },

    update(id, patch) {
      const design = state.designs.find((d) => d.id === id);
      if (!design) return null;
      Object.assign(design, patch, { updated_at: new Date().toISOString() });
      save();
      return clone(design);
    },

    /** Autosave. Drafts are mutable; published versions never are. */
    saveDraft(versionId, document, theme) {
      const version = state.versions.find((v) => v.id === versionId);
      if (!version) return null;
      if (version.status === "published") return null;
      version.document = clone(document);
      if (theme) version.theme = clone(theme);
      const design = state.designs.find((d) => d.id === version.design_id);
      if (design) design.updated_at = new Date().toISOString();
      save();
      return clone(version);
    },

    /** Editing a published version forks a new draft rather than mutating it. */
    fork(versionId, label = "Working draft") {
      const source = state.versions.find((v) => v.id === versionId);
      if (!source) return null;
      const siblings = state.versions.filter((v) => v.design_id === source.design_id);
      const nextNumber = Math.max(...siblings.map((v) => v.version_number)) + 1;
      const version = {
        ...clone(source),
        id: `${source.design_id}_v${nextNumber}`,
        version_number: nextNumber,
        label,
        status: "draft",
        published_at: null,
        published_by: null,
        created_at: new Date().toISOString(),
      };
      version.document.versionNumber = nextNumber;
      state.versions.push(version);
      audit("design.fork", "Design", `forked v${source.version_number} into v${nextNumber}`, { entityId: source.design_id });
      return clone(version);
    },

    publish(versionId, label) {
      const version = state.versions.find((v) => v.id === versionId);
      if (!version) return null;

      for (const sibling of state.versions.filter((v) => v.design_id === version.design_id && v.status === "published")) {
        sibling.status = "archived";
      }
      version.status = "published";
      version.label = label || version.label;
      version.published_at = new Date().toISOString();
      version.published_by = state.users[0].id;

      const design = state.designs.find((d) => d.id === version.design_id);
      if (design) {
        design.status = "published";
        design.updated_at = version.published_at;
      }

      audit("design.publish", "Design", `published ${design?.name ?? "a design"} v${version.version_number}`, { entityId: version.design_id });
      return clone(version);
    },

    rollback(designId) {
      const all = state.versions.filter((v) => v.design_id === designId).sort((a, b) => b.version_number - a.version_number);
      const live = all.find((v) => v.status === "published");
      const previous = all.find((v) => v.status === "archived" && v.published_at);
      if (!live || !previous) return null;
      live.status = "rolled_back";
      previous.status = "published";
      const design = state.designs.find((d) => d.id === designId);
      audit("design.rollback", "Design", `rolled ${design?.name} back to v${previous.version_number}`, { entityId: designId });
      return clone(previous);
    },

    duplicate(designId, { name, organization_id } = {}) {
      const source = state.designs.find((d) => d.id === designId);
      if (!source) return null;
      const copy = {
        ...clone(source),
        id: uid("dsg"),
        name: name || `${source.name} copy`,
        organization_id: organization_id ?? source.organization_id,
        status: "draft",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      state.designs.push(copy);

      const latest = state.versions.filter((v) => v.design_id === designId).sort((a, b) => b.version_number - a.version_number)[0];
      if (latest) {
        const version = {
          ...clone(latest),
          id: `${copy.id}_v1`,
          design_id: copy.id,
          version_number: 1,
          label: "Working draft",
          status: "draft",
          published_at: null,
          published_by: null,
          created_at: new Date().toISOString(),
        };
        version.document.designId = copy.id;
        version.document.versionNumber = 1;
        state.versions.push(version);
      }
      audit("design.duplicate", "Design", `duplicated ${source.name}`, { entityId: copy.id });
      return clone(copy);
    },

    archive(designId) {
      const design = state.designs.find((d) => d.id === designId);
      if (!design) return null;
      design.status = "archived";
      audit("design.archive", "Design", `archived ${design.name}`, { entityId: designId });
      return clone(design);
    },

    remove(designId) {
      state.designs = state.designs.filter((d) => d.id !== designId);
      state.versions = state.versions.filter((v) => v.design_id !== designId);
      state.assignments = state.assignments.filter((a) => !a.design_version_id.startsWith(designId));
      audit("design.delete", "Design", "deleted a design");
      save();
      return true;
    },
  },

  /* --- Assignments ------------------------------------------------------- */
  assignments: {
    list: () => clone(state.assignments),

    create(input) {
      const assignment = {
        id: uid("asg"),
        design_version_id: input.design_version_id,
        scope: input.scope,
        organization_id: input.organization_id ?? null,
        user_id: input.user_id ?? null,
        priority: input.priority ?? (input.scope === "user" ? 90 : 10),
        starts_at: input.starts_at ?? null,
        ends_at: input.ends_at ?? null,
        enabled: true,
        created_at: new Date().toISOString(),
        created_by: state.users[0].id,
      };
      state.assignments.push(assignment);
      audit("assignment.create", "Assignment", `assigned a design version to ${input.scope === "user" ? "a user" : "an organisation"}`, { entityId: assignment.id });
      return clone(assignment);
    },

    update(id, patch) {
      const assignment = state.assignments.find((a) => a.id === id);
      if (!assignment) return null;
      Object.assign(assignment, patch);
      audit("assignment.update", "Assignment", "updated an assignment rule", { entityId: id });
      return clone(assignment);
    },

    remove(id) {
      state.assignments = state.assignments.filter((a) => a.id !== id);
      audit("assignment.delete", "Assignment", "removed an assignment rule", { entityId: id });
      save();
      return true;
    },

    /**
     * The resolution rule from the brief, implemented once and used by both the
     * Assignments preview and the Paths trace so they can never disagree.
     */
    resolve(userId) {
      const user = state.users.find((u) => u.id === userId);
      if (!user) return { version: null, trace: [{ step: "User not found", hit: false }] };

      const now = Date.now();
      const active = (a) =>
        a.enabled &&
        (!a.starts_at || new Date(a.starts_at).getTime() <= now) &&
        (!a.ends_at || new Date(a.ends_at).getTime() >= now);

      const trace = [];

      const userScope = state.assignments
        .filter((a) => a.scope === "user" && a.user_id === userId && active(a))
        .sort((a, b) => b.priority - a.priority);
      trace.push({ step: "User-scope assignment", detail: userScope.length ? `${userScope.length} match, highest priority ${userScope[0].priority}` : "none", hit: userScope.length > 0, rule: userScope[0] ?? null });
      if (userScope.length) {
        return { version: state.versions.find((v) => v.id === userScope[0].design_version_id) ?? null, rule: userScope[0], trace };
      }

      const orgScope = state.assignments
        .filter((a) => a.scope === "organization" && a.organization_id === user.organization_id && active(a))
        .sort((a, b) => b.priority - a.priority);
      trace.push({ step: "Organisation-scope assignment", detail: orgScope.length ? `${orgScope.length} match, highest priority ${orgScope[0].priority}` : "none", hit: orgScope.length > 0, rule: orgScope[0] ?? null });
      if (orgScope.length) {
        return { version: state.versions.find((v) => v.id === orgScope[0].design_version_id) ?? null, rule: orgScope[0], trace };
      }

      const orgDefault = state.designs.find((d) => d.organization_id === user.organization_id && d.status === "published");
      const orgDefaultVersion = orgDefault ? state.versions.find((v) => v.design_id === orgDefault.id && v.status === "published") : null;
      trace.push({ step: "Organisation default published design", detail: orgDefault?.name ?? "none", hit: Boolean(orgDefaultVersion) });
      if (orgDefaultVersion) return { version: orgDefaultVersion, rule: null, trace };

      const fallback = state.versions.find((v) => v.status === "published");
      trace.push({ step: "Global fallback design", detail: fallback ? state.designs.find((d) => d.id === fallback.design_id)?.name : "none", hit: Boolean(fallback) });
      if (fallback) return { version: fallback, rule: null, trace };

      trace.push({ step: "App's built-in static layout", detail: "shipped with the build", hit: true });
      return { version: null, rule: null, trace };
    },

    /** Who would see what if `candidate` were saved. Drives the preview. */
    previewImpact(candidate) {
      const before = new Map();
      for (const user of state.users.filter((u) => u.role === "app_user")) {
        before.set(user.id, db.assignments.resolve(user.id).version?.id ?? null);
      }

      state.assignments.push({ ...candidate, id: "__preview", enabled: true, created_at: new Date().toISOString() });
      const after = new Map();
      for (const user of state.users.filter((u) => u.role === "app_user")) {
        after.set(user.id, db.assignments.resolve(user.id).version?.id ?? null);
      }
      state.assignments = state.assignments.filter((a) => a.id !== "__preview");

      const changed = [];
      const unchanged = [];
      for (const [userId, beforeVersion] of before) {
        const afterVersion = after.get(userId);
        const user = state.users.find((u) => u.id === userId);
        (beforeVersion === afterVersion ? unchanged : changed).push({ user: clone(user), before: beforeVersion, after: afterVersion });
      }
      return { changed, unchanged };
    },

    /** Two rules that could both apply to the same audience. */
    conflicts() {
      const found = [];
      const orgRules = state.assignments.filter((a) => a.scope === "organization" && a.enabled);
      const byOrg = new Map();
      for (const rule of orgRules) {
        if (!byOrg.has(rule.organization_id)) byOrg.set(rule.organization_id, []);
        byOrg.get(rule.organization_id).push(rule);
      }
      for (const [orgId, rules] of byOrg) {
        if (rules.length < 2) continue;
        const sorted = [...rules].sort((a, b) => b.priority - a.priority);
        found.push({
          organization_id: orgId,
          rules: clone(sorted),
          winner: clone(sorted[0]),
          samePriority: sorted[0].priority === sorted[1].priority,
        });
      }
      return found;
    },
  },

  /* --- Paths ------------------------------------------------------------- */
  paths: {
    userEvents: (userId, limit = 80) =>
      clone(
        state.pathEvents
          .filter((e) => e.user_id === userId)
          .sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at))
          .slice(0, limit),
      ),

    /** Aggregate route-to-route transitions for the flow view. */
    flow() {
      const byUser = new Map();
      for (const event of state.pathEvents.filter((e) => e.event === "view")) {
        if (!byUser.has(event.user_id)) byUser.set(event.user_id, []);
        byUser.get(event.user_id).push(event);
      }

      const edges = new Map();
      const visits = new Map();
      for (const events of byUser.values()) {
        const ordered = events.sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
        ordered.forEach((event, i) => {
          visits.set(event.route_path, (visits.get(event.route_path) ?? 0) + 1);
          const next = ordered[i + 1];
          if (!next || next.route_path === event.route_path) return;
          const key = `${event.route_path}→${next.route_path}`;
          edges.set(key, (edges.get(key) ?? 0) + 1);
        });
      }

      return {
        visits: [...visits.entries()].map(([route, count]) => ({ route, count })).sort((a, b) => b.count - a.count),
        edges: [...edges.entries()]
          .map(([key, count]) => {
            const [from, to] = key.split("→");
            return { from, to, count };
          })
          .sort((a, b) => b.count - a.count),
      };
    },
  },

  /* --- App data ---------------------------------------------------------- */
  entities: {
    list: () => clone(state.collections),
    get: (key) => clone(state.collections.find((c) => c.key === key) ?? null),

    records({ collectionKey, org = null, q = "", filters = [], includeDeleted = false } = {}) {
      const collection = state.collections.find((c) => c.key === collectionKey);
      if (!collection) return [];

      let rows = state.records.filter((r) => r.collection_id === collection.id);
      if (!includeDeleted) rows = rows.filter((r) => !r.deleted_at);
      else rows = rows.filter((r) => r.deleted_at);
      if (org) rows = rows.filter((r) => r.organization_id === org);

      if (q) {
        const needle = q.toLowerCase();
        rows = rows.filter((r) => Object.values(r.data).some((v) => String(v).toLowerCase().includes(needle)));
      }

      for (const filter of filters) {
        if (!filter.field || filter.value === "" || filter.value === undefined) continue;
        rows = rows.filter((r) => matchFilter(r.data[filter.field], filter.op, filter.value));
      }

      return clone(rows);
    },

    createRecord(collectionKey, data, org) {
      const collection = state.collections.find((c) => c.key === collectionKey);
      if (!collection) return null;
      const record = {
        id: uid("rec"),
        collection_id: collection.id,
        organization_id: org ?? collection.organization_id ?? state.orgs[0].id,
        data,
        created_by: state.users[0].id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted_at: null,
      };
      state.records.push(record);
      audit("record.create", "Record", `created a ${collection.name} record`, { entityId: record.id });
      return clone(record);
    },

    updateRecord(id, patch) {
      const record = state.records.find((r) => r.id === id);
      if (!record) return null;
      const before = clone(record.data);
      record.data = { ...record.data, ...patch };
      record.updated_at = new Date().toISOString();
      const collection = state.collections.find((c) => c.id === record.collection_id);
      audit("record.update", "Record", `updated a ${collection?.name ?? "record"}`, { entityId: id, before, after: clone(record.data) });
      return clone(record);
    },

    deleteRecords(ids) {
      const stamp = new Date().toISOString();
      let count = 0;
      for (const record of state.records) {
        if (ids.includes(record.id) && !record.deleted_at) {
          record.deleted_at = stamp;
          count += 1;
        }
      }
      audit("record.delete", "Record", `moved ${count} record${count === 1 ? "" : "s"} to trash`);
      return count;
    },

    restoreRecords(ids) {
      let count = 0;
      for (const record of state.records) {
        if (ids.includes(record.id) && record.deleted_at) {
          record.deleted_at = null;
          count += 1;
        }
      }
      audit("record.restore", "Record", `restored ${count} record${count === 1 ? "" : "s"}`);
      return count;
    },

    bulkUpdate(ids, patch) {
      let count = 0;
      for (const record of state.records) {
        if (ids.includes(record.id)) {
          record.data = { ...record.data, ...patch };
          record.updated_at = new Date().toISOString();
          count += 1;
        }
      }
      audit("record.bulk_update", "Record", `updated ${count} records`);
      return count;
    },

    createCollection(input) {
      const collection = {
        id: uid("col"),
        organization_id: input.organization_id ?? null,
        feature_id: input.feature_id ?? null,
        key: input.key || slug(input.name),
        name: input.name,
        origin: "collection",
        title_field: input.title_field ?? input.field_schema?.[0]?.key ?? "name",
        field_schema: input.field_schema ?? [],
        created_at: new Date().toISOString(),
      };
      state.collections.push(collection);
      audit("collection.create", "Collection", `created the ${collection.name} collection`, { entityId: collection.id });
      return clone(collection);
    },

    updateCollection(id, patch) {
      const collection = state.collections.find((c) => c.id === id);
      if (!collection) return null;
      Object.assign(collection, patch);
      audit("collection.update", "Collection", `updated the ${collection.name} collection`, { entityId: id });
      return clone(collection);
    },

    removeCollection(id) {
      const collection = state.collections.find((c) => c.id === id);
      if (!collection) return false;
      state.collections = state.collections.filter((c) => c.id !== id);
      state.records = state.records.filter((r) => r.collection_id !== id);
      audit("collection.delete", "Collection", `deleted the ${collection.name} collection`, { entityId: id });
      return true;
    },

    /** Collections published as bindable data sources in the Design Studio. */
    dataSources() {
      return state.collections.map((c) => ({
        id: `query.${c.key}`,
        name: c.name,
        key: c.key,
        origin: c.origin,
        fields: c.field_schema.map((f) => ({ key: f.key, label: f.label, type: f.type })),
        sample: clone(state.records.find((r) => r.collection_id === c.id && !r.deleted_at)?.data ?? {}),
        count: state.records.filter((r) => r.collection_id === c.id && !r.deleted_at).length,
      }));
    },
  },

  /* --- Features ---------------------------------------------------------- */
  features: {
    list: () => clone(state.features),
    get: (id) => clone(state.features.find((f) => f.id === id) ?? null),
    assignments: () => clone(state.featureAssignments),

    assignment: (featureId, orgId) =>
      clone(state.featureAssignments.find((a) => a.feature_id === featureId && a.organization_id === orgId) ?? null),

    toggle(featureId, orgId, enabled) {
      const row = state.featureAssignments.find((a) => a.feature_id === featureId && a.organization_id === orgId);
      if (!row) return null;
      row.enabled = enabled;
      row.updated_at = new Date().toISOString();
      const feature = state.features.find((f) => f.id === featureId);
      const org = state.orgs.find((o) => o.id === orgId);
      audit("feature.toggle", "Feature", `${enabled ? "enabled" : "disabled"} ${feature?.name} for ${org?.name}`, { entityId: featureId });
      return clone(row);
    },

    updateSettings(featureId, orgId, settings) {
      const row = state.featureAssignments.find((a) => a.feature_id === featureId && a.organization_id === orgId);
      if (!row) return null;
      row.settings = { ...row.settings, ...settings };
      row.updated_at = new Date().toISOString();
      audit("feature.settings", "Feature", "updated per-organisation feature settings", { entityId: featureId });
      return clone(row);
    },

    /** Features that would break if `featureId` were switched off for an org. */
    dependants(featureId, orgId) {
      const feature = state.features.find((f) => f.id === featureId);
      if (!feature) return [];
      return state.features.filter((other) => {
        if (!other.depends_on?.includes(feature.key)) return false;
        const row = state.featureAssignments.find((a) => a.feature_id === other.id && a.organization_id === orgId);
        return row?.enabled;
      }).map(clone);
    },

    /** Dependencies that must be on first. */
    missingDependencies(featureId, orgId) {
      const feature = state.features.find((f) => f.id === featureId);
      if (!feature) return [];
      return (feature.depends_on ?? [])
        .map((key) => state.features.find((f) => f.key === key))
        .filter((dep) => {
          if (!dep) return false;
          const row = state.featureAssignments.find((a) => a.feature_id === dep.id && a.organization_id === orgId);
          return !row?.enabled;
        })
        .map(clone);
    },

    create(input) {
      const feature = {
        id: uid("ftr"),
        key: input.key || slug(input.name),
        name: input.name,
        description: input.description ?? "",
        icon: input.icon ?? "box",
        origin: "composed",
        status: "draft",
        depends_on: input.depends_on ?? [],
        manifest: input.manifest ?? { key: input.key, version: 1, screens: [], routes: [], collections: [], navigation: [], permissions: { view: ["app_user"], manage: ["org_admin"] } },
        settings_schema: input.settings_schema ?? {},
        created_at: new Date().toISOString(),
      };
      state.features.push(feature);
      for (const org of state.orgs) {
        state.featureAssignments.push({
          id: uid("fas"),
          feature_id: feature.id,
          organization_id: org.id,
          enabled: false,
          settings: Object.fromEntries(Object.entries(feature.settings_schema).map(([k, v]) => [k, v.default])),
          updated_at: new Date().toISOString(),
          updated_by: state.users[0].id,
        });
      }
      audit("feature.create", "Feature", `created the ${feature.name} feature`, { entityId: feature.id });
      return clone(feature);
    },

    update(id, patch) {
      const feature = state.features.find((f) => f.id === id);
      if (!feature) return null;
      Object.assign(feature, patch);
      audit("feature.update", "Feature", `updated ${feature.name}`, { entityId: id });
      return clone(feature);
    },

    publish(id) {
      const feature = state.features.find((f) => f.id === id);
      if (!feature) return null;
      feature.status = "published";
      feature.manifest.version = (feature.manifest.version ?? 0) + 1;
      audit("feature.publish", "Feature", `published ${feature.name} v${feature.manifest.version}`, { entityId: id });
      return clone(feature);
    },
  },

  /* --- Rules ------------------------------------------------------------- */
  rules: {
    list: (org = null) => clone(org ? state.rules.filter((r) => r.organization_id === org) : state.rules),
    get: (id) => clone(state.rules.find((r) => r.id === id) ?? null),
    runs: (ruleId) => clone(state.ruleRuns.filter((r) => r.rule_id === ruleId).sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at))),

    create(input) {
      const rule = {
        id: uid("rul"),
        organization_id: input.organization_id,
        name: input.name,
        trigger: input.trigger,
        conditions: input.conditions ?? { all: [] },
        actions: input.actions ?? [],
        enabled: false,
        created_at: new Date().toISOString(),
        created_by: state.users[0].id,
      };
      state.rules.push(rule);
      audit("rule.create", "Rule", `created the rule "${rule.name}"`, { entityId: rule.id });
      return clone(rule);
    },

    update(id, patch) {
      const rule = state.rules.find((r) => r.id === id);
      if (!rule) return null;
      Object.assign(rule, patch);
      audit("rule.update", "Rule", `updated the rule "${rule.name}"`, { entityId: id });
      return clone(rule);
    },

    remove(id) {
      state.rules = state.rules.filter((r) => r.id !== id);
      state.ruleRuns = state.ruleRuns.filter((r) => r.rule_id !== id);
      audit("rule.delete", "Rule", "deleted a rule", { entityId: id });
      return true;
    },

    /** Dry run: evaluate the conditions, plan the actions, commit nothing. */
    test(id, sample) {
      const rule = state.rules.find((r) => r.id === id);
      if (!rule) return null;

      const conditions = (rule.conditions?.all ?? []).map((c) => {
        const left = String(c.left ?? "").replace(/^\$/, "");
        const actual = left.split(".").reduce((node, key) => node?.[key], { record: sample, user: state.users[0] });
        const passed = compare(actual, c.op, c.right);
        return { expression: `${c.left} ${c.op} ${JSON.stringify(c.right)}`, actual, passed };
      });

      const wouldRun = conditions.every((c) => c.passed);
      return {
        wouldRun,
        conditions,
        actions: rule.actions.map((a) => ({
          type: a.type,
          params: a.params,
          plan: describeAction(a, sample),
          committed: false,
        })),
        note: "Dry run. No record was written, no message sent.",
      };
    },
  },

  /* --- Audit ------------------------------------------------------------- */
  audit_: {
    list: (limit = 60) => clone(state.auditLog.slice(0, limit)),
  },

  /* --- Derived metrics for Overview -------------------------------------- */
  metrics() {
    const activeUsers = state.users.filter(
      (u) => u.last_login_at && Date.now() - new Date(u.last_login_at).getTime() < 7 * 864e5,
    ).length;

    const errors = state.pathEvents.filter(
      (e) => e.event === "error" && Date.now() - new Date(e.occurred_at).getTime() < 864e5,
    ).length;

    const series = [];
    for (let day = 29; day >= 0; day -= 1) {
      const start = Date.now() - day * 864e5;
      const end = start + 864e5;
      const count = new Set(
        state.pathEvents
          .filter((e) => {
            const t = new Date(e.occurred_at).getTime();
            return t >= start - 864e5 * 0 && t < end;
          })
          .map((e) => e.user_id),
      ).size;
      series.push({
        label: new Date(start).toLocaleDateString("en-CA", { month: "short", day: "numeric" }),
        value: count || Math.round(6 + Math.sin(day / 3) * 4 + rand() * 5),
      });
    }

    return {
      users: state.users.length,
      appUsers: state.users.filter((u) => u.role === "app_user").length,
      activeUsers,
      orgs: state.orgs.length,
      activeOrgs: state.orgs.filter((o) => o.status === "active").length,
      published: state.versions.filter((v) => v.status === "published").length,
      drafts: state.versions.filter((v) => v.status === "draft").length,
      errors,
      records: state.records.filter((r) => !r.deleted_at).length,
      collections: state.collections.length,
      enabledFeatures: state.featureAssignments.filter((a) => a.enabled).length,
      rules: state.rules.filter((r) => r.enabled).length,
      adoption: series,
      health: {
        layoutP95: 118 + Math.round(rand() * 26),
        cacheHit: 0.94 + rand() * 0.04,
        rendererErrorRate: errors / Math.max(state.pathEvents.length, 1),
        lastFailedPublish: null,
      },
    };
  },
};

/* ---------------------------------------------------------------------------
   Helpers
   --------------------------------------------------------------------------- */

function matchFilter(value, op, target) {
  const a = value === null || value === undefined ? "" : value;
  switch (op) {
    case "is":
      return String(a).toLowerCase() === String(target).toLowerCase();
    case "is not":
      return String(a).toLowerCase() !== String(target).toLowerCase();
    case "contains":
      return String(a).toLowerCase().includes(String(target).toLowerCase());
    case "does not contain":
      return !String(a).toLowerCase().includes(String(target).toLowerCase());
    case ">":
      return Number(a) > Number(target);
    case "<":
      return Number(a) < Number(target);
    case "is empty":
      return a === "" || a === null || a === undefined;
    case "is not empty":
      return !(a === "" || a === null || a === undefined);
    default:
      return true;
  }
}

function compare(actual, op, expected) {
  switch (op) {
    case "==":
      return String(actual) === String(expected);
    case "!=":
      return String(actual) !== String(expected);
    case ">":
      return Number(actual) > Number(expected);
    case "<":
      return Number(actual) < Number(expected);
    case "contains":
      return String(actual ?? "").toLowerCase().includes(String(expected).toLowerCase());
    default:
      return true;
  }
}

function describeAction(action, sample) {
  const fill = (text) => String(text ?? "").replace(/\{\{record\.(\w+)\}\}/g, (_m, key) => sample?.[key] ?? `{{${key}}}`);
  switch (action.type) {
    case "send_email":
      return `Would send the "${action.params.template}" email to ${fill(action.params.to)}`;
    case "send_push":
      return `Would push "${fill(action.params.message)}"`;
    case "notify_admin":
      return `Would notify admins: "${fill(action.params.message)}"`;
    case "create_record":
      return `Would create a record in ${action.params.collection}`;
    case "update_record":
      return `Would update ${action.params.collection}`;
    case "set_field":
      return `Would set ${action.params.field} to "${action.params.value}"`;
    case "call_webhook":
      return `Would ${action.params.method ?? "POST"} to ${action.params.url}`;
    case "toggle_feature":
      return `Would turn ${action.params.enabled ? "on" : "off"} the ${action.params.feature} feature`;
    default:
      return `Would run ${action.type}`;
  }
}

export const ACTION_TYPES = [
  { value: "send_email", label: "Send an email", glyph: "mail" },
  { value: "send_push", label: "Send a push notification", glyph: "bell" },
  { value: "create_record", label: "Create a record", glyph: "plus" },
  { value: "update_record", label: "Update a record", glyph: "edit" },
  { value: "set_field", label: "Set a field", glyph: "tag" },
  { value: "call_webhook", label: "Call a webhook", glyph: "link" },
  { value: "toggle_feature", label: "Toggle a feature", glyph: "toggle" },
  { value: "notify_admin", label: "Notify an admin in-app", glyph: "alertCircle" },
];

export const TRIGGER_TYPES = [
  { value: "record.created", label: "A record is created", needsCollection: true },
  { value: "record.updated", label: "A record is updated", needsCollection: true, needsField: true },
  { value: "record.deleted", label: "A record is deleted", needsCollection: true },
  { value: "user.created", label: "A user is created" },
  { value: "user.first_login", label: "A user signs in for the first time" },
  { value: "form.submitted", label: "A form is submitted", needsCollection: true },
  { value: "threshold.crossed", label: "A threshold is crossed", needsCollection: true },
  { value: "schedule", label: "On a schedule", needsSchedule: true },
];

export const ROLES = [
  { value: "super_admin", label: "Super admin", description: "Everything, across all organisations." },
  { value: "org_admin", label: "Org admin", description: "Users, assignments and designs within their organisation." },
  { value: "designer", label: "Designer", description: "Create and edit designs. Cannot publish or manage users." },
  { value: "viewer", label: "Viewer", description: "Read-only across the dashboard." },
  { value: "app_user", label: "App user", description: "Mobile app only. No dashboard access." },
];

export const FIELD_TYPES = [
  { value: "text", label: "Text", glyph: "text" },
  { value: "longtext", label: "Long text", glyph: "list" },
  { value: "number", label: "Number", glyph: "hash" },
  { value: "currency", label: "Currency", glyph: "dollar" },
  { value: "percent", label: "Percent", glyph: "percent" },
  { value: "boolean", label: "Yes / no", glyph: "toggle" },
  { value: "date", label: "Date", glyph: "calendar" },
  { value: "datetime", label: "Date and time", glyph: "calendarClock" },
  { value: "select", label: "Select", glyph: "chevronDown" },
  { value: "multiselect", label: "Multi-select", glyph: "list" },
  { value: "relation", label: "Relation", glyph: "link" },
  { value: "file", label: "File", glyph: "file" },
  { value: "image", label: "Image", glyph: "image" },
  { value: "color", label: "Colour", glyph: "droplet" },
  { value: "json", label: "JSON", glyph: "json" },
  { value: "computed", label: "Computed", glyph: "code" },
];

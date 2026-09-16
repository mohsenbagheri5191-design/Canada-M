/**
 * App Data — full create, edit and delete over the records the app serves.
 *
 * Two storage backends behind one interface: native tables described by an
 * entity config, and dashboard-created collections stored as JSONB records.
 * They are deliberately not unified — auto-generating migrations from a
 * dashboard is how you end up with an unrecoverable production schema.
 */

import { el, mount as mountTo, on } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { fmt, slug, uid, downloadFile, toCsv, parseCsv, groupBy } from "../core/util.js";
import {
  searchField,
  emptyState,
  pill,
  checkbox,
  menu,
  modal,
  confirm,
  toast,
  drawer,
  metaRow,
  segmented,
  switchControl,
  splitHandle,
} from "../core/ui.js";
import { registerCommands } from "../core/shell.js";
import { FIELD_TYPES } from "../data/db.js";

export function mount(host, { db, go, setCrumbs, params, app }) {
  setCrumbs([{ label: "App Data" }]);

  const state = {
    collectionKey: db.entities.list()[0]?.key ?? null,
    q: "",
    filters: [],
    selected: new Set(),
    sort: null,
    dir: "asc",
    trash: false,
    hidden: new Set(),
  };

  const rail = el("div.split-rail");
  const main = el("div.split-main");
  host.appendChild(el("div.split", rail, splitHandle((dx) => {
    const current = Number.parseInt(getComputedStyle(rail).width, 10);
    rail.style.setProperty("--split-w", `${Math.min(Math.max(current + dx, 180), 380)}px`);
  }), main));

  const unregister = registerCommands([
    { id: "data.new", label: "New collection", glyph: "plus", group: "App Data", run: () => openSchemaBuilder() },
    { id: "data.import", label: "Import records from CSV", glyph: "upload", group: "App Data", run: () => openImport() },
    ...db.entities.list().map((c) => ({
      id: `data.open.${c.key}`,
      label: `Open ${c.name}`,
      glyph: c.origin === "native" ? "db" : "package",
      group: "App Data",
      run: () => {
        state.collectionKey = c.key;
        state.selected.clear();
        renderRail();
        renderMain();
      },
    })),
  ]);

  /* --- Left rail ------------------------------------------------------------ */

  function renderRail() {
    const collections = db.entities.list();
    const byFeature = groupBy(collections, (c) => db.features.get(c.feature_id)?.name ?? "Ungrouped");

    mountTo(
      rail,
      el(
        "div.split-rail-head",
        el(
          "div.row",
          { style: { marginBottom: "var(--s-2)" } },
          el("h2", "Data"),
          el("div.spacer"),
          el("button.btn.sm.icon.ghost", { "data-tip": "New collection", onclick: () => openSchemaBuilder() }, icon("plus")),
        ),
        searchField("Filter", (value) => {
          railFilter = value.toLowerCase();
          renderRail();
        }),
      ),
      el(
        "div.split-rail-body",
        ...[...byFeature.entries()].flatMap(([feature, list]) => {
          const visible = list.filter((c) => c.name.toLowerCase().includes(railFilter));
          if (!visible.length) return [];
          return [
            el("div.rail-section-label", feature),
            ...visible.map((collection) => {
              const count = db.entities.records({ collectionKey: collection.key }).length;
              return el(
                "button",
                {
                  type: "button",
                  class: `rail-entry${collection.key === state.collectionKey ? " active" : ""}`,
                  onclick: () => {
                    state.collectionKey = collection.key;
                    state.selected.clear();
                    state.trash = false;
                    state.filters = [];
                    renderRail();
                    renderMain();
                  },
                  oncontextmenu: (event) => {
                    event.preventDefault();
                    openCollectionMenu(event, collection);
                  },
                },
                icon(collection.origin === "native" ? "db" : "package"),
                el("span.truncate", collection.name),
                el("span.count", fmt.compact(count)),
              );
            }),
          ];
        }),
        el("div.rail-section-label", "System"),
        el(
          "button",
          {
            type: "button",
            class: `rail-entry${state.trash ? " active" : ""}`,
            onclick: () => {
              state.trash = true;
              state.selected.clear();
              renderRail();
              renderMain();
            },
          },
          icon("trash"),
          el("span.truncate", "Trash"),
          el("span.count", String(db.raw.records.filter((r) => r.deleted_at).length)),
        ),
      ),
    );
  }

  let railFilter = "";

  function openCollectionMenu(event, collection) {
    menu(
      { left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY, width: 0, height: 0 },
      [
        { label: "Edit schema", icon: "edit", disabled: collection.origin === "native", onSelect: () => openSchemaBuilder(collection) },
        { label: "Export as CSV", icon: "download", onSelect: () => exportCollection(collection) },
        { label: "Import from CSV", icon: "upload", onSelect: () => openImport(collection) },
        "-",
        {
          label: "Delete collection",
          icon: "trash",
          tone: "danger",
          disabled: collection.origin === "native",
          onSelect: async () => {
            const count = db.entities.records({ collectionKey: collection.key }).length;
            const ok = await confirm({
              title: `Delete "${collection.name}"?`,
              message: `${fmt.plural(count, "record")} will be deleted with it, and any Design Studio binding to this source will stop resolving.`,
              confirmLabel: "Delete collection",
              tone: "danger",
              typeToConfirm: count > 0 ? collection.name : null,
            });
            if (!ok) return;
            db.entities.removeCollection(collection.id);
            state.collectionKey = db.entities.list()[0]?.key ?? null;
            renderRail();
            renderMain();
          },
        },
      ],
      { minWidth: 200 },
    );
  }

  /* --- Main ------------------------------------------------------------------- */

  const toolbar = el("div.data-toolbar");
  const tableWrap = el("div.data-table-wrap");
  const bulkHost = el("div", { style: { position: "relative" } });
  mountTo(main, toolbar, el("div", { style: { flex: "1 1 auto", minHeight: 0, position: "relative", display: "flex", flexDirection: "column" } }, tableWrap, bulkHost));

  function collection() {
    return db.entities.get(state.collectionKey);
  }

  function rows() {
    if (state.trash) {
      return db.raw.records
        .filter((r) => r.deleted_at)
        .map((r) => ({ ...r, collection: db.entities.list().find((c) => c.id === r.collection_id) }));
    }
    const list = db.entities.records({ collectionKey: state.collectionKey, q: state.q, filters: state.filters });
    if (!state.sort) return list;
    return [...list].sort((a, b) => {
      const av = a.data[state.sort];
      const bv = b.data[state.sort];
      const sign = state.dir === "asc" ? 1 : -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * sign;
      return String(av ?? "").localeCompare(String(bv ?? ""), "en", { numeric: true }) * sign;
    });
  }

  function renderMain() {
    if (state.trash) return renderTrash();

    const col = collection();
    if (!col) {
      mountTo(toolbar);
      mountTo(tableWrap, emptyState("appdata", "No collections", "Create one and it becomes available as a data source in the Design Studio.", el("button.btn.primary", { onclick: () => openSchemaBuilder() }, icon("plus"), "New collection")));
      return;
    }

    renderToolbar(col);
    renderTable(col);
  }

  function renderToolbar(col) {
    mountTo(
      toolbar,
      el("div.row", { style: { gap: "var(--s-2)", minWidth: 0 } }, icon(col.origin === "native" ? "db" : "package", 14), el("b", { style: { fontSize: "var(--fs-13)" } }, col.name), pill(col.origin === "native" ? "native table" : "collection", col.origin === "native" ? "info" : "accent")),
      el("div.vr"),
      searchField("Search all fields", (value) => {
        state.q = value;
        renderTable(col);
      }, { width: 220 }),
      el(
        "button.btn.sm.ghost",
        { onclick: (event) => openFilterBuilder(event.currentTarget, col), "aria-pressed": String(state.filters.length > 0) },
        icon("filter"),
        state.filters.length ? `${state.filters.length} filter${state.filters.length === 1 ? "" : "s"}` : "Filter",
      ),
      el("button.btn.sm.ghost", { onclick: (event) => openColumnsMenu(event.currentTarget, col) }, icon("columns"), "Columns"),
      el("div.spacer"),
      el("button.btn.sm.ghost", { onclick: () => exportCollection(col) }, icon("download"), "Export"),
      el("button.btn.sm.ghost", { onclick: () => openImport(col) }, icon("upload"), "Import"),
      el("button.btn.primary.sm", { onclick: () => openRecordDrawer(null, col) }, icon("plus"), "New record"),
    );
  }

  function renderTable(col) {
    const data = rows();
    const fields = col.field_schema.filter((f) => !state.hidden.has(f.key));

    if (!data.length) {
      mountTo(tableWrap, emptyState("appdata", state.q || state.filters.length ? "No records match" : `No ${col.name.toLowerCase()} yet`, state.q || state.filters.length ? "Loosen the search or clear a filter." : "Create the first record, or import a CSV.", el("button.btn.primary", { onclick: () => openRecordDrawer(null, col) }, icon("plus"), "New record")));
      mountTo(bulkHost);
      return;
    }

    const allSelected = data.every((r) => state.selected.has(r.id));

    const headCheck = checkbox(allSelected, (value) => {
      if (value) for (const r of data) state.selected.add(r.id);
      else state.selected.clear();
      renderTable(col);
    }, { indeterminate: !allSelected && data.some((r) => state.selected.has(r.id)) });

    let lastClicked = null;

    mountTo(
      tableWrap,
      el(
        "table.data",
        el(
          "thead",
          el(
            "tr",
            el("th.tight", headCheck),
            ...fields.map((field) =>
              el(
                "th",
                {
                  class: "sortable",
                  "aria-sort": state.sort === field.key ? (state.dir === "asc" ? "ascending" : "descending") : null,
                  onclick: () => {
                    if (state.sort === field.key) state.dir = state.dir === "asc" ? "desc" : "asc";
                    else {
                      state.sort = field.key;
                      state.dir = "asc";
                    }
                    renderTable(col);
                  },
                },
                field.label,
                el("span.sort-caret", icon("chevronUp", 10)),
              ),
            ),
            el("th", "Updated"),
            el("th.tight", ""),
          ),
        ),
        el(
          "tbody",
          ...data.map((record, rowIndex) =>
            el(
              "tr",
              {
                class: state.selected.has(record.id) ? "selected" : "",
                onclick: (event) => {
                  if (event.target.closest(".check, .row-actions, td.editing")) return;
                  if (event.shiftKey && lastClicked !== null) {
                    const [from, to] = [Math.min(lastClicked, rowIndex), Math.max(lastClicked, rowIndex)];
                    for (let i = from; i <= to; i += 1) state.selected.add(data[i].id);
                    renderTable(col);
                    return;
                  }
                  lastClicked = rowIndex;
                  openRecordDrawer(record, col);
                },
              },
              el(
                "td.tight",
                checkbox(state.selected.has(record.id), (value) => {
                  if (value) state.selected.add(record.id);
                  else state.selected.delete(record.id);
                  lastClicked = rowIndex;
                  renderTable(col);
                }),
              ),
              ...fields.map((field) => cell(record, field, col)),
              el("td", fmt.relative(record.updated_at)),
              el(
                "td.tight",
                el(
                  "div.row-actions",
                  el(
                    "button.btn.sm.icon.ghost",
                    {
                      "data-tip": "Actions",
                      onclick: (event) => {
                        event.stopPropagation();
                        openRecordMenu(event.currentTarget, record, col);
                      },
                    },
                    icon("more"),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );

    renderBulkBar(col, data);
  }

  /** Inline-editable cell. Escape reverts, Enter commits, errors show in place. */
  function cell(record, field, col) {
    const value = record.data[field.key];
    const editable = !["computed", "relation", "file", "image", "json"].includes(field.type);

    const td = el(
      `td${field.type === "number" || field.type === "currency" || field.type === "percent" ? ".num-cell" : ""}`,
      { class: editable ? "editable" : "" },
      renderValue(value, field),
    );

    if (!editable) return td;

    td.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      beginEdit();
    });

    function beginEdit() {
      td.classList.add("editing");
      const input =
        field.type === "boolean"
          ? el("select.cell-edit", el("option", { value: "true", selected: value === true }, "Yes"), el("option", { value: "false", selected: value !== true }, "No"))
          : field.type === "select"
            ? el("select.cell-edit", ...(field.options ?? []).map((o) => el("option", { value: o, selected: o === value }, o)))
            : el("input.cell-edit", { value: value ?? "", type: field.type === "number" || field.type === "currency" ? "number" : field.type === "date" ? "date" : "text" });

      mountTo(td, input);
      input.focus();
      input.select?.();

      const commit = () => {
        const raw = input.value;
        let next = raw;
        if (field.type === "boolean") next = raw === "true";
        else if (["number", "currency", "percent"].includes(field.type)) next = Number(raw);

        if (field.required && (next === "" || next === null)) {
          td.classList.add("rejected");
          toast(`${field.label} is required`, { tone: "danger", duration: 2600 });
          setTimeout(() => {
            td.classList.remove("rejected", "editing");
            mountTo(td, renderValue(value, field));
          }, 900);
          return;
        }

        td.classList.remove("editing");
        td.classList.add("saving");
        mountTo(td, renderValue(next, field));
        db.entities.updateRecord(record.id, { [field.key]: next });
        setTimeout(() => td.classList.remove("saving"), 200);
      };

      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          input.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          input.removeEventListener("blur", commit);
          td.classList.remove("editing");
          mountTo(td, renderValue(value, field));
        }
      });
    }

    return td;
  }

  function renderValue(value, field) {
    if (value === null || value === undefined || value === "") return el("span.dim", "—");
    switch (field.type) {
      case "boolean":
        return el("span.row", { style: { gap: "5px" } }, el(`span.dot.${value ? "success" : ""}`), value ? "Yes" : "No");
      case "currency":
        return fmt.currency(Number(value));
      case "percent":
        return fmt.percent(Number(value) / 100, 0);
      case "number":
        return fmt.number(Number(value));
      case "date":
        return fmt.date(value);
      case "datetime":
        return fmt.datetime(value);
      case "select":
        return pill(String(value), toneForValue(value));
      case "image":
      case "file":
        return el("span.row", { style: { gap: "5px" } }, icon(field.type === "image" ? "image" : "file", 12), "1 file");
      case "color":
        return el("span.row", { style: { gap: "5px" } }, el("span.swatch", { style: { "--swatch": value, width: "14px", height: "14px" } }), String(value));
      default:
        return String(value);
    }
  }

  const toneForValue = (value) =>
    ({ Complete: "success", Scheduled: "info", "In progress": "accent", Blocked: "danger", High: "danger", Low: "", Pending: "warning", Answered: "success", Missed: "danger", Sent: "info" })[value] ?? "";

  /* --- Bulk actions ------------------------------------------------------------ */

  function renderBulkBar(col, data) {
    if (!state.selected.size) {
      mountTo(bulkHost);
      return;
    }

    const count = state.selected.size;

    mountTo(
      bulkHost,
      el(
        "div.bulk-bar",
        el("b", fmt.plural(count, "record")),
        el("span", "selected"),
        el("div.vr"),
        el("button.btn.sm.ghost", { onclick: () => openBulkEdit(col) }, icon("edit"), "Edit a field"),
        el(
          "button.btn.sm.ghost",
          {
            onclick: () => {
              const ids = [...state.selected];
              const selectedRows = data.filter((r) => ids.includes(r.id));
              downloadFile(`${col.key}-selection.csv`, toCsv(col.field_schema.map((f) => ({ key: f.key, label: f.label, value: (r) => r.data[f.key] })), selectedRows));
              toast(`Exported ${fmt.plural(ids.length, "record")}`, { tone: "success" });
            },
          },
          icon("download"),
          "Export",
        ),
        el(
          "button.btn.sm.danger",
          {
            onclick: async () => {
              const ids = [...state.selected];
              const ok = await confirm({
                title: `Delete ${fmt.plural(ids.length, "record")}?`,
                message: "Soft delete. Records move to Trash and are restorable for 30 days.",
                confirmLabel: `Delete ${ids.length}`,
                tone: "danger",
                typeToConfirm: ids.length > 50 ? String(ids.length) : null,
              });
              if (!ok) return;
              db.entities.deleteRecords(ids);
              state.selected.clear();
              toast(`Moved ${fmt.plural(ids.length, "record")} to trash`, {
                tone: "info",
                undo: () => {
                  db.entities.restoreRecords(ids);
                  renderMain();
                },
              });
              renderMain();
              renderRail();
            },
          },
          icon("trash"),
          "Delete",
        ),
        el(
          "button.btn.sm.icon.ghost",
          {
            onclick: () => {
              state.selected.clear();
              renderTable(col);
            },
          },
          icon("close"),
        ),
      ),
    );
  }

  function openBulkEdit(col) {
    modal((close) => {
      let fieldKey = col.field_schema[0].key;
      let value = "";
      const valueBox = el("div.field");

      const paintValue = () => {
        const field = col.field_schema.find((f) => f.key === fieldKey);
        mountTo(
          valueBox,
          el("label", "New value"),
          field.type === "select"
            ? el("select.select", { onchange: (e) => (value = e.target.value) }, ...(field.options ?? []).map((o) => el("option", { value: o }, o)))
            : field.type === "boolean"
              ? el("select.select", { onchange: (e) => (value = e.target.value === "true") }, el("option", { value: "true" }, "Yes"), el("option", { value: "false" }, "No"))
              : el("input.input", { oninput: (e) => (value = e.target.value) }),
        );
      };
      paintValue();

      return {
        title: `Edit ${fmt.plural(state.selected.size, "record")}`,
        subtitle: "The same value is written to every selected record.",
        body: [
          el(
            "div.field",
            el("label", "Field"),
            el(
              "select.select",
              {
                onchange: (event) => {
                  fieldKey = event.target.value;
                  paintValue();
                },
              },
              ...col.field_schema.map((f) => el("option", { value: f.key }, f.label)),
            ),
          ),
          valueBox,
        ],
        footer: [
          el("div.spacer"),
          el("button.btn.subtle", { onclick: () => close() }, "Cancel"),
          el(
            "button.btn.primary",
            {
              onclick: () => {
                const ids = [...state.selected];
                db.entities.bulkUpdate(ids, { [fieldKey]: value });
                close();
                state.selected.clear();
                toast(`Updated ${fmt.plural(ids.length, "record")}`, { tone: "success" });
                renderMain();
              },
            },
            "Apply to all",
          ),
        ],
      };
    });
  }

  /* --- Record drawer ------------------------------------------------------------- */

  function openRecordDrawer(record, col) {
    const isNew = !record;
    const draft = { ...(record?.data ?? Object.fromEntries(col.field_schema.map((f) => [f.key, defaultFor(f)]))) };

    drawer(
      (close) => ({
        leading: el("span.feature-mark", icon(col.origin === "native" ? "db" : "package")),
        title: isNew ? `New ${singular(col.name)}` : String(record.data[col.title_field] ?? record.id),
        subtitle: isNew ? col.name : `${col.name} · ${record.id}`,
        body: [
          el(
            "div.col",
            { style: { gap: "var(--s-3)" } },
            ...col.field_schema.map((field) => fieldControl(field, draft)),
          ),
          !isNew &&
            el(
              "section.col",
              { style: { gap: "var(--s-2)" } },
              el("span.eyebrow", "Record history"),
              el(
                "div.panel",
                { style: { padding: "var(--s-3)" } },
                metaRow("Created", `${fmt.datetime(record.created_at)}`),
                metaRow("Updated", `${fmt.datetime(record.updated_at)}`),
                metaRow("Organisation", db.orgs.get(record.organization_id)?.name ?? "—"),
                metaRow("Audit", el("button.btn.sm.ghost", { onclick: () => toast("Per-record audit is served by /api/v1/audit?entity=record", { tone: "info" }) }, "View trail")),
              ),
            ),
        ],
        footer: [
          !isNew &&
            el(
              "button.btn.danger",
              {
                onclick: async () => {
                  const ok = await confirm({ title: "Delete this record?", message: "Soft delete, restorable from Trash for 30 days.", confirmLabel: "Delete", tone: "danger" });
                  if (!ok) return;
                  db.entities.deleteRecords([record.id]);
                  close();
                  renderMain();
                  renderRail();
                },
              },
              icon("trash"),
              "Delete",
            ),
          el("div.spacer"),
          el("button.btn.subtle", { onclick: () => close() }, "Cancel"),
          el(
            "button.btn.primary",
            {
              onclick: () => {
                const missing = col.field_schema.filter((f) => f.required && (draft[f.key] === "" || draft[f.key] === null || draft[f.key] === undefined));
                if (missing.length) return toast(`${missing.map((f) => f.label).join(", ")} required`, { tone: "warning" });

                if (isNew) db.entities.createRecord(col.key, draft, app.get("org"));
                else db.entities.updateRecord(record.id, draft);

                close();
                toast(isNew ? "Record created" : "Record saved", { tone: "success" });
                renderMain();
                renderRail();
              },
            },
            isNew ? "Create record" : "Save changes",
          ),
        ],
      }),
      {},
    );
  }

  function fieldControl(field, draft) {
    const set = (value) => {
      draft[field.key] = value;
    };

    let control;
    switch (field.type) {
      case "longtext":
        control = el("textarea.textarea", { rows: 4, value: draft[field.key] ?? "", oninput: (e) => set(e.target.value) });
        break;
      case "boolean":
        control = el("div.row", switchControl(Boolean(draft[field.key]), set));
        break;
      case "select":
        control = el(
          "select.select",
          { onchange: (e) => set(e.target.value) },
          el("option", { value: "" }, "—"),
          ...(field.options ?? []).map((o) => el("option", { value: o, selected: o === draft[field.key] }, o)),
        );
        break;
      case "date":
        control = el("input.input", { type: "date", value: String(draft[field.key] ?? "").slice(0, 10), onchange: (e) => set(e.target.value) });
        break;
      case "datetime":
        control = el("input.input", { type: "datetime-local", value: String(draft[field.key] ?? "").slice(0, 16), onchange: (e) => set(e.target.value) });
        break;
      case "number":
      case "currency":
      case "percent":
        control = el("input.input", { type: "number", value: draft[field.key] ?? "", oninput: (e) => set(Number(e.target.value)) });
        break;
      case "color":
        control = el("input.input", { type: "color", value: draft[field.key] || "#000000", oninput: (e) => set(e.target.value) });
        break;
      case "json":
        control = el("textarea.textarea", { rows: 4, style: { fontFamily: "var(--font-mono)", fontSize: "var(--fs-11)" }, value: JSON.stringify(draft[field.key] ?? {}, null, 2), onchange: (e) => { try { set(JSON.parse(e.target.value)); } catch { toast("Not valid JSON", { tone: "danger" }); } } });
        break;
      case "computed":
        control = el("div.code", "Server-evaluated, read-only");
        break;
      default:
        control = el("input.input", { value: draft[field.key] ?? "", oninput: (e) => set(e.target.value) });
    }

    return el(
      "div.field",
      el("label", field.label, field.required && el("span", { style: { color: "var(--danger)", marginLeft: "3px" } }, "*")),
      control,
      field.help && el("span.hint", field.help),
    );
  }

  const defaultFor = (field) => (field.type === "boolean" ? false : ["number", "currency", "percent"].includes(field.type) ? 0 : "");
  const singular = (name) => (name.endsWith("s") ? name.slice(0, -1) : name).toLowerCase();

  function openRecordMenu(anchor, record, col) {
    menu(
      anchor,
      [
        { label: "Open", icon: "expand", onSelect: () => openRecordDrawer(record, col) },
        {
          label: "Duplicate",
          icon: "duplicate",
          onSelect: () => {
            db.entities.createRecord(col.key, { ...record.data }, record.organization_id);
            toast("Record duplicated", { tone: "success" });
            renderMain();
          },
        },
        {
          label: "Copy as JSON",
          icon: "json",
          onSelect: () => {
            navigator.clipboard?.writeText(JSON.stringify(record.data, null, 2));
            toast("Copied", { tone: "success", duration: 1500 });
          },
        },
        "-",
        {
          label: "Delete",
          icon: "trash",
          tone: "danger",
          onSelect: () => {
            db.entities.deleteRecords([record.id]);
            toast("Moved to trash", { tone: "info", undo: () => { db.entities.restoreRecords([record.id]); renderMain(); } });
            renderMain();
            renderRail();
          },
        },
      ],
      { minWidth: 190 },
    );
  }

  /* --- Filters and columns --------------------------------------------------------- */

  function openFilterBuilder(anchor, col) {
    modal((close) => {
      let working = state.filters.length ? [...state.filters] : [{ field: col.field_schema[0].key, op: "contains", value: "", conj: "and" }];
      const listBox = el("div.col", { style: { gap: "var(--s-2)" } });

      const ops = ["is", "is not", "contains", "does not contain", ">", "<", "is empty", "is not empty"];

      const paint = () => {
        mountTo(
          listBox,
          ...working.map((filter, index) =>
            el(
              "div.filter-row",
              el("span.conj", index === 0 ? "Where" : el("select.select", { style: { width: "auto" }, onchange: (e) => { filter.conj = e.target.value; } }, el("option", { value: "and", selected: filter.conj === "and" }, "and"), el("option", { value: "or", selected: filter.conj === "or" }, "or"))),
              el("select.select", { onchange: (e) => { filter.field = e.target.value; } }, ...col.field_schema.map((f) => el("option", { value: f.key, selected: f.key === filter.field }, f.label))),
              el("select.select", { onchange: (e) => { filter.op = e.target.value; } }, ...ops.map((o) => el("option", { value: o, selected: o === filter.op }, o))),
              el("input.input", { value: filter.value, oninput: (e) => { filter.value = e.target.value; }, disabled: filter.op.startsWith("is empty") || filter.op.startsWith("is not empty") }),
              el("button.btn.sm.icon.ghost", { onclick: () => { working = working.filter((_, i) => i !== index); paint(); } }, icon("close")),
            ),
          ),
        );
      };
      paint();

      return {
        title: "Filter records",
        subtitle: "Conditions combine with AND and OR, evaluated in order.",
        body: [
          listBox,
          el("button.btn.subtle.sm", { style: { width: "fit-content" }, onclick: () => { working.push({ field: col.field_schema[0].key, op: "contains", value: "", conj: "and" }); paint(); } }, icon("plus"), "Add condition"),
        ],
        footer: [
          el("button.btn.ghost", { onclick: () => { state.filters = []; close(); renderToolbar(col); renderTable(col); } }, "Clear all"),
          el("div.spacer"),
          el("button.btn.subtle", { onclick: () => close() }, "Cancel"),
          el("button.btn.primary", { onclick: () => { state.filters = working.filter((f) => f.value !== "" || f.op.includes("empty")); close(); renderToolbar(col); renderTable(col); } }, "Apply"),
        ],
      };
    });
  }

  function openColumnsMenu(anchor, col) {
    menu(
      anchor,
      [
        { label: "Visible columns", header: true },
        ...col.field_schema.map((field) => ({
          label: field.label,
          icon: FIELD_TYPES.find((t) => t.value === field.type)?.glyph ?? "text",
          checked: !state.hidden.has(field.key),
          onSelect: () => {
            if (state.hidden.has(field.key)) state.hidden.delete(field.key);
            else state.hidden.add(field.key);
            renderTable(col);
          },
        })),
      ],
      { minWidth: 210 },
    );
  }

  /* --- Trash ------------------------------------------------------------------------ */

  function renderTrash() {
    const deleted = rows();

    mountTo(
      toolbar,
      el("div.row", { style: { gap: "var(--s-2)" } }, icon("trash", 14), el("b", { style: { fontSize: "var(--fs-13)" } }, "Trash")),
      el("span.dim", { style: { fontSize: "var(--fs-11)" } }, "Soft-deleted records, restorable for 30 days"),
      el("div.spacer"),
      state.selected.size > 0 &&
        el(
          "button.btn.sm.subtle",
          {
            onclick: () => {
              const ids = [...state.selected];
              db.entities.restoreRecords(ids);
              state.selected.clear();
              toast(`Restored ${fmt.plural(ids.length, "record")}`, { tone: "success" });
              renderMain();
              renderRail();
            },
          },
          icon("refresh"),
          "Restore selected",
        ),
    );

    if (!deleted.length) {
      mountTo(tableWrap, emptyState("trash", "Trash is empty", "Deleted records land here for 30 days before they are purged."));
      mountTo(bulkHost);
      return;
    }

    mountTo(
      tableWrap,
      el(
        "table.data",
        el("thead", el("tr", el("th.tight", ""), el("th", "Record"), el("th", "Collection"), el("th", "Deleted"), el("th.tight", ""))),
        el(
          "tbody",
          ...deleted.map((record) =>
            el(
              "tr",
              { class: state.selected.has(record.id) ? "selected" : "" },
              el(
                "td.tight",
                checkbox(state.selected.has(record.id), (value) => {
                  if (value) state.selected.add(record.id);
                  else state.selected.delete(record.id);
                  renderTrash();
                }),
              ),
              el("td.primary-cell", String(record.data[record.collection?.title_field] ?? record.id)),
              el("td", record.collection?.name ?? "—"),
              el("td", fmt.relative(record.deleted_at)),
              el(
                "td.tight",
                el(
                  "div.row-actions",
                  el(
                    "button.btn.sm.ghost",
                    {
                      onclick: () => {
                        db.entities.restoreRecords([record.id]);
                        toast("Restored", { tone: "success" });
                        renderMain();
                        renderRail();
                      },
                    },
                    "Restore",
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    mountTo(bulkHost);
  }

  /* --- Schema builder ----------------------------------------------------------------- */

  function openSchemaBuilder(existing = null) {
    modal(
      (close) => {
        const draft = {
          name: existing?.name ?? "",
          key: existing?.key ?? "",
          feature_id: existing?.feature_id ?? null,
          title_field: existing?.title_field ?? null,
          fields: existing ? structuredClone(existing.field_schema) : [{ key: "name", label: "Name", type: "text", required: true }],
        };

        const fieldsBox = el("div.col", { style: { gap: "2px" } });

        const paintFields = () => {
          mountTo(
            fieldsBox,
            ...draft.fields.map((field, index) =>
              el(
                "div.schema-field",
                el("span.grip", { "data-tip": "Drag to reorder" }, icon("dragHandle")),
                el("input.input", {
                  value: field.label,
                  placeholder: "Field label",
                  oninput: (event) => {
                    field.label = event.target.value;
                    field.key = slug(event.target.value) || field.key;
                  },
                }),
                el(
                  "select.select",
                  { onchange: (event) => { field.type = event.target.value; paintFields(); } },
                  ...FIELD_TYPES.map((t) => el("option", { value: t.value, selected: t.value === field.type }, t.label)),
                ),
                el("label.check", el("input", { type: "checkbox", checked: field.required, onchange: (e) => (field.required = e.target.checked) }), el("span.box", icon("check")), el("span", { style: { fontSize: "var(--fs-11)" } }, "Req")),
                el(
                  "button.btn.sm.icon.ghost",
                  {
                    disabled: draft.fields.length < 2,
                    onclick: () => {
                      draft.fields.splice(index, 1);
                      paintFields();
                    },
                  },
                  icon("close"),
                ),
                field.type === "select" &&
                  el(
                    "div",
                    { style: { gridColumn: "2 / -1", marginTop: "-2px", marginBottom: "4px" } },
                    el("input.input", {
                      placeholder: "Options, comma separated",
                      value: (field.options ?? []).join(", "),
                      oninput: (event) => {
                        field.options = event.target.value.split(",").map((o) => o.trim()).filter(Boolean);
                      },
                    }),
                  ),
              ),
            ),
          );
        };
        paintFields();

        return {
          title: existing ? `Edit ${existing.name}` : "New collection",
          subtitle: existing ? "Changing a field type on a collection with data shows a migration preview first." : "Stored as JSONB records — no database migration, and it becomes a bindable data source the moment you save.",
          body: [
            el(
              "div.field-grid-2",
              el("div.field", el("label", "Name"), el("input.input", { value: draft.name, placeholder: "Inspections", oninput: (e) => { draft.name = e.target.value; keyInput.value = slug(e.target.value); draft.key = keyInput.value; } })),
              el("div.field", el("label", "Key"), (keyInput = el("input.input", { value: draft.key, placeholder: "inspections", style: { fontFamily: "var(--font-mono)" }, oninput: (e) => (draft.key = e.target.value) })), el("span.hint", "Used in bindings as query.<key>")),
            ),
            el(
              "div.field",
              el("label", "Belongs to feature"),
              el(
                "select.select",
                { onchange: (e) => (draft.feature_id = e.target.value || null) },
                el("option", { value: "" }, "Ungrouped"),
                ...db.features.list().map((f) => el("option", { value: f.id, selected: f.id === draft.feature_id }, f.name)),
              ),
            ),
            el("span.eyebrow", "Fields"),
            fieldsBox,
            el("button.btn.subtle.sm", { style: { width: "fit-content" }, onclick: () => { draft.fields.push({ key: `field_${draft.fields.length + 1}`, label: "", type: "text", required: false }); paintFields(); } }, icon("plus"), "Add field"),
            el(
              "div.callout.accent",
              icon("link"),
              el("div", el("b", "Publishing this collection exposes it in the Design Studio."), " It appears in the Data panel's source picker with a live sample, so a screen can bind to it without any code change. That link is the point of the whole system."),
            ),
          ],
          footer: [
            el("div.spacer"),
            el("button.btn.subtle", { onclick: () => close() }, "Cancel"),
            el(
              "button.btn.primary",
              {
                onclick: () => {
                  if (!draft.name.trim()) return toast("Name the collection", { tone: "warning" });
                  const fields = draft.fields.filter((f) => f.label.trim());
                  if (!fields.length) return toast("Add at least one field", { tone: "warning" });

                  const payload = {
                    name: draft.name.trim(),
                    key: draft.key || slug(draft.name),
                    feature_id: draft.feature_id,
                    field_schema: fields,
                    title_field: draft.title_field ?? fields[0].key,
                    organization_id: app.get("org"),
                  };

                  if (existing) db.entities.updateCollection(existing.id, payload);
                  else {
                    const created = db.entities.createCollection(payload);
                    state.collectionKey = created.key;
                  }

                  close();
                  toast(existing ? "Schema updated" : `${payload.name} created`, {
                    tone: "success",
                    detail: existing ? null : "Available as a data source in the Design Studio now.",
                  });
                  renderRail();
                  renderMain();
                },
              },
              existing ? "Save schema" : "Create collection",
            ),
          ],
        };
      },
      { width: "wide" },
    );
  }

  let keyInput;

  /* --- Import and export -------------------------------------------------------------- */

  function openImport(col = collection()) {
    modal(
      (close) => {
        let parsed = { header: [], rows: [], mapping: {} };
        const previewBox = el("div.col", { style: { gap: "2px", maxHeight: "200px", overflow: "auto" } });
        const mappingBox = el("div.col", { style: { gap: "var(--s-2)" } });

        const paint = () => {
          if (!parsed.rows.length) {
            mountTo(previewBox, el("span.dim", { style: { fontSize: "var(--fs-12)" } }, "Paste CSV above to preview the import."));
            mountTo(mappingBox);
            return;
          }

          mountTo(
            mappingBox,
            el("span.eyebrow", "Column mapping"),
            ...parsed.header.map((column, index) =>
              el(
                "div.field-row",
                el("span.field-label.truncate", column || `Column ${index + 1}`),
                el(
                  "select.select",
                  {
                    onchange: (event) => {
                      parsed.mapping[index] = event.target.value || null;
                      paint();
                    },
                  },
                  el("option", { value: "" }, "Skip"),
                  ...col.field_schema.map((f) => el("option", { value: f.key, selected: parsed.mapping[index] === f.key }, f.label)),
                ),
              ),
            ),
          );

          const results = parsed.rows.map((row) => {
            const data = {};
            for (const [index, key] of Object.entries(parsed.mapping)) {
              if (key) data[key] = row[index] ?? "";
            }
            const missing = col.field_schema.filter((f) => f.required && !data[f.key]);
            return { data, reason: missing.length ? `missing ${missing.map((f) => f.label).join(", ")}` : null };
          });

          mountTo(
            previewBox,
            ...results.slice(0, 60).map((result) =>
              el(
                "div.import-row",
                { dataset: { kind: result.reason ? "reject" : "create" } },
                icon(result.reason ? "xCircle" : "plus", 11),
                el("span.truncate", Object.values(result.data).slice(0, 4).join(" · ") || "(empty row)"),
                el("div.spacer"),
                el("span", result.reason ?? "create"),
              ),
            ),
          );

          commitButton.textContent = `Commit ${results.filter((r) => !r.reason).length} rows`;
          commitButton.disabled = !results.some((r) => !r.reason);
          pendingResults = results;
        };

        let pendingResults = [];
        const commitButton = el(
          "button.btn.primary",
          {
            disabled: true,
            onclick: () => {
              const valid = pendingResults.filter((r) => !r.reason);
              for (const result of valid) db.entities.createRecord(col.key, result.data, app.get("org"));
              close();
              toast(`Imported ${fmt.plural(valid.length, "record")}`, { tone: "success", detail: `${pendingResults.length - valid.length} rejected and not written.` });
              renderMain();
              renderRail();
            },
          },
          "Commit",
        );

        paint();

        return {
          title: `Import into ${col.name}`,
          subtitle: "Dry run first. Nothing is written until you commit, and a partial import never happens silently.",
          body: [
            el("textarea.textarea", {
              rows: 5,
              placeholder: col.field_schema.map((f) => f.label).join(",") + "\n...",
              style: { fontFamily: "var(--font-mono)", fontSize: "var(--fs-11)" },
              oninput: (event) => {
                const table = parseCsv(event.target.value);
                if (!table.length) {
                  parsed = { header: [], rows: [], mapping: {} };
                  paint();
                  return;
                }
                const [header, ...rest] = table;
                const mapping = {};
                header.forEach((column, index) => {
                  const match = col.field_schema.find((f) => f.label.toLowerCase() === column.trim().toLowerCase() || f.key === slug(column));
                  mapping[index] = match?.key ?? null;
                });
                parsed = { header, rows: rest, mapping };
                paint();
              },
            }),
            mappingBox,
            el("span.eyebrow", "Dry run"),
            previewBox,
          ],
          footer: [el("div.spacer"), el("button.btn.subtle", { onclick: () => close() }, "Cancel"), commitButton],
        };
      },
      { width: "wide" },
    );
  }

  function exportCollection(col) {
    const data = db.entities.records({ collectionKey: col.key });
    downloadFile(
      `${col.key}-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(col.field_schema.map((f) => ({ key: f.key, label: f.label, value: (r) => r.data[f.key] })), data),
    );
    toast(`Exported ${fmt.plural(data.length, "record")}`, { tone: "success" });
  }

  /* --- Boot --------------------------------------------------------------------------- */

  renderRail();
  renderMain();
  if (params.create) openSchemaBuilder();

  return unregister;
}

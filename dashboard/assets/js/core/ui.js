/**
 * Interaction primitives: toasts, menus, tooltips, modals, drawers and the
 * small form controls the inspector is built from.
 *
 * Every one of these is a function returning a DOM node or a handle. Nothing
 * here reaches into application state.
 */

import { el, mount, on, anchorTo, trapFocus, drag, raf, $ } from "./dom.js";
import { icon } from "./icons.js";
import { clamp, round as roundTo, fmt } from "./util.js";

/* ---------------------------------------------------------------------------
   Toasts
   --------------------------------------------------------------------------- */

const TOAST_ICON = { success: "checkCircle", danger: "xCircle", warning: "alert", info: "info" };

export function toast(message, options = {}) {
  const { tone = "info", detail = null, duration = 4200, undo = null, action = null } = options;

  const host = $("#toasts") || document.body.appendChild(el("div#toasts"));

  let timer = null;
  const node = el(
    `div.toast.${tone}`,
    { role: "status" },
    el("span.toast-icon", icon(TOAST_ICON[tone] || "info")),
    el("div.toast-text", el("b", message), detail && el("small", detail)),
    undo &&
      el(
        "button.btn.sm.ghost",
        {
          onclick: () => {
            undo();
            dismiss();
          },
        },
        "Undo",
      ),
    action &&
      el(
        "button.btn.sm.ghost",
        {
          onclick: () => {
            action.run();
            dismiss();
          },
        },
        action.label,
      ),
    el("button.btn.sm.icon.ghost", { onclick: () => dismiss(), "aria-label": "Dismiss" }, icon("close")),
  );

  function dismiss() {
    clearTimeout(timer);
    node.classList.add("leaving");
    setTimeout(() => node.remove(), 180);
  }

  // Hovering a toast holds it open; nobody should lose an undo to a timer.
  on(node, "pointerenter", () => clearTimeout(timer));
  on(node, "pointerleave", () => {
    timer = setTimeout(dismiss, 1600);
  });

  host.appendChild(node);
  if (duration) timer = setTimeout(dismiss, duration);

  return { dismiss };
}

/* ---------------------------------------------------------------------------
   Tooltips. One shared node, delegated from [data-tip].
   --------------------------------------------------------------------------- */

let tipNode = null;
let tipTimer = null;

export function initTooltips() {
  on(document, "pointerover", (event) => {
    const target = event.target.closest?.("[data-tip]");
    if (!target || target === tipNode) return;

    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => showTip(target), 420);

    const leave = () => {
      clearTimeout(tipTimer);
      hideTip();
      target.removeEventListener("pointerleave", leave);
      target.removeEventListener("pointerdown", leave);
    };
    target.addEventListener("pointerleave", leave);
    target.addEventListener("pointerdown", leave);
  });

  // A tooltip whose anchor is torn down — a tab change, a modal opening over
  // it — never receives pointerleave, so it would hang around over unrelated
  // content. These cover every way that happens.
  on(window, "hashchange", hideTip);
  on(window, "blur", hideTip);
  on(document, "keydown", hideTip, true);
  on(document, "pointerdown", hideTip, true);
  on(document, "scroll", hideTip, true);
}

function showTip(target) {
  hideTip();
  const shortcut = target.dataset.tipKey;
  tipNode = el(
    "div.tooltip",
    { role: "tooltip" },
    target.dataset.tip,
    shortcut && el("span.shortcut", shortcut),
  );
  document.body.appendChild(tipNode);
  anchorTo(tipNode, target, { placement: target.dataset.tipPlace || "bottom-center", gap: 7 });
}

function hideTip() {
  tipNode?.remove();
  tipNode = null;
}

/* ---------------------------------------------------------------------------
   Popover menus
   --------------------------------------------------------------------------- */

let openPopover = null;

/**
 * items: [{ label, icon, shortcut, tone, disabled, onSelect }] | "-" | { label: "...", header: true }
 */
export function menu(anchor, items, options = {}) {
  closePopover();

  const node = el("div.popover", { role: "menu" });
  let cursor = -1;

  const rows = [];
  for (const item of items) {
    if (item === "-" || item === null || item === undefined) {
      node.appendChild(el("div.menu-sep"));
      continue;
    }
    if (item.header) {
      node.appendChild(el("div.menu-label", item.label));
      continue;
    }

    const row = el(
      `button.menu-item${item.tone ? `.${item.tone}` : ""}`,
      {
        type: "button",
        role: "menuitem",
        "aria-disabled": item.disabled ? "true" : null,
        onclick: () => {
          if (item.disabled) return;
          closePopover();
          item.onSelect?.();
        },
      },
      item.icon ? icon(item.icon) : el("span", { style: { width: "14px" } }),
      el("span.truncate", item.label),
      item.checked && icon("check"),
      item.shortcut && el("span.shortcut", item.shortcut),
    );
    if (!item.disabled) rows.push(row);
    node.appendChild(row);
  }

  document.body.appendChild(node);
  if (options.minWidth) node.style.minWidth = `${options.minWidth}px`;
  anchorTo(node, anchor, { placement: options.placement || "bottom-start" });

  const moveCursor = (delta) => {
    if (!rows.length) return;
    rows[cursor]?.classList.remove("cursor");
    cursor = (cursor + delta + rows.length) % rows.length;
    rows[cursor].classList.add("cursor");
    rows[cursor].scrollIntoView({ block: "nearest" });
  };

  const offKey = on(document, "keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closePopover();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveCursor(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveCursor(-1);
    } else if (event.key === "Enter" && cursor > -1) {
      event.preventDefault();
      rows[cursor].click();
    }
  });

  const offDown = on(
    document,
    "pointerdown",
    (event) => {
      if (!node.contains(event.target) && !(anchor instanceof Element && anchor.contains(event.target))) {
        closePopover();
      }
    },
    true,
  );

  openPopover = {
    node,
    close() {
      offKey();
      offDown();
      node.remove();
      openPopover = null;
      options.onClose?.();
    },
  };

  return openPopover;
}

export function closePopover() {
  openPopover?.close();
}

/* ---------------------------------------------------------------------------
   Modal
   --------------------------------------------------------------------------- */

/**
 * build(close) returns { title, subtitle, body, footer, width }.
 */
export function modal(build, { width = "", onClose } = {}) {
  const scrim = el("div.scrim");
  const box = el(`div.modal${width ? `.${width}` : ""}`, { role: "dialog", "aria-modal": "true", tabIndex: -1 });

  let releaseFocus = null;

  const close = (result) => {
    offKey();
    releaseFocus?.();
    scrim.style.animation = "fade-in 140ms var(--ease) reverse forwards";
    setTimeout(() => scrim.remove(), 140);
    onClose?.(result);
  };

  const spec = build(close);

  mount(
    box,
    el(
      "header.modal-head",
      el("div.col.spacer", el("h2", spec.title), spec.subtitle && el("div.sub", spec.subtitle)),
      el("button.btn.icon.ghost", { onclick: () => close(), "aria-label": "Close" }, icon("close")),
    ),
    el("div.modal-body", spec.body),
    spec.footer && el("footer.modal-foot", spec.footer),
  );

  scrim.appendChild(box);
  on(scrim, "pointerdown", (event) => {
    if (event.target === scrim && spec.dismissable !== false) close();
  });

  const offKey = on(document, "keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  });

  document.body.appendChild(scrim);
  releaseFocus = trapFocus(box);

  return { close, node: box };
}

/** Yes/no, with an optional type-to-confirm gate for destructive work. */
export function confirm({
  title,
  message,
  confirmLabel = "Confirm",
  tone = "primary",
  typeToConfirm = null,
  detail = null,
}) {
  return new Promise((resolve) => {
    let settled = false;

    modal(
      (close) => {
        let confirmButton;
        const input =
          typeToConfirm &&
          el("input.input", {
            placeholder: typeToConfirm,
            autocomplete: "off",
            spellcheck: false,
            oninput: (event) => {
              confirmButton.disabled = event.target.value.trim() !== typeToConfirm;
            },
          });

        confirmButton = el(
          `button.btn.${tone === "danger" ? "danger-solid" : "primary"}`,
          {
            disabled: Boolean(typeToConfirm),
            onclick: () => {
              settled = true;
              close();
              resolve(true);
            },
          },
          confirmLabel,
        );

        return {
          title,
          body: [
            el("p.prose", message),
            detail,
            typeToConfirm &&
              el(
                "div.field",
                el("label", ["Type ", el("b", { style: { color: "var(--text)" } }, typeToConfirm), " to confirm"]),
                input,
              ),
          ],
          footer: [
            el("div.spacer"),
            el("button.btn.subtle", { onclick: () => close() }, "Cancel"),
            confirmButton,
          ],
        };
      },
      {
        onClose: () => {
          if (!settled) resolve(false);
        },
      },
    );
  });
}

/* ---------------------------------------------------------------------------
   Drawer
   --------------------------------------------------------------------------- */

export function drawer(build, { width = "", onClose } = {}) {
  const scrim = el("div.drawer-scrim");
  const panel = el(`aside.drawer${width ? `.${width}` : ""}`, { role: "dialog", "aria-modal": "true", tabIndex: -1 });

  let releaseFocus = null;

  const close = (result) => {
    offKey();
    releaseFocus?.();
    panel.style.animation = "slide-from-right 180ms var(--ease) reverse forwards";
    scrim.style.animation = "fade-in 180ms var(--ease) reverse forwards";
    setTimeout(() => {
      panel.remove();
      scrim.remove();
    }, 180);
    onClose?.(result);
  };

  const spec = build(close, panel);

  mount(
    panel,
    el(
      "header.drawer-head",
      spec.leading,
      el("div.col.spacer", el("h2.truncate", spec.title), spec.subtitle && el("div.sub.dim", spec.subtitle)),
      spec.actions,
      el("button.btn.icon.ghost", { onclick: () => close(), "aria-label": "Close" }, icon("close")),
    ),
    el("div.drawer-body", spec.body),
    spec.footer && el("footer.drawer-foot", spec.footer),
  );

  on(scrim, "pointerdown", () => close());
  const offKey = on(document, "keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  });

  document.body.append(scrim, panel);
  releaseFocus = trapFocus(panel);

  return { close, node: panel, body: panel.querySelector(".drawer-body") };
}

/* ---------------------------------------------------------------------------
   Segmented control
   --------------------------------------------------------------------------- */

/**
 * options: [{ value, label?, icon?, tip? }]
 */
export function segmented(options, value, onChange, { block = false, accent = false } = {}) {
  const thumb = el("span.seg-thumb");
  const buttons = options.map((opt) =>
    el(
      "button",
      {
        type: "button",
        "aria-pressed": String(opt.value === value),
        "data-tip": opt.tip || null,
        "data-value": opt.value,
        onclick: () => {
          if (opt.value === current) return;
          select(opt.value);
          onChange?.(opt.value);
        },
      },
      opt.icon && icon(opt.icon),
      opt.label && el("span.truncate", opt.label),
    ),
  );

  const node = el(
    `div.segmented${block ? ".block" : ""}${accent ? ".accent" : ""}`,
    { role: "group" },
    thumb,
    ...buttons,
  );

  let current = value;

  function place() {
    const active = buttons.find((b) => b.dataset.value === String(current));
    if (!active) {
      thumb.style.opacity = "0";
      return;
    }
    thumb.style.opacity = "1";
    thumb.style.setProperty("--seg-x", `${active.offsetLeft - 2}px`);
    thumb.style.setProperty("--seg-w", `${active.offsetWidth}px`);
  }

  function select(next) {
    current = next;
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.value === String(next)));
    place();
  }

  // Lay the thumb out once the control is measurable.
  requestAnimationFrame(place);
  new ResizeObserver(place).observe(node);

  node.setValue = select;
  return node;
}

/* ---------------------------------------------------------------------------
   Switch and checkbox
   --------------------------------------------------------------------------- */

export function switchControl(checked, onChange, { label = null, disabled = false } = {}) {
  const input = el("input", {
    type: "checkbox",
    checked,
    disabled,
    onchange: (event) => onChange?.(event.target.checked),
  });
  const node = el("label.switch", input, el("span.track"), label && el("span.switch-label", label));
  node.setValue = (v) => {
    input.checked = v;
  };
  return node;
}

export function checkbox(checked, onChange, { label = null, indeterminate = false } = {}) {
  const input = el("input", {
    type: "checkbox",
    checked,
    onchange: (event) => onChange?.(event.target.checked, event),
    onclick: (event) => event.stopPropagation(),
  });
  input.indeterminate = indeterminate;
  const node = el("label.check", { onclick: (e) => e.stopPropagation() }, input, el("span.box", icon("check")), label && el("span", label));
  node.setValue = (v, ind = false) => {
    input.checked = v;
    input.indeterminate = ind;
  };
  return node;
}

/* ---------------------------------------------------------------------------
   Numeric field with drag-to-scrub
   --------------------------------------------------------------------------- */

/**
 * The tag on the left is a scrub handle: press and drag horizontally to change
 * the value without aiming at a 3px slider. Shift scrubs by 10, Alt by 0.1.
 */
export function numberField(value, onChange, options = {}) {
  const {
    min = -Infinity,
    max = Infinity,
    step = 1,
    unit = null,
    tag = null,
    tagIcon = null,
    placeholder = "",
    tip = null,
    commitOnInput = true,
  } = options;

  const input = el("input", {
    type: "text",
    inputMode: "decimal",
    value: value ?? "",
    placeholder,
    oninput: () => {
      if (!commitOnInput) return;
      const parsed = parse(input.value);
      if (parsed !== null) onChange?.(parsed, { live: true });
    },
    onchange: () => commit(),
    onblur: () => commit(),
    onkeydown: (event) => {
      if (event.key === "Enter") {
        commit();
        input.blur();
        return;
      }
      const dir = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
      if (!dir) return;
      event.preventDefault();
      const mult = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
      const next = clamp((parse(input.value) ?? 0) + dir * step * mult, min, max);
      input.value = trim(next);
      onChange?.(next, { live: false });
    },
  });

  const parse = (text) => {
    const n = Number.parseFloat(String(text).replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? clamp(n, min, max) : null;
  };

  const trim = (n) => String(Math.round(n * 1000) / 1000);

  function commit() {
    const parsed = parse(input.value);
    if (parsed === null) {
      input.value = value ?? "";
      return;
    }
    input.value = trim(parsed);
    onChange?.(parsed, { live: false });
  }

  const handle = el(
    "span.num-tag",
    {
      "data-tip": tip,
      onpointerdown: (event) => {
        const base = parse(input.value) ?? 0;
        drag(event, {
          cursor: "ew-resize",
          onMove: ({ dx, shift, alt }) => {
            const mult = shift ? 10 : alt ? 0.1 : 1;
            const next = clamp(roundTo(base + dx * step * mult * 0.5, step * (alt ? 0.1 : 1)), min, max);
            input.value = trim(next);
            onChange?.(next, { live: true });
          },
          onEnd: ({ moved }) => {
            if (moved) onChange?.(parse(input.value) ?? base, { live: false });
          },
        });
      },
    },
    tagIcon ? icon(tagIcon) : tag,
  );

  const node = el("div.num", tag || tagIcon ? handle : null, input, unit && el("span.num-unit", unit));

  node.setValue = (v) => {
    input.value = v === null || v === undefined ? "" : trim(Number(v));
  };
  node.input = input;
  return node;
}

/* ---------------------------------------------------------------------------
   Slider with a bound numeric readout
   --------------------------------------------------------------------------- */

export function sliderField(value, onChange, { min = 0, max = 100, step = 1, unit = null } = {}) {
  const input = el("input", {
    type: "range",
    min,
    max,
    step,
    value,
    oninput: (event) => {
      const v = Number(event.target.value);
      paint(v);
      num.setValue(v);
      onChange?.(v, { live: true });
    },
    onchange: (event) => onChange?.(Number(event.target.value), { live: false }),
  });

  const track = el("div.slider", input);

  const num = numberField(value, (v, meta) => {
    input.value = v;
    paint(v);
    onChange?.(v, meta);
  }, { min, max, step, unit, tag: "" });

  function paint(v) {
    track.style.setProperty("--slider-fill", `${((v - min) / (max - min)) * 100}%`);
  }
  paint(value);

  const node = el("div", { style: { display: "grid", gridTemplateColumns: "1fr 64px", gap: "var(--s-2)", alignItems: "center" } }, track, num);
  node.setValue = (v) => {
    input.value = v;
    num.setValue(v);
    paint(v);
  };
  return node;
}

/* ---------------------------------------------------------------------------
   Small layout helpers used across the tabs
   --------------------------------------------------------------------------- */

export const fieldRow = (label, control, { tip = null } = {}) =>
  el("div.field-row", el("span.field-label", { "data-tip": tip }, label), control);

export const field = (label, control, hint) =>
  el("div.field", el("label", label), control, hint && el("span.hint", hint));

export const emptyState = (glyph, title, description, action = null) =>
  el(
    "div.empty",
    el("div.empty-mark", icon(glyph)),
    el("div.empty-text", el("b", title), el("span", description)),
    action,
  );

export const skeletonRows = (count = 6, height = 12) =>
  el(
    "div.col",
    { style: { gap: "var(--s-3)", padding: "var(--s-3)" } },
    ...Array.from({ length: count }, (_, i) =>
      el("div.skeleton", { style: { height: `${height}px`, width: `${88 - (i % 4) * 14}%` } }),
    ),
  );

export const pill = (text, tone = "", glyph = null) =>
  el(`span.pill${tone ? `.${tone}` : ""}`, glyph && icon(glyph), text);

export const avatar = (name, { size = "", hue } = {}) =>
  el(`span.avatar${size ? `.${size}` : ""}`, { style: { "--hue": hue } }, fmt.initials(name));

export const statusPill = (status) => {
  const tone =
    { published: "success", active: "success", live: "success", enabled: "success", draft: "warning", invited: "warning", pending: "warning", archived: "", suspended: "danger", disabled: "danger", failed: "danger", deprecated: "danger", rolled_back: "danger" }[status] ?? "";
  return pill(fmt.label(status), tone);
};

/** A labelled key/value line, used in detail panels. */
export const metaRow = (label, value) =>
  el(
    "div",
    { style: { display: "grid", gridTemplateColumns: "116px 1fr", gap: "var(--s-3)", alignItems: "baseline", minHeight: "22px" } },
    el("span", { style: { color: "var(--text-tertiary)", fontSize: "var(--fs-11)" } }, label),
    el("div", { style: { fontSize: "var(--fs-12)", minWidth: 0 } }, value),
  );

/** Collapsible section used throughout the inspector. */
export function section(title, body, { open = true, tools = null, id = null } = {}) {
  const node = el(
    "div.section",
    { dataset: { open: String(open), section: id || "" } },
    el(
      "button.section-head",
      {
        type: "button",
        onclick: (event) => {
          if (event.target.closest(".section-tools")) return;
          node.dataset.open = node.dataset.open === "true" ? "false" : "true";
        },
      },
      el("span.chev", icon("chevronRight")),
      el("span.spacer", { style: { textAlign: "left" } }, title),
      tools && el("span.section-tools", tools),
    ),
    el("div.section-body", body),
  );
  return node;
}

/** A search input that reports its value as you type. */
export function searchField(placeholder, onInput, { value = "", width = null } = {}) {
  const input = el("input.input", {
    type: "search",
    placeholder,
    value,
    autocomplete: "off",
    spellcheck: false,
    oninput: (event) => onInput?.(event.target.value),
  });
  const node = el(
    "div.search-field",
    { style: width ? { width: `${width}px` } : null },
    icon("search"),
    input,
  );
  node.input = input;
  return node;
}

/* ---------------------------------------------------------------------------
   Sparkline. Small enough to be honest about what it shows.
   --------------------------------------------------------------------------- */

export function sparkline(values, { width = 120, height = 28, tone = "var(--accent)", fill = true } = {}) {
  if (!values || values.length < 2) return el("div", { style: { width: `${width}px`, height: `${height}px` } });

  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const stepX = width / (values.length - 1);
  const y = (v) => height - 2 - ((v - min) / span) * (height - 4);

  const points = values.map((v, i) => `${(i * stepX).toFixed(2)},${y(v).toFixed(2)}`);
  const line = `M${points.join("L")}`;
  const area = `${line}L${width},${height}L0,${height}Z`;

  const gradId = `sg${Math.random().toString(36).slice(2, 8)}`;

  return el("div", {
    style: { width: `${width}px`, height: `${height}px` },
    html: `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${tone}" stop-opacity="0.26"/>
        <stop offset="100%" stop-color="${tone}" stop-opacity="0"/>
      </linearGradient></defs>
      ${fill ? `<path d="${area}" fill="url(#${gradId})"/>` : ""}
      <path d="${line}" fill="none" stroke="${tone}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`,
  });
}

/* ---------------------------------------------------------------------------
   Column chart, restyled; no default palette.
   --------------------------------------------------------------------------- */

export function barChart(series, { height = 150, labelEvery = 5, formatValue = fmt.number } = {}) {
  const max = Math.max(...series.map((d) => d.value), 1);

  const bars = series.map((d, i) =>
    el(
      "div",
      {
        style: {
          position: "relative",
          flex: "1 1 0",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
          minWidth: 0,
        },
        "data-tip": `${d.label} · ${formatValue(d.value)}`,
      },
      el("div", {
        style: {
          height: `${Math.max(2, (d.value / max) * (height - 26))}px`,
          marginBottom: "20px",
          borderRadius: "3px 3px 1px 1px",
          background: d.tone || "var(--accent)",
          opacity: d.muted ? 0.35 : 0.85,
          transition: "height var(--t-slow) var(--ease), opacity var(--t-fast) var(--ease)",
          animation: `rise-in var(--t-slow) var(--ease-out) backwards`,
          animationDelay: `${i * 14}ms`,
        },
      }),
      // Labels are taken out of flow and centred on their column, so a wide
      // label can overhang its narrow neighbours instead of being clipped.
      i % labelEvery === 0 &&
        el(
          "span",
          {
            style: {
              position: "absolute",
              bottom: "0",
              left: "50%",
              transform: "translateX(-50%)",
              fontSize: "var(--fs-11)",
              color: "var(--text-tertiary)",
              whiteSpace: "nowrap",
              pointerEvents: "none",
            },
          },
          d.label,
        ),
    ),
  );

  return el(
    "div",
    { style: { display: "flex", alignItems: "flex-end", gap: "3px", height: `${height}px` } },
    ...bars,
  );
}

/* ---------------------------------------------------------------------------
   KPI tile
   --------------------------------------------------------------------------- */

export function kpi({ label, value, delta = null, hint = null, spark = null, glyph = null, tone = null }) {
  const deltaTone = delta === null ? null : delta >= 0 ? "success" : "danger";

  return el(
    "article.panel",
    { style: { padding: "var(--s-3) var(--panel-pad)", display: "flex", flexDirection: "column", gap: "var(--s-1)" } },
    el(
      "div.row",
      { style: { gap: "var(--s-2)" } },
      glyph && el("span", { style: { color: tone || "var(--text-tertiary)", display: "flex" } }, icon(glyph, 13)),
      el("span", { style: { fontSize: "var(--fs-11)", color: "var(--text-tertiary)", fontWeight: "var(--fw-medium)" } }, label),
      el("span.spacer"),
      delta !== null &&
        el(
          "span",
          { style: { fontSize: "var(--fs-11)", color: `var(--${deltaTone})`, fontWeight: "var(--fw-medium)" } },
          `${delta >= 0 ? "+" : ""}${delta}%`,
        ),
    ),
    el(
      "div.row",
      { style: { gap: "var(--s-3)", alignItems: "flex-end" } },
      el(
        "strong",
        { style: { fontSize: "var(--fs-20)", fontWeight: "var(--fw-semibold)", letterSpacing: "var(--tracking-tight)", lineHeight: 1.1 } },
        value,
      ),
      el("span.spacer"),
      spark && sparkline(spark, { width: 64, height: 22, tone: tone || "var(--accent)" }),
    ),
    hint && el("span", { style: { fontSize: "var(--fs-11)", color: "var(--text-tertiary)" } }, hint),
  );
}

/* ---------------------------------------------------------------------------
   Colour input: swatch + hex field + native picker, with contrast readout.
   --------------------------------------------------------------------------- */

/**
 * Colour input: swatch, hex field, native picker, live contrast readout.
 *
 * `allowNone` matters more than it looks. Plenty of props default to
 * "transparent", and coercing that to #000000 would silently paint a black box
 * the moment someone opened the panel. A none state is shown as none.
 */
export function colorField(value, onChange, { contrastAgainst = null, allowNone = false } = {}) {
  const isNone = (v) => v === "transparent" || v === "none" || v === "" || v === null || v === undefined;

  if (allowNone && isNone(value)) {
    const node = el(
      "div.row",
      { style: { gap: "4px" } },
      el(
        "button.btn.sm.subtle",
        {
          style: { flex: "1 1 auto", justifyContent: "flex-start" },
          onclick: () => onChange?.("#ffffff", { live: false }),
        },
        el("span.swatch", { style: { "--swatch": "transparent" } }),
        el("span.dim", "None"),
      ),
    );
    node.setValue = () => {};
    return node;
  }

  const native = el("input", {
    type: "color",
    value: normaliseHex(value),
    style: { position: "absolute", inset: 0, opacity: 0, cursor: "pointer", border: 0, padding: 0 },
    oninput: (event) => apply(event.target.value, true),
    onchange: (event) => apply(event.target.value, false),
  });

  const swatchBox = el("span.swatch", { style: { "--swatch": value, position: "relative" } }, native);

  const text = el("input", {
    type: "text",
    value,
    spellcheck: false,
    style: {
      flex: "1 1 auto",
      minWidth: 0,
      background: "none",
      border: 0,
      fontFamily: "var(--font-mono)",
      fontSize: "var(--fs-11)",
      textTransform: "lowercase",
    },
    onchange: (event) => apply(event.target.value, false),
  });

  const readout = contrastAgainst ? el("span", { style: { fontSize: "var(--fs-11)", flex: "none" } }) : null;

  function apply(next, live) {
    const hex = normaliseHex(next);
    swatchBox.style.setProperty("--swatch", hex);
    text.value = hex;
    native.value = hex;
    paintContrast(hex);
    onChange?.(hex, { live });
  }

  async function paintContrast(hex) {
    if (!readout) return;
    const { contrastGrade } = await import("./util.js");
    const grade = contrastGrade(hex, contrastAgainst);
    readout.textContent = `${grade.text}`;
    readout.style.color = grade.passes ? "var(--success)" : "var(--danger)";
    readout.title = `Contrast against ${contrastAgainst}: ${grade.level}`;
  }
  paintContrast(value);

  const node = el(
    "div.num",
    { style: { paddingLeft: "5px", gap: "6px" } },
    swatchBox,
    text,
    readout,
    allowNone &&
      el(
        "button",
        {
          type: "button",
          "data-tip": "Clear to none",
          style: { display: "grid", placeItems: "center", width: "18px", height: "18px", marginRight: "3px", borderRadius: "4px", color: "var(--text-tertiary)", flex: "none" },
          onclick: () => onChange?.("transparent", { live: false }),
        },
        icon("close", 11),
      ),
  );

  node.setValue = (v) => {
    const hex = normaliseHex(v);
    swatchBox.style.setProperty("--swatch", hex);
    text.value = hex;
    native.value = hex;
    paintContrast(hex);
  };

  return node;
}

function normaliseHex(value) {
  const text = String(value ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(text)) {
    return `#${text.slice(1).split("").map((c) => c + c).join("")}`.toLowerCase();
  }
  if (/^[0-9a-f]{6}$/i.test(text)) return `#${text.toLowerCase()}`;
  return "#000000";
}

/* ---------------------------------------------------------------------------
   Resizable split. Used by the studio and App Data.
   --------------------------------------------------------------------------- */

export function splitHandle(onResize, { axis = "x", invert = false } = {}) {
  return el("div", {
    style: {
      flex: "none",
      width: axis === "x" ? "5px" : "100%",
      height: axis === "x" ? "100%" : "5px",
      marginInline: axis === "x" ? "-2px" : 0,
      marginBlock: axis === "x" ? 0 : "-2px",
      cursor: axis === "x" ? "col-resize" : "row-resize",
      zIndex: 5,
      position: "relative",
    },
    onpointerdown: (event) => {
      drag(event, {
        cursor: axis === "x" ? "col-resize" : "row-resize",
        onMove: ({ dx, dy }) => onResize((axis === "x" ? dx : dy) * (invert ? -1 : 1)),
      });
    },
  });
}

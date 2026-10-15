/**
 * Entry point.
 *
 * Everything else is loaded as an ES module by the browser. There is no build
 * step, no bundler and no dependency to install, matching how the rest of this
 * repository ships: static assets you can open or serve as-is.
 */

import { boot } from "./core/shell.js";
import { toast } from "./core/ui.js";

// A failure anywhere should surface, not vanish into the console.
window.addEventListener("error", (event) => {
  console.error("[dashboard]", event.error ?? event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("[dashboard] unhandled rejection", event.reason);
  toast("Something failed in the background", {
    tone: "danger",
    detail: String(event.reason?.message ?? event.reason ?? "").slice(0, 140),
  });
});

boot();

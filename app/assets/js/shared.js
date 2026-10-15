/**
 * The seam onto the code the app shares with the dashboard.
 *
 * The whole architecture rests on one claim: the editor and the app read the
 * same component registry. If the app had its own copy, a component would
 * eventually render one way in the studio and another on a phone, and every
 * design published in between would be wrong in a way nobody could see.
 *
 * So this file is the only place the app reaches across into `dashboard/`.
 * Everything else imports from here. If the shared code moves — into a package,
 * a CDN bundle, a build step — this is the single file that changes.
 */

export { registry, getDef, categories } from "../../../dashboard/assets/js/data/registry.js";

export {
  renderScreen,
  renderNode,
  walk,
  findNode,
  countNodes,
  LIMITS,
} from "../../../dashboard/assets/js/render/renderer.js";

export {
  makeTheme,
  defaultTheme,
  getStyle,
  appStyles,
  appPalettes,
  createSurfaceResolver,
} from "../../../dashboard/assets/js/data/styles.js";

export { el, mount } from "../../../dashboard/assets/js/core/dom.js";
export { icon } from "../../../dashboard/assets/js/core/icons.js";

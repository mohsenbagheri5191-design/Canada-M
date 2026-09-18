/**
 * Sign in.
 *
 * Written by hand rather than composed from the registry for a reason worth
 * stating: this screen must work when the layout system does not. It is what
 * the user sees before any design has been resolved, and if it depended on a
 * resolved theme or a published document there would be no way back from a bad
 * publish. It reads the app's default theme and nothing else.
 */

import { el, icon } from "../shared.js";
import { signIn } from "../supabase.js";

export function signInScreen({ appName = "Workspace", onSignedIn }) {
  const email = el("input.app-input", {
    type: "email",
    name: "email",
    autocomplete: "username",
    inputmode: "email",
    placeholder: "you@company.com",
    required: true,
  });

  const password = el("input.app-input", {
    type: "password",
    name: "password",
    autocomplete: "current-password",
    placeholder: "Password",
    required: true,
  });

  const error = el("p.form-error", { role: "alert", hidden: true });
  const submit = el("button.app-btn", { type: "submit", dataset: { variant: "primary" } }, "Sign in");

  let busy = false;

  const form = el(
    "form.signin-form",
    {
      novalidate: true,
      onsubmit: async (event) => {
        event.preventDefault();
        if (busy) return;

        const address = email.value.trim();
        if (!address || !password.value) {
          fail("Enter your email and password.");
          return;
        }

        setBusy(true);
        try {
          await signIn(address, password.value);
          // Clear the field rather than leaving a password in a live DOM node
          // for the rest of the session.
          password.value = "";
          onSignedIn();
        } catch (caught) {
          // Auth deliberately answers the same way for a wrong password and an
          // address that has no account, and so does this: saying which one is
          // wrong tells an attacker which addresses are real.
          fail(
            caught?.status === 400 || caught?.status === 401
              ? "That email and password do not match an account."
              : "Could not reach the server. Check your connection and try again.",
          );
        } finally {
          setBusy(false);
        }
      },
    },
    el("label.app-label", { for: "email" }, "Email"),
    email,
    el("label.app-label", { for: "password" }, "Password"),
    password,
    error,
    submit,
  );

  function fail(message) {
    error.textContent = message;
    error.hidden = false;
  }

  function setBusy(next) {
    busy = next;
    submit.disabled = next;
    submit.textContent = next ? "Signing in…" : "Sign in";
    if (next) error.hidden = true;
  }

  queueMicrotask(() => email.focus());

  return el(
    "div.signin",
    el(
      "div.signin-card",
      el("div.signin-mark", icon("layers", 26)),
      el("h1.signin-title", appName),
      el("p.signin-sub", "Sign in to continue."),
      form,
    ),
  );
}

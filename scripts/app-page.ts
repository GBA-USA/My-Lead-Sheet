import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { newSalt, passwordKey } from "../src/password.ts";
import { Phone } from "./api-session.ts";
import type { Site } from "./chrome.ts";

export const WIDTH = 390;
export const PASSWORD_PEPPER = "check-only-password-pepper-0123456789abcdef";
const js = (value: unknown) => JSON.stringify(value);
export const settle = (ms = 250) => new Promise((done) => setTimeout(done, ms));

/** Drives the app in one Chrome tab the way a player taps it, at phone size, with a phone's Face ID authenticator. */
export async function appPage(site: Site) {
  await site.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: 844, deviceScaleFactor: 2, mobile: true });
  await site.send("Page.enable");
  await site.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__errors = []; addEventListener("error", (e) => __errors.push(String(e.message))); addEventListener("unhandledrejection", (e) => __errors.push(String(e.reason)));`,
  });
  await site.send("WebAuthn.enable");
  await site.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  const until = async (expression: string, what: string, ms = 8000) => {
    for (const end = Date.now() + ms; Date.now() < end; await settle(100)) if (await site.evaluate<boolean>(expression)) return;
    throw new Error(`timed out waiting for ${what} at ${await site.evaluate<string>("location.href")}`);
  };
  const click = async (text: string, scope = "document") => {
    const clicked = await site.evaluate<boolean>(
      `(() => { const el = [...(${scope}?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === ${js(text)} && !b.disabled); el?.click(); return !!el; })()`,
    );
    assert.ok(clicked, `a ${text} button to tap`);
    await settle();
  };
  const type = async (label: string, text: string) => {
    await site.evaluate(`[...document.querySelectorAll("[role=dialog] label")].find((l) => l.textContent.trim() === ${js(label)}).control.focus()`);
    await site.send("Input.insertText", { text });
  };
  const text = (selector: string) => site.evaluate<string>(`document.querySelector(${js(selector)})?.textContent ?? ""`);
  const texts = (selector: string) => site.evaluate<string[]>(`[...document.querySelectorAll(${js(selector)})].map((el) => el.textContent.trim())`);
  const library = () => until(`!!document.querySelector(".shell-header [aria-label=More]")`, "the library", 15000);

  const openMenu = async () => {
    await site.evaluate(`document.querySelector(".shell-header [aria-label=More]").click()`);
    await until(`!!document.querySelector("[role=menu]")`, "the More menu");
    return texts("[role=menu] [role=menuitem]");
  };
  const closeMenu = async () => {
    await site.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await settle();
  };
  const pick = (item: string) => click(item, "document.querySelector('[role=menu]')");

  const shot = async (path: string | undefined) => {
    if (path) writeFileSync(path, Buffer.from((await site.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  };
  const fits = () =>
    site.evaluate<{ page: number; left: number; right: number }>(`(() => {
      const sheet = document.querySelector("[role=dialog]")?.getBoundingClientRect() ?? { left: 0, right: 0 };
      return { page: document.documentElement.scrollWidth, left: sheet.left, right: sheet.right };
    })()`);

  /** Create an account with Face ID or fingerprint from the More menu, as a new player does. */
  const signUp = async (name: string) => {
    await openMenu();
    await pick("Sign in");
    const atStep = (step: string) => until(`document.querySelector(".account-sheet")?.dataset.step === ${js(step)}`, `the ${step} screen`);
    await atStep("start");
    await click("New here? Create an account");
    await type("Your name (what bandmates see)", name);
    await click("Sign in with Face ID or fingerprint");
    await atStep("codes");
    await click("I saved them");
    await atStep("account");
    await click("✕");
  };

  return { until, click, type, text, texts, library, openMenu, closeMenu, pick, shot, fits, signUp, errors: () => site.evaluate<string[]>("window.__errors") };
}

/** Another player on their own phone, signed up with a password straight to the API, sending the app's Origin. */
export async function passwordPlayer(base: string, origin: string, name: string, handle: string) {
  const phone = new Phone(base);
  const call = phone.call.bind(phone);
  phone.call = (path, body, headers = {}) => call(path, body, { origin, ...headers });
  const salt = newSalt();
  const made = await phone.call("/api/auth/password/create", { name, handle, salt, key: await passwordKey("violet tram 42 lantern", salt) });
  assert.equal(made.status, 200, `${name} signs up (${JSON.stringify(made.body)})`);
  return Object.assign(phone, { name, handle, userId: made.body.account.userId as string });
}

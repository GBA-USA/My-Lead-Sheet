import { writeFileSync } from "node:fs";
import { startApi } from "./api-session.ts";
import { openSite } from "./chrome.ts";

/** Set SHOTS to a folder to save each sign-in screen at phone size. */
const shots = process.env.SHOTS;
const root = new URL("..", import.meta.url).pathname;
const WIDTH = 390;
let failures = 0;
const check = (ok: boolean, message: string) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
};

let apiBase = "";
const site = await openSite(root, "check-account", () => apiBase);
const origin = site.origin.replace("127.0.0.1", "localhost");
const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost" });
apiBase = base;

const js = (value: unknown) => JSON.stringify(value);
const settle = (ms = 250) => new Promise((done) => setTimeout(done, ms));
async function until(expression: string, what: string, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await settle(100)) if (await site.evaluate<boolean>(expression)) return true;
  check(false, `timed out waiting for ${what} at ${await site.evaluate<string>("location.href")}`);
  return false;
}
const step = () => site.evaluate<string>(`document.querySelector(".account-sheet")?.dataset.step ?? ""`);
const atStep = (name: string) => until(`document.querySelector(".account-sheet")?.dataset.step === ${js(name)}`, `the ${name} screen`);
const click = (text: string, scope = "document") =>
  site.evaluate<boolean>(`(() => { const el = [...(${scope}?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === ${js(text)} && !b.disabled); el?.click(); return !!el; })()`);
const sheetButtons = () => site.evaluate<string[]>(`[...document.querySelectorAll(".account-sheet button")].map((b) => b.textContent.trim())`);
async function type(label: string, text: string) {
  await site.evaluate(`[...document.querySelectorAll(".account-sheet label")].find((l) => l.textContent.trim() === ${js(label)}).control.focus()`);
  await site.send("Input.insertText", { text });
}
async function openSheet(item: string) {
  await site.evaluate(`document.querySelector(".shell-header [aria-label=More]").click()`);
  await settle();
  check(await click(item, "document.querySelector('[role=menu]')"), `the More menu offers ${item}`);
  await settle();
}
async function fitsPhone(name: string) {
  const fit = await site.evaluate<{ page: number; left: number; right: number; privacy: string }>(`(() => {
    const sheet = document.querySelector(".account-sheet").getBoundingClientRect();
    return { page: document.documentElement.scrollWidth, left: sheet.left, right: sheet.right, privacy: document.querySelector(".account-sheet a.account-privacy")?.getAttribute("href") ?? "" };
  })()`);
  check(fit.page <= WIDTH && fit.left >= 0 && fit.right <= WIDTH, `${name}: no sideways overflow at ${WIDTH}px (page ${fit.page}, sheet ${Math.round(fit.left)}..${Math.round(fit.right)})`);
  check(fit.privacy === "privacy.html", `${name}: links the privacy page (${fit.privacy || "missing"})`);
  if (shots) writeFileSync(`${shots}/account-${name}.png`, Buffer.from((await site.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
}

try {
  await site.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: 844, deviceScaleFactor: 2, mobile: true });
  await site.send("Page.enable");
  await site.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__errors = []; addEventListener("error", (e) => __errors.push(String(e.message))); addEventListener("unhandledrejection", (e) => __errors.push(String(e.reason)));`,
  });
  await site.send("WebAuthn.enable");
  const { authenticatorId } = await site.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  await site.send("Page.navigate", { url: `${origin}/#/songs` });
  await until(`!!document.querySelector(".shell-header [aria-label=More]")`, "the library", 15000);
  await openSheet("Sign in");
  await atStep("start");
  check((await sheetButtons()).includes("Sign in with Face ID or fingerprint"), "Sign in offers Face ID or fingerprint");
  await fitsPhone("sign-in");

  check(await click("New here? Create an account"), "Create an account opens");
  await atStep("create");
  check(!(await click("Sign in with Face ID or fingerprint")), "the passkey button waits for a name");
  await type("Your name (what bandmates see)", "Sam Rivera");
  await fitsPhone("create");
  check(await click("Sign in with Face ID or fingerprint"), "Face ID or fingerprint creates the account");
  await atStep("codes");
  const codes = await site.evaluate<string[]>(`[...document.querySelectorAll(".account-codes li")].map((li) => li.textContent)`);
  check(codes.length === 8 && codes.every((code) => /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(code)), `Save your backup codes shows 8 codes (${codes.length})`);
  const apart = await site.evaluate<boolean>(`(() => {
    const boxes = [...document.querySelectorAll(".account-codes li")].map((li) => {
      const range = document.createRange();
      range.selectNodeContents(li);
      return range.getBoundingClientRect();
    });
    return boxes.every((a, i) => boxes.every((b, j) => i === j || a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top));
  })()`);
  check(apart, "no backup code runs into another");
  await fitsPhone("codes");
  const { credentials } = await site.send("WebAuthn.getCredentials", { authenticatorId });
  check(credentials.length === 1 && credentials[0].isResidentCredential && credentials[0].rpId === "localhost", "the phone holds one passkey for this site");

  check(await click("I saved them"), "I saved them");
  await atStep("account");
  const view = await site.evaluate<{ title: string; handle: string; removeDisabled: boolean; left: string }>(`(() => {
    const sheet = document.querySelector(".account-sheet");
    const remove = [...sheet.querySelectorAll(".account-ways button")].find((b) => b.textContent.trim() === "Remove");
    return { title: sheet.querySelector("h2").textContent, handle: sheet.querySelector(".account-handle").textContent, removeDisabled: !!remove?.disabled, left: [...sheet.querySelectorAll(".account-note")].map((n) => n.textContent).join("|") };
  })()`);
  check(view.title === "Sam Rivera" && view.handle === "@samrivera", `the account shows the name and @handle the server made (${view.title}, ${view.handle})`);
  check(view.removeDisabled, "Remove is off while Face ID or fingerprint is the only way");
  check(view.left.includes("8 left"), `Backup codes shows 8 left (${view.left})`);
  await fitsPhone("account");

  check(await click("Sign out"), "Sign out");
  await atStep("start");
  check(await click("Sign in with Face ID or fingerprint"), "Sign in with the passkey the phone made");
  await atStep("account");
  check((await site.evaluate<string>(`document.querySelector(".account-handle").textContent`)) === "@samrivera", "the passkey signs back in to the same account");

  await site.send("Page.reload");
  await until(`!!document.querySelector(".shell-header [aria-label=More]")`, "the library after a reload");
  await openSheet("Sign in");
  await atStep("account");
  check((await site.evaluate<string>(`document.querySelector(".account-handle")?.textContent ?? ""`)) === "@samrivera", "after a reload the session cookie still opens the account");

  check(await click("Sign out"), "Sign out again");
  await atStep("start");
  check(await click("Use a backup code"), "Use a backup code opens");
  await atStep("backup-code");
  await type("Your @name", "@samrivera");
  await type("Backup code", codes[0].toLowerCase());
  await fitsPhone("backup-code");
  check(await click("Sign in"), "Sign in with a backup code");
  await atStep("account");
  check((await site.evaluate<string>(`[...document.querySelectorAll(".account-sheet .account-note")].map((n) => n.textContent).join("|")`)).includes("7 left"), "a used backup code leaves 7");

  check(await click("Sign out"), "Sign out before reusing the code");
  await atStep("start");
  await click("Use a backup code");
  await atStep("backup-code");
  await type("Your @name", "samrivera");
  await type("Backup code", codes[0]);
  await click("Sign in");
  await until(`!!document.querySelector(".account-sheet [role=alert]")`, "the reused code's error");
  check((await step()) === "backup-code", "the same backup code is refused the second time");

  await site.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await settle();
  check(!(await site.evaluate<boolean>(`!!document.querySelector(".account-sheet")`)), "Escape closes the sheet");

  await site.send("Page.addScriptToEvaluateOnNewDocument", { source: "delete window.PublicKeyCredential;" });
  await site.send("Page.reload");
  await until(`!!document.querySelector(".shell-header [aria-label=More]")`, "the library without passkeys");
  await openSheet("Sign in");
  await atStep("start");
  const noPasskeys = await site.evaluate<string>(`document.querySelector(".account-sheet [role=note]")?.textContent ?? ""`);
  check(noPasskeys.includes("Open My Lead Sheet in Safari or Chrome"), `a browser without passkeys says Open in Safari or Chrome (${noPasskeys || "nothing"})`);
  check(!(await sheetButtons()).includes("Sign in with Face ID or fingerprint"), "and offers no Face ID button there");
  await fitsPhone("no-passkeys");

  const errors = await site.evaluate<string[]>("window.__errors");
  check(errors.length === 0, `no page errors (${errors.join("; ")})`);
} finally {
  await site.close();
  await worker.dispose();
}

if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("check:account passed");

import { startApi } from "./api-session.ts";
import { openSite } from "./chrome.ts";
import { startMockGoogle } from "./mock-google.ts";

const root = new URL("..", import.meta.url).pathname;
const PEPPER = "check-only-password-pepper-0123456789abcdef";
const CLIENT = { clientId: "check-client.apps.example", clientSecret: "check-only-google-secret" };
const SIZES = [344, 390, 820, 884, 1280];
const PASSKEY = "Sign in with Face ID or fingerprint";
const WRONG_ADDRESS = "Open localhost to use Face ID or fingerprint.";
const GENERIC = "Something went wrong. Try again.";

let failures = 0;
const check = (ok: boolean, message: string) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
};

const mock = await startMockGoogle(CLIENT);
let apiBase = "";
const site = await openSite(root, "check-ux-passkey-msg-fix", () => apiBase);
const other = site.origin;
const main = other.replace("127.0.0.1", "localhost");
const deployed = await startApi({ APP_ORIGIN: main, RP_ID: "localhost" });
const loose = await startApi({
  APP_ORIGIN: other,
  RP_ID: "localhost",
  PASSWORD_PEPPER: PEPPER,
  GOOGLE_ISSUER: mock.issuer,
  GOOGLE_CLIENT_ID: CLIENT.clientId,
  GOOGLE_CLIENT_SECRET: CLIENT.clientSecret,
  GOOGLE_REDIRECT_URI: `${other}/api/auth/google/callback`,
});

const js = (value: unknown) => JSON.stringify(value);
const settle = (ms = 250) => new Promise((done) => setTimeout(done, ms));
async function until(expression: string, what: string, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await settle(100)) if (await site.evaluate<boolean>(expression)) return true;
  check(false, `timed out waiting for ${what} at ${await site.evaluate<string>("location.href")}`);
  return false;
}
const atStep = (name: string) => until(`document.querySelector(".account-sheet")?.dataset.step === ${js(name)}`, `the ${name} screen`);
const click = (text: string) =>
  site.evaluate<boolean>(`(() => { const el = [...document.querySelectorAll(".account-sheet button")].find((b) => b.textContent.trim() === ${js(text)} && !b.disabled); el?.click(); return !!el; })()`);
const enabledButtons = () => site.evaluate<string[]>(`[...document.querySelectorAll(".account-sheet button")].filter((b) => !b.disabled).map((b) => b.textContent.trim())`);
const alertText = () => site.evaluate<string>(`document.querySelector(".account-sheet [role=alert]")?.textContent ?? ""`);
const alertLink = () => site.evaluate<string>(`document.querySelector(".account-sheet [role=alert] a")?.href ?? ""`);
const asked = () => site.evaluate<string[]>("window.__asked");
const linkOrigin = (href: string) => (href ? new URL(href).origin : "");
async function type(label: string, text: string) {
  await site.evaluate(`[...document.querySelectorAll(".account-sheet label")].find((l) => l.textContent.trim() === ${js(label)}).control.focus()`);
  await site.send("Input.insertText", { text });
}
const ready = () => until(`[...document.querySelectorAll(".account-sheet button")].some((b) => b.textContent.trim() === ${js(PASSKEY)} && !b.disabled)`, "the passkey button");
async function openSignIn(url: string) {
  await site.send("Page.navigate", { url: "about:blank" });
  await site.send("Page.navigate", { url });
  await until(`!!document.querySelector(".shell-header [aria-label=Settings]")`, "the library", 15000);
  await site.evaluate(`document.querySelector(".shell-header [aria-label=Settings]").click()`);
  await until(`!!document.querySelector(".settings")`, "Settings");
  await site.evaluate(`[...document.querySelectorAll(".settings [role=group][aria-label=Account] button")].find((b) => b.textContent.trim() === "Sign in")?.click()`);
  await atStep("start");
  await ready();
}
async function phoneSize(width: number) {
  await site.send("Emulation.setDeviceMetricsOverride", { width, height: width > 884 ? 900 : 844, deviceScaleFactor: 2, mobile: width <= 884 });
  await settle(300);
}

try {
  await phoneSize(390);
  await site.send("Page.enable");
  await site.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__errors = []; addEventListener("error", (e) => __errors.push(String(e.message))); addEventListener("unhandledrejection", (e) => __errors.push(String(e.reason)));
      window.__asked = [];
      for (const name of ["get", "create"]) {
        const real = CredentialsContainer.prototype[name];
        CredentialsContainer.prototype[name] = function (options) {
          __asked.push(name);
          if (window.__refuse) return Promise.reject(new DOMException("The relying party ID is not a registrable domain suffix of, nor equal to the current domain.", window.__refuse));
          return real.call(this, options);
        };
      }`,
  });
  await site.send("WebAuthn.enable");
  const { authenticatorId } = await site.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  apiBase = deployed.base;
  await openSignIn(`${main}/#/songs`);
  await click("New here? Create an account");
  await atStep("create");
  await type("Your name (what bandmates see)", "Sam Rivera");
  check(await click(PASSKEY), "on the main host Face ID or fingerprint makes an account");
  await atStep("account");
  check((await alertText()) === "", `on the main host the passkey flow is unchanged: making the account shows no error (${await alertText()})`);
  check(await click("Sign out"), "Sign out");
  await atStep("start");
  await ready();
  check(await click(PASSKEY), "Sign in with the passkey the phone made");
  await atStep("account");
  const { credentials } = await site.send("WebAuthn.getCredentials", { authenticatorId });
  check(
    (await asked()).join() === "create,get" && credentials.length === 1 && credentials[0].rpId === "localhost",
    `on the main host the passkey flow is unchanged: the browser was asked to make then use one passkey for localhost (${(await asked()).join()})`,
  );
  check(await click("Sign out"), "Sign out again");
  await atStep("start");
  await ready();

  await site.evaluate(`window.__refuse = "SecurityError"`);
  check(await click(PASSKEY), "tap Face ID or fingerprint when the browser refuses with a SecurityError");
  await until(`!!document.querySelector(".account-sheet [role=alert]")`, "the SecurityError message");
  check((await alertText()) === WRONG_ADDRESS, `a passkey SecurityError shows Open the main address to use Face ID or fingerprint, with that address (${await alertText()})`);
  check(linkOrigin(await alertLink()) === "https://localhost", `a passkey SecurityError links to the main address (${(await alertLink()) || "no link"})`);

  await openSignIn(`${other}/#/songs`);
  check(await click(PASSKEY), "on a host the Worker refuses as wrong-origin, tap Face ID or fingerprint");
  await until(`!!document.querySelector(".account-sheet [role=alert]")`, "the wrong-origin message");
  const refused = await alertText();
  check(refused !== GENERIC && refused.includes("main address"), `a host the server refuses says to open the main address, not Something went wrong (${refused})`);

  apiBase = loose.base;
  await openSignIn(`${other}/#/songs`);
  check(await click(PASSKEY), "on a host that is not the passkey rp id, tap Face ID or fingerprint");
  await until(`!!document.querySelector(".account-sheet [role=alert]")`, "the wrong-address message");
  check(
    (await alertText()) === WRONG_ADDRESS && (await asked()).length === 0,
    `on a host that is not the passkey rp id, the passkey buttons say so before the browser prompt (${await alertText()}; browser asked ${(await asked()).length} times)`,
  );
  check(linkOrigin(await alertLink()) === "https://localhost", `the wrong-address message links to https://localhost (${(await alertLink()) || "no link"})`);
  for (const width of SIZES) {
    await phoneSize(width);
    const fit = await site.evaluate<{ page: number; sheet: number[]; alert: number[]; link: number[]; seen: boolean } | null>(`(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.right, r.top, r.bottom]; };
      const link = document.querySelector(".account-sheet [role=alert] a");
      if (!link) return null;
      const r = link.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + Math.min(r.width / 2, 4), r.top + r.height / 2);
      return { page: document.documentElement.scrollWidth, sheet: box(document.querySelector(".account-sheet")), alert: box(document.querySelector(".account-sheet [role=alert]")), link: box(link), seen: link === hit || link.contains(hit) };
    })()`);
    if (!fit) {
      check(false, `at ${width}px the message has a link to fit`);
      continue;
    }
    const [sheetLeft, sheetRight] = fit.sheet;
    const inside = (b: number[]) => b[0] >= sheetLeft - 0.5 && b[1] <= sheetRight + 0.5 && b[1] > b[0];
    check(
      fit.page <= width && inside(fit.alert) && inside(fit.link) && fit.seen,
      `at ${width}px the message and its link fit inside the sheet and the link can be tapped (page ${fit.page}, sheet ${fit.sheet.map(Math.round).join("..")}, link ${fit.link.map(Math.round).join("..")})`,
    );
  }
  await phoneSize(390);
  const offered = await enabledButtons();
  check(offered.includes("Continue with Google") && offered.includes("Sign in with a password"), `Password and Google sign-in are still offered next to the message (${offered.join(", ")})`);

  check(await click("New here? Create an account"), "Create an account opens");
  await atStep("create");
  await type("Your name (what bandmates see)", "Alex Low");
  check(await click(PASSKEY), "tap Face ID or fingerprint on Create");
  await until(`!!document.querySelector(".account-sheet [role=alert]")`, "the wrong-address message on Create");
  check(
    (await alertText()) === WRONG_ADDRESS && (await asked()).length === 0,
    `on a host that is not the passkey rp id, the create passkey button says so before the browser prompt (${await alertText()}; browser asked ${(await asked()).length} times)`,
  );
  check(await site.evaluate<boolean>(`(() => { document.querySelector(".account-sheet .account-close").click(); return true; })()`), "Close the sheet");
  await settle();
  check(!(await site.evaluate<boolean>(`!!document.querySelector(".account-sheet")`)), "a visitor who sees the message can close the sheet and keep using the app");

  await openSignIn(`${other}/#/songs`);
  await click("New here? Create an account");
  await atStep("create");
  await type("Your name (what bandmates see)", "Alex Low");
  check(await click("Make a password"), "Make a password");
  await atStep("make-password");
  await type("Password", "walking-bass-under-the-moon-42");
  check(await click("Make account"), "Make account");
  check(await atStep("account"), "Password sign-in still works on a host that is not the passkey rp id");
  check(await click("Sign out"), "Sign out of the password account");
  await atStep("start");

  const errors = await site.evaluate<string[]>("window.__errors");
  check(errors.length === 0, `no page errors (${errors.join("; ")})`);

  check(await click("Continue with Google"), "Continue with Google");
  check(
    await until(`["account", "nudge"].includes(document.querySelector(".account-sheet")?.dataset.step) && location.host === ${js(new URL(other).host)}`, "the account Google made", 15000),
    "Google sign-in still works on a host that is not the passkey rp id",
  );
} finally {
  await site.close();
  await deployed.worker.dispose();
  await loose.worker.dispose();
  await mock.close();
}

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);

import assert from "node:assert/strict";
import { Phone, TEST_ORIGIN, startApi } from "./api-session.ts";
import { openSite } from "./chrome.ts";
import { startMockGoogle, type MockUser, type TokenTamper } from "./mock-google.ts";

const CLIENT = { clientId: "check-client.apps.example", clientSecret: "check-only-google-secret" };
const CALLBACK_PATH = "/api/auth/google/callback";

const mock = await startMockGoogle(CLIENT);
const googleVars = (origin: string) => ({
  GOOGLE_ISSUER: mock.issuer,
  GOOGLE_CLIENT_ID: CLIENT.clientId,
  GOOGLE_CLIENT_SECRET: CLIENT.clientSecret,
  GOOGLE_REDIRECT_URI: `${origin}${CALLBACK_PATH}`,
});

let counter = 0;
const googleUser = (name: string): MockUser => {
  counter += 1;
  return { sub: `10${String(counter).padStart(19, "0")}`, email: `${name.toLowerCase().replace(/\W/g, "")}@example.test`, name };
};

/** One phone's browser for the Google round trip: a cookie jar, the app's Origin on POSTs, and no automatic redirects. */
class Browser {
  readonly jar = new Map<string, string>();
  readonly base: string;

  constructor(base: string) {
    this.base = base;
  }

  private keep(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const at = pair.indexOf("=");
      const value = pair.slice(at + 1);
      if (value && !/Max-Age=0/.test(line)) this.jar.set(pair.slice(0, at), value);
      else this.jar.delete(pair.slice(0, at));
    }
  }

  async fetch(url: string, init: RequestInit = {}) {
    const target = url.startsWith(TEST_ORIGIN) ? new URL(url.slice(TEST_ORIGIN.length), this.base) : new URL(url, this.base);
    const cookie = [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await fetch(target, { ...init, redirect: "manual", headers: { ...(init.headers as Record<string, string>), ...(cookie ? { cookie } : {}) } });
    this.keep(response);
    return response;
  }

  async post(path: string, body: object) {
    const response = await this.fetch(path, { method: "POST", headers: { "content-type": "application/json", origin: TEST_ORIGIN }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  }

  async me() {
    const response = await this.fetch("/api/me");
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  }

  async callbackAddress(start: { intent: "sign-in" | "link"; name?: string }, as: MockUser) {
    const started = await this.post("/api/auth/google/start", start);
    assert.equal(started.status, 200, `Google start answers (${JSON.stringify(started.body)})`);
    mock.signInAs(as);
    const consent = await fetch(started.body.url, { redirect: "manual" });
    assert.equal(consent.status, 302, "the mock's consent step sends the phone back");
    return consent.headers.get("location")!;
  }

  async followCallback(address: string) {
    const back = await this.fetch(address);
    assert.equal(back.status, 302, `the callback sends the phone back to the app (${back.status})`);
    const location = new URL(back.headers.get("location")!);
    assert.equal(location.origin, TEST_ORIGIN, "the callback goes back to the app's origin");
    return location.searchParams.get("google");
  }

  async google(start: { intent: "sign-in" | "link"; name?: string }, as: MockUser, tamper?: TokenTamper) {
    const address = await this.callbackAddress(start, as);
    if (tamper) mock.tamperNext(tamper);
    return this.followCallback(address);
  }
}

async function apiChecks() {
  const { worker, base } = await startApi(googleVars(TEST_ORIGIN));
  try {
    const config = await fetch(new URL("/api/auth/config", base)).then((r) => r.json());
    assert.deepEqual(config, { google: true }, "with a Google client the server offers Google");

    const gail = googleUser("Gail Google");
    const first = new Browser(base);
    assert.equal(await first.google({ intent: "sign-in", name: "Gail" }, gail), "new", "a first Google sign-in makes a new account");
    assert.equal(first.jar.has("mls_google"), false, "the callback clears the Google flow cookie");
    const made = await first.me();
    assert.equal(made.status, 200, "the new account is signed in");
    assert.equal(made.body.account.displayName, "Gail", "the name typed on the create screen is the display name");
    assert.deepEqual(
      made.body.account.ways.map((way: { kind: string; id: string; detail: string }) => [way.kind, way.id, way.detail]),
      [["google", gail.sub, gail.email]],
      "the account's one way is Google, keyed on sub, showing the connected address",
    );

    const again = new Browser(base);
    assert.equal(await again.google({ intent: "sign-in" }, gail), "in", "the same Google account signs in again");
    assert.equal((await again.me()).body.account.userId, made.body.account.userId, "and reaches the same account");

    const fromStart = googleUser("Stella Start");
    const starter = new Browser(base);
    assert.equal(await starter.google({ intent: "sign-in" }, fromStart), "new");
    assert.equal((await starter.me()).body.account.displayName, "Stella Start", "a Google sign-in from the start screen takes Google's name");

    const refusals: [string, TokenTamper, string][] = [
      ["a token for another audience", { aud: "someone-else.apps.example" }, "wrong-audience"],
      ["a token from another issuer", { iss: "http://127.0.0.1:1" }, "wrong-issuer"],
      ["an expired token", { expiresIn: -120 }, "token-expired"],
      ["a token with another flow's nonce", { nonce: "not-this-flows-nonce" }, "wrong-nonce"],
      ["a token signed by another key", { otherKey: true }, "bad-signature"],
    ];
    for (const [label, tamper, reason] of refusals) {
      const who = googleUser(label);
      const browser = new Browser(base);
      assert.equal(await browser.google({ intent: "sign-in" }, who, tamper), reason, `${label} is refused with ${reason}`);
      assert.equal(browser.jar.has("mls_session"), false, `${label} sets no session`);
      assert.equal(await new Browser(base).google({ intent: "sign-in" }, who), "new", `${label} made no account`);
    }

    const replayer = new Browser(base);
    const used = await replayer.callbackAddress({ intent: "sign-in" }, googleUser("Replay"));
    const cookie = replayer.jar.get("mls_google")!;
    assert.equal(await replayer.followCallback(used), "new", "a callback works once");
    replayer.jar.set("mls_google", cookie);
    assert.equal(await replayer.followCallback(used), "wrong-state", "the same callback a second time is refused");

    const attacker = new Browser(base);
    const planted = await attacker.callbackAddress({ intent: "sign-in" }, googleUser("Attacker"));
    const victim = new Browser(base);
    assert.equal(await victim.followCallback(planted), "wrong-state", "a callback started in another browser is refused (no login CSRF)");
    assert.equal(victim.jar.has("mls_session"), false, "and signs the victim in to nothing");

    const pkce = new Browser(base);
    const stolen = await pkce.callbackAddress({ intent: "sign-in" }, googleUser("Code Thief"));
    const otherFlow = await pkce.callbackAddress({ intent: "sign-in" }, googleUser("Code Thief"));
    const injected = new URL(otherFlow);
    injected.searchParams.set("code", new URL(stolen).searchParams.get("code")!);
    assert.equal(await pkce.followCallback(injected.href), "google-refused", "a code from another flow fails its PKCE verifier and is refused");

    const canceller = new Browser(base);
    mock.pressCancel(true);
    const cancelled = await canceller.callbackAddress({ intent: "sign-in" }, googleUser("Cancel"));
    mock.pressCancel(false);
    assert.equal(await canceller.followCallback(cancelled), "google-cancelled", "pressing Cancel at Google signs in to nothing");

    const sam = new Phone(base);
    await sam.createAccount("Sam Passkey");
    const samBrowser = new Browser(base);
    samBrowser.jar.set("mls_session", sam.cookie.slice("mls_session=".length));
    const samGoogle = googleUser("Sam Google");
    assert.equal(await samBrowser.google({ intent: "link" }, samGoogle), "linked", "a signed-in account connects Google");
    const linkedView = (await samBrowser.me()).body.account;
    assert.deepEqual(linkedView.ways.map((way: { kind: string }) => way.kind), ["passkey", "google"], "the account now has a passkey and Google");
    const viaGoogle = new Browser(base);
    assert.equal(await viaGoogle.google({ intent: "sign-in" }, samGoogle), "in", "Google then signs in instead of making an account");
    assert.equal((await viaGoogle.me()).body.account.userId, linkedView.userId, "linking keeps one account");
    assert.equal(await samBrowser.google({ intent: "link" }, gail), "google-taken", "a Google account already on another account is refused");
    assert.equal((await samBrowser.me()).body.account.ways.length, 2, "and nothing changes on this one");
    assert.equal((await new Browser(base).post("/api/auth/google/start", { intent: "link" })).status, 401, "connecting Google needs a session");

    const lastWay = await first.post("/api/me/remove-google", { id: gail.sub });
    assert.deepEqual([lastWay.status, lastWay.body.error], [409, "last-way"], "removing Google when it is the only way is refused");
    const removed = await samBrowser.post("/api/me/remove-google", { id: samGoogle.sub });
    assert.deepEqual(removed.body.account.ways.map((way: { kind: string }) => way.kind), ["passkey"], "Remove takes Google off while another way is left");
    assert.equal(await new Browser(base).google({ intent: "sign-in" }, samGoogle), "new", "a removed Google account no longer reaches the old account");
  } finally {
    await worker.dispose();
  }

  const off = await startApi({ GOOGLE_ISSUER: mock.issuer, GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: CLIENT.clientSecret, GOOGLE_REDIRECT_URI: `${TEST_ORIGIN}${CALLBACK_PATH}` });
  try {
    assert.deepEqual(await fetch(new URL("/api/auth/config", off.base)).then((r) => r.json()), { google: false }, "with an empty GOOGLE_CLIENT_ID the server offers no Google");
    const started = await new Browser(off.base).post("/api/auth/google/start", { intent: "sign-in" });
    assert.deepEqual([started.status, started.body.error], [503, "not-configured"], "and refuses to start a Google flow");
  } finally {
    await off.worker.dispose();
  }
}

async function screenChecks() {
  const root = new URL("..", import.meta.url).pathname;
  let apiBase = "";
  const site = await openSite(root, "check-google", () => apiBase);
  const origin = site.origin.replace("127.0.0.1", "localhost");
  const { worker, base } = await startApi({ APP_ORIGIN: origin, RP_ID: "localhost", ...googleVars(origin) });
  apiBase = base;
  const js = JSON.stringify;
  const until = async (expression: string, what: string) => {
    for (const end = Date.now() + 10000; Date.now() < end; await new Promise((done) => setTimeout(done, 100))) {
      if (await site.evaluate<boolean>(expression).catch(() => false)) return;
    }
    throw new Error(`timed out waiting for ${what} at ${await site.evaluate<string>("location.href")}`);
  };
  const atStep = (name: string) => until(`document.querySelector(".account-sheet")?.dataset.step === ${js(name)}`, `the ${name} screen`);
  const click = (text: string) =>
    site.evaluate<boolean>(`(() => { const el = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${js(text)} && !b.disabled); el?.click(); return !!el; })()`);
  const sheetText = () => site.evaluate<string>(`document.querySelector(".account-sheet")?.innerText ?? ""`);
  const openSheet = async () => {
    await until(`!!document.querySelector(".shell-header [aria-label=More]")`, "the library");
    await site.evaluate(`document.querySelector(".shell-header [aria-label=More]").click()`);
    await until(`[...document.querySelectorAll("[role=menu] button")].some((b) => b.textContent.trim() === "Sign in")`, "the More menu");
    await click("Sign in");
    await atStep("start");
  };
  try {
    await site.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await site.send("Page.enable");
    await site.send("Page.navigate", { url: `${origin}/#/songs` });
    await openSheet();
    await until(`[...document.querySelectorAll(".account-sheet button")].some((b) => b.textContent.trim() === "Continue with Google")`, "the Google button");
    assert.ok((await sheetText()).includes("New here? This makes a new account. Already have one? Sign in another way, then connect Google in Settings."), "the sign-in screen says what a first Google sign-in does");
    assert.equal(await site.evaluate<string>(`document.querySelector(".account-sheet a.account-privacy")?.getAttribute("href") ?? ""`), "privacy.html", "the sign-in screen keeps the privacy link");

    mock.signInAs(googleUser("Chrome Player"));
    assert.ok(await click("Continue with Google"), "Continue with Google");
    await atStep("codes");
    assert.equal(await site.evaluate<string>("location.search"), "", "the app drops ?google= from the address once it has read it");
    const codes = await site.evaluate<number>(`document.querySelectorAll(".account-codes li").length`);
    assert.equal(codes, 8, "a new Google account ends on Save your backup codes with 8 codes");
    assert.ok(await click("I saved them"));
    await atStep("account");
    const text = await sheetText();
    assert.ok(text.includes("Chrome Player") && text.includes("Google (chromeplayer@example.test)"), `Ways to sign in shows Google with the connected address (${text})`);
    assert.ok(text.includes("+ Add a password") && !text.includes("+ Connect Google"), "the account offers a password and no second Google");
    assert.equal(
      await site.evaluate<boolean>(`[...document.querySelectorAll(".account-ways button")].every((b) => b.disabled)`),
      true,
      "Remove is off while Google is the only way",
    );

    assert.ok(await click("Sign out"));
    await atStep("start");
    assert.ok(await click("Continue with Google"), "Continue with Google again");
    await atStep("account");
    assert.ok((await sheetText()).includes("Chrome Player"), "Google signs back in to the same account");

    await site.send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0" });
    assert.ok(await click("Sign out"));
    await site.send("Page.reload");
    await openSheet();
    await until(`!!document.querySelector(".account-sheet [role=note]")`, "the in-app browser note");
    const note = await site.evaluate<string>(`document.querySelector(".account-sheet [role=note]").textContent`);
    assert.ok(note.includes("Google sign-in") && note.includes("Open My Lead Sheet in Safari or Chrome"), `an in-app browser says Open in Safari or Chrome (${note})`);
    assert.ok(!(await sheetText()).includes("Continue with Google"), "and shows no Google button there");
  } finally {
    await site.close();
    await worker.dispose();
  }
}

let failed = false;
try {
  await apiChecks();
  await screenChecks();
  console.log(
    "check:google passed: mock issuer sign-in makes an account and signs in again, wrong audience, issuer, expiry, nonce and key refused, replayed and cross-browser callbacks refused, PKCE verifier mismatch refused, cancel, linking keeps one account, Google taken, last way kept, empty client id hides Google, the sheet round trip and the in-app note",
  );
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await mock.close();
}
process.exit(failed ? 1 : 0);

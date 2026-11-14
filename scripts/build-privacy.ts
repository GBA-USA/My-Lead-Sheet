import type { Plugin } from "vite";
import { DATA_KINDS, PRIVACY_HREF, type DataPlace } from "../src/data-kinds.ts";

export const CONTACT_PLACEHOLDER = "No contact has been set for this copy of the app yet.";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char]);

function kindList(place: DataPlace, none: string): string {
  const kinds = DATA_KINDS.filter((kind) => kind.place === place);
  if (kinds.length === 0) return `<p>${none}</p>`;
  return `<ul>\n${kinds.map((kind) => `      <li>${escape(kind.what)} <code>${escape(kind.key)}</code></li>`).join("\n")}\n    </ul>`;
}

export function privacyHtml(contact: string | undefined): string {
  const who = contact?.trim() ? escape(contact.trim()) : CONTACT_PLACEHOLDER;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Privacy · Lead Sheets</title>
    <style>
      body { margin: 0 auto; max-width: 40rem; padding: 1.5rem 1.25rem 3rem; font: 1rem/1.55 system-ui, sans-serif; background: #13120d; color: #f2efe6; }
      h1 { font-size: 1.6rem; }
      h2 { font-size: 1.15rem; margin-top: 2rem; }
      code { font-size: 0.8em; color: #b9b3a3; }
      a { color: #f5c542; }
    </style>
  </head>
  <body>
    <h1>Privacy</h1>
    <p><a href="./">Back to Lead Sheets</a></p>

    <h2>What the app keeps on this phone</h2>
    <p>These stay in this browser on this phone. They are not sent anywhere.</p>
    ${kindList("phone", "Nothing.")}

    <h2>What the app keeps on its server</h2>
    ${kindList("server", "Nothing yet. This version of the app has no accounts and sends nothing to a server.")}

    <h2>The microphone</h2>
    <p>Find BPM and Learn listen only while they are open. The sound is worked out on the phone and is never saved or sent. Only the timings listed above are kept.</p>

    <h2>Signing in with Google</h2>
    <p>If you sign in with Google, Google tells the app your name, your email address, and the account number Google uses to recognise you next time. That is all. The app gets no access to your mail, contacts, files, calendar or anything else in your Google account.</p>

    <h2>Deleting your data</h2>
    <p>To delete what is on this phone, clear this site's data in your browser settings. In Safari that is Settings, Safari, Advanced, Website Data. In Chrome it is Settings, Site settings, All sites.</p>
    <p>To delete an account and everything the server keeps for it, write to the contact below and say which account. Signing out never deletes what is on your phone.</p>

    <h2>Contact</h2>
    <p id="contact">${who}</p>
  </body>
</html>
`;
}

/** Emits the privacy page into every build, with the contact from `VITE_PRIVACY_CONTACT` (env or .env files). */
export function privacyPage(): Plugin {
  let contact: string | undefined;
  return {
    name: "privacy-page",
    configResolved(config) {
      contact = config.env.VITE_PRIVACY_CONTACT;
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: PRIVACY_HREF, source: privacyHtml(contact) });
    },
  };
}

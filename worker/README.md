# mls-rooms Worker

The `mls-rooms` Worker serves `/api/*` for the app. It holds two Durable Object classes, both SQLite-backed and both on the Workers Free plan:

- `Directory` holds accounts, friends and codes. It has no routes until cook C8.
- `Room` is one object per band, DM or personal room. Phones connect to it over a WebSocket.

The Pages site forwards `/api/*` to this Worker through `functions/api/[[path]].ts`. The Pages project needs one service binding, `API`, pointing at the Worker `mls-rooms`. Set it in the Pages project settings under Bindings. The site and the API share one origin, so the sign-in cookie works with no CORS.

## Routes

| Route | Answer |
|---|---|
| `GET /api/health` | `200 {"ok":true}` |
| `GET /api/rooms/:id` | `{"room": id, "peers": n}`. The id is 1 to 64 of `A-Z a-z 0-9 _ -`. |
| `GET /api/rooms/:id` with `Upgrade: websocket` | Joins the room's socket |

## Room socket messages

On connect the room sends `{"kind":"hello","you":peerId,"peers":[...]}`. `peers` lists the ids already in the room.

A phone sends `{"kind":"intro"|"ping"|"pong","to":peerId,"body":...}`. The room passes it to that peer as `{"kind",...,"from":peerId,"body","rx","tx"}`. `rx` is the room's clock when the message came in and `tx` is when it went out, in milliseconds since 1970. Workers only advance the clock between I/O, so the two are usually equal. An introduction carries WebRTC offers and answers. A clock ping goes follower to room to leader and comes back as a pong (PLAN.md 7.6).

A message the room can't read gets `{"kind":"error","error":"bad-message"}`. One addressed to a peer who isn't in the room gets `{"kind":"error","error":"no-peer","to":peerId}`.

## Config and handoff

`wrangler.jsonc` has no account id, domain or email. Wrangler takes the account from your login or `CLOUDFLARE_ACCOUNT_ID`. `env.test` is Terry's test account and `env.production` is Brian's. Each holds the same vars, empty until the owner fills them in:

| Var | What |
|---|---|
| `APP_ORIGIN` | The site's origin |
| `RP_ID`, `RP_NAME` | Passkey relying-party id (the site's domain) and name |
| `GOOGLE_CLIENT_ID`, `GOOGLE_REDIRECT_URI` | Google sign-in client and its callback address |
| `PRIVACY_CONTACT` | Contact address on the privacy page |
| `CF_ACCOUNT_ID` | Account whose relay usage the spend guard reads |
| `TURN_KEY_ID` | Cloudflare Realtime TURN key id |
| `RELAY_CAP_GB` | Monthly relay cap, 50 |

Secrets go in with `wrangler secret put NAME --env production`, never in a file: `SESSION_SECRET`, `PASSWORD_PEPPER`, `CODE_SIGNING_KEY`, `GOOGLE_CLIENT_SECRET`, `TURN_API_TOKEN`, `CF_ANALYTICS_TOKEN`.

`npm run check:portable` fails on a hard-coded account id, `workers.dev` or `pages.dev` host, email, literal origin, relying-party id, `/My-Lead-Sheet/` path, or Terry or GBA string in `src`, `worker`, `functions`, `public`, the workflows or the root config files. Markdown files are skipped. Real values are allowed only in the `env.*.vars` slots of `wrangler.jsonc`, and a Terry or GBA string is refused even there.

## Run it locally

`npm run check:api` type-checks the Worker and the Pages Function, starts the Worker under Miniflare with no saved state, and checks health, the Pages forwarding, a Room's answer, an introduction and a clock ping relayed between two sockets, room isolation, bad messages, and a socket leaving.

`npx wrangler dev --local -c worker/wrangler.jsonc` runs it by hand.

## Deploy

`wrangler deploy -c worker/wrangler.jsonc --env test` (or `--env production`). The first deploy runs migration `v1`, which creates both classes. Add later classes in a new migration tag. Never edit `v1`.

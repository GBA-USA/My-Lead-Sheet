# C0 server route spike: results

This spike answers one question. Can one Worker with one Room Durable Object, on the Workers Free plan, relay the leader's state and the followers' clock pings fast enough for the server route (PLAN.md 7.2 route 3, targets in 7.15, cost in 7.16)?

The code is throwaway. It lives only in `spike/server/` and has its own wrangler config, under the Worker name `mls-spike-server`. Nothing in the app or in `worker/` uses it.

## What runs

- `worker.js` is the Worker plus the `Room` Durable Object. The Room keeps the latest leader state in its SQLite table `gig`. It relays each `state` to every follower, relays each follower `ping` to the leader, and routes each leader `pong` back to the follower that sent the ping. A follower that connects gets the stored state first, marked `snapshot`. The Room counts its own socket upgrades and inbound messages per role, plus its awake time, at `/room/<name>/stats`.
- `drill.mjs <url>` runs 1 leader and 4 followers in a fresh room. The leader runs in the drill process. Each follower is its own Node process, so killing a follower is a real `SIGKILL`, not a polite socket close. The leader sends 200 changes, one every 500 ms, each about 1.3 KB. Each follower bursts 16 pings 100 ms apart on join, then pings every second (`--ping-ms 5000` gives the plan's server cadence). At change 50 the drill kills follower 4. It starts the follower again 60 s later and expects the newest `rev` within 2 s.
- The clock math follows PLAN 7.6. The sample offset is `band - (t0 + t1) / 2`. The filter keeps the last 32 samples, takes the 8 with the shortest round trips, and uses their median. The spread is the range of those 8. The leader's band time has a known fake offset, so the drill also prints the true estimate error.
- The drill exits 1 and names each failure unless all of these hold. Spread p95 is 8 ms or less. The rejoined follower gets a snapshot at or above the leader's rev within 2 s and ends on rev 200. The 3 followers that stayed up see every rev 1..200 in order. No follower sees a rev go backward. The room refuses no change. The room's leader-message count equals what the leader sent, and it counts 6 upgrades.
- `npm run check:spike-server` boots this Worker in Miniflare. It sends junk from the leader (bad JSON, `null`, a state without an integer `rev`) and checks the next real change still reaches a follower. Then it runs a short drill (40 changes, 3 s kill). It fails when the Room stops sending the join snapshot (4 named failures), when it drops pongs (spread p95 NaN), and when the junk guard is removed (the follower never gets rev 1). It passes on the real Room.

## Local numbers (`wrangler dev --local`, not the go/no-go)

Wrangler 4.162.0, Node 24.22.1, Linux. The drill and the Worker ran on the same 8-core host, which other build cooks were sharing (load average 1.6 to 4.8). Every path is loopback. Raw output is in `results/`.

| Run | Pings | Tap to follower p50 / p95 / p99 / max (ms) | Ping RTT p50 / p95 (ms) | Spread p95 (ms) | Offset error p95 (ms) | Rejoin: snapshot rev / leader rev, time | Result |
|---|---|---|---|---|---|---|---|
| 1 | 1 s | 3.26 / 4.89 / 16.18 / 133.35 | 3.46 / 5.51 | 1.64 | 0.30 | 169 / 169, 46.9 ms | PASS |
| 2 | 1 s | 3.26 / 7.79 / 29.58 / 30.49 | 3.64 / 5.81 | 1.51 | 0.37 | 169 / 169, 50.0 ms | PASS |
| 3 | 1 s | 3.12 / 4.85 / 6.48 / 6.84 | 3.11 / 5.54 | 1.52 | 0.37 | 170 / 169, 60.5 ms | PASS |
| 4 | 1 s | 3.09 / 5.38 / 10.18 / 52.07 | 3.30 / 5.57 | 1.50 | 0.37 | 169 / 169, 46.0 ms | PASS |
| 5 | 5 s | 3.58 / 4.77 / 5.70 / 12.48 | 3.15 / 4.69 | 1.52 | 0.31 | 169 / 169, 44.7 ms | PASS |
| 6, final code | 1 s | 3.33 / 6.42 / 10.68 / 16.39 | 3.53 / 7.74 | 2.23 | 0.38 | 169 / 169, 48.5 ms | PASS |

Runs 1 to 5 ran before the review fixes, and run 6 ran on the code in this PR. Medians over the 6 runs are tap p50 3.26 ms, tap p95 5.14 ms, spread p95 1.52 ms against the 8 ms target, and rejoin 47.7 ms against the 2 s target.

What the numbers say:

- The counts reconcile exactly in every run, so the drill timed real deliveries. There were 680 tap samples (3 × 200, plus 49 before the kill and 31 after the rejoin). The leader sent 622 messages (200 states plus 422 pongs), and the room counted 622.
- The p50 and the spread are stable. The tail is host noise. A probe run that listed the slowest deliveries found every slow change was slow on all 4 followers at once (rev 44 took about 16 ms on each). That is one stall on the leader or room side, not a slow socket. This host was shared, so the p99 and max columns measure the host.
- Loopback has no network, so these numbers show the relay logic and the drill work. They do not show the route is fast enough. The real-network run below decides that.

## Cost

The room measured one drill of about 103 s. It counted 6 upgrades and 1,044 inbound messages, which is 58 billed requests at 20 messages per request. It was awake 103 s, which is 12.9 GB-s at 128 MB.

The drill scales this to the plan's gig. That gig is 3 hours, 190 changes, and 4 followers on the server route pinging every 5 s, each with a 16-ping burst. It comes to 885 Durable Object requests (0.9% of the free 100,000 a day) and 1,350 GB-s (10.4% of the free 13,000 a day). The drill measured 2 inbound messages per ping (ping plus pong). The rest of the per-gig figure is arithmetic, not measurement. It agrees with the PLAN 7.16 row "All 4 on the server" (970 requests, 1,350 GB-s). Two inputs are from memory, as in the plan: Cloudflare bills 20 inbound WebSocket messages as one request, and a room sleeps after about 10 s idle. With pings every 5 s the room never sleeps, so the GB-s figure is 3 hours of wall time.

## Go/no-go (pending a deployed run)

Local verdict: the relay is correct and fast on loopback, provisional GO. The go/no-go needs one run against a deployed test Worker over a real network. CoS runs it on Terry's test account (Free plan, already OK'd for spikes in PLAN 11). This cook did not deploy.

GO when all of these hold on the deployed run:

1. The drill prints `PASS`, with spread p95 8 ms or less and the latest rev within 2 s of the rejoin.
2. Tap-to-follower p99 plus 30 ms is 260 ms or less. That is the server-route lead in PLAN 7.7. If it is higher, the lead has to grow toward its 400 ms cap, and the row says so.
3. The Durable Object requests that Cloudflare's dashboard shows for `mls-spike-server` come within about 2× of the drill's `costThisDrill.doRequests`. That checks the 20:1 billing assumption against the real bill counter.

### Deploy and run steps for CoS

Run everything from the repo root on a laptop with `npm ci` done.

```sh
npx wrangler login
npx wrangler whoami
```

`whoami` must show Terry's test account. If it lists more than one account, put the test account's id in `CLOUDFLARE_ACCOUNT_ID` for the commands below. No account id or host is written into this spike.

```sh
npx wrangler deploy --config spike/server/wrangler.jsonc
```

If the account has never used workers.dev, wrangler first asks for a subdomain name, and any name works. Wrangler prints the Worker's address, `https://mls-spike-server.<your workers.dev subdomain>.workers.dev`. Use it as `URL` below.

```sh
node spike/server/drill.mjs "$URL" | tee spike-server-deployed-1s.txt
node spike/server/drill.mjs "$URL" --ping-ms 5000 | tee spike-server-deployed-5s.txt
```

Each run takes about 2 minutes. Then open the Cloudflare dashboard, go to Workers, then `mls-spike-server`, then Durable Objects metrics (location from memory), and note the requests and duration for the two runs.

Record the result with a decisions.tsv row. Give the tap p50, p95 and p99, the spread p95, the rejoin time, the dashboard requests next to the drill's estimate, the network (home Wi-Fi or cell tether), and GO or NO-GO by the 3 rules above.

Then remove the Worker:

```sh
npx wrangler delete --config spike/server/wrangler.jsonc
```

Nothing else uses this Worker, so deleting it is the whole rollback.

### What the deployed run still does not prove

- All 5 sockets start on one laptop, so they reach the same Cloudflare location over the same link. Phones on different carriers and the 240 fps film are C20's job (PLAN 7.17).
- The deployed Worker is public for as long as it exists. Anyone with the address can open a room or claim `role=leader`. That is fine for a 10-minute test on a Free plan account, where limits fail closed. It is the reason to delete the Worker straight after.

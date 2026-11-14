# Spikes C1 and C2 on real phones

This is the step-by-step for the person running spikes C1 (Wi-Fi links) and C2 (links over the internet and the relay) from PLAN.md section 11. You open pages on phones, do the drills below, and share one results file per phone per run. The pages measure everything themselves.

Nothing here deploys anything. The pages run from a laptop through a free, temporary tunnel.

## 1. What you need

- A laptop with Node 22 or newer and this repo checked out. Run `npm ci` once.
- `cloudflared`, Cloudflare's tunnel tool. A quick tunnel needs no account. Install it from Cloudflare's downloads page, or with `brew install cloudflared` on a Mac.
- At least 2 iPhones and 2 Androids. Between them, at least one phone on each of Verizon, AT&T and T-Mobile.
- A travel router (test gear only, never something a band needs) that can:
  - turn client isolation ("guest network", "AP isolation") on and off;
  - show a sign-in page (captive portal), or a hotel or cafe Wi-Fi that has one;
  - block UDP with a firewall rule;
  - run with its internet cable unplugged.
- For C2 only: Terry's Cloudflare test account, to mint short-lived TURN credentials (section 5).

## 2. Start the pages

1. On the laptop, in the repo:

   ```sh
   node spike/lan/relay.mjs
   ```

   It prints `spike relay on http://0.0.0.0:8787/lan/ and /cell/` and whether TURN is configured.

2. In a second terminal:

   ```sh
   cloudflared tunnel --url http://localhost:8787
   ```

   It prints an `https://<random-words>.trycloudflare.com` address. That is `SITE` below. It lasts until you stop `cloudflared`, and it changes each time.

3. Keep the laptop awake and online for the whole session. The laptop's own network doesn't matter to the phones, because they reach `SITE` over the internet.

Page addresses (pick any room name, the same on every phone in one run):

| Page | Address |
|---|---|
| C1 leader | `SITE/lan/?role=leader&room=NAME&plan=fallback` (or `plan=auto`) |
| C1 follower | `SITE/lan/?role=follower&room=NAME` (add `&links=4` to make 4 links from one phone) |
| C2 leader | `SITE/cell/?role=leader&room=NAME&plan=each&secs=300` (or `plan=auto`) |
| C2 follower | `SITE/cell/?role=follower&room=NAME` |

- `plan=fallback` tries the Wi-Fi link for 5 s, then one attempt with every kind of address (Auto).
- `plan=auto` makes only the one attempt with every kind of address, as Settings > Connection's Auto will.
- `plan=each` tries over the internet direct, then the relay forced over UDP, TCP and TLS on 443. It holds each working route for `secs` seconds, then moves to the next.

## 3. Every run, on every phone

1. Open the page and pick the **Setup** from the list. Type the phone model, carrier and anything odd into the note.
2. Keep the screen on and the page in front unless a drill says otherwise.
3. Do the drills for that setup.
4. At the end, tap **Share results** and send the file to Terry (AirDrop, email or Messages). On a phone that can't share files, tap **Copy results** and paste them into an email.

The file name says the spike, the role, the setup and the time, for example `mls-spike-lan-follower-venue-isolated-2026-11-20T1930.json`.

The **status line** at the top names the route in the app's words ("Wi-Fi link", "Over the internet", "Through the relay") and says why when it falls back. The second line shows the links open, the clock spread p95 and the round trip p99.

## 4. C1: Wi-Fi links, one run per setup

Do every step below on each setup. The leader and at least one follower join the same Wi-Fi.

1. **Link through the room.** Open the leader page with `plan=fallback`, then the follower page. Wait until the status says `● … · Wi-Fi link`, or the fallback words. Leave it running 5 minutes.
2. **Lock 20 s.** On the follower, press the side button, count 20 s, and unlock. Then do the same on the leader. The page records each lock by itself.
3. **Auto.** Reload the leader with `plan=auto` and the follower with **Join again**. Wait 2 minutes.
4. **QR, two scans.** On the leader, tap **QR join (two scans)**.
   - Android follower: tap **Scan a code** and point it at the leader's code.
   - iPhone follower: open the Camera app and tap the link it finds. The follower page opens with the code.
   - The follower then shows an answer code. The leader scans it the same way. On an iPhone leader, the Camera app opens a new tab that is meant to pass the answer back to the leader's tab. Whether that works on iOS is one of the things this run finds out. Switch back to the leader tab. If nothing happens, copy the text under the code and paste it into the leader's box.
5. **QR, one scan (the experiment).** On the follower, tap **Show my link certificate**, and let the leader scan it. Then on the leader tap **One-scan QR**, and let the follower scan that one code. Write in the note whether it linked. Either answer is a result.
6. Share results from both phones.

The setups:

| Setup in the list | How to build it | Expect |
|---|---|---|
| `own-router` | The travel router with isolation off, as a band's own router | Wi-Fi link |
| `venue-open` | A venue, church or cafe Wi-Fi that lets phones see each other. If none is at hand, the travel router again with a different channel. | Wi-Fi link |
| `venue-isolated` | The travel router's guest network or isolation switch on | "This Wi-Fi keeps phones apart. Going over the internet." With `plan=auto`, linked over the internet within 5 s. |
| `sign-in-page` | The travel router's captive portal, or a hotel Wi-Fi with a sign-in page. Do not accept the sign-in page at first. | Write down what the phone showed. See the note below. |
| `udp-blocked` | A firewall rule that drops UDP except DNS (port 53) | No direct path. With TURN configured, "Through the relay" over TCP or TLS. |
| `iphone-hotspot` | The leader is an iPhone with Personal Hotspot on, and the followers join it | Wi-Fi link |
| `android-hotspot` | The leader is an Android with its hotspot on | Wi-Fi link |

Three more C1 checks:

- **Wi-Fi with no internet.** On `own-router`, link both phones with the router online. Then unplug the router's internet cable. Android asks whether to stay connected. Say yes. Leave it 5 minutes. In the results, `links[].closedMs` should stay empty, and on a phone that also has cell data, `room.lastOkMs` keeps growing. That means the phone still reaches the room over cell. Pick `wifi-no-internet` as the setup.
- **QR with no internet at all.** With the router unplugged and cell data off on both phones, try step 4. The pages must already be open, because they can't load offline. An iPhone's Camera app link can't open a new page offline. Write down whether the Android in-page scanner, or copy and paste, still linked.
- **8 links for an hour (leader CPU and battery).** Use an Android leader if you can, because iPhones don't let a page read the battery. Unplug the leader from power. Open followers with `links=` adding up to 8 (for example two phones with `&links=4`). Leave everything running 60 minutes with the screens on. On an iPhone leader, write the battery % at the start and end into the note.

**Sign-in page note.** The pages run over HTTPS, so a sign-in page can't redirect the page's own check of the relay. It usually shows up as `health[].state: "unreachable"`, not `"sign-in page"`. Record what `health` says and what the phone itself showed. That tells C17 how the app can detect it.

## 5. C2: over the internet and the relay

### TURN credentials (Terry, once per session)

The relay attempts need short-lived TURN credentials. The pages never see the TURN key. They get only the credentials, from the laptop's `/turn` stub.

1. In Terry's Cloudflare test account, open Realtime (Calls), then TURN, and create a TURN key if none exists. Note the key id and its API token. The menu names are from memory and may differ.
2. On the laptop, mint credentials that expire in 4 hours (the endpoint shape is from memory, so check Cloudflare's TURN docs if it fails):

   ```sh
   curl -s -X POST "https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers" \
     -H "Authorization: Bearer $TURN_KEY_API_TOKEN" -H "Content-Type: application/json" \
     -d '{"ttl": 14400}' > spike/cell/turn.local.json
   ```

3. Restart `node spike/lan/relay.mjs`. It should print `TURN: N relay addresses loaded`.

`spike/cell/turn.local.json` is ignored by git. Delete it after the session. Anyone who has `SITE` during those 4 hours can read the credentials from `/turn`, so don't share `SITE` beyond the testers.

### The runs

For each pair below, open the leader with `plan=each&secs=300` and then the follower. The run takes about 20 minutes (four routes, 5 minutes each). Then reload the leader with `plan=auto`, tap **Join again** on the follower, and leave it 5 minutes.

| Setup in the list | Leader | Follower |
|---|---|---|
| `verizon-att` | Verizon, Wi-Fi off | AT&T, Wi-Fi off |
| `verizon-tmobile` | Verizon, Wi-Fi off | T-Mobile, Wi-Fi off |
| `att-tmobile` | AT&T, Wi-Fi off | T-Mobile, Wi-Fi off |
| `venue-isolated-to-cell` | On the travel router with isolation on and internet connected | Any carrier, Wi-Fi off |

Do the 20 s lock drill once in each run, on the follower, while a route is held.

Relay MB per hour comes from the 5-minute holds. For a better number, run one extra relay pair with `secs=1800`.

## 6. Go or no-go bars

Each results file has a `bars` block that checks itself against the numbers below. `pass: null` means the run had nothing to measure.

| Spike | Bar | Where in the results | Source |
|---|---|---|---|
| C1 | The link connects on every setup that lets phones see each other | `links[].openMs` and `links[].path` | 11, row C1 |
| C1 | `.local` names resolve, recorded per setup | `links[].localNames.resolved` (`true` means a `.local` name got used, `null` means none were sent) | 7.4 |
| C1 | On isolated Wi-Fi, linked another way within 5 s | `bars.settleMs` on the `plan=auto` run | 7.4, 7.17 |
| C1 | Time to notice isolation | `links[].noticeMs` on the Wi-Fi attempt of the `plan=fallback` run | 7.4 |
| C1 | Clock spread p95 1 ms or less | `bars.clockSpreadP95Ms` | 11, row C1 |
| C1 | A 20 s lock survives | `bars.lockSurvived`, and `locks[]` for detail | 7.4 |
| C1 | Wi-Fi with no internet still reaches the room over cell | `room.lastOkMs` keeps growing after the cable is pulled | 7.4 |
| C1 | Leader CPU and battery per hour with 8 links | `power.battery.dropPctPerHour`, `power.loopLagP95Ms`, `power.samples` | 7.4 |
| C2 | Direct or relay, per carrier pair | `links[].selected.path` and `links[].selected.local.relayProtocol` | 11, row C2 |
| C2 | Clock spread p95 6 ms or less | `bars.clockSpreadP95Ms` | 11, row C2 |
| C2 | Relay MB per hour, against the budget of about 2.7 MB per relayed follower per 3-hour gig | `links[].bytes.mbPerHour` on the relay routes, both phones | 7.16 |
| C2 | The relay over TLS on 443 links on every carrier | `links[]` with `route: "relay-tls443"` | 7.2 |

What a no-go means (PLAN.md section 11, Gates):

- C1 no-go makes Auto skip the Wi-Fi link, and the plan is revisited.
- C2 no-go for direct paths still allows the relay. If the relay is also no-go, Over the internet uses direct paths only.

## 7. The four TURN account facts (Terry)

Answer these on the test account and send them with the results. C7b's spend guard depends on them.

| # | Question | Where to look (from memory) | Write down |
|---|---|---|---|
| 1 | Does TURN need a card on file? | Billing, then Payment methods, while creating a TURN key on an account with no card | Yes or no, and the exact message if blocked |
| 2 | Is there any top-up or auto-pay setting? | Billing and the Realtime (Calls) pages | Every spend-related switch you see and its setting. Leave paid usage off. |
| 3 | Can this month's relay use be read from the analytics API, and how late is it? | The GraphQL analytics API for Realtime TURN usage | Whether the number appears, and the delay between a relay run ending and its bytes showing up. Run one relayed session, note the time, and check every 10 minutes. |
| 4 | Can a credential be revoked before it expires? | The TURN key's API (a revoke call), or deleting the key | Whether a revoked credential stops a live relayed link, and how fast. Test it on a `plan=each` run while `relay-tcp` is held. |

Also set up the usage-based billing notification (Notifications, then usage-based billing, lowest threshold) and note that it exists (7.16, step 5).

## 8. What the local check covers, and what it doesn't

`npm run check:spike-links` runs on one machine with no phones.

- It covers the clock filter math, the `/turn` stub, the route filters, the page's room and QR introductions, the lock record, the fallback timing and a well-formed results file. The TURN credential never appears in the file.
- On the build machine, Chrome policy blocks every direct WebRTC path (`WebRtcIPHandling` is `disable_non_proxied_udp`). So the check links its two tabs through a small TURN relay over TCP on the laptop (`spike/cell/local-turn.mjs`). That relay checks permissions the way a real one does. The one-scan QR doesn't link through it. The most likely reason is that the leader's relay never learns the follower's address, so it has no permission for it and drops the follower's checks. The check prints how many packets the relay dropped that way.
- It does not cover the Wi-Fi link between two phones, `.local` names, carriers, Cloudflare's relay, Safari, or battery. Only the phone runs above do.

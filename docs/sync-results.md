# Sync results (C20)

This is where the filmed sync proof on real phones is written down (PLAN.md 7.17, cook C20p). Nothing here is
measured yet. The harness that fills it in is built and proven on fixtures: the Sync check screen, `sync_log`,
`scripts/sync-report.ts` and `scripts/sync-video.ts` (`npm run check:sync-check`). B6 waits on these rows or on
Terry's written OK.

There are no relay setups and no relay target. No TURN or paid relay is used while the app is in test (Terry t28u).
The routes are the Wi-Fi link, over the internet direct (free public STUN only), and the server.

## What a run needs

- At least 2 iPhones (one 60 Hz, one 120 Hz if there is one) and at least 2 Androids, covering Verizon, AT&T and
  T-Mobile, with at least one phone on each carrier.
- A travel router whose guest network or isolation switch can be turned on and off. It stands in for venue Wi-Fi
  and is test gear for this proof only.
- A 240 fps camera with every phone in frame, and one microphone the same distance from every phone.
- Someone to film. That is Terry or CoS.

## How to run one setup

1. On every phone, open Settings, then Sync check. Pick the carrier. Put the phones side by side.
2. At soundcheck, use Line up with the band on each phone once: tap "My click is late" or "My click is early"
   until its click sits on the others by ear. The speaker delay is saved on that phone.
3. The admin taps Start a 60 s run. Every phone flashes white and clicks on each beat, and logs each beat.
4. Mid-run, with the click going, do the drills: turn the Wi-Fi off to switch the route, hand off the lead,
   switch the leader's phone off, flight mode for 20 s, and lock for 20 s.
5. Save the run's rows (`POST /api/bands/sync/rows` answers `{ rows }`) and run
   `node --experimental-strip-types scripts/sync-report.ts rows.json`.
6. Turn the film into a frame list (`frame,<user id>,...`, one brightness per phone per frame) and run
   `node --experimental-strip-types scripts/sync-video.ts --frames frames.csv --log rows.json --run <run id> --fps 240`.
   If the film and the log disagree by more than 5 ms, the film wins: correct the delay tables and run again.
7. Do every setup once with Auto and once with the route forced, and each of those once at full brightness and once dimmed.

## Pass bar (PLAN.md 7.15 and 7.17)

| Route of the two phones | Screens p95 / max | Clicks p95 / max |
|---|---|---|
| Both on the Wi-Fi link, or the leader and a Wi-Fi link phone | 17 / 30 ms | 5 / 10 ms |
| Both over the internet, direct | 18 / 32 ms | 8 / 18 ms |
| Both on the server | 20 / 35 ms | 10 / 20 ms |
| Mixed run, any pair | The looser target of the two phones' routes. The worst pair is held to 20 / 35. | The looser of the two. Worst pair 10 / 20. |

- Logged spread is 5 ms or less at p95 on every phone. Late changes are 1% or fewer.
- Route switches and handoffs show no step on film beyond the route's max, no backward jump and no double flip.
- The phone logs agree with the film within 5 ms.
- In venue-style Wi-Fi that keeps phones apart, Auto moves to over the internet within 5 s and the screen says why.

## Runs

The forced route is the one the setup is about. Mixed runs set each phone's route by hand.

| Setup | Route | Brightness | Screens p95 / max | Clicks p95 / max | Spread p95 | Late changes | Film vs log | Result |
|---|---|---|---|---|---|---|---|---|
| Wi-Fi link, band's own router | Auto | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Wi-Fi link, band's own router | Auto | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Wi-Fi link, band's own router | Wi-Fi link | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Wi-Fi link, band's own router | Wi-Fi link | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Wi-Fi link, venue-style Wi-Fi that lets phones see each other | Auto | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Wi-Fi link, venue-style Wi-Fi that lets phones see each other | Auto | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Wi-Fi link, venue-style Wi-Fi that lets phones see each other | Wi-Fi link | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Wi-Fi link, venue-style Wi-Fi that lets phones see each other | Wi-Fi link | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Venue-style Wi-Fi that keeps phones apart | Auto | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Venue-style Wi-Fi that keeps phones apart | Auto | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Venue-style Wi-Fi that keeps phones apart | Over the internet | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Venue-style Wi-Fi that keeps phones apart | Over the internet | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Venue-style Wi-Fi with a sign-in page | Auto | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Venue-style Wi-Fi with a sign-in page | Auto | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Venue-style Wi-Fi with a sign-in page | Over the internet | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Venue-style Wi-Fi with a sign-in page | Over the internet | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Venue-style Wi-Fi with UDP blocked | Auto | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Venue-style Wi-Fi with UDP blocked | Auto | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Venue-style Wi-Fi with UDP blocked | Through the server | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Venue-style Wi-Fi with UDP blocked | Through the server | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Wi-Fi link, leader's iPhone hotspot | Auto | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Wi-Fi link, leader's iPhone hotspot | Auto | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Wi-Fi link, leader's iPhone hotspot | Wi-Fi link | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Wi-Fi link, leader's iPhone hotspot | Wi-Fi link | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Wi-Fi link, Android hotspot | Auto | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Wi-Fi link, Android hotspot | Auto | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Wi-Fi link, Android hotspot | Wi-Fi link | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Wi-Fi link, Android hotspot | Wi-Fi link | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Over the internet, cell, Verizon | Auto | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Over the internet, cell, Verizon | Auto | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Over the internet, cell, Verizon | Over the internet | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Over the internet, cell, Verizon | Over the internet | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Over the internet, cell, AT&T | Auto | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Over the internet, cell, AT&T | Auto | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Over the internet, cell, AT&T | Over the internet | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Over the internet, cell, AT&T | Over the internet | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Over the internet, cell, T-Mobile | Auto | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Over the internet, cell, T-Mobile | Auto | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Over the internet, cell, T-Mobile | Over the internet | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Over the internet, cell, T-Mobile | Over the internet | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Server | Auto | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Server | Auto | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Server | Through the server | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Server | Through the server | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Mixed run: 2 Wi-Fi link, 1 over the internet on cell, 1 server | Mixed | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Mixed run: 2 Wi-Fi link, 1 over the internet on cell, 1 server | Mixed | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Real venue Wi-Fi, if one is at hand | Mixed | Full | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |
| Real venue Wi-Fi, if one is at hand | Mixed | Dim | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured | not yet measured |

## Screen delay per phone model

Each phone model's screen delay comes from the film (PLAN.md 7.8). Line up with the band covers the speaker delay.

| Phone model | Refresh rate | Screen delay | Measured in |
|---|---|---|---|
| not yet measured | not yet measured | not yet measured | not yet measured |

## Phones and carriers used

| Phone | Model | OS | Carrier |
|---|---|---|---|
| not yet measured | not yet measured | not yet measured | not yet measured |

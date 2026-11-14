# Gig field drills (C24)

This printable field-drill sheet is for testing the My Lead Sheet app at rehearsal with real phones. Work through every drill, observe what happens on every screen, measure timings where required, and record the results.

## Before you start

- [ ] Gather phones: Have at least 3 phones ready (leader, backup leader, and follower/admin).
- [ ] Assign roles: Name one gig leader, one named backup leader, and one admin.
- [ ] Identify routes to try: Test across venue Wi-Fi, phone hotspot, and internet relay.
- [ ] Charge all phones fully before the session.
- [ ] Bring a pen for marking results.
- [ ] Assign one person to call the steps and write down results.

---

## 1. The leader double-taps Next

- **Setup:** Connect all phones to the gig. Start a song with chart and click running.
- **Steps:**
  1. On the leader phone, tap the Next button twice quickly (a rapid double-tap).
- **What every phone should show:** Every phone advances exactly one chart change. The app shows one change with a single `at` timestamp. No phone skips ahead two songs or pages.
- **Pass bar:** Exactly one change applied across all phones. Screen update timing meets the route target (Wi-Fi link 17/30 ms, internet direct or relay 18/32 ms, server 20/35 ms).
- **What to write down:** Did any phone double-advance? Measured screen update time. Pass or Fail.

---

## 2. The same change arrives on the Wi-Fi link and through the room

- **Setup:** Connect phones so both the local Wi-Fi link and the room route are active.
- **Steps:**
  1. Trigger a chart change from the leader phone so the message travels over both the Wi-Fi link and through the room simultaneously.
- **What every phone should show:** Follower phones receive the change from both paths but apply it only once. Charts advance smoothly with no flicker, double-flip, or jump.
- **Pass bar:** The change is applied exactly once on all phones.
- **What to write down:** Was the change duplicated on any device? Pass or Fail.

---

## 3. The Wi-Fi is switched off mid-song

- **Setup:** Phones are actively playing a song with click and scroll running over local venue Wi-Fi.
- **Steps:**
  1. In the middle of the song, turn off the venue Wi-Fi router or toggle Wi-Fi off on the phones.
- **What every phone should show:** Phones automatically fail over to cellular data or internet relay to reach the server. The shared song clock carries across without stopping. The audio click continues uninterrupted and never jumps mid-bar.
- **Pass bar:** Phones switch route over the internet or to the server. Clock carries across. Click never jumps mid-bar and step stays under route click max (Wi-Fi 10 ms, direct/relay 18 ms, server 20 ms).
- **What to write down:** Failover route taken. Did the click glitch or jump mid-bar? Pass or Fail.

---

## 4. The venue Wi-Fi keeps phones apart

- **Setup:** Connect phones to a guest Wi-Fi network configured with client isolation (phones cannot talk directly to each other).
- **Steps:**
  1. Attempt to start a gig session and link follower phones over the isolated Wi-Fi network.
- **What every phone should show:** Within 5 seconds, the app displays: "This Wi-Fi keeps phones apart. Going over the internet." Follower phones then establish a link over the venue's internet connection or cellular data.
- **Pass bar:** Message appears within 5 seconds. Connection successfully completes over the internet or cell.
- **What to write down:** Time until notification appeared (target: under 5 s). Fallback connection route. Pass or Fail.

---

## 5. The venue Wi-Fi has a sign-in page

- **Setup:** Connect a follower phone to a venue Wi-Fi network that requires a captive portal sign-in before allowing internet traffic.
- **Steps:**
  1. Open the app and attempt to join the gig before completing the captive portal sign-in.
- **What every phone should show:** The phone displays the message: "This Wi-Fi wants you to sign in first". The app continues trying to establish the local Wi-Fi link directly.
- **Pass bar:** The captive portal warning displays as specified, and the direct Wi-Fi link attempt continues.
- **What to write down:** Warning text displayed. Status of local link attempt. Pass or Fail.

---

## 6. The relay cap is reached

- **Setup:** Simulate or trigger reaching the monthly bandwidth/connection cap on the relay service.
- **Steps:**
  1. Have phones attempt to connect or mint relay credentials once the monthly relay cap is exhausted.
- **What every phone should show:** Credential minting immediately stops. Phones automatically fall back to the server. The app displays: "Relay is full this month". No new relay credentials are minted until the 1st of next month.
- **Pass bar:** Minting stops, warning displays, and all phones migrate cleanly to the server route without minting until the 1st.
- **What to write down:** Notification shown. Route used by phones. Pass or Fail.

---

## 7. A follower's change arrives 200 ms late

- **Setup:** Introduce a 200 ms transmission delay on a change message sent from a follower phone to the band.
- **Steps:**
  1. Send a change from the follower that arrives 200 ms late while click and chart scroll are active.
- **What every phone should show:** The change renders on the very next screen frame once received. The click audio and chart scroll remain perfectly locked to the timing grid without stuttering.
- **Pass bar:** Change shows on the next frame. Click and scroll stay on grid. Band late changes stay at 1% or fewer.
- **What to write down:** Visual frame update behavior. Any audible click disruption. Pass or Fail.

---

## 8. Handoff mid-song with the click running

- **Setup:** Play a song with click active. Leader and backup phones are in sync.
- **Steps:**
  1. While the song is playing and the click is ticking, initiate a leadership handoff to the backup leader.
- **What every phone should show:** The new leader adopts band time seamlessly. The click continues running without audible stutter or tempo shift.
- **Pass bar:** New leader adopts band time. Step on film stays under the route's click max (Wi-Fi link 10 ms, direct/relay 18 ms, server 20 ms). Remaining clock skew absorbs cleanly within 2 ppm drift budget.
- **What to write down:** Click step deviation across handoff. Continuity of beat. Pass or Fail.

---

## 9. The leader's phone is switched off mid-song

- **Setup:** Band is playing mid-song with click running.
- **Steps:**
  1. Abruptly power off the leader's phone (or force quit the app).
  2. Observe follower phones and the backup leader phone over the next 35 seconds.
- **What every phone should show:** At 10 seconds, follower screens show "Isn't answering". At 30 seconds, follower screens show "dropped". The beat continues playing without stopping. The backup takes over the lead with no timing jump.
- **Pass bar:** "Isn't answering" banner at exactly 10 s. "Dropped" banner at exactly 30 s. Beat continues uninterrupted. Backup leader assumes control with zero timing jump.
- **What to write down:** Timestamps for 10 s and 30 s banners. Beat continuity. Pass or Fail.

---

## 10. Two people take the lead offline at once

- **Setup:** Take both the admin phone and the backup leader phone offline (disconnect network).
- **Steps:**
  1. On both the admin phone and the backup leader phone, tap to take the lead while offline.
  2. Reconnect both phones to the network.
- **What every phone should show:** When the two phones hear each other, the conflict resolves immediately: the admin wins leadership, and the backup leader steps down automatically.
- **Pass bar:** Admin retains leadership. Backup leader steps down as soon as it hears the admin.
- **What to write down:** Resulting leader. Did backup yield cleanly? Pass or Fail.

---

## 11. The old leader comes back after a take-over

- **Setup:** A leadership take-over has completed while the old leader was disconnected. The band is operating under a higher epoch counter.
- **Steps:**
  1. Reconnect the old leader's phone to the gig.
  2. Attempt to tap page turns or song changes on the old leader phone.
- **What every phone should show:** The old leader detects the higher epoch number and immediately steps down to follower status. Any tap inputs on the old leader phone are rejected.
- **Pass bar:** Old leader steps down upon seeing the higher epoch. Taps on the old leader phone are refused.
- **What to write down:** Did the old leader step down? Were old leader taps refused? Pass or Fail.

---

## 12. A phone locks for 20 s mid-song

- **Setup:** Band is actively playing a song with continuous chart scrolling and click.
- **Steps:**
  1. Lock one follower phone screen for 20 seconds while the song continues playing on other phones.
  2. Unlock the phone.
- **What every phone should show:** The unlocked phone briefly displays "Syncing", then jumps directly into sync on the next musical bar. The chart does not flip backwards or perform a double flip.
- **Pass bar:** Phone shows "Syncing" and rejoins on the next bar. No backward page jump. No double flip.
- **What to write down:** Rejoin behavior and timing. Absence of backward/double flip. Pass or Fail.

---

## 13. Spread above 8 ms for 10 s (simulated)

- **Setup:** Introduce clock jitter or simulation condition causing sync spread between phones to exceed 8 ms continuously for 10 seconds.
- **Steps:**
  1. Maintain clock spread above 8 ms for 10 seconds during an active session.
- **What every phone should show:** Phones display the warning banner: "Out of sync · fixing". The audio click and visual sync dot immediately go quiet to prevent misleading the players.
- **Pass bar:** "Out of sync · fixing" banner appears. Click audio and flashing dot mute until sync recovers.
- **What to write down:** Did warning display? Did click and dot silence? Pass or Fail.

---

## 14. No internet, links made at soundcheck

- **Setup:** Soundcheck venue with no internet access (or router WAN disconnected). Direct Wi-Fi links established between phones at soundcheck.
- **Steps:**
  1. Run songs, turns, and tempo changes purely over the local Wi-Fi link with no external internet connection.
- **What every phone should show:** Full mirroring continues to operate normally across all phones over the local Wi-Fi link.
- **Pass bar:** Mirroring works reliably offline. Latency meets Wi-Fi link targets: screen updates within 17/30 ms, click sync within 5/10 ms.
- **What to write down:** Screen and click response times over local Wi-Fi link. Pass or Fail.

---

## 15. Someone not on the lineup tries to link or open the socket

- **Setup:** An unauthorized device running the app attempts to join the active gig session.
- **Steps:**
  1. From an unauthorized phone not included in the gig lineup, attempt to link to the room or open the connection socket.
- **What every phone should show:** The unauthorized device is immediately refused by the room server or blocked by the gig-secret cryptographic challenge. Band phones show no disruption.
- **Pass bar:** Connection attempt is rejected. Unauthorized device cannot access the charts or click stream.
- **What to write down:** Rejection confirmation on unauthorized device. Pass or Fail.

---

## 16. The leader stops the song

- **Setup:** Song is playing across all phones with click, animated dot, and chart scrolling active.
- **Steps:**
  1. On the leader phone, tap the Stop button.
- **What every phone should show:** On every connected phone, the audio click, the flashing dot, and chart scrolling stop cleanly on the very next musical beat.
- **Pass bar:** Click, dot, and scroll stop simultaneously on the next beat across all phones.
- **What to write down:** Did any phone keep playing past the next beat? Pass or Fail.

---

## 17. The band talks for 5 minutes between songs

- **Setup:** A song finishes and stops. All phones remain open on the gig screen.
- **Steps:**
  1. Leave all phones sitting untouched for 5 minutes between songs while the band talks.
- **What every phone should show:** Every phone remains completely still. No unprompted screen scrolls, no ghost page turns, and no spontaneous audio clicks.
- **Pass bar:** Zero movement or state changes on any phone for the entire 5-minute interval.
- **What to write down:** Any drift, battery sleep issue, or screen movement noted. Pass or Fail.

---

## 18. A player drags their chart to look ahead, then lets go

- **Setup:** Active song displayed on all phones.
- **Steps:**
  1. On a follower phone, drag the screen to scroll ahead to a later section of the chart.
  2. Release your finger from the screen.
- **What every phone should show:** While dragging, the local screen displays "Looking ahead". No update is transmitted to the rest of the band. When released, the chart smoothly glides back to the band's current position within 400 ms.
- **Pass bar:** "Looking ahead" banner displays locally. Band remains undisturbed. Chart returns to band position within 400 ms.
- **What to write down:** Local banner appearance. Band isolation. Return glide time (target: 400 ms). Pass or Fail.

---

## 19. A member who isn't the backup tries to take the lead

- **Setup:** Gig session active with one designated leader, one named backup, and regular followers.
- **Steps:**
  1. On a regular follower phone (not designated as backup or admin), look at the navigation and control interface.
- **What every phone should show:** There is no take-over button present on the interface. Only the named backup leader and the admin have access to the take-over control.
- **Pass bar:** Take-over button is absent on non-backup member phones.
- **What to write down:** Confirm button absence on follower device. Pass or Fail.

---

## 20. The leader changes the backup mid-gig

- **Setup:** Gig session running with Player A as the named backup leader and Player B as a regular follower.
- **Steps:**
  1. On the leader phone, change the designated backup leader from Player A to Player B.
- **What every phone should show:** Player B's screen immediately displays the take-over button. Player A's screen immediately loses the take-over button.
- **Pass bar:** Role switch updates instantly: new backup gains the take-over button; previous backup loses it.
- **What to write down:** Time for button to appear on new backup and vanish from old backup. Pass or Fail.

---

## 21. The band's scroll setting is off

- **Setup:** In the gig configuration, toggle the shared scroll setting to OFF.
- **Steps:**
  1. Start a song with click and navigate through the chart on the leader phone.
- **What every phone should show:** Follower charts do not follow the leader's continuous scrolling. However, audio clicks and explicit page turns continue mirroring across all phones.
- **Pass bar:** Charts remain stationary during scrolling. Page turns and clicks mirror synchronously.
- **What to write down:** Confirm scroll isolation while click and page turns stay linked. Pass or Fail.

---

## 22. A guest pass runs out mid-week

- **Setup:** A temporary guest pass that expired mid-week is stored on a device.
- **Steps:**
  1. Launch the app on the guest phone, both when connected to the network and when offline.
- **What every phone should show:** The room connection rejects the expired pass. All gig charts are hidden and deleted from the device upon opening the app, even when offline.
- **Pass bar:** Room refuses connection. Charts are completely hidden and wiped from local storage offline.
- **What to write down:** Chart deletion confirmation on guest device. Pass or Fail.

---

## 23. A forwarded guest link is opened on a second phone

- **Setup:** Generate an authorized guest link for one phone.
- **Steps:**
  1. Open and activate the guest link on Phone 1.
  2. Forward the exact same link to Phone 2 and open it.
- **What every phone should show:** Phone 2 is refused access. The guest pass remains bound strictly to the first phone that opened it.
- **Pass bar:** Access is denied on Phone 2.
- **What to write down:** Error message and refusal on second phone. Pass or Fail.

---

## 24. The daily free limit is used up

- **Setup:** Exhaust the account's daily free room quota.
- **Steps:**
  1. Attempt to make room calls and initiate connections across various routes once the daily limit is spent.
- **What every phone should show:** Room calls fail. Direct Wi-Fi links continue to function normally. Phones configured for server routes drop gracefully to on-your-own mode. No unexpected charges or bills are generated.
- **Pass bar:** Room calls fail cleanly, direct links remain operational, server phones fall back to on-your-own, and no billing charge occurs.
- **What to write down:** Direct link status, server fallback behavior, confirmation of no bill. Pass or Fail.

---

## Sync check rerun

At a real gig, rerun the C20 Sync check once on whatever Wi-Fi network is available at the venue. Measure clock spread, screen lag, and click delay, and compare them against the 7.15 timing targets below.

### 7.15 Timing targets reference table

All figures represent p95 timing between any two phones, with maximum allowed spikes after the slash:

| Route of the two phones | Modeled clock / screen / click (p95) | Target screens (p95 / max) | Target clicks (p95 / max) |
|---|---|---|---|
| Both on Wi-Fi link, or leader and Wi-Fi link phone | 0.8 / 14.0 / 4.3 ms | 17 / 30 ms | 5 / 10 ms |
| Both over internet, direct | 6.0 / 15.4 / 7.4 ms | 18 / 32 ms | 8 / 18 ms |
| Both through relay | 6.1 / 15.4 / 7.4 ms | 18 / 32 ms | 8 / 18 ms |
| Both on server | 7.8 / 16.0 / 9.0 ms | 20 / 35 ms | 10 / 20 ms |
| Mixed gig, any pair | Up to 6.9 / 15.8 / 8.1 ms (relay + server) | Looser target of the two routes. Worst pair held to 20 / 35 ms. | Looser target of the two routes. Worst pair held to 10 / 20 ms. |

### Additional sync pass criteria:
- **Logged spread:** 5 ms or less at p95 across every route.
- **Late changes:** 1% or fewer of all transmitted changes.
- **Drift budget:** Remaining clock skew after estimation stays at 2 ppm or less. Across any handoff, timing steps stay below the route's click maximum.
- **Bluetooth earbuds:** Bluetooth latency falls outside these timing bars; the existing dot nudge setting handles earbud compensation.

---

## Results table

| Drill | Route | Phones | Pass/Fail | Measured time | Notes | Fix cook opened? |
|---|---|---|---|---|---|---|
| 1. Double-tap Next | | | | | | |
| 2. Duplicate change arriving on Wi-Fi & room | | | | | | |
| 3. Wi-Fi switched off mid-song | | | | | | |
| 4. Wi-Fi keeps phones apart | | | | | | |
| 5. Wi-Fi captive sign-in page | | | | | | |
| 6. Relay cap reached | | | | | | |
| 7. Late change (200 ms) | | | | | | |
| 8. Handoff mid-song with click | | | | | | |
| 9. Leader phone switched off mid-song | | | | | | |
| 10. Two leaders offline at once | | | | | | |
| 11. Old leader returns after take-over | | | | | | |
| 12. Phone locked 20 s mid-song | | | | | | |
| 13. Spread above 8 ms for 10 s | | | | | | |
| 14. No internet soundcheck links | | | | | | |
| 15. Unauthorized join attempt | | | | | | |
| 16. Leader stops song | | | | | | |
| 17. 5-minute pause between songs | | | | | | |
| 18. Look ahead drag and release | | | | | | |
| 19. Non-backup tries take-over | | | | | | |
| 20. Change backup mid-gig | | | | | | |
| 21. Band scroll setting off | | | | | | |
| 22. Guest pass expired mid-week | | | | | | |
| 23. Forwarded guest link reuse | | | | | | |
| 24. Daily free limit exhausted | | | | | | |
| Sync check rerun (real gig Wi-Fi) | | | | | | |

Any fail opens a fix cook.

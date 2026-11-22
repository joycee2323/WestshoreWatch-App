# Play Console review kit: Android Auto

Ready-to-paste text for the Android Auto submission of Westshore Watch. Edit anything in
`[brackets]` before pasting. Background and the full checklist are in
`android-auto.md` → "Google Play Console checklist".

---

## (a) Android Auto review notes

Paste into the review notes / "Instructions for reviewers" field for the Android Auto form
factor (Play Console → Test and release → Advanced settings → Form factors → Android Auto,
or the release notes for reviewers when you submit the release that adds Android Auto):

> Westshore Watch is a drone-awareness app used by public-safety agencies, venue security
> and airspace operators. Our sensors receive FAA Remote ID broadcasts from nearby drones and
> show where each drone and its operator (pilot) is.
>
> The Android Auto experience is a **point-of-interest (POI)** app. The points of interest are
> live, safety-relevant locations: the current position of each detected drone and the
> position of its operator. Responders and security staff use it while driving to reach the
> operator (or the area under the drone). The main screen is a host-drawn map with a list of
> nearby drones, nearest first, with distance and direction. Selecting one opens a detail
> pane with **Navigate to drone** and **Navigate to operator**, which hand the location to the
> car's navigation app. The app shows no video, no free text entry and no scrolling text, and
> posts no notifications on the car screen. While driving it shows only names, distance,
> direction, altitude and speed.
>
> **What you will most likely see:** the list is driven by real drone broadcasts near our
> customers' sensors. Unless a drone is flying near one of the test account's sensors while
> you review, the main screen shows the empty state: "No drones detected · Live feed
> connected". This is expected and is not a failure. **We attached a screen recording**
> captured on the Android Auto Desktop Head Unit with simulated drones. It shows the list with
> live drones, a drone landing and being removed, the detail pane, and the navigate actions.
>
> Sign-in: the car app uses the phone app's account. Please sign in on the phone first with
> the test account in App access, then open Westshore Watch in Android Auto.
>
> [Recording: link or attachment name, e.g. `westshore-watch-android-auto-review.mp4`]

Short version, for fields with a small character limit:

> POI app: live Remote ID drone and operator positions (safety-relevant locations) with
> navigation to them. Sign in on the phone first (App access). With no drones near the test
> account's sensors you'll see the empty state "No drones detected", which is expected. A DHU
> recording with simulated drones is attached.

---

## (b) App access: addition to the existing instructions

Add to *Policy → App content → App access* (keep the existing reviewer credentials):

> **Android Auto:** the car app uses the phone app's sign-in. Before opening Westshore Watch
> in Android Auto, open the Westshore Watch phone app, sign in with the credentials above,
> and allow location when asked (used to show distance and direction to each drone). Then
> connect to Android Auto (car or Desktop Head Unit) and open Westshore Watch from the
> launcher. If the car screen says "Sign in on your phone", sign in on the phone and tap
> "Try again".

---

## (c) Screen recording script (DHU, debug build)

Goal: one video of about 2–3 minutes that shows real functionality (the reviewer will see
only the empty state otherwise). Setup and commands are in `android-auto.md` ("Running on
the Desktop Head Unit" and "Testing without real drones").

Before recording:
1. Debug build installed, phone signed in, location granted, DHU running and showing the
   Android Auto home screen. Use the default DHU window (no OEM skin).
2. Start a screen recorder on the PC capturing only the DHU window (e.g. Xbox Game Bar
   `Win+Alt+R` with the DHU focused, or OBS window capture). Keep a terminal open next to it,
   but off-camera.
3. `adb shell am broadcast -a com.westshoredrone.watch.auto.DEBUG_SIM --es scenario stop -p com.westshoredrone.watch`
   (start clean).

Record:

| Time | Do | Shows |
|---|---|---|
| 0:00 | Open the launcher, tap **Westshore Watch**. Wait on the list. | App in launcher; empty state "No drones detected · Live feed connected" (what reviewers will see). |
| 0:10 | Send `--es scenario many`. Wait ~10 s. | New-drone toast (batched, at most one per 10 s), list fills (capped at the host limit), red pins on the map, nearest first, distances updating. |
| 0:35 | Tap the top drone. | Detail pane: position, altitude/speed/heading, operator, Remote ID. |
| 0:45 | Tap **Navigate to operator**. Let the navigation app open for ~5 s, then go back to Westshore Watch. | Navigation handoff (core POI function). |
| 1:00 | Tap the header **refresh** button. | Refresh applies the current list. |
| 1:05 | Send `--es scenario stop`, then right away `--es scenario landing`. Wait ~55 s. | Old drones age out; `SIM-LAND-1` appears, descends (ft high counts down) and **disappears ~5 s after touchdown**. |
| 2:05 | Send `--es scenario one`. Tap `SIM-ONE-1`, wait 10 s, tap **Navigate to drone**, then come back. | Single drone + operator, live updates, navigate to drone. |
| 2:30 | Send `--es scenario stop`. Stop recording after the list empties (~15 s). | Clean finish. |

Keep it under 3 minutes. Don't show the terminal or the phone screen. Also take DHU
screenshots (`screenshot <file.png>` in the DHU console) of: the list with drones, the
detail pane, and the empty state. Save them in `docs/android-auto-screens/`.

Separately, NOT for the reviewer: run `--es scenario churn` for the full 15 minutes as the
quota soak test (checklist in `android-auto.md`).

---

## (d) Data safety re-check

The Android Auto feature adds **no new data collection or sharing** as far as the code
shows. Re-confirm each line against the current Data safety form before submitting:

- [ ] **Location.** The car app reads the phone's location (same `ACCESS_FINE/COARSE_LOCATION`
      permissions the app already has; no new permission, no `ACCESS_BACKGROUND_LOCATION`). It
      is used **on the device only**, for distance/direction and the "you are here" map dot.
      The car code never sends it anywhere (its network calls are `GET /api/detections/recent`
      and a WebSocket that sends only `SUBSCRIBE_ORG`/`PING`). The form already declares
      location for the phone app's existing features, so no change is expected; confirm the
      declared purposes still cover "App functionality".
- [ ] **Account/auth.** The car app reuses the existing sign-in token (read on the device). No
      new account data.
- [ ] **Drone data (Remote ID positions, operator positions, UAS IDs).** Already handled by
      the phone app. The car app only displays it. No change.
- [ ] **Data shared with third parties.** "Navigate to drone/operator" passes a `geo:` location
      to the navigation app the user picks (e.g. Google Maps) via an Android intent, only when
      the user taps. Play treats user-initiated transfers like this as not "sharing"; confirm
      your form's answer still holds.
- [ ] **New permissions in the release manifest:** only
      `androidx.car.app.MAP_TEMPLATES` (a normal Car App Library permission, not a runtime or
      dangerous one). Nothing for the Data safety form.
- [ ] **Encryption in transit / deletion requests:** unchanged (same HTTPS/WSS backend, same
      account deletion flow).
- [ ] The privacy policy needs no change for the car feature. Optionally add one sentence:
      "On Android Auto, the app shows the same drone information on your car's display."

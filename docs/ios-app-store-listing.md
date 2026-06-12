# Westshore Watch — iOS App Store Listing Draft

Phase 0, step 10 of the iOS port. This document is the complete first-draft
copy for the App Store Connect listing. Paste into App Store Connect when
creating the iOS app record. Update before submission if anything has
changed since this was written.

---

## App Name (30 chars max)

```
Westshore Watch
```

15 chars. Matches Play Store listing and marketing site.

---

## Subtitle (30 chars max)

```
Remote ID drone detection
```

25 chars. "Remote ID" is a specific technical term that filters for the
right audience (drone operators, public safety, security professionals)
while remaining parseable to first-time visitors.

---

## Promotional Text (170 chars max)

```
Real-time Remote ID drone detection. Pair Westshore Watch nodes to monitor airspace from your iPhone or iPad — wherever drones fly nearby matters to you.
```

149 chars. Soft, inclusive hook. This field can be updated without
resubmitting the app, so use it for time-sensitive messaging when needed
(launches, sales, new product announcements).

---

## Description (4000 chars max)

```
Westshore Watch is a Remote ID drone detection platform. Hardware nodes detect drones broadcasting Remote ID and stream their flight paths to your dashboard and devices in real time.

Westshore Watch for iPhone and iPad pairs detection nodes over Bluetooth, relays Remote ID broadcasts to the cloud, and lets you monitor detections, manage deployments, and receive alerts wherever you are.

WHAT YOU CAN DO

• Pair detection nodes via Bluetooth
• Stream detections to your team in real time
• View live drone detections on an interactive map
• Track flight paths, operator locations, drone models, and altitudes
• Get push notifications when drones enter your facility boundaries
• Manage active deployments and assigned nodes
• View statistics, repeat-offender history, and proximity events
• Receive alerts when nodes go offline or deployments end

WHO USES WESTSHORE WATCH

Westshore Watch is used by anyone who needs to know what's flying nearby — public safety agencies, security teams, event organizers, commercial drone operators, real estate and inspection pilots, property owners, and critical infrastructure operators. If you fly drones professionally, monitor airspace, or operate property where drones might appear, Westshore Watch shows you what's there.

HARDWARE

Westshore Watch nodes connect to the Westshore Watch cloud and stream Remote ID detections to your account.

• Sentinel — stationary node, plugs in and runs standalone (no phone needed)
• X1 — portable node for mobile deployments
• M1 — compact portable node

Visit westshoredrone.com to learn more or purchase hardware.

REQUIREMENTS

A Westshore Watch account is required to use this app. Sign up at watch.westshoredrone.com. Portable nodes (X1, M1) pair with this app over Bluetooth to relay detections; Sentinel nodes operate independently. iOS and Android devices work interchangeably on the same account.

ABOUT REMOTE ID

The FAA Remote ID rule requires most drones to broadcast their identification, location, and operator location while in flight. Westshore Watch receives these broadcasts to provide real-time situational awareness for anyone who needs to know what's flying nearby.
```

Roughly 1,800 characters. Plenty of headroom under the 4,000 limit.

---

## Keywords (100 chars max, comma-separated, no spaces)

```
remoteid,drone,detection,FAA,UAS,airspace,security,publicsafety,patrol,event,dispatch,sentinel,X1,M1
```

98 chars. Includes hardware product names so existing customers can find
the app by searching for what they bought. "RemoteID" is concatenated to
save a character (Apple's parser is strict about no-space-after-comma).

---

## Categories

- **Primary:** Utilities
- **Secondary:** Business

Utilities is the safest primary for a monitoring/dashboard app. Business
captures the B2B nature.

---

## Age Rating

Target: **4+**

Questionnaire answers:
- Violence, sexual content, profanity, drugs, alcohol, gambling: None
- Unrestricted web access: **Yes** (AdminWebScreen opens watch.westshoredrone.com via WebView)
- User-generated content: **No** (no public sharing, no comments, no social features)
- Location services: **Yes** (Mapbox uses location to center map)
- Tracking: **No**

---

## URLs

- **Support URL:** `https://watch.westshoredrone.com/support`
- **Marketing URL:** `https://westshoredrone.com`
- **Privacy Policy URL:** `https://watch.westshoredrone.com/privacy`

Verify the `/support` URL exists before submission. If it doesn't yet,
either create a support page or point at `https://westshoredrone.com`
temporarily.

---

## App Privacy ("Nutrition Label")

This section in App Store Connect is filled out via a questionnaire form.
The answers for Westshore Watch:

### Data collected and linked to user identity

- **Contact Info:**
  - Email address (for account)
  - Name (for account)
- **Identifiers:**
  - User ID (internal user ID)
  - Device ID (push notification token)
- **Location:**
  - Coarse location (used to center the map; not stored on the server)
- **Diagnostics:**
  - Crash data (if any crash reporting SDK is integrated — otherwise mark as "Not Collected")
  - Performance data (same)

### Data used for tracking

**None.** Westshore Watch does not share data with third-party advertisers
or data brokers. No advertising SDKs are present.

### Data not linked to user identity

None. Everything Westshore Watch collects is in the context of a logged-in
account.

---

## Review Notes (private, visible only to Apple reviewers)

```
Westshore Watch is a detection-relay and monitoring client for the Westshore
Watch Remote ID drone detection platform. The iOS app:

- Westshore Watch scans for Bluetooth advertisements broadcast by Westshore
  Watch detection nodes, which relay drone Remote ID information per the FAA
  Part 89 rule. The app does not scan for arbitrary Bluetooth devices. All
  drone detection originates on dedicated hardware nodes (Sentinel stationary,
  or X1/M1 portable nodes); the app relays those broadcasts to our backend over
  authenticated HTTPS and also receives detection data via authenticated
  WebSocket.

- Does NOT require any unusual entitlements. Push notifications use APNs
  via Expo's push service. Location permission is requested only to center
  the map; no background location is used.

- Subscriptions are sold via Stripe Checkout (web), not in-app purchase.
  Westshore Watch is a hardware + service product; the subscription is for
  use of the cloud platform that hosts the hardware's data stream. Per
  guideline 3.1.3(b), physical goods and services consumed outside the app
  are not subject to IAP requirements.

DEMO ACCOUNT FOR REVIEW:
Email: [create a dedicated review account before submission]
Password: [set during account creation; share via App Store Connect]

The demo account will have one paired Sentinel node showing recent
detections. Tap any detection marker on the Live Map to see drone
details. The Settings tab includes a "Send test notification" button to
verify push delivery.

CONTACT FOR QUESTIONS:
[your name and contact email/phone for App Review]
```

**Action before submission:**

1. Create a dedicated review-only account at watch.westshoredrone.com with
   a recognizable email like `appreview@westshoredrone.com`.
2. Pair at least one Sentinel node to it (or configure synthetic
   detections so the Live Map isn't empty when the reviewer opens it).
3. Fill in the email/password placeholders in the review notes before
   pasting into App Store Connect.
4. Add your name and contact info in the CONTACT section.

The Stripe-vs-IAP defense is the most important paragraph in this note.
Apple's guideline 3.1.3(b) has a documented carve-out for SaaS tied to
physical hardware/services consumed outside the app. Citing the guideline
signals you've done the research and reduces the chance of a reviewer
flagging the subscription model as needing IAP.

---

## Screenshots

Apple requires screenshots in specific dimensions per device class. With
`supportsTablet: true` set in `app.config.js`, both iPhone and iPad
screenshots are required.

### Required dimensions (App Store Connect, current as of this draft)

| Device class | Resolution | Required? |
|---|---|---|
| 6.7" iPhone (Pro Max) | 1290 × 2796 px portrait | Yes |
| 6.5" iPhone (XS Max / 11 Pro Max) | 1242 × 2688 px portrait | Sometimes (Apple is phasing out) |
| 13" iPad (M4 Pro) | 2064 × 2752 px portrait | Yes (universal app) |

**Verify current requirements at submission time** — Apple updates these
periodically and may have changed the device classes required.

### Recommended screenshot content (5 screens, in this order)

1. **Live Map with active detections**
   Primary screen. Show the interactive map with several drone markers,
   flight paths, and at least one node icon. Caption: "Real-time drone
   detections on an interactive map."

2. **Drone detail sheet open**
   Tap a drone marker so the bottom sheet shows model, altitude, speed,
   operator location, source node. Caption: "See model, altitude,
   operator location, and flight path for every detection."

3. **Statistics screen**
   Show the month-bar drill-in, time-of-day heatmap, or proximity events
   widget. Caption: "Track repeat offenders, peak detection times, and
   facility proximity events."

4. **Notification example on lock screen**
   Mockup of an iOS lock screen showing a Westshore Watch push
   notification (e.g., "Drone #1A2B3C4D5E6F7890 entered North Lot
   Patrol"). Caption: "Get push notifications when drones enter your
   facility boundaries."

5. **Hardware lineup / architecture**
   Visual of Sentinel, X1, and M1 nodes with a brief diagram showing
   "Nodes detect → Cloud → Your iPhone/iPad." Caption: "Pair Westshore
   Watch hardware to start detecting drones."

iPad screenshots can repeat the same content for v1.0, taken with the
universal app running in compatibility mode. Re-shoot with proper iPad
layouts when Level 2 iPad adaptations ship in v1.1+.

### How to generate screenshots without a 6.7" iPhone

Erik's iPhone 11 and 12 don't match the 6.7" requirement. Options:

- **Use an iOS Simulator on a Mac** (if available — none currently)
- **Use a design tool** (Figma, Sketch, Photoshop) to create mocked
  screenshots at the required dimensions, dropping in real screenshot
  content from the iPhone 11/12 and scaling/composing as needed
- **Borrow a 6.7" iPhone** for a screenshot session
- **Use a screenshot generation service** (e.g., AppLaunchpad, Screenshot
  Studio) that accepts smaller-device input and produces App Store-ready
  outputs

For the notification mockup (screenshot #4), all of these methods work
since there's no "real" version to capture — it's always a composed image.

---

## Submission Checklist

Before clicking submit in App Store Connect:

1. [ ] Apple Developer Program enrollment active ($99/year)
2. [ ] Bundle ID `com.westshoredrone.watch` registered in Apple Developer portal
3. [ ] APNs auth key (.p8) uploaded to Expo via `eas credentials` (so push notifications work in TestFlight)
4. [ ] At least one TestFlight build has been installed and tested on a physical iOS device (iPhone 11 or 12 acceptable)
5. [ ] Demo account created at watch.westshoredrone.com for App Review
6. [ ] Demo account credentials filled into review notes (replace placeholders)
7. [ ] Contact name and info filled into review notes
8. [ ] Support URL `https://watch.westshoredrone.com/support` exists (or replaced with a working URL)
9. [ ] Privacy policy at `https://watch.westshoredrone.com/privacy` is current and reflects iOS data collection
10. [ ] Screenshots generated at required dimensions for both iPhone 6.7" and iPad
11. [ ] App Privacy questionnaire filled out in App Store Connect
12. [ ] Age rating questionnaire completed
13. [ ] All copy in this document spot-checked for typos and up-to-date hardware pricing
14. [ ] `app.config.js` version bumped if any code changes shipped since the last submission
15. [ ] Privacy manifest (`PrivacyInfo.xcprivacy`) aggregation complete (Phase 0 step 6)

---

## Maintenance Notes

This document is a snapshot of the intended listing at the time of writing.
Update when:

- Hardware lineup changes (new product, retired product, pricing change)
- New iOS-specific features ship (live activities, widgets, watch app, etc.)
- iPad Level 2 layouts ship — re-shoot iPad screenshots
- Use-case framing evolves based on customer research
- Apple changes their submission requirements (screenshot dimensions, manifest rules, etc.)

The Promotional Text field (170 chars) can be updated in App Store Connect
without resubmitting the app, so use it for in-quarter announcements.
Everything else requires a new app version.

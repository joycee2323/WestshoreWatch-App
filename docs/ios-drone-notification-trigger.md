# iOS "New Drone Detected" notification — trigger analysis

*Scope: exactly where the "drone detected" local push fires on iOS, and whether it
is independent of a successful backend upload. Written for someone who knows the
architecture and wants to verify each claim. App repo: `C:\dev\WestshoreWatch`;
backend: `…\WestshoreWatch-Backend`.*

---

## TL;DR / verdict

1. **The notification is a *local fallback*, fired from shared JS on raw ODID parse
   success — before and independent of any upload.** `bleScanner.ts` calls
   `notifyNewDrone(uasId)` the moment a new drone's BasicId/Pack frame is parsed
   (`bleScanner.ts:390, :409`), well before either upload path runs. No upload
   result (native `WSWDetectionUploader` or node-less `detectionUpload.ts`) is
   consulted.
2. **It is a *delayed* fallback: an 8-second timer that fires unless a backend
   `drone_detected` push cancels it** (`droneNotifier.ts:139-143`, cancel at
   `:82-94`). The only thing that suppresses it is a server push for the same
   `uas_id`. A push is only sent when the backend writes a `drone_detections` row.
   **Zero rows ⇒ no push ⇒ the timer runs to completion ⇒ local notification
   fires.** This is exactly the observed test.
3. **The trigger is NOT iOS-only in code.** `notifyNewDrone` is in shared
   `bleScanner.ts` with no `Platform.OS` gate; `droneNotifier.ts`'s `Platform.OS`
   branches are only Android channel plumbing, not suppression. Android has the
   identical fallback. Its silence in the test is a runtime/device condition (didn't
   receive/parse the frame, or lacked notification permission, or already-notified),
   **not** a code difference — see §3.
4. **Trust issue (confirmed): the notification asserts a detection the backend has
   no record of.** "New Drone Detected" fires precisely in the case where nothing
   was logged. On iOS build 10 this is not an edge case — with node-less upload
   disabled (see `docs/ios-build9-to-build10-ble-diff.md`), it is the *expected*
   outcome for any detection lacking a recovered node MAC. See §4.

---

## 1. The exact trigger path

### Step 1 — BLE parse fires `notifyNewDrone`, before any upload

In `src/services/bleScanner.ts`, inside the `BLEScanResult` handler, right after
`parseOdidAdvertisement` (`:360`) succeeds and a `uasId` is in hand:

- Pack path (`msgType 0xF`, self-identifying) — `bleScanner.ts:382-391`:
  ```ts
  if (parsed.msgType === ODID_MSG_PACK) {
    if (parsed.uasId) {
      effectiveUasId = parsed.uasId;
      const prev = mergeBySource.get(sourceMacUpper);
      const isNewSighting = !prev || prev.uasId !== parsed.uasId;
      if (isNewSighting) void notifyNewDrone(parsed.uasId);   // ← line 390
    }
  }
  ```
- Legacy BasicId path — `bleScanner.ts:392-410`:
  ```ts
  } else if (parsed.uasId) {
    …
    if (isNewSighting) {
      void notifyNewDrone(parsed.uasId);                       // ← line 409
    }
  }
  ```

Both calls happen **inside the same synchronous scan callback**, at line 390/409 —
*before* `onDetection(...)` (`:468`) and *before* the node-less upload enqueue
(`enqueueDetectionUpload`, `:484-501`). The native node-attributed upload runs
entirely in Swift (`WSWBLEScanner.maybeEnqueueForUpload` → `WSWDetectionUploader`),
on a separate path that `notifyNewDrone` neither calls nor observes. **The
notification trigger is upstream of, and blind to, every upload.**

Note the trigger needs only a `uasId` (a BasicId/Pack frame). It does **not** require
a position. The upload paths *do* require `lat/lon` (`bleScanner.ts:487-489`;
Swift `:409`). So the notification can fire for a frame that no upload path would
ever have sent even on a fully healthy system.

### Step 2 — `notifyNewDrone` arms an 8s timer

`src/services/droneNotifier.ts:127-144`:
```ts
export async function notifyNewDrone(uasId: string): Promise<void> {
  if (!uasId) return;
  if (notifiedUasIds.has(uasId)) return;          // per-process dedup
  notifiedUasIds.add(uasId);
  if (permissionStatus !== 'granted') return;      // needs notif permission
  if (pendingFallbacks.has(uasId)) return;
  const timer = setTimeout(() => {
    pendingFallbacks.delete(uasId);
    void fireFallbackNotification(uasId);          // ← fires the local push
  }, FALLBACK_TIMEOUT_MS);                          // 8000ms (:32)
  pendingFallbacks.set(uasId, timer);
}
```

### Step 3 — the local notification (no upload dependency anywhere)

`droneNotifier.ts:108-125`:
```ts
async function fireFallbackNotification(uasId: string): Promise<void> {
  if (permissionStatus !== 'granted') return;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'New Drone Detected',
      body: `UAS ID: ${uasId}`,
      sound: 'default',
      data: { source: 'local_fallback', uas_id: uasId },   // ← tell-tale marker
    },
    trigger: Platform.OS === 'android' ? { channelId: 'drone-detections' } : null,
  });
}
```
The `data.source === 'local_fallback'` marker is how you positively identify one of
these in a notification payload vs. a server push. Nothing in this function, or in
the timer that calls it, references any upload result.

### Step 4 — the ONLY suppressor: a backend push for the same uasId

`droneNotifier.ts:82-94` (attached by `initDroneNotifications`, called once at
`App.tsx:47` on both platforms):
```ts
crossRefSub = Notifications.addNotificationReceivedListener(notification => {
  const data = notification?.request?.content?.data || {};
  if (data.kind !== 'drone_detected') return;
  const pushUasId = typeof data.uas_id === 'string' ? data.uas_id : null;
  …
  const timer = pendingFallbacks.get(pushUasId);
  if (timer) { clearTimeout(timer); pendingFallbacks.delete(pushUasId); }   // cancel
});
```

That backend push is emitted **only when the backend writes a first-seen
detection** — `sendNotificationToOrg(orgId, 'drone_detected', …)` on the ingest
paths (e.g. `routes/deployments.js:1333`, `routes/nodes.js`), and only after a row
is upserted. The outgoing push carries `data.kind` because
`sendNotificationToUser` folds it in:
`notificationService.js:520` — `const pushData = { ...(data||{}), kind, notificationId };`
(org fanout routes through this per-user send, `notificationService.js:673-681`).
So the cancel path **is** correctly wired *when a push is actually sent*.

**The chain therefore closes as:** no `drone_detections` row (test: 0 rows) ⇒ no
`drone_detected` push ⇒ nothing cancels the 8s timer ⇒ local "New Drone Detected"
fires ~8s after the BLE sighting. Exactly the reported behavior.

---

## 2. Answering "which condition fires it?"

| Candidate trigger | Is it the trigger? |
|---|---|
| Raw ODID parse success (new uasId) | **YES** — arms the timer (`bleScanner.ts:390/409`), no position or upload needed |
| Successful native node-attributed upload | No — separate Swift path, never consulted |
| Successful node-less upload | No — `enqueueDetectionUpload` runs *after* and is unrelated |
| Backend round-trip / DB write | Only as a *suppressor* — a push cancels the pending timer |

So the notification is **armed on parse, fired on timeout, cancelled only by a
server push.** It is independent of every upload; the upload matters only
indirectly, because a *successful* one eventually produces the push that would
cancel the timer.

---

## 3. iOS-only? No — shared code; Android's silence is runtime

`notifyNewDrone` lives in shared `bleScanner.ts` and is called with **no
`Platform.OS` guard** (`:390`, `:409`). `droneNotifier.ts`'s only platform branches
are cosmetic: the Android notification-channel creation (`:60-66`) and the
`channelId` trigger (`:118-120`). `initDroneNotifications` runs on both platforms
(`App.tsx:47`). **There is no iOS-only path and no Android suppression.**

So Android *has* the same fallback. Why it didn't fire in this test (given 0 DB rows
means no push cancelled anyone's timer) must be one of these runtime conditions:

- **The Android device never received/parsed the ODID frame** — not scanning (not on
  LiveMap/GuestScan), out of BLE range, or its scanner didn't surface that advert.
  Then its `bleScanner.ts` never called `notifyNewDrone`. (Most consistent with an
  iPhone-only sighting.)
- **Android notification permission not granted** — `notifyNewDrone` early-returns
  at `droneNotifier.ts:134` (`permissionStatus !== 'granted'`). On Android 13+,
  POST_NOTIFICATIONS is a runtime grant.
- **Android already notified that uasId** this process — `notifiedUasIds`
  (`:129`). Note `resetNotifiedDrones` (`:148`) has **no caller in `src/`**, so this
  set is never cleared for the process lifetime; a uasId seen earlier won't re-alert.

Ruled out: a server push cancelling Android's timer — with 0 rows, no push existed.

**Decisive point:** because 0 rows means *no push reached either device*, any device
that (a) parsed the frame, (b) had notification permission, and (c) hadn't already
notified that uasId **would** fire the local fallback. The iPhone met all three; the
Android device failed at least one. This is a device/runtime difference, **not** a
code-level iOS-vs-Android trigger difference.

### System-level asymmetry worth knowing (why iOS fires this *more often*)

Even though it doesn't explain this specific test's Android silence, the two
platforms differ structurally in how often the fallback survives to fire:

- **iOS build 10** frequently doesn't upload at all — the node-less path is disabled
  (`docs/ios-build9-to-build10-ble-diff.md`), and the native path only fires once a
  node's `0x08FE` MAC is recovered. No upload ⇒ no row ⇒ no push ⇒ **fallback fires.**
- **Android** uploads via the Kotlin foreground service keyed on the node MAC
  (`device.address` always available), so it more readily writes a row ⇒ push ⇒
  **fallback cancelled.**

Net: iOS users see this local "New Drone Detected" far more often than Android users,
independent of any single test.

---

## 4. Trust / UX issue — flagged

**The notification tells the user a drone was detected and (by implication) logged,
in exactly the cases where the backend recorded nothing.** By design the fallback
exists for "backend down / push broken" (`droneNotifier.ts:1-27`), but the trigger
cannot distinguish *"backend was up but we never uploaded"* from *"backend was
down."* It fires the same way for:

- iOS build-10 node-less detections (upload path dead — the common case),
- any detection with no recovered node MAC and no relay target,
- a frame with a uasId but no position (upload gates on lat/lon; notification does not),
- a genuinely offline/unreachable backend.

Only the last is the intended fallback scenario; the first three are silent
data-loss cases the user is told were successful detections. On iOS build 10
specifically, this is the *normal* outcome, not a rare failure — so a user running
build 10 gets "New Drone Detected" alerts for drones the backend has zero record of,
which is precisely the discrepancy seen in the DB query.

Secondary defect noticed while tracing: `resetNotifiedDrones` (`droneNotifier.ts:148`)
is defined but never called in `src/`, despite its doc ("Call on logout, BLE scan
stop"). Once a uasId is in `notifiedUasIds`, it never re-alerts for the process
lifetime — so a later *real* re-detection of the same drone is silently suppressed.
Independent of the main finding, but same module.

### Recommendation direction (not applied)

If the intent is "notify only when we actually have (or will have) a record," the
fallback should be gated on an *upload outcome*, not merely on the absence of a
return push — e.g. arm the timer only after an upload is enqueued to a real target,
or have the upload layer signal success/failure back to `droneNotifier`. As written,
the notification is a pure client-side parse event and should not be read as
evidence the detection was logged.

---

## Reference — where to verify

| Claim | Location |
|---|---|
| Fires on parse, before uploads | `src/services/bleScanner.ts:390, :409` (vs upload `:484-501`, Swift `maybeEnqueueForUpload`) |
| 8s timer + fire | `src/services/droneNotifier.ts:32, :127-144, :108-125` |
| `data.source:'local_fallback'` marker | `droneNotifier.ts:116` |
| Only suppressor = backend push | `droneNotifier.ts:82-94` (`data.kind==='drone_detected'`) |
| Push only on DB write; carries `kind` | `routes/deployments.js:1333`; `notificationService.js:520, :673-681`, `buildDroneDetectedPush:590-624` |
| Shared JS, no iOS gate | `bleScanner.ts:390/409` (no `Platform.OS`); `droneNotifier.ts:60, :118` cosmetic only |
| Init both platforms | `App.tsx:47` |
| iOS node-less upload disabled (build 10) | `docs/ios-build9-to-build10-ble-diff.md` §5 |
| `resetNotifiedDrones` never called | `droneNotifier.ts:148`; no caller in `src/` |

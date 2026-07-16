# iOS Detection Attribution — why node-relay can't be told apart from "nodeless"

*Scope: how WestshoreWatch tags detection "source", why iOS can't attribute a
BLE-relayed detection to a specific node, and whether backend logs can reliably
distinguish node-relay from direct detection on iOS. Written for someone who
already knows the system architecture.*

File/line references are given so every claim is verifiable. App repo:
`C:\dev\WestshoreWatch`. Backend repo: `…\WestshoreWatch-Backend`.

---

## TL;DR

1. **There is no phone-side WiFi ODID scanning anywhere in this app — on iOS *or*
   Android.** The phone detects drones *only* over BLE. So the mental model
   "`user_nodeless` = phone's own native WiFi scan" does not match the code. On
   iOS, `user_nodeless` really means **"a BLE detection the phone could not
   attribute to a Westshore node."**
2. **`source` is not a stored field.** The DB row (`drone_detections`) has only a
   nullable **`node_id`**. `"user_nodeless"` exists solely as a log/WebSocket
   diagnostic string on one ingest route.
3. **The `source` distinction is purely which endpoint got the POST:**
   `/api/nodes/<mac>/detections` (→ `node_id` set) vs
   `/api/deployments/<id>/detections` (→ `node_id` NULL, logged `user_nodeless`).
4. **iOS cannot read a peripheral's hardware MAC — hard CoreBluetooth limitation.**
   It recovers the node MAC by a *firmware-cooperative workaround* (parsing the
   node's `0x08FE` manufacturer-data identity advert), not from CoreBluetooth.
5. **On iOS you cannot use the detection `source` tag to tell node-relay from
   direct.** `user_nodeless` is the *default/expected* tag on iOS even when a node
   *is* relaying, because the iOS node-less upload path has no node-vs-bridge
   guard and fires for every detection. Seeing `user_nodeless` in logs does **not**
   mean the node-relay path is idle. (You *can* tell from `node_id` on the stored
   row and from node heartbeats — see §5.)

---

## 1. The two (really three) detection paths

The phone (iOS or Android) is a passive BLE central. Over BLE it can receive:

- **ODID service-data adverts** (BLE service UUID `0xFFFA`) — ASTM F3411 Remote ID.
  These come from a drone broadcasting RID over BLE directly, a third-party
  DroneScout/BlueMark bridge, **or** a WestshoreWatch X1/M1 node relaying a
  drone's WiFi RID as BLE.
- **The node identity advert** (manufacturer company ID `0x08FE`) — WestshoreWatch
  firmware's own beacon carrying `[companyLE(2)][MAC(6)][api_key prefix]`.

There is **no WiFi/Wi-Fi-Aware/NAN RID capture** in the phone app. Repo-wide
searches for `WifiAware|NanManager|802.11|opendroneid|NEHotspot` hit only
incidental "WiFi flap" socket-recovery comments (`DetectionUploader.kt:53,139`).
The iOS scanner imports only `CoreBluetooth`/`CoreLocation`
(`plugins/ios/BLEScanner/WSWBLEScanner.swift:2-3`).

So the user-facing "two paths" map onto **three backend ingest routes**, chosen by
endpoint + auth, not by any payload flag:

| Path | Route (file:line) | Auth | `node_id` stored |
|---|---|---|---|
| Sentinel / cellular X1 **direct** | `POST /api/detections` — `routes/detections.js:39` | API-key (`authenticateNode`) | `req.node.id` (always) |
| **Node-relay** (drone→node→BLE→phone) | `POST /api/nodes/:device_id/detections` — `routes/nodes.js:538` | JWT **or** API-key (`authenticateNodeOrUser`) | relaying `node.id` |
| **Node-less** ("`user_nodeless`") | `POST /api/deployments/:deploymentId/detections` — `routes/deployments.js:1078` | user JWT (`authenticate`) | `NULL` |

`authenticateNodeOrUser` picks API-key auth if `X-Node-API-Key` is present, else
JWT (`middleware/auth.js:113-118`).

---

## 2. Where each path's code lives, and how "source" is tagged

### Client (shared JS + native)

- **Scan + parse (shared):** `src/services/bleScanner.ts` receives every advert on
  the `BLEScanResult` event (`:337`), parses ODID (`src/services/odidParser.ts`),
  and calls `onDetection(...)` for the map (`:468-477`).
- **Android node-relay upload (native Kotlin):**
  `android/.../BLEScannerService.kt` reads the node's **real MAC** from
  `result.device.address` (`:327`), uses it as `deviceId` (`:450`), and
  `DetectionUploader.kt` POSTs to `"$baseUrl/api/nodes/$deviceId/detections"`
  (`DetectionUploader.kt:260`).
- **iOS node-relay upload (native Swift):**
  `plugins/ios/BLEScanner/WSWBLEScanner.swift` → `maybeEnqueueForUpload` (`:362`)
  hard-gates on a recovered node MAC (`guard let deviceId … else { return }`,
  `:392`) and enqueues to `WSWDetectionUploader.swift`, which POSTs to
  `…/api/nodes/<deviceId>/detections` (`WSWDetectionUploader.swift:173`).
- **iOS node-less upload (shared JS):** `src/services/detectionUpload.ts` batches
  and POSTs via `api.deploymentDetections` →
  `/api/deployments/<id>/detections` (`src/services/api.ts:234-235`). This is
  driven from `bleScanner.ts:484-501` whenever a relay target is set.

**No client sets a `source` field.** Every upload body is just
`{ drones: [{ id, lat, lon, alt, spd, hdg, op_lat, op_lon, ts }] }`
(`detectionUpload.ts:138-142`, `DetectionUploader.kt:243-256`,
`WSWDetectionUploader.swift:157-171`). The only literal `source:` in the app is on
a *local push notification*, unrelated (`droneNotifier.ts:116`).

### Backend

- The stored attribution field is **`drone_detections.node_id`** (nullable FK to
  `nodes`; `migrations/001_initial_schema.sql:122`, made `ON DELETE SET NULL` by
  `004_nodes_ondetach_detections.sql`). There is **no `source` column.**
- `"user_nodeless"` appears **only** in `routes/deployments.js`, as a
  non-persisted log/WS tag, in three places:
  - stale-frame log — `deployments.js:1239`
  - coalescer-drop log — `deployments.js:1251`
  - `[ws.broadcast.detection]` diagnostic — `deployments.js:1325`
- The node paths store a real `node_id` (`nodes.js:806-827` incl.
  `node_id = EXCLUDED.node_id`; `detections.js:298-319`) and log a `device_id`
  instead of any source string (`nodes.js:786`, `detections.js:270`).
- The node-less path inserts `node_id = NULL` and, on conflict, **preserves any
  existing node_id**: `node_id = COALESCE(EXCLUDED.node_id,
  drone_detections.node_id)` (`deployments.js:1278`, and `:1231` in the stale
  branch). So a node-less write never *erases* an X1's attribution.

There is no complementary `"node_relay"` / `"node"` source literal anywhere — the
only string is `user_nodeless`.

---

## 3. Why iOS can't attribute a BLE-relayed detection to a specific node

### The CoreBluetooth restriction (hard limitation)

When iOS delivers a BLE advert to
`centralManager(_:didDiscover:advertisementData:rssi:)`, the peripheral's identity
is `peripheral.identifier` — an **opaque, per-app-randomized `NSUUID`, not the
hardware MAC** (`WSWBLEScanner.swift:258`, and the header note at `:25-39`). Apple
deliberately never exposes the hardware BT MAC of a peripheral to a scanning app;
the UUID is also stable only per app-install, and rotates. **There is no API,
entitlement, or trick to obtain the peripheral's real MAC from CoreBluetooth.**
This part is a genuine, non-workable-around platform limitation.

Android has no such restriction: `ScanResult.getDevice().getAddress()` returns the
node's real MAC (`BLEScannerService.kt:327`), which is why Android keys every node
operation on the MAC and iOS cannot.

### The firmware-cooperative workaround iOS actually uses

Because the backend node endpoint is `/api/nodes/<MAC>/detections`, iOS still needs
the node MAC. It recovers it **not from CoreBluetooth but from the advertisement
payload**: the firmware's `0x08FE` identity advert carries the MAC in bytes 2..<8
of its manufacturer data (`WSWBLEScanner.swift:263-286`):

```swift
if companyId == WSWBLEScanner.westshoreCompanyId, mfg.count >= 8 {
    let macBytes = mfg.subdata(in: 2..<8)
    let mac = macBytes.map { String(format: "%02X", $0) }.joined()
    peripheralToDeviceId[pid] = mac      // cache pid(UUID) -> MAC
    nodeDeviceId = mac
}
```

It caches `peripheral.identifier → MAC` and, on later adverts from the same
peripheral that lack the identity payload, looks the MAC back up (`:287-289`).
Only once a MAC is recovered does the native node path fire; until then native
upload/heartbeat for that peripheral are deferred (`:305-310`, `:392`).

**So "can iOS attribute to a node?" has two answers:**

- *Reading the hardware MAC via CoreBluetooth* — **no, hard limitation, no
  workaround.**
- *Attributing a detection to a node at all* — **partially yes, via the firmware
  `0x08FE` beacon workaround**, but it is contingent on two things the code itself
  flags as unverified (`WSWBLEScanner.swift:35-39`):
  1. the firmware must emit the `0x08FE` identity advert, and it must be received
     (foreground-only; iOS throttles background scanning hard, `:41-48`);
  2. the ODID relay advert and the `0x08FE` identity advert must arrive from the
     **same `CBPeripheral.identifier`**. If the firmware advertises them as
     separate sets with independent random BLE addresses, the pid→MAC correlation
     breaks and the node path silently never fires (the `attrib=MISS` diagnostic at
     `:382-385` exists to catch exactly this).

---

## 4. Does "`user_nodeless`" mean the node-relay path isn't being used? — No.

This is the crux. On iOS, `user_nodeless` is **not** a reliable signal that a
detection came in without a node. Three independent reasons:

**(a) There is no "direct phone WiFi scan" on iOS to contrast against.**
Everything iOS detects is BLE. `user_nodeless` cannot mean "detected directly by
phone WiFi" because that path does not exist in the app.

**(b) The iOS node-less upload fires for *every* detection, node or not.**
In `bleScanner.ts`, once a relay target is set, `enqueueDetectionUpload(...)` is
called for **any** position-bearing parsed detection — with **no node-vs-bridge
guard** (`bleScanner.ts:484-501`):

```ts
if (relayDeploymentId && typeof parsed.lat === 'number' && …) {
  enqueueDetectionUpload(relayDeploymentId, { id: effectiveUasId, lat: …, lon: … });
}
```

So a genuine WestshoreWatch **node-relayed** frame also gets POSTed to the
deployment (node-less) endpoint and logged `source: 'user_nodeless'` — *in
parallel* with the native Swift node-endpoint POST (which fires only if the MAC
was recovered). On iOS, a node-relayed drone therefore routinely produces **both**
a `node_id`-stamped write (node path) **and** a `user_nodeless` write (deployment
path).

**(c) If the `0x08FE` identity advert isn't captured, ONLY `user_nodeless`
appears.** When the node path never fires (node identity not seen, or the
separate-advertising-set correlation break from §3), the detection still uploads —
but *only* via the node-less deployment endpoint. The node-relayed detection then
fully masquerades as `user_nodeless`, with no `node_id` on the row.

**Coalescer makes the two copies indistinguishable downstream.** The dedup key is
`` `${deploymentId}:${uasId}` `` — **source-blind and node-blind**
(`detectionCoalescer.js:52-54`), 1500 ms window (`:32`). The node copy and the
node-less copy for the same `(deployment, uas)` land in the same bucket and
collapse; whichever arrives first in the window wins the broadcast, and `node_id`
is COALESCE-preserved on the row.

### Can backend logs distinguish node-relay from direct on iOS?

- **`user_nodeless` in logs is the expected default on iOS and proves nothing about
  whether a node relayed.** It only tells you the deployment endpoint received a
  POST.
- The two `[ws.broadcast.detection]` lines for the node path (`nodes.js:881-897`)
  and node-less path (`deployments.js:1316-1327`) are structurally similar; only
  the node-less one carries the `source: 'user_nodeless'` tag, and only the direct
  path dumps the raw request with an api-key prefix (`detections.js:41`). None of
  the accepted-detection broadcast logs carries the relaying node's MAC.

**What *does* let you tell a node was involved (just not via the detection
`source` tag):**

1. **`drone_detections.node_id`** on the stored row — non-NULL ⇒ a node's POST won
   the row (node path fired). NULL ⇒ only node-less writes landed.
2. **Node heartbeats.** When a WestshoreWatch node is being BLE-relayed by the
   phone, the iOS heartbeat uploader POSTs `connection_type: "ble_relay"` to
   `/api/nodes/<mac>/heartbeat` (`WSWNodeHeartbeatUploader.swift:106`,
   `:112`), which flips the node `status` to `online` and refreshes `last_seen`
   (`nodes.js:566-579`). So node *presence + relay* is observable on the `nodes`
   table even when the per-detection tag says `user_nodeless`.

### Bottom line for the question you're actually asking

> If a detection shows up as `user_nodeless` while a node is nearby and
> broadcasting, does that mean the node-relay path isn't being used/tested?

**No.** On iOS, `user_nodeless` is emitted for node-relayed detections too, so it
cannot distinguish "detected via node relay" from "detected directly" — and
"detected directly by phone WiFi" isn't even a real path on iOS. To confirm the
node-relay path is exercising on iOS, look at **`node_id` on the detection row**
and at the **node's `ble_relay` heartbeat / online status**, not at the
`user_nodeless` source string in the ingestion logs.

---

## 5. Quick reference — where to look

| Question | Look at |
|---|---|
| Did a node's identity advert reach iOS? | `WSWBLEScanner.swift:284` "identity recovered pid=… -> mac=…"; `:382-385` "attrib=MISS" if not |
| Was this detection attributed to a node? | `drone_detections.node_id` (NULL = node-less) |
| Is a node being BLE-relayed by a phone right now? | node `status='online'` + `connection_type='ble_relay'` heartbeat (`nodes.js:566-579`) |
| Which route ingested a POST? | `user_nodeless` log ⇒ deployment route; `detection POST <apikey>` dump (`detections.js:41`) ⇒ direct route; `device_id=` on a stale/drop line ⇒ a node route |
| Why iOS ≠ Android here | CoreBluetooth gives `peripheral.identifier` (UUID), never MAC (`WSWBLEScanner.swift:25-39, 258`); Android gives `ScanResult.getDevice().getAddress()` (`BLEScannerService.kt:327`) |

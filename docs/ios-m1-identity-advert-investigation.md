# iOS M1/C6 identity-advert parsing — investigation (no chip-batch bug found)

*Scope: does iOS's `0x08FE` identity-advert parser fail for M1 (ESP32-C6) nodes
the way an earlier Android bug failed for a different chip batch? Short answer:
**no**. The earlier Android bug was a new-**MAC-OUI** procurement batch, not a
reformatted advert, and iOS was built OUI-agnostic from day one. The C5 and C6
firmware emit the `0x08FE` advert byte-for-byte identically, and iOS parses that
format correctly. This doc records the evidence so you can verify before touching
code. Written for someone who knows the architecture.*

App repo: `C:\dev\WestshoreWatch`. Firmware trees under
`C:\Users\joyce\WestshoreWatch\WSW-Firmware-C5` / `-C6` / `XIAO-Firmware`.

---

## TL;DR / verdict

1. **The prior Android fix was not an advert-format fix.** It fixed a *new MAC
   OUI* (`10:BD:A3`) shipping on newer ESP32 procurement batches that the app's
   hardcoded OUI allowlist rejected. The advert byte layout never changed
   (`6b369a66`, `32e7b380` commit messages).
2. **C5 and C6 firmware build the `0x08FE` identity advert identically** — same
   company ID, same MAC offset, same natural byte order, same length, same
   trailing api_key. Authored once in `7f062be1` (2026-04-11), never diverged.
3. **iOS parses exactly that format and matches it** (`WSWBLEScanner.swift:265,
   279-281`). There is **no M1/C6-specific mismatch** — no wrong company ID, no
   wrong offset, no reversed bytes, and the `mfg.count >= 8` gate is always
   satisfied by a real node advert.
4. **iOS is actually *ahead* of the Android bug, not behind it.** iOS recognizes
   nodes purely by `0x08FE` presence and is OUI-agnostic (`WSWBLEScanner.swift:302-304`),
   so the `10:BD:A3` batch that broke Android was never a problem on iOS.
5. **The one genuine iOS-only gap is different and already known:** iOS *cannot*
   have Android's OUI fallback (CoreBluetooth never exposes a MAC), so iOS depends
   entirely on **receiving** the extended `0x08FE` advert. The open risk is
   *reception* of that extended-PDU advert, not *parsing* it — and it's already
   instrumented with diagnostics (`WSWBLEScanner.swift:266-278`), still flagged
   `NEEDS VERIFICATION` (`:35-39`). See §5.

If you were about to patch the iOS byte offsets / length check for M1: **don't** —
there is nothing mismatched there.

---

## 1. What the prior Android fix actually was

Full history is present (190 commits, not shallow). The recognition logic evolved:

| Commit | Date | Effect |
|---|---|---|
| `885b54b4` | 2026-04-11 | Original: OUI-only, `mac.startsWith("98:A3:16:7D")` |
| `e53d8d24` | 2026-04-16 | Added 2nd OUI `38:44:BE` (the ESP32-C5 batch) |
| `32e7b380` | 2026-06-17 | **Fix #1**: recognize by `0x08FE` presence, OUI removed (interim name `isNodeIdentityAdvert`) — touched `.kt`, `.ts`, **and `.swift`** |
| `1a38d2a1` | 2026-06-20 | Revert of PR #6 collaterally reverted Fix #1 in `.kt`/`.ts` back to OUI-only |
| `6b369a66` | 2026-06-24 | **Fix #2 (current)**: `0x08FE` presence **OR** legacy OUI fallback (`.kt`, `.ts`) |
| `389df7e3` | 2026-07-06 | Cosmetic TS refactor (Erik Joyce), no behavior change |

The motivating batch difference, quoted from the fix commits:

> `32e7b380`: "New XIAO procurement batches ship on new OUIs (e.g. 10:BD:A3) that
> the old allowlist (98:A3:16:7D / 38:44:BE) rejected, breaking NODE IN RANGE,
> add-node, heartbeat, and detection attribution…"

> `6b369a66`: "new hardware batches on other OUIs (e.g. 10:BD:A3) were never
> recognized … **despite healthy firmware advertising correctly.**"

So the difference between batches was **the module's assigned MAC OUI** (`10:BD:A3`
vs `98:A3:16:7D` / `38:44:BE`) — *not* company ID, byte offset, MAC order, or
advert length. "Firmware advertising correctly" is explicit in the message. This
is the crux: your recollection of a *reformatted* advert per chip batch does not
match what actually happened.

### Current Android recognition (dual-signal)

`android/app/src/main/java/com/westshoredrone/watch/BLEScannerService.kt` — const
`WESTSHORE_COMPANY_ID = 0x08FE` (`:579`), recognition `:467-475`:

```kotlin
private fun isWestshoreWatchNode(macUpper: String, record: ScanRecord?): Boolean {
    // …presence IS the recognition signal — no payload-length gating. Fallback
    // to the legacy OUI allowlist for older fleet…
    if (record?.getManufacturerSpecificData(WESTSHORE_COMPANY_ID) != null) return true
    return macUpper.startsWith("98:A3:16:7D") || macUpper.startsWith("38:44:BE")
}
```

Shared JS mirror — `src/services/bleScanner.ts:242-259` (`0x08FE` little-endian
from base64 `manufacturerData`, else OUI prefix). Note the OUI fallback still only
covers `98:A3:16:7D` / `38:44:BE` — **not** `10:BD:A3`; a `10:BD:A3` unit is
recognized only via the `0x08FE` presence branch. That's fine because current
firmware always emits `0x08FE`.

---

## 2. Firmware C5 vs C6 — the `0x08FE` advert is identical

The identity advertiser is `configure_id_advertiser()` (firmware "handle 3",
`ID_ADV_HANDLE = 3`) in each tree's `main/ble_relay.c`. Byte construction:

**C5** (`WSW-Firmware-C5\WSW-Firmware\main\ble_relay.c:826-847`) and
**C6** (`WSW-Firmware-C6\WSW-Firmware\main\ble_relay.c:852-873`) are identical:

```c
uint8_t mac[6];
esp_read_mac(mac, ESP_MAC_BT);            // BT public address (deliberate)
…
buf[0] = (uint8_t)payload_len;            // AD length
buf[1] = 0xFF;                            // AD type = Manufacturer Specific Data
buf[2] = 0xFE;                            // company LSB  ┐ 0x08FE
buf[3] = 0x08;                            // company MSB  ┘ little-endian → FE 08 on air
memcpy(&buf[4],  mac, 6);                 // MAC, natural order (mac[0] = OUI first byte)
memcpy(&buf[10], g_config.api_key, key_len);  // api_key, up to ID_API_KEY_MAX = 64
```

| Aspect | C5 (X1, OUI 38:44:BE) | C6 (M1, OUI 98:A3:16:7D) |
|---|---|---|
| Company ID | `0x08FE` (`buf[2]=0xFE`, `buf[3]=0x08`) | identical |
| MAC offset in app-visible payload¹ | 2..8 | identical |
| MAC byte order | natural (`memcpy(mac,6)`, `mac[0]`=0x38) | natural (`mac[0]`=0x98) |
| Min length (key_len=0) | 8 bytes (company+MAC) | identical |
| Trailing bytes | api_key ≤ 64 | identical |
| Advert handle / PDU | handle 3, extended, non-conn, sid=3, 500 ms | identical |

¹ The manufacturer-data payload the OS hands the app **starts at the company ID**
(the `[0]`length/`[1]`type bytes are stripped by the BLE stack), so the MAC sits at
payload offset 2..8 — exactly what iOS reads.

- Format authored in `7f062be1` (2026-04-11); C5 and C6 share that commit on the
  payload lines. No post-`7f062be1` commit in either tree touches handle 3 (later
  C6 commits `e981590`/`c9c9a67`/etc. touch handles 0/1/2 only).
- **Do not confuse handles:** handle 2 = *detection* advert, company `0x08FF`
  (e.g. C5 `ble_relay.c:989-995`). Handle 3 = *identity* advert, company `0x08FE`.
  Only `0x08FE` is what iOS uses for MAC recovery.
- MAC source is deliberately `ESP_MAC_BT` (not the WiFi STA MAC, which "differs by
  2 bytes … caused the Android scanner's observed device_id to mismatch the
  registered backend identity" — C5 `ble_relay.c:821-825`). That comment is the
  one substantive MAC design note, and it is present and identical in all trees.

---

## 3. iOS parser — matches the firmware, handles both trees

`plugins/ios/BLEScanner/WSWBLEScanner.swift`:

- `westshoreCompanyId: UInt16 = 0x08FE` (`:57`).
- Company ID read little-endian: `UInt16(mfg[0]) | (UInt16(mfg[1]) << 8)` (`:265`).
- Gate + MAC recovery (`:279-283`):
  ```swift
  if companyId == WSWBLEScanner.westshoreCompanyId, mfg.count >= 8 {
      let macBytes = mfg.subdata(in: 2..<8)          // offset 2..8
      let mac = macBytes.map { String(format: "%02X", $0) }.joined()  // natural order
      peripheralToDeviceId[pid] = mac
      nodeDeviceId = mac
  }
  ```
- Recognition is OUI-agnostic — the recovered MAC *is* the recognition signal, no
  OUI check (`:302-304`: "no MAC-OUI check, so any OUI is supported").

Point-by-point against the firmware:

| Check | Firmware emits | iOS expects | Match? |
|---|---|---|---|
| Company ID | `0x08FE` LE | `0x08FE`, LE decode | ✅ |
| MAC offset (payload) | 2..8 | `subdata(in: 2..<8)` | ✅ |
| MAC byte order | natural | natural (`%02X` join, no reverse) | ✅ |
| Min length | 8 (company+MAC, key_len can be 0) | `mfg.count >= 8` | ✅ always satisfied |
| OUI dependence | any OUI (10:BD:A3, 38:44:BE, 98:A3:16:7D) | none — 0x08FE only | ✅ handles all |

**There is nothing to fix in the iOS byte layout / length / company-ID logic for
M1/C6.** It already matches C5 and C6 equally.

### iOS history — the fix was never left half-reverted

`git log -- plugins/ios/BLEScanner/WSWBLEScanner.swift` shows only 3 commits, newest
`32e7b380`. The `0x08FE` recovery lines blame to `a2b33ce8` (2026-06-12, original
iOS parity) and `ee348b14` (2026-06-14, diag). The collateral revert `1a38d2a1`
touched `BLEScannerService.kt` and `bleScanner.ts` **only — not the Swift file** —
so iOS's `0x08FE` recognition has been continuously present since 2026-06-12 and
survived the Android revert intact. iOS never carried the OUI-only bug in the first
place (it has no MAC to gate an OUI on).

---

## 4. Minimal fix? — none needed for the stated concern

The requested patch (iOS parser doesn't handle M1/C6 → fix offsets/length/company
ID) has **no target**: the format is uniform and iOS already matches it. Applying
offset/length changes would *break* a correct parser. Recommend: no code change on
the parsing path.

Two *optional* parity tidy-ups, neither of which fixes an M1 bug:

- **Length gate cosmetic divergence (harmless).** Android recognizes by *presence*
  with no length gate (`BLEScannerService.kt:469-470`); iOS requires `mfg.count >= 8`
  before recovering the MAC (`:279`). Since real firmware always sends ≥ 8 bytes
  (company 2 + MAC 6), iOS never misses a genuine advert. If you want strict
  parity you could recognize-on-presence and only *gate MAC extraction* on length,
  but there is no observed failure this prevents.
- **Nothing else.** The OUI fallback that Android has is impossible on iOS by
  design (see §5) — not a portability gap you can close.

---

## 5. The real (different) iOS risk — reception, not parsing

Worth stating precisely because it's easy to conflate with the parsing hypothesis:

- **iOS can never have Android's OUI fallback.** CoreBluetooth exposes only the
  per-app-random `peripheral.identifier`, never a MAC/OUI, so iOS has no OUI to
  check and *must* obtain the MAC from the `0x08FE` payload
  (`WSWBLEScanner.swift:25-39`). Consequence: a node running **pre-`0x08FE`
  firmware** (before `7f062be1`, 2026-04-11) is recoverable on Android via OUI
  fallback but **not on iOS at all**. This is a *firmware-version* dependency, not
  a chip-batch/C5-vs-C6 format difference — and any node on current firmware is
  fine.
- **The open question is whether iOS reliably *receives* the extended-PDU
  `0x08FE` advert.** Handle 3 is an extended, non-connectable advert; iOS
  background scanning is throttled and the identity advert has no `0xFFFA` service
  UUID to filter on (which is why the scan runs `services: nil` +
  `allowDuplicates` — `:234-237`). The per-advert `os_log` probes at `:266-278`
  exist exactly to answer "does the `0x08FE` handle-3 EXTENDED advert reach
  `didDiscover` at all?", and the header still flags this `NEEDS VERIFICATION`
  (`:35-39`), including the sub-question of whether the relay advert and the
  identity advert arrive under the **same** `CBPeripheral.identifier`.

If M1 nodes appear unrecognized on iOS in the field, the thing to check is **advert
reception** (capture the `mfg company=0x08FE len=…` os_log line on an M1), not the
byte-offset parsing — which this investigation confirms is correct.

---

## Reference — where to verify

| Claim | Location |
|---|---|
| Prior Android fix was a new-OUI batch, not a reformat | commits `32e7b380`, `6b369a66` messages; `BLEScannerService.kt:467-475` |
| C5/C6 `0x08FE` payload identical | `WSW-Firmware-C5\…\ble_relay.c:826-847`; `WSW-Firmware-C6\…\ble_relay.c:852-873`; blame → `7f062be1` |
| iOS company ID / offset / order / length | `WSWBLEScanner.swift:57, 265, 279-281` |
| iOS is OUI-agnostic (handles 10:BD:A3 etc.) | `WSWBLEScanner.swift:302-304` |
| iOS fix survived the Android revert | `git log -- plugins/ios/BLEScanner/WSWBLEScanner.swift`; `1a38d2a1` touched `.kt`/`.ts` only |
| Real risk is extended-advert reception | `WSWBLEScanner.swift:35-39, 234-237, 266-278` |

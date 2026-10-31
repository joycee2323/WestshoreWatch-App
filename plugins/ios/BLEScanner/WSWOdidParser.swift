import Foundation

// Swift port of:
//   android/app/src/main/java/com/westshoredrone/watch/OdidParser.kt
//   src/services/odidParser.ts
//
// Parses ASTM F3411-22a Remote ID broadcasts carried in the FFFA service-data
// field of a BLE advertisement. Kept byte-for-byte aligned with the Kotlin and
// TypeScript versions so all platforms decode identically. If you change the
// byte layout here, change it in all three.

struct WSWOdidResult {
    var msgType: Int?
    var hasBasicId = false
    var hasLocation = false
    var hasSystem = false
    var uasId: String?
    var lat: Double?
    var lon: Double?
    var altGeo: Double?
    var speedHoriz: Double?
    var heading: Double?
    var status: Int?
    // Location bytes 17-18: height (m, raw * 0.5 - 1000) relative to
    // heightType. nil = unknown/invalid.
    var height: Double?
    // Location byte 1 bit 2: 0 = above takeoff, 1 = above ground. X1/M1 relays
    // always carry 0. Parsed for completeness; not uploaded.
    var heightType: Int?
    // Location byte 4: signed vertical speed, raw * 0.5 m/s, positive up.
    // nil = unknown/invalid.
    var speedVert: Double?
    var opLat: Double?
    var opLon: Double?
    // ASTM F3411-22a Location message bytes 21-22 (uint16 LE): deciseconds
    // since the most recent UTC hour, range 0-36000. Drone-self-reported; the
    // backend stale-frame gate compares it to the last stored value to suppress
    // phantom POSTs from firmware cached re-broadcasts.
    var odidTimestamp: Int?
    // Relay format 2 only (see WSWOdidParser.relayFormatSpec): speedHoriz /
    // heading came from the drone's spec Location; decoder + locRaw are
    // uploaded. nil = legacy decode (no decoder field is sent).
    var decoder: String?
    var locRaw: String?
    var relayFormat: Int?

    func merged(with other: WSWOdidResult) -> WSWOdidResult {
        var r = WSWOdidResult()
        r.msgType = other.msgType ?? msgType
        r.hasBasicId = other.hasBasicId || hasBasicId
        r.hasLocation = other.hasLocation || hasLocation
        r.hasSystem = other.hasSystem || hasSystem
        r.uasId = other.uasId ?? uasId
        r.lat = other.lat ?? lat
        r.lon = other.lon ?? lon
        r.altGeo = other.altGeo ?? altGeo
        r.speedHoriz = other.speedHoriz ?? speedHoriz
        r.heading = other.heading ?? heading
        r.status = other.status ?? status
        r.height = other.height ?? height
        r.heightType = other.heightType ?? heightType
        r.speedVert = other.speedVert ?? speedVert
        r.opLat = other.opLat ?? opLat
        r.opLon = other.opLon ?? opLon
        r.odidTimestamp = other.odidTimestamp ?? odidTimestamp
        r.decoder = other.decoder ?? decoder
        r.locRaw = other.locRaw ?? locRaw
        r.relayFormat = other.relayFormat ?? relayFormat
        return r
    }
}

enum WSWOdidParser {
    static let appCode = 0x0D
    static let opStatusAirborne = 2
    // ASTM F3411 / opendroneid invalid-or-unknown encodings → nil. Mirrors
    // OdidParser.kt: status 5..15 reserved (4 = RID system failure, valid),
    // altitudes/height raw 0 (-1000 m, decoded <= -999.75), vertical speed
    // 63 m/s (|v| > 62).
    static let opStatusMaxValid = 4
    // Relay format 2 — WestshoreWatch-Firmware WSW-Firmware/main/odid_encoder.h
    // (tag x1m1-1.4-westshore). Pack byte 1 = (rf << 5) | count; message 4 is
    // the drone's own ASTM Location with type nibble msgSpecLocation. rf is
    // read from the Pack itself; handle-0 frames stay legacy. Mirrors
    // odidParser.ts / OdidParser.kt.
    static let relayFormatSpec = 2
    static let msgSpecLocation = 0xE
    static let decoderSpec = "odid-spec-1"
    static let altInvalidMaxM = -999.75
    static let vspeedMaxValidMps = 62.0
    static let msgPack = 0xF

    /// Entry point: full service-data payload = [app_code 0x0D][counter][message(s)].
    static func parseServiceData(_ bytes: [UInt8]?) -> WSWOdidResult? {
        guard let bytes = bytes, bytes.count >= 27 else { return nil }
        if Int(bytes[0]) != appCode { return nil }
        // Skip app code + counter, then 25-byte message(s) follow.
        let msg = Array(bytes[2...])
        return parseMessage(msg)
    }

    static func parseMessage(_ msg: [UInt8]) -> WSWOdidResult {
        if msg.isEmpty { return WSWOdidResult() }
        let msgType = (Int(msg[0]) >> 4) & 0x0F
        switch msgType {
        case 0: return parseBasicId(msg, msgType)
        case 1: return parseLocation(msg, msgType)
        case 4: return parseSystem(msg, msgType)
        case 0xF: return parsePack(msg, msgType)
        default:
            var r = WSWOdidResult(); r.msgType = msgType; return r
        }
    }

    private static func parseBasicId(_ msg: [UInt8], _ msgType: Int) -> WSWOdidResult {
        let end = min(msg.count, 22)
        var chars = [Character]()
        if end > 2 {
            for i in 2..<end {
                let b = Int(msg[i]) & 0xFF
                if b == 0 { break }
                chars.append(Character(UnicodeScalar(UInt8(b))))
            }
        }
        let uasId = chars.isEmpty ? nil : String(chars)
        var r = WSWOdidResult()
        r.msgType = msgType
        r.hasBasicId = true
        r.uasId = uasId
        return r
    }

    private static func parseLocation(_ msg: [UInt8], _ msgType: Int) -> WSWOdidResult {
        var r = WSWOdidResult(); r.msgType = msgType
        if msg.count < 25 { return r }
        let statusRaw = (Int(msg[1]) >> 4) & 0x0F
        let status: Int? = statusRaw <= opStatusMaxValid ? statusRaw : nil
        let heightType = (Int(msg[1]) >> 2) & 0x01
        let vspeed = Double(Int8(bitPattern: msg[4])) * 0.5
        let speedVert: Double? = abs(vspeed) <= vspeedMaxValidMps ? vspeed : nil
        let ewSeg = Int(msg[1]) & 0x01
        let dirMod = (Int(msg[2]) >> 1) & 0x7F
        let speedMult = Int(msg[2]) & 0x01
        let speedRaw = Int(msg[3]) & 0xFF

        let latRaw = readInt32LE(msg, 5)
        let lonRaw = readInt32LE(msg, 9)
        let altGeoRaw = readUInt16LE(msg, 15)
        let heightRaw = readUInt16LE(msg, 17)
        let tsRaw = readUInt16LE(msg, 21)

        let lat = Double(latRaw) / 1e7
        let lon = Double(lonRaw) / 1e7
        let altGeoM = (Double(altGeoRaw) * 0.5) - 1000.0
        let altGeo: Double? = altGeoM > altInvalidMaxM ? altGeoM : nil
        let heightM = (Double(heightRaw) * 0.5) - 1000.0
        let height: Double? = heightM > altInvalidMaxM ? heightM : nil
        let speedHoriz = speedMult == 1 ? (Double(speedRaw) * 0.75 + 63.75) : (Double(speedRaw) * 0.25)
        let heading = Double(dirMod + (ewSeg * 180))

        if lat == 0.0 && lon == 0.0 {
            r.hasLocation = false
            return r
        }
        r.hasLocation = true
        r.lat = lat
        r.lon = lon
        r.altGeo = altGeo
        r.speedHoriz = speedHoriz
        r.heading = heading
        r.status = status
        r.height = height
        r.heightType = heightType
        r.speedVert = speedVert
        r.odidTimestamp = tsRaw
        return r
    }

    private static func parseSystem(_ msg: [UInt8], _ msgType: Int) -> WSWOdidResult {
        var r = WSWOdidResult(); r.msgType = msgType
        if msg.count < 25 { return r }
        let opLat = Double(readInt32LE(msg, 2)) / 1e7
        let opLon = Double(readInt32LE(msg, 6)) / 1e7
        if opLat == 0.0 && opLon == 0.0 {
            r.hasSystem = false
            return r
        }
        r.hasSystem = true
        r.opLat = opLat
        r.opLon = opLon
        return r
    }

    private static func parsePack(_ data: [UInt8], _ msgType: Int) -> WSWOdidResult {
        var r = WSWOdidResult(); r.msgType = msgType
        if data.count < 2 { return r }
        let msgCount = Int(data[1]) & 0x1F
        let relayFormat = (Int(data[1]) >> 5) & 0x07
        var acc = WSWOdidResult()
        var spec: [UInt8]? = nil
        for i in 0..<msgCount {
            let offset = 2 + i * 25
            if offset + 25 > data.count { break }
            let sub = Array(data[offset..<(offset + 25)])
            if ((Int(sub[0]) >> 4) & 0x0F) == msgSpecLocation { spec = sub; continue }
            acc = acc.merged(with: parseMessage(sub))
        }
        var out = acc
        if relayFormat == relayFormatSpec, let spec = spec, acc.hasLocation {
            let k = parseSpecLocationKinematics(spec)
            var original = spec
            original[0] = UInt8((0x1 << 4) | (Int(spec[0]) & 0x0F))
            out.speedHoriz = k.speedHoriz
            out.heading = k.heading
            out.decoder = decoderSpec
            out.locRaw = original.map { String(format: "%02x", $0) }.joined()
            out.relayFormat = relayFormat
        }
        out.msgType = msgType
        return out
    }

    struct SpecKinematics { let heading: Double?; let speedHoriz: Double?; let lat: Double; let lon: Double }

    // ASTM F3411 / opendroneid Location bytes 1-4: byte 1 bit 0 SpeedMult,
    // bit 1 EWDirection; byte 2 = direction 0..179 (+180 with EW), >= 180 =
    // unknown (361 is written as 181 + EW); speed = mult ? raw*0.75 + 63.75 :
    // raw*0.25, raw 255 with mult = unknown. Lat/lon as doubles.
    static func parseSpecLocationKinematics(_ msg: [UInt8]) -> SpecKinematics {
        let b1 = Int(msg[1])
        let mult = b1 & 0x01
        let ew = (b1 >> 1) & 0x01
        let dir = Int(msg[2])
        let raw = Int(msg[3])
        let heading: Double? = dir >= 180 ? nil : Double(dir + (ew == 1 ? 180 : 0))
        let speed: Double? = (mult == 1 && raw == 255) ? nil
            : (mult == 1 ? Double(raw) * 0.75 + 63.75 : Double(raw) * 0.25)
        return SpecKinematics(heading: heading, speedHoriz: speed,
                              lat: Double(readInt32LE(msg, 5)) / 1e7, lon: Double(readInt32LE(msg, 9)) / 1e7)
    }

    struct FirmwareTag { let version: String; let build: String?; let relayFormat: Int? }

    // 0x08FE identity advert. CoreBluetooth manufacturer data INCLUDES the
    // company id: [FE 08][MAC(6)][api_key ...][0x00]["fw=<ver>+<elf8>;rf=<n>"].
    // Firmware without the fw tag sends no 0x00 / tag -> nil.
    static func parseFirmwareTag(_ mfg: [UInt8]) -> FirmwareTag? {
        guard mfg.count > 9 else { return nil }
        guard let sep = mfg[8...].firstIndex(of: 0), sep + 1 < mfg.count else { return nil }
        guard let tag = String(bytes: mfg[(sep + 1)...], encoding: .ascii), tag.hasPrefix("fw=") else { return nil }
        let parts = tag.dropFirst(3).split(separator: ";", omittingEmptySubsequences: false)
        let verBuild = parts.first.map(String.init) ?? ""
        let plusParts = verBuild.split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false)
        let version = plusParts.first.map(String.init) ?? ""
        let build: String? = plusParts.count > 1 && !plusParts[1].isEmpty ? String(plusParts[1]) : nil
        var rf: Int? = nil
        for p in parts.dropFirst() where p.hasPrefix("rf=") { rf = Int(p.dropFirst(3)) }
        guard !version.isEmpty, version.count <= 50,
              version.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value <= 0x7E }) else { return nil }
        return FirmwareTag(version: version, build: build, relayFormat: rf)
    }

    private static func readInt32LE(_ buf: [UInt8], _ offset: Int) -> Int32 {
        let b0 = UInt32(buf[offset]) & 0xFF
        let b1 = (UInt32(buf[offset + 1]) & 0xFF) << 8
        let b2 = (UInt32(buf[offset + 2]) & 0xFF) << 16
        let b3 = (UInt32(buf[offset + 3]) & 0xFF) << 24
        return Int32(bitPattern: b0 | b1 | b2 | b3)
    }

    private static func readUInt16LE(_ buf: [UInt8], _ offset: Int) -> Int {
        return (Int(buf[offset]) & 0xFF) | ((Int(buf[offset + 1]) & 0xFF) << 8)
    }
}

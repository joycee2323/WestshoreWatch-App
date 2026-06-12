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
    var opLat: Double?
    var opLon: Double?
    // ASTM F3411-22a Location message bytes 21-22 (uint16 LE): deciseconds
    // since the most recent UTC hour, range 0-36000. Drone-self-reported; the
    // backend stale-frame gate compares it to the last stored value to suppress
    // phantom POSTs from firmware cached re-broadcasts.
    var odidTimestamp: Int?

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
        r.opLat = other.opLat ?? opLat
        r.opLon = other.opLon ?? opLon
        r.odidTimestamp = other.odidTimestamp ?? odidTimestamp
        return r
    }
}

enum WSWOdidParser {
    static let appCode = 0x0D
    static let opStatusAirborne = 2
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
        let status = (Int(msg[1]) >> 4) & 0x0F
        let ewSeg = Int(msg[1]) & 0x01
        let dirMod = (Int(msg[2]) >> 1) & 0x7F
        let speedMult = Int(msg[2]) & 0x01
        let speedRaw = Int(msg[3]) & 0xFF

        let latRaw = readInt32LE(msg, 5)
        let lonRaw = readInt32LE(msg, 9)
        let altGeoRaw = readUInt16LE(msg, 15)
        let tsRaw = readUInt16LE(msg, 21)

        let lat = Double(latRaw) / 1e7
        let lon = Double(lonRaw) / 1e7
        let altGeo = (Double(altGeoRaw) * 0.5) - 1000.0
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
        var acc = WSWOdidResult()
        for i in 0..<msgCount {
            let offset = 2 + i * 25
            if offset + 25 > data.count { break }
            let sub = Array(data[offset..<(offset + 25)])
            acc = acc.merged(with: parseMessage(sub))
        }
        var out = acc
        out.msgType = msgType
        return out
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

import Foundation
import CoreLocation

// Swift port of android/app/src/main/java/com/westshoredrone/watch/NodeHeartbeatUploader.kt.
//
// POSTs /api/nodes/<deviceId>/heartbeat for every node seen via BLE in the last
// STALE window. Cadence + thresholds mirror the Kotlin constants exactly:
//   flush every 30s, skip nodes idle > 60s, forget nodes idle > 5 min.
//
// LOCATION: Android reads getLastKnownLocation per cycle. iOS uses
// CLLocationManager; this class is fed the most recent foreground location by
// WSWBLEScanner (which owns the CLLocationManager + authorization) rather than
// owning its own, so there is a single authorization prompt and one fix shared
// across detection/heartbeat needs.
final class WSWNodeHeartbeatUploader {

    // deviceId -> process-uptime seconds when most recently observed.
    private var lastSeen: [String: TimeInterval] = [:]
    private var loggedMissingNodes = Set<String>()
    private var currentlySkipping = Set<String>()
    private let lock = NSLock()

    private var baseUrl: String?
    private var authToken: String?

    // Most recent foreground location, pushed in by WSWBLEScanner.
    private var lastLocation: CLLocation?

    private var timer: DispatchSourceTimer?
    private let workQueue = DispatchQueue(label: "com.westshoredrone.watch.heartbeat-uploader")

    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 15
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg)
    }()

    private let flushIntervalSec: TimeInterval = 30
    private let staleSec: TimeInterval = 60
    private let forgetSec: TimeInterval = 300

    func configure(baseUrl: String?, authToken: String?) {
        lock.lock(); defer { lock.unlock() }
        self.baseUrl = baseUrl?.trimmedTrailingSlash()
        let t = authToken?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.authToken = (t?.isEmpty == false) ? t : nil
    }

    func updateLocation(_ loc: CLLocation?) {
        lock.lock(); defer { lock.unlock() }
        if let loc = loc { lastLocation = loc }
    }

    func start() {
        let t = DispatchSource.makeTimerSource(queue: workQueue)
        t.schedule(deadline: .now() + flushIntervalSec, repeating: flushIntervalSec)
        t.setEventHandler { [weak self] in self?.flushOnce() }
        timer = t
        t.resume()
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    func markNodeSeen(_ deviceId: String) {
        if deviceId.isEmpty { return }
        lock.lock(); defer { lock.unlock() }
        lastSeen[deviceId] = ProcessInfo.processInfo.systemUptime
    }

    private func flushOnce() {
        let now = ProcessInfo.processInfo.systemUptime

        lock.lock()
        // Forget nodes idle > 5 min so the map doesn't grow unbounded.
        for (id, seen) in lastSeen where now - seen > forgetSec {
            lastSeen.removeValue(forKey: id)
            currentlySkipping.remove(id)
        }
        if lastSeen.isEmpty { lock.unlock(); return }
        guard let url = baseUrl, let token = authToken else { lock.unlock(); return }
        let loc = lastLocation
        let entries = lastSeen
        lock.unlock()

        for (deviceId, seen) in entries {
            let idle = now - seen
            if idle > staleSec {
                lock.lock()
                let firstSkip = currentlySkipping.insert(deviceId).inserted
                lock.unlock()
                if firstSkip {
                    NSLog("[WSWNodeHeartbeatUploader] skip \(deviceId): stale \(Int(idle))s")
                }
                continue
            }
            lock.lock(); currentlySkipping.remove(deviceId); lock.unlock()
            postHeartbeat(baseUrl: url, token: token, deviceId: deviceId, loc: loc)
        }
    }

    private func postHeartbeat(baseUrl: String, token: String, deviceId: String, loc: CLLocation?) {
        var bodyObj: [String: Any] = ["connection_type": "ble_relay"]
        if let loc = loc {
            bodyObj["last_lat"] = loc.coordinate.latitude
            bodyObj["last_lon"] = loc.coordinate.longitude
        }
        guard let body = try? JSONSerialization.data(withJSONObject: bodyObj),
              let reqUrl = URL(string: "\(baseUrl)/api/nodes/\(deviceId)/heartbeat") else { return }

        var req = URLRequest(url: reqUrl)
        req.httpMethod = "POST"
        req.httpBody = body
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let task = session.dataTask(with: req) { [weak self] _, response, error in
            guard let self = self else { return }
            if error != nil { return } // transient — retry next cycle (idempotent)
            guard let http = response as? HTTPURLResponse else { return }
            switch http.statusCode {
            case 200..<300:
                break
            case 404:
                self.lock.lock()
                let firstTime = self.loggedMissingNodes.insert(deviceId).inserted
                self.lastSeen.removeValue(forKey: deviceId)
                self.lock.unlock()
                if firstTime {
                    NSLog("[WSWNodeHeartbeatUploader] POST 404 node=\(deviceId) (not in org), dropping this session")
                }
            case 401:
                self.lock.lock(); self.authToken = nil; self.lock.unlock()
            default:
                NSLog("[WSWNodeHeartbeatUploader] POST fail node=\(deviceId) status=\(http.statusCode)")
            }
        }
        task.resume()
    }
}

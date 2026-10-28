import Foundation

// Swift port of android/app/src/main/java/com/westshoredrone/watch/DetectionUploader.kt.
//
// Drives POSTs to /api/nodes/<deviceId>/detections. On Android this lives in a
// foreground service so uploads survive Doze; on iOS there is no equivalent —
// see WSWBLEScanner.swift for the background-execution constraints. The batching
// semantics, payload shape, and HTTP status handling mirror the Kotlin version
// exactly so the backend behaves identically regardless of relay platform.
//
// iOS NOTE: no SQLite persistence (Android doesn't persist either — the queue is
// in-memory there too). The app is session-based; queue loss on app exit is
// acceptable per the product decision.
final class WSWDetectionUploader {

    struct DroneRecord {
        let id: String
        let lat: Double
        let lon: Double
        let alt: Double?
        let spd: Double?
        let hdg: Double?
        let opLat: Double?
        let opLon: Double?
        // ASTM F3411-22a Location timestamp (deciseconds since the UTC hour).
        // Nullable for forward compat; backend treats missing as "skip the gate".
        let odidTimestamp: Int?
    }

    // deviceId -> (uasId -> latest record). Coalesces repeat sightings within a
    // flush window into the most recent reading per drone, matching Kotlin.
    private var queue: [String: [String: DroneRecord]] = [:]
    private let lock = NSLock()

    private var baseUrl: String?
    private var authToken: String?

    // Billing-pause backoff (402). Re-enqueue the batch and sit out flushes until
    // pausedUntil; backoff doubles 5s -> 60s cap, resets on the next 2xx.
    private var pausedBackoffMs: Double = 0
    private var pausedUntil: TimeInterval = 0

    private var loggedMissingNodes = Set<String>()

    // Last 2xx, in process-uptime seconds. Surfaced to the watchdog so it can
    // detect a stuck uploader (queue non-empty, no success in 30s).
    private var lastSuccessUptime: TimeInterval = 0
    private var reinitCounter = 0

    private var timer: DispatchSourceTimer?
    private let workQueue = DispatchQueue(label: "com.westshoredrone.watch.detection-uploader")

    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 15
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg)
    }()

    // Emits lifecycle events back to JS (DeploymentPaused / DeploymentResumed /
    // UploaderForcedReinit). Set by WSWBLEScanner so this class stays decoupled
    // from RCTEventEmitter.
    var emit: ((_ name: String, _ body: [String: Any]) -> Void)?

    private let flushIntervalMs: Double = 500
    private let maxPerNode = 200
    private let pausedBackoffInitialMs: Double = 5_000
    private let pausedBackoffCapMs: Double = 60_000
    private let uploadStallThresholdSec: TimeInterval = 30

    func configure(baseUrl: String?, authToken: String?) {
        lock.lock(); defer { lock.unlock() }
        self.baseUrl = baseUrl?.trimmedTrailingSlash()
        let t = authToken?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.authToken = (t?.isEmpty == false) ? t : nil
    }

    func start() {
        lock.lock(); lastSuccessUptime = ProcessInfo.processInfo.systemUptime; lock.unlock()
        let t = DispatchSource.makeTimerSource(queue: workQueue)
        t.schedule(deadline: .now() + .milliseconds(Int(flushIntervalMs)),
                   repeating: .milliseconds(Int(flushIntervalMs)))
        t.setEventHandler { [weak self] in self?.flushOnce() }
        timer = t
        t.resume()
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    func enqueue(deviceId: String, record: DroneRecord) {
        lock.lock(); defer { lock.unlock() }
        var bucket = queue[deviceId] ?? [:]
        if bucket.count >= maxPerNode && bucket[record.id] == nil { return }
        bucket[record.id] = record
        queue[deviceId] = bucket
    }

    func lastSuccessUptimeValue() -> TimeInterval {
        lock.lock(); defer { lock.unlock() }
        return lastSuccessUptime
    }

    func reinitCount() -> Int {
        lock.lock(); defer { lock.unlock() }
        return reinitCounter
    }

    func queueSize() -> Int {
        lock.lock(); defer { lock.unlock() }
        return queue.values.reduce(0) { $0 + $1.count }
    }

    // True when there's nothing to do right now: queue empty, not configured, or
    // sitting out a 402 backoff. The watchdog skips reinit under these.
    func isIdle() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if queue.isEmpty { return true }
        if baseUrl == nil || authToken == nil { return true }
        if ProcessInfo.processInfo.systemUptime < pausedUntil { return true }
        return false
    }

    // Mirrors DetectionUploader.reinitForStall. Nulls the token + emits
    // UploaderForcedReinit so JS re-pushes it; resets watchdog clock.
    func reinitForStall(_ reason: String) {
        lock.lock()
        let queued = queue.values.reduce(0) { $0 + $1.count }
        authToken = nil
        lastSuccessUptime = ProcessInfo.processInfo.systemUptime
        reinitCounter += 1
        lock.unlock()
        emit?("UploaderForcedReinit", ["reason": reason, "queued": queued])
    }

    private func flushOnce() {
        lock.lock()
        if queue.isEmpty { lock.unlock(); return }
        if ProcessInfo.processInfo.systemUptime < pausedUntil { lock.unlock(); return }
        guard let url = baseUrl, let token = authToken else {
            // Hold the buffer; configure() with a real token re-enables uploads.
            lock.unlock(); return
        }
        // Drain a snapshot.
        let snapshot = queue.map { ($0.key, Array($0.value.values)) }
        queue.removeAll(keepingCapacity: true)
        lock.unlock()

        for (deviceId, drones) in snapshot where !drones.isEmpty {
            postBatch(baseUrl: url, token: token, deviceId: deviceId, drones: drones)
        }
    }

    private func postBatch(baseUrl: String, token: String, deviceId: String, drones: [DroneRecord]) {
        var dronesJson: [[String: Any]] = []
        for d in drones {
            dronesJson.append([
                "id": d.id,
                "lat": d.lat,
                "lon": d.lon,
                "alt": d.alt as Any? ?? NSNull(),
                "spd": d.spd as Any? ?? NSNull(),
                "hdg": d.hdg as Any? ?? NSNull(),
                "op_lat": d.opLat as Any? ?? NSNull(),
                "op_lon": d.opLon as Any? ?? NSNull(),
                "ts": d.odidTimestamp as Any? ?? NSNull(),
            ])
        }
        let bodyObj: [String: Any] = ["drones": dronesJson]
        guard let body = try? JSONSerialization.data(withJSONObject: bodyObj),
              let reqUrl = URL(string: "\(baseUrl)/api/nodes/\(deviceId)/detections") else { return }

        var req = URLRequest(url: reqUrl)
        req.httpMethod = "POST"
        req.httpBody = body
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")

        // Synchronous within the workQueue tick (mirrors Kotlin's blocking
        // OkHttp call inside the flush loop). A semaphore keeps the batch
        // ordering and backoff bookkeeping simple.
        let sem = DispatchSemaphore(value: 0)
        let task = session.dataTask(with: req) { [weak self] data, response, error in
            defer { sem.signal() }
            guard let self = self else { return }
            if let error = error {
                // Transient network failure — requeue (cap-bounded).
                self.requeue(deviceId: deviceId, drones: drones)
                NSLog("[WSWDetectionUploader] POST io error node=\(deviceId): \(error.localizedDescription) — requeueing")
                return
            }
            guard let http = response as? HTTPURLResponse else { return }
            switch http.statusCode {
            case 200..<300:
                self.lock.lock()
                self.lastSuccessUptime = ProcessInfo.processInfo.systemUptime
                let wasPaused = self.pausedBackoffMs > 0
                if wasPaused {
                    self.pausedBackoffMs = 0
                    self.pausedUntil = 0
                }
                self.lock.unlock()
                if wasPaused { self.emit?("DeploymentResumed", [:]) }
            case 404:
                self.lock.lock()
                let firstTime = self.loggedMissingNodes.insert(deviceId).inserted
                self.lock.unlock()
                if firstTime {
                    NSLog("[WSWDetectionUploader] POST 404 node=\(deviceId) (not in org), dropping future uploads this session")
                }
            case 401:
                NSLog("[WSWDetectionUploader] POST 401 node=\(deviceId) — token rejected, clearing for JS re-configure")
                self.lock.lock(); self.authToken = nil; self.lock.unlock()
            case 402:
                var deploymentId: String?
                if let data = data,
                   let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let did = obj["deployment_id"] as? String, !did.isEmpty {
                    deploymentId = did
                }
                self.requeue(deviceId: deviceId, drones: drones)
                self.lock.lock()
                self.pausedBackoffMs = self.pausedBackoffMs == 0
                    ? self.pausedBackoffInitialMs
                    : min(self.pausedBackoffMs * 2, self.pausedBackoffCapMs)
                self.pausedUntil = ProcessInfo.processInfo.systemUptime + self.pausedBackoffMs / 1000.0
                self.lock.unlock()
                var payload: [String: Any] = [:]
                if let deploymentId = deploymentId { payload["deployment_id"] = deploymentId }
                self.emit?("DeploymentPaused", payload)
            default:
                NSLog("[WSWDetectionUploader] POST fail node=\(deviceId) status=\(http.statusCode)")
            }
        }
        task.resume()
        _ = sem.wait(timeout: .now() + 20)
    }

    private func requeue(deviceId: String, drones: [DroneRecord]) {
        lock.lock(); defer { lock.unlock() }
        var bucket = queue[deviceId] ?? [:]
        for d in drones {
            if bucket.count >= maxPerNode && bucket[d.id] == nil { break }
            if bucket[d.id] == nil { bucket[d.id] = d }
        }
        queue[deviceId] = bucket
    }
}

extension String {
    func trimmedTrailingSlash() -> String {
        var s = self
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }
}

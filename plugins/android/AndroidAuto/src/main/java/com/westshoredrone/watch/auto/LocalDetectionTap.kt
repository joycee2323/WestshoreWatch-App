package com.westshoredrone.watch.auto

/**
 * Hook for BLEScannerService: every detection it enqueues for upload is also
 * offered here, so the car list can show node-relayed drones without waiting for
 * the backend round trip (and still show them with no cellular data).
 *
 * With no car session running, [sink] is null and [onLocalDetection] returns
 * immediately, so the phone app's behavior is unchanged. A throwing sink is
 * swallowed: the car feature can never break the upload path.
 */
object LocalDetectionTap {
    @Volatile var sink: ((DroneObservation) -> Unit)? = null

    private const val OP_STATUS_GROUND = 1
    private const val ON_GROUND_MAX_SPEED_MPS = 0.5
    private const val ON_GROUND_MAX_HEIGHT_M = 3.0

    @JvmStatic
    fun onLocalDetection(
        uasId: String,
        lat: Double,
        lon: Double,
        heightM: Double?,
        speedMps: Double?,
        headingDeg: Double?,
        opLat: Double?,
        opLon: Double?,
        status: Int?,
        specDecoded: Boolean,
    ) {
        val s = sink ?: return
        try {
            s(
                DroneObservation(
                    uasId = uasId,
                    nickname = null,
                    lat = lat,
                    lon = lon,
                    altitudeM = heightM,
                    altitudeKind = AltitudeKind.HEIGHT,
                    speedMps = speedMps,
                    headingDeg = headingDeg,
                    opLat = opLat,
                    opLon = opLon,
                    observedAtMs = System.currentTimeMillis(),
                    onGround = isOnGroundFrame(status, speedMps, heightM),
                    source = DroneSource.LOCAL_BLE,
                    kinematicsReliable = specDecoded,
                ),
            )
        } catch (_: Throwable) {
            // Never let the car feature affect the BLE/upload path.
        }
    }

    /** Same rule as src/services/onGround.ts isOnGroundFrame. */
    fun isOnGroundFrame(status: Int?, speedMps: Double?, heightM: Double?): Boolean {
        if (status != OP_STATUS_GROUND) return false
        if (speedMps == null || speedMps.isNaN() || speedMps > ON_GROUND_MAX_SPEED_MPS) return false
        if (heightM != null && !heightM.isNaN() && heightM > ON_GROUND_MAX_HEIGHT_M) return false
        return true
    }
}

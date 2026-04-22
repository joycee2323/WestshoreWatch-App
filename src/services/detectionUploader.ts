// @deprecated — uploads moved to the Kotlin foreground service so they
// survive Android Doze mode (the JS thread is suspended when the screen is
// off, which was dropping detections). See android/.../DetectionUploader.kt.
// This file is a no-op stub kept for one release so callers don't break;
// delete after the native path has soaked in a release build.

export interface QueueInput {
  sourceMac: string;
  uasId: string;
  lat: number;
  lon: number;
  altGeo?: number;
  rssi: number;
  opLat?: number;
  opLon?: number;
  speedHoriz?: number;
  heading?: number;
  timestamp?: number;
}

export function queueDetection(_input: QueueInput): void {
  // Intentionally empty. Native uploader handles POSTs now.
}

// Does a backend `rejected` verdict cancel the pending local "New Drone
// Detected" fallback (droneNotifier.applyUploadResult)? Pure, so it is
// testable under plain Node: test/fallbackCancel.test.mjs.
//
// Stale-frame reasons (too_old / unchanged / out_of_order / frozen) are about
// ONE frame, so they cancel only when the rejected frame is the one that armed
// the fallback (or either side has no ts to compare) — a fresh frame of the
// same drone must still be able to alert.
//
// "grounded" (WestshoreWatch-Backend services/groundedState.js) is about the
// AIRCRAFT: it is parked, and the backend deliberately sends no push. The
// uploaders post the latest frame per 500 ms flush, so its ts rarely equals
// the arming frame's; matching on ts would let the fallback fire for a docked
// aircraft. A launch is pushed by the backend (accepted, not rejected), so
// cancelling here never hides a real flight's backend alert.
export function rejectionCancelsFallback(
  armedTs: number | null,
  rejectedTs: number | null,
  reason?: string,
): boolean {
  if (reason === 'grounded') return true;
  return armedTs === null || rejectedTs === null || armedTs === rejectedTs;
}

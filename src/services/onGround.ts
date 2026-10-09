// Local "on ground" DISPLAY rule for BLE frames (passive live map, guest scan).
// Pure, so it is testable under plain Node: test/onGround.test.mjs.
//
// LABEL / GREY ONLY. A frame that matches is drawn greyed (passive map) or
// labelled "ON GROUND" (guest scan); it is NEVER removed from the screen and
// NEVER suppresses a local alert. A hovering drone that wrongly reports
// status 1 must stay visible. Alerts follow the backend's grounded decision
// (WestshoreWatch-Backend services/groundedState.js), which uses an anchor,
// altitude and a 5-minute rule this per-frame check does not have.
//
// Thresholds match the backend's per-frame grounded rules:
//   status == 1 (on ground), explicitly
//   horizontal speed known and <= 0.5 m/s (unknown speed = not on ground)
//   height <= 3 m, or height unknown

export const OP_STATUS_GROUND = 1;
export const ON_GROUND_MAX_SPEED_MPS = 0.5;
export const ON_GROUND_MAX_HEIGHT_M = 3;
export const ON_GROUND_COLOR = '#9ca3af';

export interface OnGroundInput {
  status?: number | null;
  speedHoriz?: number | null;
  height?: number | null;
}

export function isOnGroundFrame(d: OnGroundInput | null | undefined): boolean {
  if (!d) return false;
  if (d.status !== OP_STATUS_GROUND) return false;
  if (typeof d.speedHoriz !== 'number' || !Number.isFinite(d.speedHoriz)) return false;
  if (d.speedHoriz > ON_GROUND_MAX_SPEED_MPS) return false;
  if (typeof d.height === 'number' && Number.isFinite(d.height) && d.height > ON_GROUND_MAX_HEIGHT_M) return false;
  return true;
}

// Guest-scan status text. Only the full on-ground rule says "ON GROUND";
// status 1 alone (e.g. moving on the ground) says what the drone reports.
export function guestStatusLabel(d: OnGroundInput | null | undefined): string {
  if (isOnGroundFrame(d)) return '● ON GROUND';
  switch (d?.status) {
    case 2: return '↑ AIRBORNE';
    case 3: return '⚠ EMERGENCY';
    case 4: return '⚠ RID SYSTEM FAILURE';
    case 1: return '○ GROUND STATUS';
    default: return '○ STATUS UNKNOWN';
  }
}

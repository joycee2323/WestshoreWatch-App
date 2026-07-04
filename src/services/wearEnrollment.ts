import { api, API_BASE } from './api';
import { WearBridge, ConnectedWatch } from '../native/WearBridge';

export interface EnrollmentResult {
  sentTo: string; // watch display name
  expiresIn: number; // seconds the code is valid
}

// Phone side of the one-time Wear enrollment handshake.
//
// HELD: this is authored but intentionally NOT wired to a UI action or auto-run
// yet. Exercising /auth/device/enroll-code + the handoff against an UNVERIFIED
// backend is the ambiguity we're avoiding — do not call this from a screen until
// the backend device-auth lifecycle is proven green on staging
// (`npm run verify:staging`). Then task 9 wires the watch side and we exercise
// this end-to-end.
//
// Flow: confirm a watch is paired -> mint a short-lived (90s) SINGLE-USE code
// (authenticated as this user) -> hand { code, apiBase } to the watch over the
// encrypted Data Layer. The raw user JWT never leaves the phone; the watch
// redeems the code for its OWN device tokens at `${apiBase}/auth/device/enroll`.
export async function enrollPairedWatch(preferredNodeId?: string): Promise<EnrollmentResult> {
  if (!WearBridge.isAvailable()) {
    throw new Error('Wear bridge unavailable on this build/platform');
  }

  const watches: ConnectedWatch[] = await WearBridge.getConnectedWatches();
  if (watches.length === 0) {
    throw new Error('No paired watch found. Open the watch app and try again.');
  }
  const target =
    (preferredNodeId ? watches.find((w) => w.id === preferredNodeId) : undefined) ?? watches[0];

  // Mint the code AFTER confirming a watch is present, so a 90s code isn't
  // burned before the handoff can happen.
  const { code, expiresIn } = await api.getWearEnrollCode();
  const payload = JSON.stringify({ code, apiBase: API_BASE });
  await WearBridge.sendEnrollment(target.id, payload);

  return { sentTo: target.displayName, expiresIn };
}

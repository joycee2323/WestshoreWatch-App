import { Platform } from 'react-native';
import { caps as baseCaps, type CapsUser, type Caps } from './caps';

export interface CapsWithDevice extends Caps {
  canPairNodeOnThisDevice: boolean;
}

/**
 * useCaps — role-derived capabilities for the current user.
 *
 * `canPairNodeOnThisDevice` = the role-based `canPairNode` AND the platform
 * can actually discover and claim a node over BLE — which is Android-only.
 * iOS CoreBluetooth never delivers the 0x08FE node-identity advert (the
 * "device_id wall", see services/bleScanner.ts) and never exposes the
 * hardware MAC, so the claim-by-MAC pairing flow cannot work there: the
 * scanner would run forever and surface nothing. Gating here keeps every
 * pairing entry point (Add Node scan, the Nodes-tab "+ ADD" / "SCAN FOR
 * NEARBY NODE" buttons) hidden on iOS while leaving the read-only Nodes
 * view intact. (Restores the guard removed in a2b33ce8.)
 */
export function useCaps(user: CapsUser): CapsWithDevice {
  const base = baseCaps(user);
  return {
    ...base,
    canPairNodeOnThisDevice: base.canPairNode && Platform.OS === 'android',
  };
}

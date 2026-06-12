import { caps as baseCaps, type CapsUser, type Caps } from './caps';

export interface CapsWithDevice extends Caps {
  canPairNodeOnThisDevice: boolean;
}

/**
 * useCaps — role-derived capabilities for the current user.
 *
 * `canPairNodeOnThisDevice` is currently identical to the role-based
 * `canPairNode`: every supported platform (Android and iOS) ships a native
 * BLE scanner, so pairing is available wherever the role allows it. It is
 * kept as a distinct, forward-compatible name (rather than collapsing call
 * sites back onto `canPairNode`) so that any future device-level constraint
 * on pairing can be folded in here without touching every screen.
 */
export function useCaps(user: CapsUser): CapsWithDevice {
  const base = baseCaps(user);
  return {
    ...base,
    canPairNodeOnThisDevice: base.canPairNode,
  };
}

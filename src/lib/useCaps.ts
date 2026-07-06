import { Platform } from 'react-native';
import { caps as baseCaps, type CapsUser, type Caps } from './caps';

export interface CapsWithDevice extends Caps {
  canPairNodeOnThisDevice: boolean;
}

export function useCaps(user: CapsUser): CapsWithDevice {
  const base = baseCaps(user);
  return {
    ...base,
    canPairNodeOnThisDevice: base.canPairNode && Platform.OS === 'android',
  };
}

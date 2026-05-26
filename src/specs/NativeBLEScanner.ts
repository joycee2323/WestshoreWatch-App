import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  startService(): Promise<void>;
  configure(config: Object): Promise<void>;
  addListener(eventType: string): void;
  removeListeners(count: number): void;
  getWatchdogStats(): Promise<Object>;
  stopService(): Promise<void>;
}

// Android-only: iOS is viewer-only and has no BLE native module. Using get()
// (returns null) instead of getEnforcing() (throws) so the iOS bundle loads
// without crashing. bleScanner.ts null-guards every call site.
export default TurboModuleRegistry.get<Spec>('BLEScanner');

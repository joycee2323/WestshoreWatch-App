import { NativeModules } from 'react-native';

// Typed wrapper around the WearBridge native module
// (android/.../WearBridgeModule.kt). The module is present only on Android
// builds that include the native code — absent on iOS and in Expo Go — so every
// call guards for `native` being undefined.

export interface ConnectedWatch {
  id: string;
  displayName: string;
  nearby: boolean;
}

interface WearBridgeNative {
  getConnectedWatches(): Promise<ConnectedWatch[]>;
  sendEnrollment(nodeId: string, payloadJson: string): Promise<void>;
}

const native: WearBridgeNative | undefined = NativeModules.WearBridge;

export const WearBridge = {
  isAvailable(): boolean {
    return !!native;
  },
  getConnectedWatches(): Promise<ConnectedWatch[]> {
    if (!native) return Promise.resolve([]);
    return native.getConnectedWatches();
  },
  sendEnrollment(nodeId: string, payloadJson: string): Promise<void> {
    if (!native) {
      return Promise.reject(new Error('WearBridge native module unavailable'));
    }
    return native.sendEnrollment(nodeId, payloadJson);
  },
};

// Expo Push integration: token registration, foreground handler,
// Android notification channels, listeners + deep-link routing.
//
// Token lifecycle:
//   - registerForPushNotifications() runs after successful login,
//     persists the token in SecureStore (key=PUSH_TOKEN_KEY), and POSTs
//     it to the backend so the user's row in push_tokens is current.
//   - revokePushToken() runs before logout, DELETEs the row from the
//     backend (token-only, no JWT required) and clears local storage.
//
// The notification handler is configured at module-load time (called
// from App.tsx) so foreground arrivals still surface a banner. Channels
// are created idempotently on every app launch.
//
// Backend channelId routing: not currently set in the Expo Push payload
// from the server. Android delivers all kinds to the system default
// channel. The four channels declared here still let users mute
// categories at the OS level (Settings → Apps → Westshore Watch →
// Notifications) once the backend wires `channelId` per kind. See
// the project notes for the planned backend follow-up.

import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { api } from './api';

const PUSH_TOKEN_KEY = 'push_token';
const PUSH_REGISTRATION_STATUS_KEY = 'push_registration_status';

export type RegistrationStep =
  | 'permission'
  | 'device'
  | 'token'
  | 'register'
  | 'success';

export interface RegistrationStatus {
  timestamp: string;
  success: boolean;
  step: RegistrationStep;
  error?: string;
  token?: string;
}

// Persist the most recent registerForPushNotifications outcome so the
// Settings → "Push diagnostic" row can surface it without needing
// adb logcat. Best-effort write (SecureStore failures swallowed —
// this is debugging UI, not load-bearing).
async function recordRegistrationStatus(status: RegistrationStatus): Promise<void> {
  try {
    await SecureStore.setItemAsync(PUSH_REGISTRATION_STATUS_KEY, JSON.stringify(status));
  } catch (err) {
    console.warn('[pushReg] failed to persist registration status:', err);
  }
}

// Read the most recent registration outcome. Used by the Settings
// "Push diagnostic" row.
export async function getLastRegistrationStatus(): Promise<RegistrationStatus | null> {
  try {
    const raw = await SecureStore.getItemAsync(PUSH_REGISTRATION_STATUS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed as RegistrationStatus;
  } catch (err) {
    console.warn('[pushReg] failed to read registration status:', err);
    return null;
  }
}

export const NOTIFICATION_KIND_CHANNELS: Record<string, string> = {
  drone_detected: 'drone_alerts',
  deployment_paused: 'deployment_alerts',
  deployment_resumed: 'deployment_alerts',
  deployment_cancelled: 'deployment_alerts',
  deployment_expired: 'deployment_alerts',
  node_online: 'node_alerts',
  node_offline: 'node_alerts',
  billing_subscription_cancelled: 'billing_alerts',
  billing_payment_failed: 'billing_alerts',
  billing_subscription_expiring: 'billing_alerts',
};

// Configure foreground notification handling. Banner + sound + badge
// shown even when the app is in the foreground — without this the OS
// silently swallows pushes that arrive while the user is in-app.
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
}

// Create the four Android notification channels. No-op on iOS. Idempotent.
export async function setupAndroidChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const channels: Array<{
    id: string;
    name: string;
    importance: Notifications.AndroidImportance;
  }> = [
    { id: 'drone_alerts', name: 'Drone Alerts', importance: Notifications.AndroidImportance.HIGH },
    { id: 'deployment_alerts', name: 'Deployment Alerts', importance: Notifications.AndroidImportance.DEFAULT },
    { id: 'node_alerts', name: 'Node Alerts', importance: Notifications.AndroidImportance.DEFAULT },
    { id: 'billing_alerts', name: 'Billing Alerts', importance: Notifications.AndroidImportance.HIGH },
  ];
  for (const ch of channels) {
    try {
      await Notifications.setNotificationChannelAsync(ch.id, {
        name: ch.name,
        importance: ch.importance,
        vibrationPattern: [0, 250, 250, 250],
        sound: 'default',
        enableLights: true,
        enableVibrate: true,
      });
    } catch (err) {
      console.warn(`[push] failed to create channel ${ch.id}:`, err);
    }
  }
}

// Read the EAS project id from app.config.js extra.eas.projectId. The
// expo SDK requires this for getExpoPushTokenAsync — without it, the
// call throws on standalone builds. Constants.expoConfig is null in
// some bare-RN scenarios; fall back to easConfig.
function readProjectId(): string | undefined {
  const fromExpo = (Constants.expoConfig as any)?.extra?.eas?.projectId;
  if (typeof fromExpo === 'string' && fromExpo.length > 0) return fromExpo;
  const fromEas = (Constants as any).easConfig?.projectId;
  if (typeof fromEas === 'string' && fromEas.length > 0) return fromEas;
  return undefined;
}

// Acquire an Expo Push token from the device, persist it, and POST it
// to the backend. Returns the token on success, null on any failure
// (permission denied, simulator, network error). Safe to call on every
// login — backend UPSERTs by token.
//
// Every step writes a [pushReg] console log AND persists a status
// snapshot to SecureStore so SettingsScreen → "Push diagnostic" can
// show the most recent outcome without adb logcat. The status
// instrumentation is debug-only — remove before production.
export async function registerForPushNotifications(): Promise<string | null> {
  console.log('[pushReg] starting registration flow');

  if (!Device.isDevice) {
    console.log('[pushReg] step=device result=fail (simulator/emulator)');
    await recordRegistrationStatus({
      timestamp: new Date().toISOString(),
      success: false,
      step: 'device',
      error: 'Not a physical device',
    });
    return null;
  }
  console.log('[pushReg] step=device result=ok (Device.isDevice=true)');

  try {
    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    console.log(`[pushReg] step=permission existing.status=${status}`);
    if (status !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      status = req.status;
      console.log(`[pushReg] step=permission requested.status=${status}`);
    }
    if (status !== 'granted') {
      console.log('[pushReg] step=permission result=fail (denied)');
      await recordRegistrationStatus({
        timestamp: new Date().toISOString(),
        success: false,
        step: 'permission',
        error: `Permission status: ${status}`,
      });
      return null;
    }
    console.log('[pushReg] step=permission result=ok');

    const projectId = readProjectId();
    console.log(`[pushReg] step=token projectId=${projectId || '<none>'}`);
    if (!projectId) {
      console.warn('[pushReg] no projectId found in app.config — Expo Push will fail in standalone builds');
    }

    let token: string;
    try {
      const tokenResponse = await Notifications.getExpoPushTokenAsync(
        projectId ? { projectId } : undefined,
      );
      token = tokenResponse.data;
      console.log(`[pushReg] step=token result=ok token=${token ? token.slice(0, 24) + '...' : '<empty>'}`);
    } catch (tokenErr: any) {
      const msg = tokenErr?.message || String(tokenErr);
      console.warn('[pushReg] step=token result=fail error=', msg);
      await recordRegistrationStatus({
        timestamp: new Date().toISOString(),
        success: false,
        step: 'token',
        error: msg,
      });
      return null;
    }
    if (!token) {
      console.warn('[pushReg] step=token result=fail empty');
      await recordRegistrationStatus({
        timestamp: new Date().toISOString(),
        success: false,
        step: 'token',
        error: 'getExpoPushTokenAsync returned empty token',
      });
      return null;
    }

    try {
      await api.registerPushToken(token, Platform.OS === 'ios' ? 'ios' : 'android');
      console.log('[pushReg] step=register result=ok');
    } catch (err: any) {
      const status = err?.status ? `HTTP ${err.status}` : '';
      const msg = `${status} ${err?.message || String(err)}`.trim();
      console.warn('[pushReg] step=register result=fail error=', msg);
      await recordRegistrationStatus({
        timestamp: new Date().toISOString(),
        success: false,
        step: 'register',
        error: msg,
        token,
      });
      // Keep the local token so a retry on next launch can recover.
      // Don't throw to caller.
      try {
        await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token);
      } catch {}
      return null;
    }

    try {
      await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token);
    } catch (err) {
      console.warn('[pushReg] SecureStore.set failed:', err);
    }
    console.log('[pushReg] step=success');
    await recordRegistrationStatus({
      timestamp: new Date().toISOString(),
      success: true,
      step: 'success',
      token,
    });
    return token;
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.warn('[pushReg] unexpected failure:', msg);
    await recordRegistrationStatus({
      timestamp: new Date().toISOString(),
      success: false,
      step: 'token',
      error: `Unexpected: ${msg}`,
    });
    return null;
  }
}

// Tell the backend to forget this device's token, then drop the local
// copy. Logout flow calls this BEFORE clearing auth_token (revoke
// endpoint doesn't require auth, but the order keeps the local state
// consistent if the network call fails).
export async function revokePushToken(): Promise<void> {
  let token: string | null = null;
  try {
    token = await SecureStore.getItemAsync(PUSH_TOKEN_KEY);
  } catch {
    token = null;
  }
  if (!token) return;
  try {
    await api.revokePushTokenServer(token);
  } catch (err) {
    console.warn('[push] backend revoke failed (continuing):', err);
  }
  try {
    await SecureStore.deleteItemAsync(PUSH_TOKEN_KEY);
  } catch {
    /* swallow */
  }
}

// Map a notification payload's `screen` field to a navigation action.
// Called by the response listener and by in-app row taps.
export function deepLinkForNotification(navigation: any, data: any): void {
  if (!navigation) return;
  const screen = data && typeof data.screen === 'string' ? data.screen : '';
  const deploymentId = data && typeof data.deployment_id === 'string' ? data.deployment_id : undefined;
  try {
    switch (screen) {
      case 'LiveMap':
        navigation.navigate('Main', { screen: 'LiveMap' });
        break;
      case 'DeploymentDetail':
        navigation.navigate('Main', { screen: 'Deployments', params: { deployment_id: deploymentId } });
        break;
      case 'Nodes':
        navigation.navigate('Main', { screen: 'Nodes' });
        break;
      case 'Billing':
        // BillingScreen is rendered in-place from SettingsScreen via
        // local state, not a navigation route — the best we can do
        // without a deeper refactor is land the user on Settings.
        navigation.navigate('Main', { screen: 'Settings' });
        break;
      default:
        navigation.navigate('Notifications');
        break;
    }
  } catch (err) {
    console.warn('[push] deepLinkForNotification failed:', err);
  }
}

export interface PushListeners {
  remove: () => void;
}

// Attach foreground + tap listeners. Call from a useEffect inside the
// authenticated navigator and call the returned remove() on cleanup.
// onForegroundReceived runs on every arrival regardless of app state —
// callers use it to bump the unread badge in their notifications store.
export function setupNotificationListeners(
  navigation: any,
  onForegroundReceived?: (notification: Notifications.Notification) => void,
): PushListeners {
  const subReceived = Notifications.addNotificationReceivedListener(notification => {
    try {
      if (onForegroundReceived) onForegroundReceived(notification);
    } catch (err) {
      console.warn('[push] onForegroundReceived threw:', err);
    }
  });
  const subResponse = Notifications.addNotificationResponseReceivedListener(response => {
    try {
      const data = response?.notification?.request?.content?.data || {};
      deepLinkForNotification(navigation, data);
    } catch (err) {
      console.warn('[push] response listener failed:', err);
    }
  });
  return {
    remove() {
      try { subReceived.remove(); } catch {}
      try { subResponse.remove(); } catch {}
    },
  };
}

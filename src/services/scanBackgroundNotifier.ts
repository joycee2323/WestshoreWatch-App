// iOS-only local-notification safeguard for Bluetooth scanning.
//
// iOS throttles/suspends BLE scanning when the app is backgrounded or the
// screen is locked. When the user backgrounds the app while a scan is
// actively running, we schedule a short-delayed local notification nudging
// them to reopen the app. If they return before the delay elapses, the caller
// cancels it, so brief app-switches don't fire a notification.
//
// This uses its own notification category ('scan_background'), intentionally
// distinct from operational-alert kinds (drone_detected, node_online/offline,
// deployment/billing), so iOS groups these warnings on their own thread and a
// user muting one class of notification doesn't mute the other. The
// droneNotifier cross-reference listener ignores anything whose
// data.kind !== 'drone_detected', so this category never interferes with it.

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// Category / thread identifier, distinct from every operational-alert kind.
export const SCAN_BACKGROUND_CATEGORY = 'scan_background';

// Delay before the warning fires. Long enough that a quick app-switch (glance
// at another app, accept a call, pull notification center) is cancelled on
// return; short enough that a genuine background gap surfaces promptly.
const SCAN_WARNING_DELAY_SEC = 12;

let categoryRegistered = false;

// Register the dedicated iOS notification category once. Best-effort — if it
// fails the notification still delivers, just without its own category.
async function ensureCategory(): Promise<void> {
  if (categoryRegistered || Platform.OS !== 'ios') return;
  try {
    await Notifications.setNotificationCategoryAsync(SCAN_BACKGROUND_CATEGORY, []);
    categoryRegistered = true;
  } catch (err) {
    console.warn('[scanBgNotifier] category registration failed:', err);
  }
}

// Whether notification permission is granted right now. Used to choose between
// an OS notification and the in-app banner fallback. We only read status here;
// permission is requested at boot (droneNotifier / pushNotifications).
export async function hasNotificationPermission(): Promise<boolean> {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    return status === 'granted';
  } catch (err) {
    console.warn('[scanBgNotifier] permission check failed:', err);
    return false;
  }
}

// Schedule the "Detection limited" warning to fire after a short delay.
// Returns the scheduled-notification id (pass it to cancelScanWarning on
// return) or null if nothing was scheduled.
export async function scheduleScanWarning(): Promise<string | null> {
  if (Platform.OS !== 'ios') return null;
  await ensureCategory();
  try {
    return await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Detection limited',
        body: 'Westshore Watch is in the background. iOS is limiting Bluetooth scanning — reopen the app and keep the screen on for continuous detection.',
        sound: 'default',
        categoryIdentifier: SCAN_BACKGROUND_CATEGORY,
        data: { kind: 'scan_background_warning' },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: SCAN_WARNING_DELAY_SEC,
        repeats: false,
      },
    });
  } catch (err) {
    console.warn('[scanBgNotifier] schedule failed:', err);
    return null;
  }
}

// Cancel a previously-scheduled warning. Safe to call with null.
export async function cancelScanWarning(id: string | null): Promise<void> {
  if (!id) return;
  try {
    await Notifications.cancelScheduledNotificationAsync(id);
  } catch (err) {
    console.warn('[scanBgNotifier] cancel failed:', err);
  }
}

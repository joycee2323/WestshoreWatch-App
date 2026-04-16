import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// UAS IDs already notified this session — don't repeat.
const notifiedUasIds = new Set<string>();

let permissionStatus: 'unknown' | 'granted' | 'denied' = 'unknown';
let initPromise: Promise<void> | null = null;

export function initDroneNotifications(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowAlert: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        }),
      });

      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('drone-detections', {
          name: 'Drone Detections',
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
        });
      }

      const existing = await Notifications.getPermissionsAsync();
      let status = existing.status;
      if (status !== 'granted') {
        const req = await Notifications.requestPermissionsAsync();
        status = req.status;
      }
      permissionStatus = status === 'granted' ? 'granted' : 'denied';
    } catch (e) {
      console.warn('[droneNotifier] init failed:', e);
      permissionStatus = 'denied';
    }
  })();
  return initPromise;
}

export async function notifyNewDrone(uasId: string): Promise<void> {
  if (!uasId) return;
  if (notifiedUasIds.has(uasId)) return;
  notifiedUasIds.add(uasId);

  if (permissionStatus !== 'granted') return;

  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'New Drone Detected',
        body: `UAS ID: ${uasId}`,
        sound: 'default',
      },
      trigger: Platform.OS === 'android'
        ? { channelId: 'drone-detections' } as any
        : null,
    });
  } catch (e) {
    console.warn('[droneNotifier] schedule failed:', e);
  }
}

export function resetNotifiedDrones(): void {
  notifiedUasIds.clear();
}

import React, { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';
import AppNavigator from './src/navigation/AppNavigator';
import { initDroneNotifications } from './src/services/droneNotifier';
import { KEEP_SCREEN_ON_STORAGE_KEY } from './src/components/KeepScreenOnToggle';

const LEGACY_KEEP_SCREEN_ON_KEY = 'live_map_keep_screen_on';

async function migrateKeepScreenOnKey() {
  try {
    const legacy = await AsyncStorage.getItem(LEGACY_KEEP_SCREEN_ON_KEY);
    if (legacy == null) return;
    const current = await AsyncStorage.getItem(KEEP_SCREEN_ON_STORAGE_KEY);
    if (current == null) {
      await AsyncStorage.setItem(KEEP_SCREEN_ON_STORAGE_KEY, legacy);
    }
    await AsyncStorage.removeItem(LEGACY_KEEP_SCREEN_ON_KEY);
  } catch (err) {
    console.warn('keep_screen_on migration failed:', err);
  }
}

export default function App() {
  useEffect(() => {
    void migrateKeepScreenOnKey();
    void initDroneNotifications();
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppNavigator />
    </GestureHandlerRootView>
  );
}

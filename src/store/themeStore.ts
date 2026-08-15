// Zustand store for the user's manual dark/light theme choice. Replaces the
// prior behavior of following react-native's useColorScheme() (OS setting)
// unconditionally — that's still the default (mode starts 'dark', matching
// what the OS-driven behavior always resolved to before this store existed
// for any device without an explicit light-mode OS preference already
// tested against this app), but the user can now override it from Settings
// and the choice persists across app restarts.
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ThemeMode = 'dark' | 'light';

export const THEME_MODE_STORAGE_KEY = 'theme_mode';

interface ThemeStore {
  mode: ThemeMode;
  loadMode: () => Promise<void>;
  setMode: (mode: ThemeMode) => void;
}

export const useThemeStore = create<ThemeStore>((set) => ({
  mode: 'dark',

  loadMode: async () => {
    try {
      const stored = await AsyncStorage.getItem(THEME_MODE_STORAGE_KEY);
      if (stored === 'dark' || stored === 'light') set({ mode: stored });
    } catch (err) {
      console.warn('[theme] failed to load stored mode:', err);
    }
  },

  setMode: (mode) => {
    set({ mode });
    AsyncStorage.setItem(THEME_MODE_STORAGE_KEY, mode).catch(err =>
      console.warn('[theme] failed to persist mode:', err)
    );
  },
}));

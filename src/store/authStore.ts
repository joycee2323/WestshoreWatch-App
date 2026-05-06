import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { api } from '../services/api';
import { fetchNodes as fetchNodeRegistry, clearCache as clearNodeRegistry } from '../services/nodeRegistry';
import { configureNativeUpload } from '../services/bleScanner';
import { registerForPushNotifications, revokePushToken } from '../services/pushNotifications';

interface AuthStore {
  token: string | null;
  user: any | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  loadToken: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set) => ({
  token: null,
  user: null,
  isLoading: true,

  loadToken: async () => {
    try {
      const token = await SecureStore.getItemAsync('auth_token');
      const userJson = await SecureStore.getItemAsync('auth_user');
      if (token && userJson) {
        set({ token, user: JSON.parse(userJson), isLoading: false });
        void configureNativeUpload(token);
        void fetchNodeRegistry();
        // Re-register the device's push token on every cold start so a
        // backend-side token reap (DeviceNotRegistered sweep) doesn't
        // leave the user permanently unreachable. UPSERTs by token,
        // so a no-op when the row is already current.
        void registerForPushNotifications();
      } else {
        set({ isLoading: false });
      }
    } catch {
      set({ isLoading: false });
    }
  },

  login: async (email, password) => {
    const res = await api.login(email, password);
    await SecureStore.setItemAsync('auth_token', res.token);
    await SecureStore.setItemAsync('auth_user', JSON.stringify(res.user));
    set({ token: res.token, user: res.user });
    void configureNativeUpload(res.token);
    void fetchNodeRegistry();
    void registerForPushNotifications();
  },

  logout: async () => {
    // Revoke push token BEFORE clearing auth_token so the DELETE call
    // doesn't strand the device on the user's row. The endpoint is
    // unauthenticated, but keeping the order means a network failure
    // at this step doesn't lose the local logout.
    try { await revokePushToken(); } catch {}
    await SecureStore.deleteItemAsync('auth_token');
    await SecureStore.deleteItemAsync('auth_user');
    clearNodeRegistry();
    void configureNativeUpload(null);
    set({ token: null, user: null });
  },
}));

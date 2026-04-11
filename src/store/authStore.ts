import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { api } from '../services/api';

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
  },

  logout: async () => {
    await SecureStore.deleteItemAsync('auth_token');
    await SecureStore.deleteItemAsync('auth_user');
    set({ token: null, user: null });
  },
}));

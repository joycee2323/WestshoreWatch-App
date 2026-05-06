// Zustand store for the in-app notification feed + unread badge +
// preference toggles. The backend is the source of truth — this store
// is a cache that hydrates on focus and patches via REST mutations
// before the network round-trip resolves (optimistic).

import { create } from 'zustand';
import { api } from '../services/api';

export interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string;
  data_json: any;
  created_at: string;
  read_at: string | null;
}

interface NotificationsStore {
  notifications: Notification[];
  unreadCount: number;
  hasMore: boolean;
  loading: boolean;
  preferences: Record<string, boolean>;
  preferencesLoaded: boolean;

  // Replace the feed with the latest first page + refreshed unread count.
  refresh: () => Promise<void>;
  // Append the next page using the oldest visible row's created_at.
  loadMore: () => Promise<void>;
  // Optimistic mark-read + backend PATCH.
  markRead: (id: string) => Promise<void>;
  // Optimistic mark-all + backend POST.
  markAllRead: () => Promise<void>;
  // Bump the unread count without refetching (used by foreground listener).
  incrementUnread: () => void;
  // Refresh just the unread count — cheap, used by tab focus listener.
  refreshUnreadCount: () => Promise<void>;

  // Preferences map (kind → enabled). Defaults to TRUE for any kind
  // missing from the response.
  loadPreferences: () => Promise<void>;
  // Optimistic toggle. Reverts on failure.
  setPreference: (kind: string, enabled: boolean) => Promise<void>;
}

export const useNotificationsStore = create<NotificationsStore>((set, get) => ({
  notifications: [],
  unreadCount: 0,
  hasMore: false,
  loading: false,
  preferences: {},
  preferencesLoaded: false,

  refresh: async () => {
    set({ loading: true });
    try {
      const res = await api.listNotifications({ limit: 50 });
      set({
        notifications: Array.isArray(res?.notifications) ? res.notifications : [],
        hasMore: !!res?.hasMore,
        unreadCount: typeof res?.unreadCount === 'number' ? res.unreadCount : 0,
      });
    } catch (err) {
      console.warn('[notifications] refresh failed:', err);
    } finally {
      set({ loading: false });
    }
  },

  loadMore: async () => {
    const { notifications, hasMore, loading } = get();
    if (!hasMore || loading || notifications.length === 0) return;
    const oldest = notifications[notifications.length - 1];
    set({ loading: true });
    try {
      const res = await api.listNotifications({ limit: 50, before: oldest.created_at });
      const next: Notification[] = Array.isArray(res?.notifications) ? res.notifications : [];
      set({
        notifications: [...notifications, ...next],
        hasMore: !!res?.hasMore,
      });
    } catch (err) {
      console.warn('[notifications] loadMore failed:', err);
    } finally {
      set({ loading: false });
    }
  },

  markRead: async (id: string) => {
    const prev = get().notifications;
    const target = prev.find(n => n.id === id);
    if (!target || target.read_at) return;
    const nowIso = new Date().toISOString();
    set({
      notifications: prev.map(n => (n.id === id ? { ...n, read_at: nowIso } : n)),
      unreadCount: Math.max(0, get().unreadCount - 1),
    });
    try {
      await api.markNotificationRead(id);
    } catch (err) {
      console.warn('[notifications] markRead failed; reverting:', err);
      set({
        notifications: prev,
        unreadCount: get().unreadCount + 1,
      });
    }
  },

  markAllRead: async () => {
    const prev = get().notifications;
    const prevUnread = get().unreadCount;
    const nowIso = new Date().toISOString();
    set({
      notifications: prev.map(n => (n.read_at ? n : { ...n, read_at: nowIso })),
      unreadCount: 0,
    });
    try {
      await api.markAllNotificationsRead();
    } catch (err) {
      console.warn('[notifications] markAllRead failed; reverting:', err);
      set({ notifications: prev, unreadCount: prevUnread });
    }
  },

  incrementUnread: () => {
    set({ unreadCount: get().unreadCount + 1 });
  },

  refreshUnreadCount: async () => {
    try {
      const res = await api.listNotifications({ limit: 1 });
      if (typeof res?.unreadCount === 'number') {
        set({ unreadCount: res.unreadCount });
      }
    } catch (err) {
      console.warn('[notifications] refreshUnreadCount failed:', err);
    }
  },

  loadPreferences: async () => {
    try {
      const res = await api.getNotificationPreferences();
      set({
        preferences: (res && typeof res.preferences === 'object') ? res.preferences : {},
        preferencesLoaded: true,
      });
    } catch (err) {
      console.warn('[notifications] loadPreferences failed:', err);
      set({ preferencesLoaded: true });
    }
  },

  setPreference: async (kind: string, enabled: boolean) => {
    const prev = get().preferences;
    set({ preferences: { ...prev, [kind]: enabled } });
    try {
      const res = await api.updateNotificationPreferences({ [kind]: enabled });
      if (res && typeof res.preferences === 'object') {
        set({ preferences: res.preferences });
      }
    } catch (err) {
      console.warn('[notifications] setPreference failed; reverting:', err);
      set({ preferences: prev });
    }
  },
}));

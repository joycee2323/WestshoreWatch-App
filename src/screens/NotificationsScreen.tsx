import React, { useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, Platform, ActivityIndicator,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme';
import { useNotificationsStore, Notification } from '../store/notificationsStore';
import { deepLinkForNotification } from '../services/pushNotifications';

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diffMs = Date.now() - then;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'yesterday';
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function NotificationsScreen() {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const s = styles(colors);

  const notifications = useNotificationsStore(st => st.notifications);
  const unreadCount = useNotificationsStore(st => st.unreadCount);
  const loading = useNotificationsStore(st => st.loading);
  const hasMore = useNotificationsStore(st => st.hasMore);
  const refresh = useNotificationsStore(st => st.refresh);
  const loadMore = useNotificationsStore(st => st.loadMore);
  const markRead = useNotificationsStore(st => st.markRead);
  const markAllRead = useNotificationsStore(st => st.markAllRead);

  useFocusEffect(useCallback(() => {
    void refresh();
  }, [refresh]));

  const onRowPress = useCallback((n: Notification) => {
    if (!n.read_at) void markRead(n.id);
    deepLinkForNotification(navigation, n.data_json || {});
  }, [markRead, navigation]);

  const renderItem = useCallback(({ item }: { item: Notification }) => {
    const unread = !item.read_at;
    return (
      <TouchableOpacity onPress={() => onRowPress(item)} activeOpacity={0.65} style={s.row}>
        <View style={s.dotCol}>
          {unread ? <View style={s.unreadDot} /> : <View style={s.dotPlaceholder} />}
        </View>
        <View style={s.bodyCol}>
          <Text style={[s.title, unread && { color: colors.text }]}>{item.title}</Text>
          <Text style={s.body} numberOfLines={2}>{item.body}</Text>
        </View>
        <Text style={s.ts}>{relativeTime(item.created_at)}</Text>
      </TouchableOpacity>
    );
  }, [colors.text, onRowPress, s]);

  const headerHeight = (insets.top || 0) + 16;

  return (
    <View style={[s.page, { paddingTop: headerHeight }]}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>NOTIFICATIONS</Text>
        {unreadCount > 0 ? (
          <TouchableOpacity onPress={() => void markAllRead()} style={s.markAllBtn}>
            <Text style={s.markAllText}>MARK ALL READ</Text>
          </TouchableOpacity>
        ) : (
          <View style={s.markAllBtn} />
        )}
      </View>

      <FlatList
        data={notifications}
        keyExtractor={n => n.id}
        renderItem={renderItem}
        ItemSeparatorComponent={() => <View style={s.sep} />}
        ListEmptyComponent={
          loading ? (
            <View style={s.empty}>
              <ActivityIndicator color={colors.cyan} />
            </View>
          ) : (
            <View style={s.empty}>
              <Text style={s.emptyText}>No notifications yet.</Text>
            </View>
          )
        }
        ListFooterComponent={
          hasMore && notifications.length > 0 ? (
            <View style={s.footer}>
              <ActivityIndicator color={colors.cyan} />
            </View>
          ) : null
        }
        onEndReachedThreshold={0.4}
        onEndReached={() => { void loadMore(); }}
        refreshControl={
          <RefreshControl
            refreshing={loading && notifications.length > 0}
            onRefresh={refresh}
            tintColor={colors.cyan}
            colors={[colors.cyan]}
          />
        }
      />
    </View>
  );
}

const styles = (c: ReturnType<typeof useTheme>) => StyleSheet.create({
  page: { flex: 1, backgroundColor: c.bg },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: c.border,
  },
  backBtn: { paddingRight: 12 },
  headerTitle: {
    flex: 1, color: c.text, fontSize: 14, fontWeight: '700', letterSpacing: 3,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  markAllBtn: { paddingHorizontal: 8, paddingVertical: 6, minWidth: 110, alignItems: 'flex-end' },
  markAllText: {
    color: c.cyan, fontSize: 10, letterSpacing: 1.5, fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  row: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingHorizontal: 16, paddingVertical: 14,
    backgroundColor: c.surface,
  },
  sep: { height: 1, backgroundColor: c.border, marginLeft: 40 },
  dotCol: { width: 24, alignItems: 'center', paddingTop: 6 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.cyan },
  dotPlaceholder: { width: 8, height: 8 },
  bodyCol: { flex: 1, paddingRight: 8 },
  title: { color: c.textDim, fontSize: 13, fontWeight: '600', marginBottom: 2 },
  body: { color: c.textMuted, fontSize: 12, lineHeight: 16 },
  ts: { color: c.textMuted, fontSize: 10, letterSpacing: 0.5, marginTop: 6, marginLeft: 8 },
  empty: { paddingVertical: 60, alignItems: 'center' },
  emptyText: { color: c.textMuted, fontSize: 13 },
  footer: { paddingVertical: 16, alignItems: 'center' },
});

// Live Video (DJI Pilot 2 → WebRTC). Lists the org's live sessions; tapping
// one plays it in a WebView pointed at the dashboard's public player
// (https://watch.westshoredrone.com/live/<token>?embed=1) using a per-viewer
// link the backend mints for this user (kind 'member'). No native module:
// react-native-webview is already in the build, so this ships OTA.
//
// The app never sends its login token into the WebView. Share uses RN core
// Share with a NEW one-person link (backend kind 'manual').
// No billing or purchase links here (App Store rule).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator, Share, Alert, RefreshControl,
} from 'react-native';
import { WebView, WebViewNavigation } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '../theme';
import { api } from '../services/api';

const PLAYER_ORIGIN = 'https://watch.westshoredrone.com';
const POLL_MS = 5000;

type Session = {
  id: string;
  status: 'live' | 'reconnecting' | 'ended' | 'closed';
  key_label: string;
  deployment_name: string | null;
  started_at: string;
  is_open: boolean;
};

function elapsed(fromIso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(fromIso).getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

export default function LiveVideoScreen() {
  const colors = useTheme();
  const s = useMemo(() => styles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [watching, setWatching] = useState<{ session: Session; url: string } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const r = await api.liveSessions('open');
      if (!mounted.current) return;
      setSessions(r.sessions);
      setError(null);
    } catch (e: any) {
      if (mounted.current) setError(e?.message || 'Could not load live video');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    const t = setInterval(load, POLL_MS);
    return () => { mounted.current = false; clearInterval(t); };
  }, [load]);

  const watch = async (session: Session) => {
    setOpening(session.id);
    try {
      const r = await api.createLiveLink(session.id, 'member');
      setWatching({ session, url: `${r.url}?embed=1` });
    } catch (e: any) {
      Alert.alert('Live video', e?.message || 'Could not open the video.');
    } finally {
      setOpening(null);
    }
  };

  const share = async (session: Session) => {
    try {
      const r = await api.createLiveLink(session.id, 'manual');
      await Share.share({
        message: `Live drone video: ${r.url}\nThis link is for one person. Please don't forward it.`,
      });
    } catch (e: any) {
      Alert.alert('Share', e?.message || 'Could not create a link.');
    }
  };

  // Keep the WebView on the player page only.
  const onNav = (req: WebViewNavigation) => req.url.startsWith(`${PLAYER_ORIGIN}/live/`);

  if (watching) {
    return (
      <View style={s.container}>
        <View style={[s.header, { paddingTop: insets.top + 8 }]}>
          <TouchableOpacity onPress={() => setWatching(null)} style={s.headerBtn} accessibilityRole="button">
            <Text style={s.link}>← Back</Text>
          </TouchableOpacity>
          <Text style={s.title} numberOfLines={1}>{watching.session.key_label}</Text>
          <TouchableOpacity onPress={() => share(watching.session)} style={s.headerBtn} accessibilityRole="button">
            <Text style={[s.link, { textAlign: 'right' }]}>Share</Text>
          </TouchableOpacity>
        </View>
        <WebView
          source={{ uri: watching.url }}
          style={{ flex: 1, backgroundColor: '#000' }}
          originWhitelist={[PLAYER_ORIGIN]}
          onShouldStartLoadWithRequest={onNav}
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          javaScriptEnabled
          domStorageEnabled
          startInLoadingState
          renderLoading={() => (
            <View style={[StyleSheet.absoluteFill, { justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' }]}>
              <ActivityIndicator color={colors.cyan} size="large" />
            </View>
          )}
        />
      </View>
    );
  }

  return (
    <View style={s.container}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.headerBtn} accessibilityRole="button">
          <Text style={s.link}>← Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>LIVE VIDEO</Text>
        <View style={s.headerBtn} />
      </View>
      {error && <Text style={s.error}>{error}</Text>}
      {!sessions ? (
        <ActivityIndicator color={colors.cyan} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={item => item.id}
          contentContainerStyle={{ padding: 16, gap: 12, flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.cyan}
            onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
          ListEmptyComponent={
            <Text style={s.empty}>
              No live video right now. When a controller starts streaming, it shows up here within a few seconds.
            </Text>
          }
          renderItem={({ item }) => (
            <View style={s.card}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <Text style={s.cardTitle} numberOfLines={1}>{item.key_label}</Text>
                <Text style={[s.badge, { backgroundColor: item.status === 'live' ? colors.red : colors.amber }]}>
                  {item.status === 'live' ? '● LIVE' : 'RECONNECTING'}
                </Text>
              </View>
              <Text style={s.dim}>
                {elapsed(item.started_at)}{item.deployment_name ? ` · ${item.deployment_name}` : ''}
              </Text>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                <TouchableOpacity style={[s.btn, s.btnPrimary]} onPress={() => watch(item)} disabled={opening === item.id}
                  accessibilityRole="button" accessibilityLabel={`Watch ${item.key_label}`}>
                  {opening === item.id ? <ActivityIndicator color="#000" /> : <Text style={s.btnPrimaryText}>WATCH</Text>}
                </TouchableOpacity>
                <TouchableOpacity style={s.btn} onPress={() => share(item)} accessibilityRole="button"
                  accessibilityLabel={`Share a link to ${item.key_label}`}>
                  <Text style={s.btnText}>SHARE LINK</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = (c: ReturnType<typeof useTheme>) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.surface,
  },
  headerBtn: { width: 70 },
  title: { color: c.text, fontSize: 14, fontWeight: '700', letterSpacing: 1.5, flex: 1, textAlign: 'center' },
  link: { color: c.cyan, fontSize: 14 },
  error: { color: c.red, fontSize: 12, padding: 16, paddingBottom: 0 },
  empty: { color: c.textDim, fontSize: 13, textAlign: 'center', marginTop: 48, lineHeight: 19 },
  card: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 14 },
  cardTitle: { color: c.text, fontSize: 14, fontWeight: '700', flex: 1 },
  badge: { color: '#fff', fontSize: 10, fontWeight: '700', letterSpacing: 1, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 4, overflow: 'hidden' },
  dim: { color: c.textDim, fontSize: 12, marginTop: 4 },
  btn: { flex: 1, paddingVertical: 10, borderRadius: 6, borderWidth: 1, borderColor: c.border2, alignItems: 'center' },
  btnText: { color: c.text, fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  btnPrimary: { backgroundColor: c.cyan, borderColor: c.cyan },
  btnPrimaryText: { color: '#000', fontSize: 12, fontWeight: '700', letterSpacing: 1 },
});

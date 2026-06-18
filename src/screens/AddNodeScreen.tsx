import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, RefreshControl,
  TouchableOpacity, Alert, Platform, ActivityIndicator,
  PermissionsAndroid, Linking,
} from 'react-native';
import * as Location from 'expo-location';
import { useNavigation } from '@react-navigation/native';
import { api } from '../services/api';
import { fetchNodes, getUnclaimedNearby } from '../services/nodeRegistry';
import {
  DiscoveredNode,
  startBleScanning, stopBleScanning, isBleScanning,
} from '../services/bleScanner';
import { useTheme } from '../theme';
import { useAuthStore } from '../store/authStore';
import { useCaps } from '../lib/useCaps';

// Mirrors the same permissions request LiveMapScreen issues right before
// it starts BLE scanning. Inlined (not exported from a shared helper) for
// the same reason LiveMap inlines it — two callers, both short, and the
// API surface is the React Native + Expo grant flow rather than something
// app-specific worth abstracting.
async function requestScanPermissions(): Promise<void> {
  await Location.requestForegroundPermissionsAsync();
  if (Platform.OS === 'android' && Platform.Version >= 31) {
    await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
  }
  if (Platform.OS === 'android' && Platform.Version >= 33) {
    await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS' as any);
  }
}

// How long to show "Starting scanner…" before falling through to
// "NO NODES IN RANGE" when this screen is the one that started the scan.
// 3s covers BLE init + first scan callback on a typical device — long
// enough to avoid a misleading "no nodes" flash, short enough that a
// genuinely empty area transitions promptly.
const SCANNER_WARMUP_MS = 3000;

export default function AddNodeScreen() {
  const colors = useTheme();
  const navigation = useNavigation<any>();
  const user = useAuthStore(s => s.user);
  const c = useCaps(user);
  const canPairNode = c.canPairNodeOnThisDevice;
  const [unclaimed, setUnclaimed] = useState<DiscoveredNode[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [claiming, setClaiming] = useState<string | null>(null);
  // True for ~SCANNER_WARMUP_MS after we started the scanner ourselves;
  // suppresses the "NO NODES IN RANGE" empty state during that window so
  // onboarding users don't see a misleading flash. Stays false when LiveMap
  // already had the scanner running (cache is hot — nodes appear instantly).
  const [warmingUp, setWarmingUp] = useState(false);
  // True iff this screen instance invoked startBleScanning AND it succeeded
  // AND we weren't unmounted before the await resolved. Drives whether the
  // unmount cleanup tears the scanner back down. If LiveMap (or any other
  // owner) had the scanner running before we mounted, we leave it alone.
  const startedByThisScreenRef = useRef(false);

  const refresh = useCallback(async () => {
    await fetchNodes();
    setUnclaimed(getUnclaimedNearby());
  }, []);

  useEffect(() => {
    refresh();
    let cancelled = false;
    let warmupTimer: any = null;
    const pollTimer = setInterval(() => setUnclaimed(getUnclaimedNearby()), 2000);

    // Viewers shouldn't trigger a scanner — they can't claim anyway, and
    // the read-only branch below renders before any UI that depends on
    // the cache. Skip permissions + start, keep the polling so the (empty)
    // empty-state still renders consistently.
    if (!canPairNode) {
      return () => {
        cancelled = true;
        clearInterval(pollTimer);
      };
    }

    (async () => {
      // If something else is already scanning (typically LiveMap mounted
      // first in the post-skip path), discoveredNodes is already populated
      // and we just consume the cache. No warmup, no ownership transfer.
      const wasAlreadyScanning = isBleScanning();
      if (wasAlreadyScanning) return;

      setWarmingUp(true);
      try {
        await requestScanPermissions();
        if (cancelled) return;
        // Pass no-op callbacks. discoveredNodes is populated inside
        // bleScanner.ts unconditionally on every WW-node sighting (it
        // doesn't gate on the optional onNodeNearby), so AddNodeScreen
        // doesn't need to handle the firehose.
        await startBleScanning(() => {}, () => {});
        if (cancelled) {
          // Race: user navigated away during the await. The scanner DID
          // come up, so we own it and have to tear it down ourselves —
          // otherwise the FG service leaks until logout. Cleanup ran
          // before this branch with startedByThisScreenRef still false,
          // so it didn't stop anything.
          try { stopBleScanning(); } catch {}
          return;
        }
        startedByThisScreenRef.current = true;
        warmupTimer = setTimeout(() => {
          if (!cancelled) setWarmingUp(false);
        }, SCANNER_WARMUP_MS);
      } catch (err: any) {
        if (cancelled) return;
        setWarmingUp(false);
        const code = err?.code || err?.userInfo?.code;
        const msg = err?.message || 'Background scanning could not start.';
        console.warn('[addnode] startBleScanning failed:', code, msg);
        // Same alert shape LiveMap uses for this code — keeps the
        // "Open Settings" remediation consistent across entry points.
        if (code === 'BLE_SERVICE_NOT_RUNNING') {
          Alert.alert(
            'Scanning unavailable',
            `${msg}\n\nTap Open Settings to grant the required permissions.`,
            [
              { text: 'Dismiss', style: 'cancel' },
              { text: 'Open Settings', onPress: () => Linking.openSettings() },
            ],
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      if (warmupTimer) clearTimeout(warmupTimer);
      // Only stop if we were the originator. An onboarding-path user who
      // claims a node and leaves the screen ends up with no scanner running
      // (correct — they may sit idle in Onboarding until pull-to-refresh
      // sees the new node and MainGate flips to AuthTabs, at which point
      // LiveMap will restart it). A skipped-onboarding user keeps LiveMap's
      // scanner alive since we never touched it.
      if (startedByThisScreenRef.current) {
        stopBleScanning();
        startedByThisScreenRef.current = false;
      }
    };
  }, [refresh, canPairNode]);

  const onPullRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await refresh(); } finally { setRefreshing(false); }
  }, [refresh]);

  const claim = useCallback(async (mac: string) => {
    setClaiming(mac);
    try {
      const node = await api.claimNode(mac);
      await fetchNodes();
      setUnclaimed(getUnclaimedNearby());
      Alert.alert(
        'Node Claimed',
        `${node.name} is now registered to your organization.`,
        [{ text: 'OK', onPress: () => navigation.goBack() }],
      );
    } catch (err: any) {
      if (err.status === 402) {
        // iOS: no purchase steering (App Store Guideline 3.1.1). Android unchanged.
        Alert.alert('Node Limit Reached', Platform.OS === 'ios'
          ? "You've reached the node limit for this account. Contact your administrator."
          : 'Your current plan does not allow another node. Upgrade to add more.');
      } else if (err.status === 409) {
        Alert.alert('Already Claimed', 'This node has already been claimed by another organization. Contact support if this is a mistake.');
      } else if (err.status === 429) {
        Alert.alert('Too Many Claims', err.message || 'Too many claims in the last hour. Try again later.');
      } else {
        Alert.alert('Claim Failed', err.message || 'Could not claim node.');
      }
    } finally {
      setClaiming(null);
    }
  }, [navigation]);

  const confirmClaim = useCallback((node: DiscoveredNode) => {
    Alert.alert(
      'Claim Node?',
      `Register ${node.mac} to your organization?\n\nSignal: ${node.rssi} dBm`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Claim', onPress: () => claim(node.mac) },
      ],
    );
  }, [claim]);

  const s = styles(colors);

  if (!canPairNode) {
    return (
      <ScrollView style={s.page} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={s.title}>ADD NODE</Text>
        <View style={s.empty}>
          <Text style={s.emptyText}>READ-ONLY</Text>
          <Text style={s.emptyHint}>
            Only operators and admins can pair nodes. Ask your organization admin to grant access.
          </Text>
        </View>
      </ScrollView>
    );
  }

  // Render priority: nodes found > warming up > nothing in range.
  const showWarmup = warmingUp && unclaimed.length === 0;

  return (
    <ScrollView
      style={s.page}
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onPullRefresh} tintColor={colors.cyan} />
      }
    >
      <Text style={s.title}>ADD NODE</Text>
      <Text style={s.subtitle}>
        {unclaimed.length > 0
          ? `${unclaimed.length} unclaimed node${unclaimed.length !== 1 ? 's' : ''} nearby`
          : showWarmup
            ? 'Starting scanner…'
            : 'Scanning for nearby Westshore Watch nodes…'}
      </Text>

      {unclaimed.length === 0 && (
        <View style={s.empty}>
          <ActivityIndicator color={colors.cyan} />
          <Text style={s.emptyText}>
            {showWarmup ? 'STARTING SCANNER…' : 'NO NODES IN RANGE'}
          </Text>
          <Text style={s.emptyHint}>
            {showWarmup
              ? 'Initializing Bluetooth. This takes a couple of seconds.'
              : 'Power on your node and wait a moment. Pull down to refresh.'}
          </Text>
        </View>
      )}

      {unclaimed.map(node => {
        const isClaiming = claiming === node.mac;
        return (
          <TouchableOpacity
            key={node.mac}
            style={[s.card, isClaiming && s.cardDisabled]}
            onPress={() => !isClaiming && confirmClaim(node)}
            activeOpacity={0.7}
            disabled={isClaiming}
          >
            <View style={s.cardRow}>
              <View>
                <Text style={s.mac}>{node.mac}</Text>
                <Text style={s.rssi}>{node.rssi} dBm</Text>
              </View>
              {isClaiming
                ? <ActivityIndicator color={colors.cyan} />
                : <Text style={s.claimLabel}>CLAIM →</Text>}
            </View>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const styles = (c: ReturnType<typeof useTheme>) => StyleSheet.create({
  page: { flex: 1, backgroundColor: c.bg },
  title: {
    color: c.text, fontSize: 18, fontWeight: '700', letterSpacing: 4,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace', marginBottom: 4,
  },
  subtitle: { color: c.textMuted, fontSize: 11, marginBottom: 16 },
  card: {
    backgroundColor: c.surface, borderRadius: 12,
    borderWidth: 1, borderColor: 'rgba(0,212,255,0.2)',
    padding: 16, marginBottom: 12,
  },
  cardDisabled: { opacity: 0.5 },
  cardRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  mac: {
    color: c.text, fontSize: 14, fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  rssi: {
    color: c.textMuted, fontSize: 11, marginTop: 4,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  claimLabel: {
    color: c.cyan, fontSize: 11, fontWeight: '700', letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  empty: { alignItems: 'center', paddingTop: 60, gap: 16 },
  emptyText: {
    color: c.textMuted, fontSize: 12, letterSpacing: 3,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  emptyHint: { color: c.textDim, fontSize: 11, textAlign: 'center', paddingHorizontal: 32 },
});

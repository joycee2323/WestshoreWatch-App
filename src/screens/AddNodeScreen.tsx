import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, RefreshControl,
  TouchableOpacity, Alert, Platform, ActivityIndicator,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { api } from '../services/api';
import { fetchNodes, getUnclaimedNearby } from '../services/nodeRegistry';
import { DiscoveredNode } from '../services/bleScanner';
import { useTheme } from '../theme';
import { useAuthStore } from '../store/authStore';
import { caps } from '../lib/caps';

export default function AddNodeScreen() {
  const colors = useTheme();
  const navigation = useNavigation<any>();
  const user = useAuthStore(s => s.user);
  const c = caps(user);
  const [unclaimed, setUnclaimed] = useState<DiscoveredNode[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [claiming, setClaiming] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    await fetchNodes();
    setUnclaimed(getUnclaimedNearby());
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(() => setUnclaimed(getUnclaimedNearby()), 2000);
    return () => clearInterval(interval);
  }, [refresh]);

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
        Alert.alert('Node Limit Reached', 'Your current plan does not allow another node. Upgrade to add more.');
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

  if (!c.canPairNode) {
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
        {unclaimed.length === 0
          ? 'Scanning for nearby Westshore Watch nodes…'
          : `${unclaimed.length} unclaimed node${unclaimed.length !== 1 ? 's' : ''} nearby`}
      </Text>

      {unclaimed.length === 0 && (
        <View style={s.empty}>
          <ActivityIndicator color={colors.cyan} />
          <Text style={s.emptyText}>NO NODES IN RANGE</Text>
          <Text style={s.emptyHint}>
            Power on your node and wait a moment. Pull down to refresh.
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

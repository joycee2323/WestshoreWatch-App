import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Alert, ActivityIndicator, RefreshControl, Platform,
} from 'react-native';
import { api } from '../services/api';
import { useTheme } from '../theme';

export default function DeploymentsScreen() {
  const colors = useTheme();
  const [deployments, setDeployments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [billing, setBilling] = useState<any>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const load = useCallback(async () => {
    try {
      const [deps, bill] = await Promise.all([api.getDeployments(), api.getBillingStatus()]);
      setDeployments(deps);
      setBilling(bill);
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await api.createDeployment(newName.trim());
      setNewName('');
      await load();
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleClose = async (dep: any) => {
    Alert.alert('Close Deployment', `Close "${dep.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Close', style: 'destructive', onPress: async () => {
        try { await api.closeDeployment(dep.id); await load(); }
        catch (err: any) { Alert.alert('Error', err.message); }
      }},
    ]);
  };

  const handleExtend = async (dep: any) => {
    try { await api.extendDeployment(dep.id); await load(); }
    catch (err: any) { Alert.alert('Error', err.message); }
  };

  const handleDelete = async (dep: any) => {
    Alert.alert(
      'Delete Deployment',
      `Delete "${dep.name}"? This permanently deletes all detection data.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: async () => {
          try { await api.deleteDeployment(dep.id); await load(); }
          catch (err: any) { Alert.alert('Error', err.message); }
        }},
      ]
    );
  };

  const active = deployments.filter(d => d.status === 'active');
  const past = deployments.filter(d => d.status !== 'active');
  const canCreate = billing?.is_super_admin || billing?.subscription?.status === 'active' || billing?.credit_balance > 0;

  const s = styles(colors);

  if (loading) {
    return (
      <View style={[s.page, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={colors.cyan} />
      </View>
    );
  }

  return (
    <ScrollView
      style={s.page}
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.cyan} />}
    >
      <Text style={s.title}>DEPLOYMENTS</Text>

      {/* New deployment */}
      <View style={s.card}>
        <Text style={s.cardHeader}>START NEW DEPLOYMENT</Text>
        <Text style={s.cardSub}>$50 credit or included with subscription</Text>
        <TextInput
          style={s.input}
          value={newName}
          onChangeText={setNewName}
          placeholder="e.g. Rogers Arena — April 5 2026"
          placeholderTextColor={colors.textMuted}
        />
        <TouchableOpacity
          style={[s.btn, (!canCreate || creating) && s.btnDisabled]}
          onPress={handleCreate}
          disabled={!canCreate || creating}
        >
          {creating
            ? <ActivityIndicator color="#000" size="small" />
            : <Text style={s.btnText}>START DEPLOYMENT</Text>
          }
        </TouchableOpacity>
        {!canCreate && (
          <Text style={[s.hint, { color: colors.amber }]}>No active subscription or credits</Text>
        )}
      </View>

      {/* Active */}
      {active.length > 0 && (
        <>
          <Text style={s.sectionLabel}>ACTIVE ({active.length})</Text>
          {active.map(dep => {
            const expiryMs = getExpiryMs(dep);
            const remaining = expiryMs !== null ? expiryMs - now : null;
            const expired = remaining !== null && remaining <= 0;
            return (
            <View key={dep.id} style={[s.card, s.activeCard]}>
              <View style={s.depHeader}>
                <Text style={s.depName}>{dep.name}</Text>
                <View style={s.activeBadge}><Text style={s.activeBadgeText}>● ACTIVE</Text></View>
              </View>
              <Text style={s.depMeta}>Started {new Date(dep.started_at).toLocaleString()}</Text>
              {remaining !== null && (
                <Text style={[s.countdown, expired && s.countdownExpired]}>
                  {expired ? 'Expired' : formatRemaining(remaining)}
                </Text>
              )}
              <View style={s.depStats}>
                <StatChip label="NODES" value={dep.node_count || 0} color={colors.cyan} />
                <StatChip label="DRONES" value={dep.drone_count || 0} color={colors.text} />
              </View>
              <View style={s.depActions}>
                <TouchableOpacity style={[s.actionBtn, s.amberBtn]} onPress={() => handleExtend(dep)}>
                  <Text style={s.actionBtnText}>+24H</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[s.actionBtn, s.dangerBtn]} onPress={() => handleClose(dep)}>
                  <Text style={s.actionBtnText}>CLOSE</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[s.actionBtn, s.dangerBtn, { opacity: 0.7 }]} onPress={() => handleDelete(dep)}>
                  <Text style={s.actionBtnText}>DELETE</Text>
                </TouchableOpacity>
              </View>
            </View>
            );
          })}
        </>
      )}

      {/* History */}
      {past.length > 0 && (
        <>
          <Text style={s.sectionLabel}>HISTORY ({past.length})</Text>
          {past.map(dep => (
            <View key={dep.id} style={s.card}>
              <View style={s.depHeader}>
                <Text style={s.depName}>{dep.name}</Text>
                <Text style={[s.statusText, { color: dep.status === 'expired' ? colors.amber : colors.textMuted }]}>
                  {dep.status.toUpperCase()}
                </Text>
              </View>
              <Text style={s.depMeta}>{new Date(dep.started_at).toLocaleDateString()} · {dep.drone_count || 0} drones</Text>
              <View style={s.depActions}>
                <TouchableOpacity style={[s.actionBtn, s.ghostBtn]} onPress={() => handleDelete(dep)}>
                  <Text style={[s.actionBtnText, { color: colors.red }]}>DELETE</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </>
      )}

      {deployments.length === 0 && (
        <View style={s.empty}>
          <Text style={s.emptyText}>NO DEPLOYMENTS</Text>
          <Text style={s.emptyHint}>Start a deployment above to begin detecting drones</Text>
        </View>
      )}
    </ScrollView>
  );
}

function getExpiryMs(dep: any): number | null {
  const raw = dep.expires_at ?? dep.ends_at ?? dep.expiry ?? null;
  if (raw) {
    const ms = new Date(raw).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  if (dep.started_at) {
    const start = new Date(dep.started_at).getTime();
    if (Number.isFinite(start)) return start + 24 * 60 * 60 * 1000;
  }
  return null;
}

function formatRemaining(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h remaining`;
  if (hours > 0) return `${hours}h ${minutes}m remaining`;
  return `${minutes}m remaining`;
}

function StatChip({ label, value, color }: any) {
  const colors = useTheme();
  return (
    <View style={{ alignItems: 'center' }}>
      <Text style={{ color, fontSize: 18, fontWeight: '700', fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace' }}>{value}</Text>
      <Text style={{ color: colors.textMuted, fontSize: 9, letterSpacing: 1, fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace' }}>{label}</Text>
    </View>
  );
}

const styles = (c: ReturnType<typeof useTheme>) => StyleSheet.create({
  page: { flex: 1, backgroundColor: c.bg },
  title: {
    color: c.text, fontSize: 18, fontWeight: '700', letterSpacing: 4,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    marginBottom: 16,
  },
  sectionLabel: {
    color: c.textMuted, fontSize: 9, letterSpacing: 2, marginBottom: 10, marginTop: 20,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  card: {
    backgroundColor: c.surface, borderRadius: 12,
    borderWidth: 1, borderColor: c.border, padding: 16, marginBottom: 12,
  },
  activeCard: { borderColor: 'rgba(0,255,136,0.2)' },
  cardHeader: {
    color: c.text, fontSize: 11, fontWeight: '600', letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  cardSub: { color: c.textMuted, fontSize: 10, marginTop: 4, marginBottom: 12 },
  input: {
    backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border,
    borderRadius: 8, padding: 12, color: c.text, fontSize: 14, marginBottom: 10,
  },
  btn: {
    backgroundColor: c.cyan, borderRadius: 8,
    padding: 13, alignItems: 'center',
  },
  btnDisabled: { opacity: 0.4 },
  btnText: {
    color: '#000', fontWeight: '700', fontSize: 11, letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  hint: { fontSize: 10, marginTop: 8, textAlign: 'center' },
  depHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  depName: {
    color: c.text, fontSize: 13, fontWeight: '600', flex: 1,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  depMeta: { color: c.textMuted, fontSize: 10, marginBottom: 4 },
  countdown: {
    color: c.cyan, fontSize: 11, marginBottom: 12, letterSpacing: 1,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  countdownExpired: { color: c.red, fontWeight: '700' },
  activeBadge: {
    backgroundColor: 'rgba(0,255,136,0.1)', borderRadius: 10,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  activeBadgeText: {
    color: '#00ff88', fontSize: 9, letterSpacing: 1,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  statusText: { fontSize: 10, letterSpacing: 1, fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace' },
  depStats: { flexDirection: 'row', gap: 24, marginBottom: 14 },
  depActions: { flexDirection: 'row', gap: 8 },
  actionBtn: { borderRadius: 6, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1 },
  amberBtn: { borderColor: c.amber, backgroundColor: 'rgba(245,158,11,0.1)' },
  dangerBtn: { borderColor: c.red, backgroundColor: 'rgba(239,68,68,0.1)' },
  ghostBtn: { borderColor: c.border },
  actionBtnText: {
    color: c.text, fontSize: 10, fontWeight: '600', letterSpacing: 1,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  empty: { alignItems: 'center', paddingTop: 60 },
  emptyText: {
    color: c.textMuted, fontSize: 12, letterSpacing: 3,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  emptyHint: { color: c.textDim, fontSize: 11, marginTop: 8, textAlign: 'center' },
});

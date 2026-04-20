import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Alert, ActivityIndicator, RefreshControl, Platform, Modal,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { api } from '../services/api';
import { useTheme } from '../theme';

const MIN_LEAD_MS = 60_000;
const MAX_LEAD_MS = 30 * 24 * 60 * 60 * 1000;

export default function DeploymentsScreen() {
  const colors = useTheme();
  const [deployments, setDeployments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [billing, setBilling] = useState<any>(null);
  const [now, setNow] = useState(() => Date.now());

  const [scheduleLater, setScheduleLater] = useState(false);
  const [scheduledDate, setScheduledDate] = useState<Date | null>(null);
  const [iosPickerOpen, setIosPickerOpen] = useState(false);
  const [iosPickerDraft, setIosPickerDraft] = useState<Date>(() => new Date(Date.now() + 15 * 60_000));

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

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Android has no native datetime mode — chain date then time imperatively.
  const openAndroidPicker = () => {
    const initial = scheduledDate ?? new Date(Date.now() + 15 * 60_000);
    DateTimePickerAndroid.open({
      value: initial,
      minimumDate: new Date(Date.now() + MIN_LEAD_MS),
      maximumDate: new Date(Date.now() + MAX_LEAD_MS),
      mode: 'date',
      onChange: (event, date) => {
        if (event.type !== 'set' || !date) return;
        DateTimePickerAndroid.open({
          value: date,
          mode: 'time',
          is24Hour: false,
          onChange: (evt2, time) => {
            if (evt2.type !== 'set' || !time) return;
            const combined = new Date(date);
            combined.setHours(time.getHours(), time.getMinutes(), 0, 0);
            setScheduledDate(combined);
          },
        });
      },
    });
  };

  const openIosPicker = () => {
    setIosPickerDraft(scheduledDate ?? new Date(Date.now() + 15 * 60_000));
    setIosPickerOpen(true);
  };

  const openPicker = Platform.OS === 'ios' ? openIosPicker : openAndroidPicker;

  const validateScheduled = (d: Date): string | null => {
    const lead = d.getTime() - Date.now();
    if (lead < MIN_LEAD_MS) return 'Scheduled time must be at least 60 seconds in the future.';
    if (lead > MAX_LEAD_MS) return 'Scheduled time must be within the next 30 days.';
    return null;
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    let scheduledFor: string | undefined;
    if (scheduleLater) {
      if (!scheduledDate) {
        Alert.alert('Pick a time', 'Choose when the deployment should start.');
        return;
      }
      const err = validateScheduled(scheduledDate);
      if (err) {
        Alert.alert('Invalid time', err);
        return;
      }
      scheduledFor = scheduledDate.toISOString();
    }
    setCreating(true);
    try {
      const res = await api.createDeployment(newName.trim(), scheduledFor);
      setNewName('');
      setScheduleLater(false);
      setScheduledDate(null);
      if (res?.warning) Alert.alert('Heads up', res.warning);
      await load();
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleCancel = (dep: any) => {
    Alert.alert(
      'Cancel Deployment',
      `Cancel "${dep.name}"? It won't start.`,
      [
        { text: 'Keep Scheduled', style: 'cancel' },
        { text: 'Cancel Deployment', style: 'destructive', onPress: async () => {
          try { await api.cancelDeployment(dep.id); await load(); }
          catch (err: any) { Alert.alert('Error', err.message); }
        }},
      ]
    );
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

  const live = deployments.filter(d => d.status === 'active' || d.status === 'scheduled');
  const history = deployments.filter(d => ['closed', 'expired', 'cancelled'].includes(d.status));
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
          style={s.scheduleRow}
          onPress={() => {
            setScheduleLater(v => {
              if (v) setScheduledDate(null);
              return !v;
            });
          }}
          activeOpacity={0.6}
        >
          <View style={[s.checkbox, scheduleLater && s.checkboxChecked]}>
            {scheduleLater && <Text style={s.checkmark}>✓</Text>}
          </View>
          <Text style={s.scheduleLabel}>SCHEDULE FOR LATER</Text>
        </TouchableOpacity>

        {scheduleLater && (
          <TouchableOpacity style={s.pickerBtn} onPress={openPicker} activeOpacity={0.7}>
            <Text style={scheduledDate ? s.pickerBtnValue : s.pickerBtnPlaceholder}>
              {scheduledDate ? scheduledDate.toLocaleString() : 'Choose date & time'}
            </Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={[s.btn, (!canCreate || creating) && s.btnDisabled]}
          onPress={handleCreate}
          disabled={!canCreate || creating}
        >
          {creating
            ? <ActivityIndicator color="#000" size="small" />
            : <Text style={s.btnText}>{scheduleLater ? 'SCHEDULE DEPLOYMENT' : 'START DEPLOYMENT'}</Text>
          }
        </TouchableOpacity>
        {!canCreate && (
          <Text style={[s.hint, { color: colors.amber }]}>No active subscription or credits</Text>
        )}
      </View>

      {/* Live (active + scheduled) */}
      {live.length > 0 && (
        <>
          <Text style={s.sectionLabel}>LIVE ({live.length})</Text>
          {live.map(dep => {
            if (dep.status === 'scheduled') {
              const scheduledMs = new Date(dep.scheduled_for).getTime();
              const startsIn = Number.isFinite(scheduledMs) ? scheduledMs - now : null;
              const overdue = startsIn !== null && startsIn <= 0;
              return (
                <View key={dep.id} style={[s.card, s.scheduledCard]}>
                  <View style={s.depHeader}>
                    <Text style={s.depName}>{dep.name}</Text>
                    <View style={s.scheduledBadge}><Text style={s.scheduledBadgeText}>◔ SCHEDULED</Text></View>
                  </View>
                  <Text style={s.depMeta}>
                    Scheduled for {Number.isFinite(scheduledMs) ? new Date(scheduledMs).toLocaleString() : '—'}
                  </Text>
                  {startsIn !== null && (
                    <Text style={[s.countdown, { color: colors.amber }]}>
                      {overdue ? 'Starting momentarily…' : `Starts in ${formatLeadTime(startsIn)}`}
                    </Text>
                  )}
                  <View style={s.depActions}>
                    <TouchableOpacity style={[s.actionBtn, s.amberOutlineBtn]} onPress={() => handleCancel(dep)}>
                      <Text style={[s.actionBtnText, { color: colors.amber }]}>CANCEL</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[s.actionBtn, s.dangerBtn, { opacity: 0.7 }]} onPress={() => handleDelete(dep)}>
                      <Text style={s.actionBtnText}>DELETE</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            }

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
      {history.length > 0 && (
        <>
          <Text style={s.sectionLabel}>HISTORY ({history.length})</Text>
          {history.map(dep => {
            const dateRaw = dep.started_at || dep.scheduled_for || dep.created_at;
            const dateStr = dateRaw ? new Date(dateRaw).toLocaleDateString() : '—';
            return (
              <View key={dep.id} style={s.card}>
                <View style={s.depHeader}>
                  <Text style={s.depName}>{dep.name}</Text>
                  <Text style={[s.statusText, { color: dep.status === 'expired' ? colors.amber : colors.textMuted }]}>
                    {dep.status.toUpperCase()}
                  </Text>
                </View>
                <Text style={s.depMeta}>{dateStr} · {dep.drone_count || 0} drones</Text>
                <View style={s.depActions}>
                  <TouchableOpacity style={[s.actionBtn, s.ghostBtn]} onPress={() => handleDelete(dep)}>
                    <Text style={[s.actionBtnText, { color: colors.red }]}>DELETE</Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          })}
        </>
      )}

      {deployments.length === 0 && (
        <View style={s.empty}>
          <Text style={s.emptyText}>NO DEPLOYMENTS</Text>
          <Text style={s.emptyHint}>Start a deployment above to begin detecting drones</Text>
        </View>
      )}

      {Platform.OS === 'ios' && (
        <Modal visible={iosPickerOpen} transparent animationType="slide" onRequestClose={() => setIosPickerOpen(false)}>
          <View style={s.iosModalBackdrop}>
            <View style={s.iosModalSheet}>
              <DateTimePicker
                value={iosPickerDraft}
                mode="datetime"
                display="spinner"
                minimumDate={new Date(Date.now() + MIN_LEAD_MS)}
                maximumDate={new Date(Date.now() + MAX_LEAD_MS)}
                onChange={(_, d) => { if (d) setIosPickerDraft(d); }}
                textColor={colors.text}
              />
              <View style={s.iosModalActions}>
                <TouchableOpacity onPress={() => setIosPickerOpen(false)}>
                  <Text style={[s.iosModalBtn, { color: colors.textMuted }]}>CANCEL</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { setScheduledDate(iosPickerDraft); setIosPickerOpen(false); }}>
                  <Text style={[s.iosModalBtn, { color: colors.cyan }]}>CONFIRM</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
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

function formatLeadTime(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(minutes, 1)}m`;
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
  amberOutlineBtn: { borderColor: c.amber, backgroundColor: 'transparent' },
  dangerBtn: { borderColor: c.red, backgroundColor: 'rgba(239,68,68,0.1)' },
  ghostBtn: { borderColor: c.border },
  scheduledCard: { borderColor: 'rgba(245,158,11,0.3)' },
  scheduledBadge: {
    backgroundColor: 'rgba(245,158,11,0.15)', borderRadius: 10,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  scheduledBadgeText: {
    color: c.amber, fontSize: 9, letterSpacing: 1,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  scheduleRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 8, marginBottom: 4,
  },
  checkbox: {
    width: 18, height: 18, borderRadius: 4,
    borderWidth: 1, borderColor: c.border,
    backgroundColor: c.surface2,
    alignItems: 'center', justifyContent: 'center',
    marginRight: 10,
  },
  checkboxChecked: {
    backgroundColor: c.cyan, borderColor: c.cyan,
  },
  checkmark: { color: '#000', fontSize: 12, fontWeight: '700', lineHeight: 14 },
  scheduleLabel: {
    color: c.textDim, fontSize: 11, letterSpacing: 2, fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  pickerBtn: {
    backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border,
    borderRadius: 8, padding: 12, marginBottom: 10,
  },
  pickerBtnValue: {
    color: c.text, fontSize: 14,
  },
  pickerBtnPlaceholder: {
    color: c.textMuted, fontSize: 14,
  },
  iosModalBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end',
  },
  iosModalSheet: {
    backgroundColor: c.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingTop: 12, paddingBottom: 24, paddingHorizontal: 16,
    borderTopWidth: 1, borderColor: c.border,
  },
  iosModalActions: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingTop: 12, borderTopWidth: 1, borderTopColor: c.border,
  },
  iosModalBtn: {
    fontSize: 13, fontWeight: '700', letterSpacing: 2,
    paddingHorizontal: 16, paddingVertical: 8,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
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

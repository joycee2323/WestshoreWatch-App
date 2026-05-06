import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, RefreshControl,
  ActivityIndicator, Platform, TouchableOpacity, Alert,
  Modal, TextInput, KeyboardAvoidingView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { api } from '../services/api';
import { useTheme } from '../theme';
import { useAuthStore } from '../store/authStore';
import { caps } from '../lib/caps';

// Sort matches the backend (display_order ASC NULLS LAST, name ASC). This is a
// client-side safety net — the backend already returns nodes pre-sorted, but
// local state munging (optimistic reorder swaps) can produce unordered arrays.
function sortNodes(list: any[]): any[] {
  return [...list].sort((a, b) => {
    const ao = a?.display_order;
    const bo = b?.display_order;
    const aNull = ao == null;
    const bNull = bo == null;
    if (aNull && bNull) return (a?.name || '').localeCompare(b?.name || '');
    if (aNull) return 1;
    if (bNull) return -1;
    if (ao !== bo) return ao - bo;
    return (a?.name || '').localeCompare(b?.name || '');
  });
}

export default function NodesScreen() {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const user = useAuthStore(s => s.user);
  const c = caps(user);
  const [nodes, setNodes] = useState<any[]>([]);
  const [deployments, setDeployments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [renameTarget, setRenameTarget] = useState<any | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameSubmitting, setRenameSubmitting] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const allNodes = await api.getNodes();
      setNodes(sortNodes(allNodes || []));
    } catch (err) {
      console.warn('Failed to load nodes:', err);
    }
    try {
      const deps = await api.getDeployments();
      setDeployments(deps.filter((d: any) => d.status === 'active'));
    } catch (err) {
      console.warn('Failed to load deployments:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleAssign = (node: any) => {
    if (deployments.length === 0) {
      Alert.alert('No Active Deployments', 'Start a deployment first before assigning a node.');
      return;
    }
    const options = deployments.map(d => ({
      text: d.name,
      onPress: async () => {
        try {
          await api.assignNode(node.id, d.id);
          await load();
        } catch (err: any) {
          Alert.alert('Error', err.message);
        }
      },
    }));
    options.push({ text: 'Cancel', onPress: async () => {} });
    Alert.alert('Assign to Deployment', `Select a deployment for "${node.name || 'this node'}"`, options);
  };

  const handleAddNode = useCallback(async () => {
    try {
      const { at_cap, current, limit, plan } = await api.getNodeLimit();
      if (at_cap) {
        Alert.alert(
          'Node Limit Reached',
          `Your ${plan} plan allows ${limit} node${limit === 1 ? '' : 's'} (you have ${current}). Upgrade to add more.`,
        );
        return;
      }
    } catch (err) {
      console.warn('Failed to check node limit, proceeding anyway:', err);
    }
    navigation.navigate('AddNode');
  }, [navigation]);

  // Swap a row with its immediate neighbor (direction: -1 up, +1 down).
  //
  // First-time reorder on an org with all-NULL display_order gets a baseline
  // assignment (10/20/30/…) across all visible rows, matching the dashboard's
  // convention so web + app don't fight over ordering. Any row whose value
  // changes — baseline or swap — is PATCHed. Local state is updated
  // optimistically and rolled back on any PATCH failure.
  const reorder = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= nodes.length) return;

    const prev = nodes;
    const hasNulls = prev.some(n => n?.display_order == null);

    // Baseline: assign 10/20/30/… to current displayed order if any row is
    // NULL. Otherwise keep existing values.
    const working = prev.map((n, i) => ({
      ...n,
      display_order: hasNulls ? (i + 1) * 10 : n.display_order,
    }));

    // Swap display_order between the tapped row and its neighbor.
    const a = working[index].display_order;
    const b = working[target].display_order;
    working[index] = { ...working[index], display_order: b };
    working[target] = { ...working[target], display_order: a };

    // Anything whose display_order changed relative to prev needs a PATCH.
    const changed = working.filter((n, i) => n.display_order !== prev[i].display_order);
    if (changed.length === 0) return;

    setNodes(sortNodes(working));

    try {
      await Promise.all(
        changed.map(n => api.setNodeDisplayOrder(n.id, n.display_order as number)),
      );
    } catch (err: any) {
      setNodes(prev);
      Alert.alert('Reorder Failed', err?.message || 'Could not save node order. Try again.');
    }
  };

  const openRename = (node: any) => {
    setRenameTarget(node);
    setRenameValue(node.name || '');
    setRenameError(null);
  };

  const closeRename = () => {
    if (renameSubmitting) return;
    setRenameTarget(null);
    setRenameValue('');
    setRenameError(null);
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenameError('Name cannot be empty.');
      return;
    }
    if (trimmed.length > 64) {
      setRenameError('Name must be 64 characters or fewer.');
      return;
    }
    setRenameError(null);
    setRenameSubmitting(true);
    const targetId = renameTarget.id;
    try {
      await api.renameNode(targetId, trimmed);
      setNodes(prev => prev.map(n => (n.id === targetId ? { ...n, name: trimmed } : n)));
      setRenameTarget(null);
      setRenameValue('');
      load();
    } catch (err: any) {
      setRenameError(err?.message || 'Rename failed. Try again.');
    } finally {
      setRenameSubmitting(false);
    }
  };

  const handleUnassign = (node: any) => {
    Alert.alert('Unassign Node', `Remove "${node.name}" from its deployment?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unassign', style: 'destructive', onPress: async () => {
        try { await api.unassignNode(node.id); await load(); }
        catch (err: any) { Alert.alert('Error', err.message); }
      }},
    ]);
  };

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
      contentContainerStyle={{
        padding: 16,
        paddingTop: 16 + (insets.top || 0),
        paddingBottom: 40,
      }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.cyan} />}
    >
      <View style={s.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={s.title}>NODES</Text>
          <Text style={s.subtitle}>{nodes.length} node{nodes.length !== 1 ? 's' : ''} registered</Text>
        </View>
        {nodes.length > 0 && c.canPairNode && (
          <TouchableOpacity style={s.addBtn} onPress={handleAddNode} activeOpacity={0.8}>
            <Text style={s.addBtnText}>+ ADD</Text>
          </TouchableOpacity>
        )}
      </View>

      {nodes.map((node, index) => {
        const online = node.status === 'online';
        const lastSeen = node.last_seen ? new Date(node.last_seen) : null;
        const ageSec = lastSeen ? Math.round((Date.now() - lastSeen.getTime()) / 1000) : null;
        const canMoveUp = index > 0;
        const canMoveDown = index < nodes.length - 1;
        return (
          <View key={node.id} style={[s.card, online ? s.cardOnline : s.cardOffline]}>
            <View style={s.nodeHeader}>
              <View style={s.nameRow}>
                <View style={[s.statusDot, { backgroundColor: online ? colors.green : colors.textMuted }]} />
                <Text style={s.nodeName}>{node.name || `Node ${node.id.slice(0, 8)}`}</Text>
                {c.canEditNode && (
                  <TouchableOpacity
                    onPress={() => openRename(node)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={s.renameBtn}
                    accessibilityLabel="Rename node"
                  >
                    <Text style={s.renameIcon}>✎</Text>
                  </TouchableOpacity>
                )}
              </View>
              <View style={s.headerRight}>
                <Text style={[s.statusBadge, { color: online ? colors.green : colors.textMuted }]}>
                  {online ? 'ONLINE' : 'OFFLINE'}
                </Text>
                {c.canEditNode && (
                  <View style={s.reorderCol}>
                    <TouchableOpacity
                      style={[s.reorderBtn, !canMoveUp && s.reorderBtnDisabled]}
                      onPress={() => reorder(index, -1)}
                      disabled={!canMoveUp}
                      hitSlop={{ top: 6, bottom: 2, left: 6, right: 6 }}
                      accessibilityLabel="Move node up"
                    >
                      <Ionicons
                        name="chevron-up"
                        size={16}
                        color={canMoveUp ? colors.cyan : colors.textMuted}
                      />
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[s.reorderBtn, !canMoveDown && s.reorderBtnDisabled]}
                      onPress={() => reorder(index, 1)}
                      disabled={!canMoveDown}
                      hitSlop={{ top: 2, bottom: 6, left: 6, right: 6 }}
                      accessibilityLabel="Move node down"
                    >
                      <Ionicons
                        name="chevron-down"
                        size={16}
                        color={canMoveDown ? colors.cyan : colors.textMuted}
                      />
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            </View>

            <View style={s.nodeDetails}>
              <NodeDetail label="MAC" value={node.mac_address || '—'} />
              <NodeDetail label="FIRMWARE" value={node.firmware_version || '—'} />
              <NodeDetail label="CONNECTION" value={(node.connection_type || '—').toUpperCase()} />
              <NodeDetail label="LAST SEEN" value={ageSec != null ? `${ageSec}s ago` : '—'} />
              {node.last_lat && node.last_lon && (
                <NodeDetail
                  label="LOCATION"
                  value={`${Number(node.last_lat).toFixed(5)}, ${Number(node.last_lon).toFixed(5)}`}
                />
              )}
            </View>

            {node.deployment_name && (
              <View style={s.deploymentTag}>
                <Text style={s.deploymentTagText}>▸ {node.deployment_name}</Text>
              </View>
            )}

            {c.canEditNode && (
              <View style={s.nodeActions}>
                {node.deployment_id ? (
                  <TouchableOpacity style={[s.actionBtn, s.dangerBtn]} onPress={() => handleUnassign(node)}>
                    <Text style={[s.actionBtnText, { color: colors.red }]}>UNASSIGN</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity style={[s.actionBtn, s.assignBtn]} onPress={() => handleAssign(node)}>
                    <Text style={[s.actionBtnText, { color: colors.cyan }]}>ASSIGN TO DEPLOYMENT</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}
          </View>
        );
      })}

      {nodes.length === 0 && (
        <View style={s.empty}>
          <Text style={s.emptyText}>NO NODES</Text>
          <Text style={s.emptyHint}>
            {c.canPairNode
              ? 'Claim a nearby node to start detecting drones'
              : 'No nodes have been registered for your organization yet.'}
          </Text>
          {c.canPairNode && (
            <TouchableOpacity
              style={s.registerBtn}
              onPress={handleAddNode}
              activeOpacity={0.8}
            >
              <Text style={s.registerBtnText}>SCAN FOR NEARBY NODE →</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <Modal
        visible={renameTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={closeRename}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={s.modalBackdrop}
        >
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>RENAME NODE</Text>
            <TextInput
              style={s.modalInput}
              value={renameValue}
              onChangeText={(t) => {
                setRenameValue(t);
                if (renameError) setRenameError(null);
              }}
              maxLength={64}
              autoFocus
              editable={!renameSubmitting}
              placeholder="Node name"
              placeholderTextColor={colors.textMuted}
              selectionColor={colors.cyan}
              returnKeyType="done"
              onSubmitEditing={submitRename}
            />
            <Text style={s.modalCounter}>{renameValue.trim().length}/64</Text>
            {renameError && <Text style={s.modalError}>{renameError}</Text>}
            <View style={s.modalActions}>
              <TouchableOpacity
                style={[s.modalBtn, s.modalCancelBtn, renameSubmitting && s.modalBtnDisabled]}
                onPress={closeRename}
                disabled={renameSubmitting}
                activeOpacity={0.8}
              >
                <Text style={[s.modalBtnText, { color: colors.textMuted }]}>CANCEL</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.modalBtn, s.modalSaveBtn, renameSubmitting && s.modalBtnDisabled]}
                onPress={submitRename}
                disabled={renameSubmitting}
                activeOpacity={0.8}
              >
                {renameSubmitting
                  ? <ActivityIndicator color={colors.cyan} />
                  : <Text style={[s.modalBtnText, { color: colors.cyan }]}>SAVE</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </ScrollView>
  );
}

function NodeDetail({ label, value }: { label: string; value: string }) {
  const colors = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5 }}>
      <Text style={{ color: colors.textMuted, fontSize: 10, letterSpacing: 1, fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace' }}>{label}</Text>
      <Text style={{ color: colors.textDim, fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace' }}>{value}</Text>
    </View>
  );
}

const styles = (c: ReturnType<typeof useTheme>) => StyleSheet.create({
  page: { flex: 1, backgroundColor: c.bg },
  title: {
    color: c.text, fontSize: 18, fontWeight: '700', letterSpacing: 4,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace', marginBottom: 4,
  },
  subtitle: { color: c.textMuted, fontSize: 11, marginBottom: 16 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  addBtn: {
    borderWidth: 1, borderColor: c.cyan, borderRadius: 6,
    paddingHorizontal: 12, paddingVertical: 7,
    backgroundColor: 'rgba(0,212,255,0.08)',
  },
  addBtnText: {
    color: c.cyan, fontSize: 10, fontWeight: '700', letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  card: {
    backgroundColor: c.surface, borderRadius: 12,
    borderWidth: 1, padding: 16, marginBottom: 12,
  },
  cardOnline: { borderColor: 'rgba(0,255,136,0.2)' },
  cardOffline: { borderColor: c.border },
  nodeHeader: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: 12,
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  nodeName: {
    color: c.text, fontSize: 13, fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  statusBadge: {
    fontSize: 9, letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  reorderCol: { flexDirection: 'column', alignItems: 'center' },
  reorderBtn: { paddingHorizontal: 4, paddingVertical: 1 },
  reorderBtnDisabled: { opacity: 0.35 },
  nodeDetails: {
    borderTopWidth: 1, borderTopColor: c.border, paddingTop: 10,
  },
  deploymentTag: {
    marginTop: 10, backgroundColor: 'rgba(0,212,255,0.08)',
    borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5,
    alignSelf: 'flex-start',
  },
  deploymentTagText: {
    color: c.cyan, fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  nodeActions: { marginTop: 12, flexDirection: 'row', gap: 8 },
  actionBtn: { borderRadius: 6, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1 },
  assignBtn: { borderColor: 'rgba(0,212,255,0.3)', backgroundColor: 'rgba(0,212,255,0.08)' },
  dangerBtn: { borderColor: 'rgba(239,68,68,0.3)', backgroundColor: 'rgba(239,68,68,0.08)' },
  actionBtnText: {
    fontSize: 10, fontWeight: '600', letterSpacing: 1,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  empty: { alignItems: 'center', paddingTop: 60 },
  emptyText: {
    color: c.textMuted, fontSize: 12, letterSpacing: 3,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  emptyHint: { color: c.textDim, fontSize: 11, marginTop: 8, textAlign: 'center' },
  registerBtn: {
    marginTop: 20,
    borderWidth: 1, borderColor: c.cyan, borderRadius: 8,
    paddingHorizontal: 18, paddingVertical: 12,
    backgroundColor: 'rgba(0,212,255,0.08)',
  },
  registerBtnText: {
    color: c.cyan, fontSize: 11, fontWeight: '700', letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  renameBtn: { marginLeft: 6, paddingHorizontal: 4, paddingVertical: 2 },
  renameIcon: {
    color: c.cyan, fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center', padding: 24,
  },
  modalCard: {
    backgroundColor: c.surface, borderRadius: 12,
    borderWidth: 1, borderColor: 'rgba(0,212,255,0.3)',
    padding: 20,
  },
  modalTitle: {
    color: c.text, fontSize: 12, fontWeight: '700', letterSpacing: 3,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    marginBottom: 14,
  },
  modalInput: {
    backgroundColor: c.bg, borderWidth: 1, borderColor: c.border,
    borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10,
    color: c.text, fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  modalCounter: {
    color: c.textMuted, fontSize: 10, marginTop: 6, textAlign: 'right',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  modalError: {
    color: c.red, fontSize: 11, marginTop: 10,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  modalActions: {
    flexDirection: 'row', justifyContent: 'flex-end',
    gap: 8, marginTop: 16,
  },
  modalBtn: {
    borderRadius: 6, paddingHorizontal: 14, paddingVertical: 9,
    borderWidth: 1, minWidth: 90, alignItems: 'center',
  },
  modalCancelBtn: { borderColor: c.border, backgroundColor: 'transparent' },
  modalSaveBtn: { borderColor: c.cyan, backgroundColor: 'rgba(0,212,255,0.08)' },
  modalBtnDisabled: { opacity: 0.5 },
  modalBtnText: {
    fontSize: 10, fontWeight: '700', letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
});

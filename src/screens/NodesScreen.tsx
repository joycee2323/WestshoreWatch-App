import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, RefreshControl,
  ActivityIndicator, Platform, TouchableOpacity, Alert,
} from 'react-native';
import { api } from '../services/api';
import { useTheme } from '../theme';

export default function NodesScreen() {
  const colors = useTheme();
  const [nodes, setNodes] = useState<any[]>([]);
  const [deployments, setDeployments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const allNodes = await api.getNodes();
      setNodes(allNodes || []);
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
    options.push({ text: 'Cancel', onPress: () => {} });
    Alert.alert('Assign to Deployment', `Select a deployment for "${node.name || 'this node'}"`, options);
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
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.cyan} />}
    >
      <Text style={s.title}>NODES</Text>
      <Text style={s.subtitle}>{nodes.length} node{nodes.length !== 1 ? 's' : ''} registered</Text>

      {nodes.map(node => {
        const online = node.status === 'online';
        const lastSeen = node.last_seen ? new Date(node.last_seen) : null;
        const ageSec = lastSeen ? Math.round((Date.now() - lastSeen.getTime()) / 1000) : null;
        return (
          <View key={node.id} style={[s.card, online ? s.cardOnline : s.cardOffline]}>
            <View style={s.nodeHeader}>
              <View style={s.nameRow}>
                <View style={[s.statusDot, { backgroundColor: online ? colors.green : colors.textMuted }]} />
                <Text style={s.nodeName}>{node.name || `Node ${node.id.slice(0, 8)}`}</Text>
              </View>
              <Text style={[s.statusBadge, { color: online ? colors.green : colors.textMuted }]}>
                {online ? 'ONLINE' : 'OFFLINE'}
              </Text>
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
          </View>
        );
      })}

      {nodes.length === 0 && (
        <View style={s.empty}>
          <Text style={s.emptyText}>NO NODES</Text>
          <Text style={s.emptyHint}>Nodes appear here once they check in via heartbeat</Text>
        </View>
      )}
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
  emptyText: {
    color: c.textMuted, fontSize: 12, letterSpacing: 3,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  emptyHint: { color: c.textDim, fontSize: 11, marginTop: 8, textAlign: 'center' },
});

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Platform, PermissionsAndroid,
} from 'react-native';
import MapboxGL from '@rnmapbox/maps';
import { useDroneStore } from '../store/droneStore';
import { useAuthStore } from '../store/authStore';
import { createWebSocket, api } from '../services/api';
import { useTheme, getDroneColor } from '../theme';
import { OP_STATUS_AIRBORNE } from '../services/odidParser';
import { startBleScanning, stopBleScanning } from '../services/bleScanner';
import * as Location from 'expo-location';

const HEARTBEAT_INTERVAL_MS = 30_000;

export default function LiveMapScreen() {
  const colors = useTheme();
  const { backendDrones, updateBackendDrone, bleDrones, updateBleDrone, nearbyNodes } = useDroneStore();
  const updateNearbyNode = useDroneStore(s => s.updateNearbyNode);
  const setMode = useDroneStore(s => s.setMode);

  const [activeDeployment, setActiveDeployment] = useState<any>(null);
  const [nodes, setNodes] = useState<any[]>([]);
  const [selectedDrone, setSelectedDrone] = useState<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const cameraRef = useRef<MapboxGL.Camera>(null);
  const timeouts = useRef<Record<string, any>>({});

  // Per-node heartbeat timers keyed by MAC, plus latest api key per MAC
  // so the interval callback always uses the freshest value.
  const heartbeatTimers = useRef<Map<string, any>>(new Map());
  const nodeApiKeys = useRef<Map<string, string>>(new Map());

  const allDrones = { ...bleDrones, ...backendDrones };
  const droneList = Object.values(allDrones);

  const sendHeartbeat = useCallback(async (apiKey: string) => {
    try {
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      await api.nodeHeartbeat(apiKey, {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
      });
    } catch (err) {
      console.warn('nodeHeartbeat failed:', err);
    }
  }, []);

  const ensureHeartbeat = useCallback((mac: string, apiKey: string) => {
    nodeApiKeys.current.set(mac, apiKey);
    if (heartbeatTimers.current.has(mac)) return;
    sendHeartbeat(apiKey);
    const timer = setInterval(() => {
      const key = nodeApiKeys.current.get(mac);
      if (key) sendHeartbeat(key);
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimers.current.set(mac, timer);
  }, [sendHeartbeat]);

  useEffect(() => {
    setMode('backend');
    requestPermissions().then(() => {
      loadActiveDeployment();
      startBleScanning(
        det => updateBleDrone(det.mac, det),
        (mac, rssi, apiKey) => {
          updateNearbyNode(mac, rssi);
          if (apiKey) ensureHeartbeat(mac, apiKey);
        }
      );
    });
    return () => {
      wsRef.current?.close();
      stopBleScanning();
      heartbeatTimers.current.forEach(t => clearInterval(t));
      heartbeatTimers.current.clear();
      nodeApiKeys.current.clear();
    };
  }, []);

  const requestPermissions = async () => {
    await Location.requestForegroundPermissionsAsync();
    if (Platform.OS === 'android' && Platform.Version >= 31) {
      await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]);
    }
  };

  const loadActiveDeployment = async () => {
    try {
      const deps = await api.getDeployments();
      const active = deps.find((d: any) => d.status === 'active');
      if (active) {
        setActiveDeployment(active);
        connectWebSocket(active.id);
        const dets = await api.getDetections(active.id);
        dets.forEach((d: any) => updateBackendDrone(d));
        const nodeList = await api.getNodes(active.id);
        setNodes(nodeList);
      }
    } catch (err) {
      console.warn('Failed to load deployment:', err);
    }
  };

  const connectWebSocket = useCallback((deploymentId: string) => {
    const ws = createWebSocket(deploymentId, (msg) => {
      if (msg.type === 'DRONE_UPDATE') {
        msg.drones.forEach((d: any) => updateBackendDrone(d));
      }
      if (msg.type === 'NODE_OFFLINE') {
        setNodes(prev => prev.map((n: any) =>
          n.id === msg.node_id ? { ...n, status: 'offline' } : n
        ));
      }
    });
    wsRef.current = ws;
  }, []);

  const s = styles(colors);

  return (
    <View style={s.container}>
      <MapboxGL.MapView style={StyleSheet.absoluteFill} styleURL={MapboxGL.StyleURL.Dark}>
        <MapboxGL.Camera
          ref={cameraRef}
          followUserLocation={!selectedDrone}
          followUserMode={MapboxGL.UserTrackingMode.Follow}
          followZoomLevel={14}
        />
        <MapboxGL.UserLocation />

        {/* Node markers */}
        {nodes.map(node => {
          if (!node.last_lat || !node.last_lon) return null;
          const online = node.status === 'online';
          return (
            <MapboxGL.PointAnnotation
              key={`node-${node.id}`}
              id={`node-${node.id}`}
              coordinate={[node.last_lon, node.last_lat]}
            >
              <View style={[s.nodeMarker, { borderColor: online ? colors.green : colors.textMuted }]}>
                <Text style={{ fontSize: 8 }}>📡</Text>
              </View>
            </MapboxGL.PointAnnotation>
          );
        })}

        {/* Drone markers */}
        {droneList.map((drone: any) => {
          const lat = drone.lat ?? drone.last_lat;
          const lon = drone.lon ?? drone.last_lon;
          if (!lat || !lon) return null;
          const id = drone.mac || drone.uas_id;
          const color = getDroneColor(id);
          return (
            <MapboxGL.PointAnnotation
              key={id}
              id={id}
              coordinate={[lon, lat]}
              onSelected={() => setSelectedDrone(drone)}
            >
              <View style={[s.droneMarker, { borderColor: color, backgroundColor: color + '33' }]}>
                <View style={[s.droneCore, { backgroundColor: color }]} />
              </View>
            </MapboxGL.PointAnnotation>
          );
        })}
      </MapboxGL.MapView>

      {/* Deployment banner */}
      <View style={s.topBar}>
        <View>
          <Text style={s.appName}>AIRAWARE</Text>
          {activeDeployment && (
            <Text style={s.depName}>▸ {activeDeployment.name}</Text>
          )}
          {Object.keys(nearbyNodes).length > 0 && (
            <Text style={s.nodeNearby}>📡 NODE IN RANGE</Text>
          )}
        </View>
        <View style={s.statsRow}>
          <View style={s.stat}>
            <Text style={s.statVal}>{droneList.length}</Text>
            <Text style={s.statLabel}>DRONES</Text>
          </View>
          <View style={s.stat}>
            <Text style={[s.statVal, { color: colors.green }]}>
              {nodes.filter(n => n.status === 'online').length}
            </Text>
            <Text style={s.statLabel}>NODES</Text>
          </View>
        </View>
      </View>

      {/* Selected drone sheet */}
      {selectedDrone && (
        <View style={s.detailSheet}>
          <TouchableOpacity style={s.sheetClose} onPress={() => setSelectedDrone(null)}>
            <Text style={s.sheetCloseText}>✕</Text>
          </TouchableOpacity>
          <Text style={s.detailId}>{selectedDrone.uas_id || selectedDrone.uasId || selectedDrone.mac}</Text>
          <View style={s.detailGrid}>
            {[
              ['POSITION', selectedDrone.last_lat ? `${Number(selectedDrone.last_lat).toFixed(6)}, ${Number(selectedDrone.last_lon).toFixed(6)}` : '—'],
              ['ALTITUDE', selectedDrone.last_altitude ? `${Math.round(selectedDrone.last_altitude * 3.28084)}ft MSL` : '—'],
              ['SPEED', selectedDrone.last_speed ? `${(selectedDrone.last_speed * 2.237).toFixed(1)}mph` : '—'],
              ['HEADING', selectedDrone.last_heading ? `${Math.round(selectedDrone.last_heading)}°` : '—'],
              ['OPERATOR', selectedDrone.op_lat ? `${Number(selectedDrone.op_lat).toFixed(6)}, ${Number(selectedDrone.op_lon).toFixed(6)}` : '—'],
              ['NODE', selectedDrone.node_name || '—'],
            ].map(([label, value]) => (
              <View key={label} style={s.detailRow}>
                <Text style={s.detailLabel}>{label}</Text>
                <Text style={s.detailValue}>{value}</Text>
              </View>
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = (c: ReturnType<typeof useTheme>) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    paddingTop: Platform.OS === 'ios' ? 56 : 40, paddingHorizontal: 16, paddingBottom: 12,
    backgroundColor: 'rgba(10,14,26,0.85)',
  },
  appName: {
    color: c.cyan, fontSize: 14, fontWeight: '700', letterSpacing: 4,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  nodeNearby: {
    color: '#00ff88', fontSize: 9, marginTop: 2, letterSpacing: 1,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  statsRow: { flexDirection: 'row', gap: 20 },
  stat: { alignItems: 'center' },
  statVal: {
    color: c.cyan, fontSize: 16, fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  statLabel: {
    color: c.textMuted, fontSize: 8, letterSpacing: 1,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  nodeMarker: {
    width: 26, height: 26, borderRadius: 13, borderWidth: 2,
    backgroundColor: 'rgba(0,255,136,0.1)',
    alignItems: 'center', justifyContent: 'center',
  },
  droneMarker: {
    width: 28, height: 28, borderRadius: 14, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  droneCore: { width: 8, height: 8, borderRadius: 4 },
  detailSheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(17,24,39,0.97)',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderTopWidth: 1, borderColor: c.border,
    padding: 20, paddingBottom: Platform.OS === 'ios' ? 36 : 20,
  },
  sheetClose: { position: 'absolute', right: 20, top: 20 },
  sheetCloseText: { color: c.textMuted, fontSize: 16 },
  detailId: {
    color: c.cyan, fontSize: 14, fontWeight: '600', marginBottom: 16,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  detailGrid: { gap: 2 },
  detailRow: {
    flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7,
    borderBottomWidth: 1, borderBottomColor: c.border,
  },
  detailLabel: {
    color: c.textMuted, fontSize: 10, letterSpacing: 1,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  detailValue: {
    color: c.text, fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
});

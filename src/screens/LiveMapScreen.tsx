import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, TextInput, StyleSheet, TouchableOpacity, Platform, PermissionsAndroid,
} from 'react-native';
import MapboxGL from '@rnmapbox/maps';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useDroneStore } from '../store/droneStore';
import { useAuthStore } from '../store/authStore';
import { createWebSocket, api } from '../services/api';
import { useTheme, getDroneColor } from '../theme';
import { OP_STATUS_AIRBORNE } from '../services/odidParser';
import { startBleScanning, stopBleScanning } from '../services/bleScanner';
import { fetchNodes as fetchNodeRegistry, getNodeByMac, getDeviceIdFromMac } from '../services/nodeRegistry';
import * as Location from 'expo-location';

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_STALE_MS = 60_000;
const HEARTBEAT_FORGET_MS = 300_000;
const NICKNAMES_STORAGE_KEY = 'drone_nicknames';

const loggedMissingHeartbeatNodes = new Set<string>();
// Last time we saw a BLE advertisement from each node (keyed by raw uppercased
// MAC, same key as heartbeatTimers). Used to stop sending heartbeats once a
// node goes out of range, since the BLE foreground service keeps this JS
// process alive indefinitely.
const lastBleSeenAt = new Map<string, number>();
// MACs whose heartbeat is currently in the "skipping (stale)" state, so the
// skip log fires once on the fresh→stale transition rather than every tick.
const currentlySkippingHeartbeats = new Set<string>();

export default function LiveMapScreen() {
  const colors = useTheme();

  // Subscribe to render-relevant state with individual selectors so that
  // high-frequency BLE updates to nearbyNodes don't re-render the whole screen.
  const backendDrones = useDroneStore(s => s.backendDrones);
  const bleDrones = useDroneStore(s => s.bleDrones);
  const nearbyNodeCount = useDroneStore(s => Object.keys(s.nearbyNodes).length);

  const [nicknames, setNicknames] = useState<Record<string, string>>({});
  const nicknamesLoaded = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(NICKNAMES_STORAGE_KEY)
      .then(raw => {
        if (raw) {
          try { setNicknames(JSON.parse(raw)); }
          catch (err) { console.warn('Failed to parse stored nicknames:', err); }
        }
      })
      .catch(err => console.warn('Failed to load nicknames:', err))
      .finally(() => { nicknamesLoaded.current = true; });
  }, []);

  useEffect(() => {
    if (!nicknamesLoaded.current) return;
    AsyncStorage.setItem(NICKNAMES_STORAGE_KEY, JSON.stringify(nicknames))
      .catch(err => console.warn('Failed to save nicknames:', err));
  }, [nicknames]);

  // Actions are stable references — selecting them individually avoids
  // subscribing to unrelated state changes.
  const updateBackendDrone = useDroneStore(s => s.updateBackendDrone);
  const updateBleDrone = useDroneStore(s => s.updateBleDrone);
  const updateNearbyNode = useDroneStore(s => s.updateNearbyNode);
  const setMode = useDroneStore(s => s.setMode);

  const [activeDeployment, setActiveDeployment] = useState<any>(null);
  const [nodes, setNodes] = useState<any[]>([]);
  const nodesRef = useRef<any[]>([]);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);

  const [selectedDrone, setSelectedDrone] = useState<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const cameraRef = useRef<MapboxGL.Camera>(null);
  const timeouts = useRef<Record<string, any>>({});

  const heartbeatTimers = useRef<Map<string, any>>(new Map());

  const allDrones = { ...bleDrones, ...backendDrones };
  const droneList = Object.values(allDrones);

  const sendHeartbeat = useCallback(async (mac: string) => {
    const deviceId = getDeviceIdFromMac(mac);
    try {
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      await api.nodeHeartbeat(deviceId, {
        last_lat: pos.coords.latitude,
        last_lon: pos.coords.longitude,
      });
    } catch (err: any) {
      if (err?.status === 404) {
        if (!loggedMissingHeartbeatNodes.has(deviceId)) {
          loggedMissingHeartbeatNodes.add(deviceId);
          console.warn(`nodeHeartbeat: node ${deviceId} not found, dropping heartbeats (logged once per session)`);
        }
        return;
      }
      console.warn('nodeHeartbeat failed:', err);
    }
  }, []);

  const ensureHeartbeat = useCallback((mac: string) => {
    if (heartbeatTimers.current.has(mac)) return;
    sendHeartbeat(mac);
    const timer = setInterval(() => {
      const last = lastBleSeenAt.get(mac);
      const now = Date.now();
      const idleMs = last == null ? Infinity : now - last;
      const wasSkipping = currentlySkippingHeartbeats.has(mac);

      if (idleMs > HEARTBEAT_FORGET_MS) {
        clearInterval(timer);
        heartbeatTimers.current.delete(mac);
        lastBleSeenAt.delete(mac);
        currentlySkippingHeartbeats.delete(mac);
        console.log(`[heartbeat] forget ${getDeviceIdFromMac(mac)}: no BLE for 5+ min`);
        return;
      }

      if (idleMs > HEARTBEAT_STALE_MS) {
        if (!wasSkipping) {
          currentlySkippingHeartbeats.add(mac);
          console.log(`[heartbeat] skip ${getDeviceIdFromMac(mac)}: stale ${Math.round(idleMs / 1000)}s`);
        }
        return;
      }

      if (wasSkipping) currentlySkippingHeartbeats.delete(mac);
      sendHeartbeat(mac);
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimers.current.set(mac, timer);
  }, [sendHeartbeat]);

  useEffect(() => {
    setMode('backend');
    void fetchNodeRegistry();
    requestPermissions().then(() => {
      loadActiveDeployment();
      startBleScanning(
        det => { if (det.uasId) updateBleDrone(det.uasId, det); },
        (mac, rssi) => {
          updateNearbyNode(mac, rssi);
          lastBleSeenAt.set(mac, Date.now());
          ensureHeartbeat(mac);
        }
      );
    });
    return () => {
      wsRef.current?.close();
      stopBleScanning();
      heartbeatTimers.current.forEach(t => clearInterval(t));
      heartbeatTimers.current.clear();
    };
  }, []);

  const setNickname = useCallback((uasId: string, name: string) => {
    setNicknames(prev => {
      const next = { ...prev };
      if (name.trim()) {
        next[uasId] = name.trim();
      } else {
        delete next[uasId];
      }
      return next;
    });
  }, []);

  const requestPermissions = async () => {
    const locResult = await Location.requestForegroundPermissionsAsync();
    console.log('Location permission:', locResult.status);
    if (Platform.OS === 'android' && Platform.Version >= 31) {
      const bleResult = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]);
      console.log('Bluetooth permissions:', JSON.stringify(bleResult));
    }
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      const notifResult = await PermissionsAndroid.request(
        'android.permission.POST_NOTIFICATIONS' as any,
      );
      console.log('Notification permission:', notifResult);
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

        {/* Drone flight path polylines */}
        {droneList.map((drone: any) => {
          const id = drone.uasId || drone.uas_id || drone.mac;
          const path = drone.path as { lat: number; lon: number }[] | undefined;
          if (!path || path.length < 2) return null;
          const coords = path.map(p => [p.lon, p.lat]);
          const color = getDroneColor(id);
          return (
            <MapboxGL.ShapeSource
              key={`path-${id}`}
              id={`path-${id}`}
              shape={{ type: 'LineString', coordinates: coords }}
            >
              <MapboxGL.LineLayer
                id={`line-${id}`}
                style={{ lineColor: color, lineWidth: 2, lineOpacity: 0.6 }}
              />
            </MapboxGL.ShapeSource>
          );
        })}

        {/* Drone markers via ShapeSource + SymbolLayer */}
        <MapboxGL.ShapeSource
          id="drone-markers"
          shape={{
            type: 'FeatureCollection',
            features: droneList
              .filter((d: any) => (d.lat ?? d.last_lat) && (d.lon ?? d.last_lon))
              .map((d: any) => {
                const id = d.uasId || d.uas_id || d.mac;
                const hdg = d.heading ?? d.last_heading ?? 0;
                return {
                  type: 'Feature' as const,
                  id,
                  geometry: {
                    type: 'Point' as const,
                    coordinates: [d.lon ?? d.last_lon, d.lat ?? d.last_lat],
                  },
                  properties: {
                    droneId: id,
                    heading: hdg,
                    color: getDroneColor(id),
                    label: nicknames[d.uasId || d.uas_id] || d.uasId || d.uas_id || id.slice(-5),
                  },
                };
              }),
          }}
          onPress={(e: any) => {
            const feature = e.features?.[0];
            if (!feature) return;
            const droneId = feature.properties?.droneId;
            const drone = droneList.find((d: any) => (d.uasId || d.uas_id || d.mac) === droneId);
            if (drone) setSelectedDrone(drone);
          }}
        >
          <MapboxGL.SymbolLayer
            id="drone-icons"
            style={{
              textField: '⊕',
              textSize: 30,
              textColor: ['get', 'color'],
              textHaloColor: ['get', 'color'],
              textHaloWidth: 1,
              textAllowOverlap: true,
              textIgnorePlacement: true,
              textFont: ['Arial Unicode MS Regular'],
            }}
          />
          <MapboxGL.SymbolLayer
            id="drone-labels"
            style={{
              textField: ['get', 'label'],
              textSize: 10,
              textColor: ['get', 'color'],
              textOffset: [0, 1.8],
              textAllowOverlap: true,
              textFont: ['DIN Pro Medium', 'Arial Unicode MS Regular'],
            }}
          />
        </MapboxGL.ShapeSource>

        {/* Pilot/operator location markers */}
        <MapboxGL.ShapeSource
          id="pilot-source"
          shape={(() => {
            const features = droneList
              .filter((d: any) => {
                const opLat = d.opLat ?? d.op_lat;
                const opLon = d.opLon ?? d.op_lon;
                return opLat && opLon && (opLat !== 0 || opLon !== 0);
              })
              .map((d: any) => {
                const id = d.uasId || d.uas_id || d.mac;
                return {
                  type: 'Feature' as const,
                  id: `pilot-${id}`,
                  geometry: {
                    type: 'Point' as const,
                    coordinates: [d.opLon ?? d.op_lon, d.opLat ?? d.op_lat],
                  },
                  properties: {
                    color: getDroneColor(id),
                  },
                };
              });
            return { type: 'FeatureCollection' as const, features };
          })()}
        >
          <MapboxGL.SymbolLayer
            id="pilot-symbol"
            style={{
              textField: 'P',
              textSize: 20,
              textColor: '#FFD600',
              textHaloColor: '#FFD600',
              textHaloWidth: 1,
              textAllowOverlap: true,
              textIgnorePlacement: true,
            }}
          />
        </MapboxGL.ShapeSource>
      </MapboxGL.MapView>

      {/* Deployment banner */}
      <View style={s.topBar}>
        <View>
          <Text style={s.appName}>AIRAWARE</Text>
          {activeDeployment && (
            <Text style={s.depName}>▸ {activeDeployment.name}</Text>
          )}
          {nearbyNodeCount > 0 && (
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
              {nodes.filter(n => n.last_lat && n.last_lon && n.last_seen && (Date.now() - new Date(n.last_seen).getTime() < 120000)).length}
            </Text>
            <Text style={s.statLabel}>NODES</Text>
          </View>
        </View>
      </View>

      {/* Selected drone sheet */}
      {selectedDrone && (() => {
        // Live lookup so the panel reflects real-time updates, not a stale snapshot
        const selId = selectedDrone.uasId || selectedDrone.uas_id || selectedDrone.mac;
        const liveDrone = droneList.find((d: any) =>
          (d.uasId || d.uas_id || d.mac) === selId
        ) ?? selectedDrone;

        // Normalize field names: BLE drones use camelCase, backend uses snake_case
        const dLat = liveDrone.lat ?? liveDrone.last_lat;
        const dLon = liveDrone.lon ?? liveDrone.last_lon;
        const dAlt = liveDrone.altGeo ?? liveDrone.last_altitude;
        const dSpeed = liveDrone.speedHoriz ?? liveDrone.last_speed;
        const dOpLat = liveDrone.opLat ?? liveDrone.op_lat;
        const dOpLon = liveDrone.opLon ?? liveDrone.op_lon;

        // Resolve source node name from the registry by BLE MAC.
        const srcMac = liveDrone.sourceMac;
        const sourceNode = srcMac ? getNodeByMac(srcMac) : null;
        const nodeName = sourceNode?.name || liveDrone.node_name || '—';

        const uasId = liveDrone.uasId || liveDrone.uas_id || liveDrone.mac;
        const nickname = nicknames[uasId] || '';

        return (
          <View style={s.detailSheet}>
            <TouchableOpacity
              style={s.sheetClose}
              onPress={() => setSelectedDrone(null)}
              hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
              activeOpacity={0.6}
            >
              <Text style={s.sheetCloseText}>✕</Text>
            </TouchableOpacity>
            {nickname ? (
              <View style={{ marginBottom: 4 }}>
                <Text style={s.detailNickname}>{nickname}</Text>
                <Text style={s.detailIdSmall}>{uasId}</Text>
              </View>
            ) : (
              <Text style={s.detailId}>{uasId}</Text>
            )}
            <TextInput
              style={s.nicknameInput}
              value={nickname}
              onChangeText={(text) => setNickname(uasId, text)}
              placeholder="Add nickname..."
              placeholderTextColor={colors.textMuted}
              maxLength={30}
            />
            <View style={s.detailGrid}>
              {[
                ['POSITION', dLat != null ? `${Number(dLat).toFixed(6)}, ${Number(dLon).toFixed(6)}` : '—'],
                ['ALTITUDE', dAlt != null ? `${Math.round(dAlt * 3.28084)}ft MSL` : '—'],
                ['SPEED', dSpeed != null ? `${(dSpeed * 2.237).toFixed(1)}mph` : '—'],
                ['OPERATOR', dOpLat != null ? `${Number(dOpLat).toFixed(6)}, ${Number(dOpLon).toFixed(6)}` : '—'],
                ['NODE', nodeName],
              ].map(([label, value]) => (
                <View key={label} style={s.detailRow}>
                  <Text style={s.detailLabel}>{label}</Text>
                  <Text style={s.detailValue}>{value}</Text>
                </View>
              ))}
            </View>
          </View>
        );
      })()}
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
  detailSheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(17,24,39,0.97)',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderTopWidth: 1, borderColor: c.border,
    padding: 20, paddingBottom: Platform.OS === 'ios' ? 36 : 20,
  },
  sheetClose: { position: 'absolute', right: 16, top: 16, padding: 8 },
  sheetCloseText: { color: c.textMuted, fontSize: 20, fontWeight: '700' },
  detailNickname: {
    color: c.cyan, fontSize: 18, fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  detailIdSmall: {
    color: c.textMuted, fontSize: 10, marginTop: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  detailId: {
    color: c.cyan, fontSize: 14, fontWeight: '600', marginBottom: 4,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  nicknameInput: {
    color: c.text, fontSize: 12, marginBottom: 12, paddingVertical: 6, paddingHorizontal: 8,
    borderWidth: 1, borderColor: c.border, borderRadius: 6,
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

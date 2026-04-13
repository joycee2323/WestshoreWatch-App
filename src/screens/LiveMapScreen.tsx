import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, TextInput, StyleSheet, TouchableOpacity, Platform, PermissionsAndroid,
} from 'react-native';
import MapboxGL from '@rnmapbox/maps';
import { useDroneStore } from '../store/droneStore';
import { useAuthStore } from '../store/authStore';
import { createWebSocket, api } from '../services/api';
import { useTheme, getDroneColor } from '../theme';
import { OP_STATUS_AIRBORNE } from '../services/odidParser';
import { startBackgroundScanning, stopBackgroundScanning } from '../services/bleScanner';
import * as Location from 'expo-location';

const HEARTBEAT_INTERVAL_MS = 30_000;

export default function LiveMapScreen() {
  const colors = useTheme();

  // Subscribe to render-relevant state with individual selectors so that
  // high-frequency BLE updates to nearbyNodes don't re-render the whole screen.
  const backendDrones = useDroneStore(s => s.backendDrones);
  const bleDrones = useDroneStore(s => s.bleDrones);
  const nearbyNodeCount = useDroneStore(s => Object.keys(s.nearbyNodes).length);

  const [nicknames, setNicknames] = useState<Record<string, string>>({});

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
      startBackgroundScanning(
        det => updateBleDrone(det.mac, det),
        (mac, rssi, apiKey) => {
          updateNearbyNode(mac, rssi);
          if (apiKey) ensureHeartbeat(mac, apiKey);
        }
      );
    });
    return () => {
      wsRef.current?.close();
      stopBackgroundScanning();
      heartbeatTimers.current.forEach(t => clearInterval(t));
      heartbeatTimers.current.clear();
      nodeApiKeys.current.clear();
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
          const id = drone.mac || drone.uas_id;
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
                const id = d.mac || d.uas_id;
                const hdg = d.heading ?? d.last_heading ?? 0;
                console.log('[DroneFeature]', d.uasId || d.uas_id || id, { heading: d.heading, last_heading: d.last_heading, resolved: hdg });
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
            const drone = droneList.find((d: any) => (d.mac || d.uas_id) === droneId);
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
                const id = d.mac || d.uas_id;
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
            console.log('[PilotFeatures]', JSON.stringify(features));
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
        const selId = selectedDrone.mac || selectedDrone.uas_id;
        const liveDrone = droneList.find((d: any) =>
          (d.mac || d.uas_id) === selId
        ) ?? selectedDrone;

        // Normalize field names: BLE drones use camelCase, backend uses snake_case
        const dLat = liveDrone.lat ?? liveDrone.last_lat;
        const dLon = liveDrone.lon ?? liveDrone.last_lon;
        const dAlt = liveDrone.altGeo ?? liveDrone.last_altitude;
        const dSpeed = liveDrone.speedHoriz ?? liveDrone.last_speed;
        const dOpLat = liveDrone.opLat ?? liveDrone.op_lat;
        const dOpLon = liveDrone.opLon ?? liveDrone.op_lon;

        // Look up source node by matching sourceApiKey against the nodes list.
        // sourceApiKey comes from NODE_API_KEYS in bleScanner.ts (BLE MAC → api_key).
        // Look up source node by deriving station MAC from BLE sourceMac.
        // BLE MAC has last byte 2 higher than station MAC, and backend
        // stores device_id as uppercase hex without colons (e.g. "98A3167D2634").
        const srcMac = liveDrone.sourceMac;
        const currentNodes = nodesRef.current;
        let sourceNode: any = null;
        if (srcMac) {
          const stripped = srcMac.replace(/:/g, '').toUpperCase();
          const lastByte = parseInt(stripped.slice(-2), 16) - 1;
          if (lastByte >= 0) {
            const stationDeviceId = stripped.slice(0, -2) + lastByte.toString(16).padStart(2, '0').toUpperCase();
            sourceNode = currentNodes.find((n: any) =>
              (n.device_id || '').toUpperCase() === stationDeviceId
            );
          }
        }
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

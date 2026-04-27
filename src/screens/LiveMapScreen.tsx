import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, TextInput, StyleSheet, TouchableOpacity, Platform, PermissionsAndroid, AppState, Linking, Alert,
} from 'react-native';
import MapboxGL from '@rnmapbox/maps';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from '@react-navigation/native';
import KeepScreenOnToggle from '../components/KeepScreenOnToggle';
import { useDroneStore } from '../store/droneStore';
import { useAuthStore } from '../store/authStore';
import { createWebSocket, api, ReconnectingWebSocket } from '../services/api';
import { useTheme, getDroneColor } from '../theme';
import { OP_STATUS_AIRBORNE } from '../services/odidParser';
import { startBleScanning, stopBleScanning } from '../services/bleScanner';
import { fetchNodes as fetchNodeRegistry, getNodeByMac } from '../services/nodeRegistry';
import * as Location from 'expo-location';

const NODE_REGISTRATION_URL = 'https://watch.westshoredrone.com/nodes';
// Debounce window for nickname edits — avoids hammering the backend on every
// keystroke while the operator is typing. Saves on settle.
const NICKNAME_SAVE_DEBOUNCE_MS = 500;
const NICKNAME_MAX = 30;
// Tracks whether we've already prompted for ACCESS_BACKGROUND_LOCATION on this
// install. Android requires the staged flow (foreground first, background
// later) and will not re-show the system dialog if the user denied it once,
// so re-prompting every launch is wasted work and gates user interaction.
const BACKGROUND_LOCATION_PROMPTED_KEY = 'background_location_prompted_v1';
// Delay before prompting for background location after the FG service starts.
// Gives the user a moment to settle into the app so the second permission
// dialog doesn't feel like a wall of prompts.
const BACKGROUND_LOCATION_PROMPT_DELAY_MS = 30_000;

// uasIds we've already logged a BLE-skip message for — keeps logcat readable
// when the same drone is seen thousands of times. Bounded by distinct drones
// the app sees per session, which is small in practice.
const loggedSkippedUasIds = new Set<string>();

export default function LiveMapScreen() {
  const colors = useTheme();

  // Subscribe to render-relevant state with individual selectors so that
  // high-frequency BLE updates to nearbyNodes don't re-render the whole screen.
  const backendDrones = useDroneStore(s => s.backendDrones);
  const nearbyNodeCount = useDroneStore(s => Object.keys(s.nearbyNodes).length);
  const nicknames = useDroneStore(s => s.nicknamesByUasId);

  // Actions are stable references — selecting them individually avoids
  // subscribing to unrelated state changes.
  const updateBackendDrone = useDroneStore(s => s.updateBackendDrone);
  const updateBleDrone = useDroneStore(s => s.updateBleDrone);
  const updateNearbyNode = useDroneStore(s => s.updateNearbyNode);
  const setNicknames = useDroneStore(s => s.setNicknames);
  const updateNickname = useDroneStore(s => s.updateNickname);

  // Per-uasId debounce timers keyed so editing several drones in succession
  // doesn't cancel earlier saves. Cleared on screen unmount.
  const nicknameSaveTimers = useRef<Record<string, any>>({});

  const orgId = useAuthStore(s => s.user?.org_id);

  // Initial nickname hydrate — once we know the user's org, fetch the
  // server-side map. Without this, nicknames only appear once a drone is
  // seen via a detection broadcast.
  useEffect(() => {
    if (!orgId) return;
    api.getDroneNicknames(orgId)
      .then((rows: any[]) => {
        const map: Record<string, string> = {};
        for (const r of rows || []) {
          if (r?.uas_id && r?.nickname) map[r.uas_id] = r.nickname;
        }
        setNicknames(map);
      })
      .catch(err => console.warn('[nicknames] initial fetch failed:', err));
  }, [orgId, setNicknames]);

  const [activeDeployment, setActiveDeployment] = useState<any>(null);
  const activeDeploymentRef = useRef<any>(null);
  useEffect(() => { activeDeploymentRef.current = activeDeployment; }, [activeDeployment]);
  const [nodes, setNodes] = useState<any[]>([]);
  const nodesRef = useRef<any[]>([]);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  // `nodes` above is scoped to the active deployment; this tracks whether the
  // user has registered ANY node across their account (drives the empty-state
  // banner for users who skipped onboarding).
  const [userHasAnyNode, setUserHasAnyNode] = useState<boolean | null>(null);

  const checkUserNodes = useCallback(async () => {
    try {
      const all = await api.getNodes();
      setUserHasAnyNode(Array.isArray(all) && all.length > 0);
    } catch (err) {
      console.warn('Failed to check user nodes:', err);
    }
  }, []);

  const [selectedDrone, setSelectedDrone] = useState<any>(null);
  const [showBackgroundLocationBanner, setShowBackgroundLocationBanner] = useState(false);
  const backgroundPromptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef = useRef<ReconnectingWebSocket | null>(null);
  const cameraRef = useRef<MapboxGL.Camera>(null);
  const timeouts = useRef<Record<string, any>>({});

  const droneList = Object.values(backendDrones);

  // Heartbeat is now driven by the native FG service (NodeHeartbeatUploader).
  // Living in Kotlin lets it survive Android Doze, so nodes stay "online" on
  // the dashboard while the phone screen is off. JS no longer maintains
  // per-node timers, last-seen state, or 404/skip tracking — see
  // android/app/src/main/java/com/westshoredrone/watch/NodeHeartbeatUploader.kt.

  // Refetch the node list for the active deployment. Used by the initial load,
  // focus/foreground resume, and unknown-node WS messages. Accepts an optional
  // deployment arg for the first call (before setActiveDeployment has flushed
  // into the ref).
  const refetchNodes = useCallback(async (dep?: any) => {
    const active = dep ?? activeDeploymentRef.current;
    if (!active) return;
    try {
      const nodeList = await api.getNodes(active.id);
      setNodes(nodeList);
    } catch (err) {
      console.warn('[nodeRefetch] failed:', err);
    }
  }, []);

  // Debounced wrapper for WS-triggered refetches — a burst of NODE_ONLINE
  // messages (e.g. after a backend restart) coalesces into a single request.
  const refetchDebounceTimer = useRef<any>(null);
  const scheduleRefetchNodes = useCallback(() => {
    if (refetchDebounceTimer.current) clearTimeout(refetchDebounceTimer.current);
    refetchDebounceTimer.current = setTimeout(() => {
      void refetchNodes();
    }, 300);
  }, [refetchNodes]);

  useEffect(() => {
    void fetchNodeRegistry();
    void checkUserNodes();
    requestPermissions().then(() => {
      loadActiveDeployment();
      startBleScanning(
        det => {
          // When a deployment is active, positions come from the backend's
          // coalesced WS stream. Routing raw BLE parses into the store here
          // would flicker the marker, since nodes rebroadcast each drone's
          // ODID independently and the phone receives ~5 Hz per node.
          if (activeDeploymentRef.current) {
            if (det.uasId && !loggedSkippedUasIds.has(det.uasId)) {
              loggedSkippedUasIds.add(det.uasId);
              console.info(`[livemap] skipping BLE write for uasId=${det.uasId} — backend-authoritative`);
            }
            return;
          }
          if (det.uasId) updateBleDrone(det.uasId, det);
        },
        (mac, rssi) => {
          updateNearbyNode(mac, rssi);
        }
      ).then(() => {
        // FG service is up — schedule the deferred background-location prompt.
        // Android requires foreground location to be granted first, which the
        // initial requestPermissions() handled.
        backgroundPromptTimer.current = setTimeout(() => {
          void maybePromptBackgroundLocation();
        }, BACKGROUND_LOCATION_PROMPT_DELAY_MS);
      }).catch((err: any) => {
        // Native module rejected — most likely the FG service didn't actually
        // come up (BLE_SERVICE_NOT_RUNNING). Surface to the user instead of
        // silently failing.
        const code = err?.code || err?.userInfo?.code;
        const msg = err?.message || 'Background scanning could not start.';
        console.warn('[livemap] startBleScanning failed:', code, msg);
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
      });
    });
    return () => {
      wsRef.current?.close();
      stopBleScanning();
      if (refetchDebounceTimer.current) clearTimeout(refetchDebounceTimer.current);
      if (backgroundPromptTimer.current) clearTimeout(backgroundPromptTimer.current);
      // Cancel any pending nickname-save debounces. The pending edits will
      // be lost; on next mount, the server-side state hydrates via getDroneNicknames.
      Object.values(nicknameSaveTimers.current).forEach(t => clearTimeout(t));
      nicknameSaveTimers.current = {};
    };
  }, []);

  // Refetch nodes when this screen regains focus (e.g. after the user visits
  // the Nodes tab and returns, where assignments may have changed).
  useFocusEffect(
    useCallback(() => {
      void refetchNodes();
      void checkUserNodes();
    }, [refetchNodes, checkUserNodes])
  );

  // Refetch nodes when the app returns from background to foreground — the
  // WS connection may have dropped heartbeats while suspended.
  useEffect(() => {
    let prevState = AppState.currentState;
    const sub = AppState.addEventListener('change', (state) => {
      if (prevState !== 'active' && state === 'active') {
        void refetchNodes();
      }
      prevState = state;
    });
    return () => sub.remove();
  }, [refetchNodes]);

  // Operator typed into the nickname TextInput. Optimistically update the
  // local store, then debounce a server PATCH. The server's WS broadcast
  // is the canonical confirmation; if the PATCH fails, the next broadcast
  // (or detection enrichment) reverts the optimistic value.
  const setNickname = useCallback((uasId: string, name: string) => {
    if (!uasId) return;
    const trimmed = name.trim().slice(0, NICKNAME_MAX);
    updateNickname(uasId, trimmed.length > 0 ? trimmed : null);

    if (!orgId) return;
    if (nicknameSaveTimers.current[uasId]) {
      clearTimeout(nicknameSaveTimers.current[uasId]);
    }
    nicknameSaveTimers.current[uasId] = setTimeout(() => {
      delete nicknameSaveTimers.current[uasId];
      api.setDroneNickname(orgId, uasId, trimmed).catch(err => {
        console.warn('[nicknames] save failed:', err);
      });
    }, NICKNAME_SAVE_DEBOUNCE_MS);
  }, [orgId, updateNickname]);

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

  // Deferred background-location prompt. Android 12+ no longer gates BLE scans
  // on this (BLUETOOTH_SCAN now uses neverForLocation), but on Android 10/11 —
  // and as a defense-in-depth signal to the OS — we still want it granted so
  // the FG service runs without throttling once the screen is off.
  // Called ~30s after the FG service starts so the user has settled into the
  // app before seeing the second permission dialog.
  const maybePromptBackgroundLocation = async () => {
    if (Platform.OS !== 'android') return;
    try {
      const already = await AsyncStorage.getItem(BACKGROUND_LOCATION_PROMPTED_KEY);
      if (already) return;
      const fg = await Location.getForegroundPermissionsAsync();
      if (fg.status !== 'granted') return;
      const existing = await Location.getBackgroundPermissionsAsync();
      if (existing.status === 'granted') {
        await AsyncStorage.setItem(BACKGROUND_LOCATION_PROMPTED_KEY, '1');
        return;
      }
      const res = await Location.requestBackgroundPermissionsAsync();
      await AsyncStorage.setItem(BACKGROUND_LOCATION_PROMPTED_KEY, '1');
      console.log('Background location permission:', res.status);
      if (res.status !== 'granted') {
        setShowBackgroundLocationBanner(true);
      }
    } catch (err) {
      console.warn('[livemap] background location prompt failed:', err);
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
        // Filter to the last 60s so stale detections from earlier in the
        // deployment don't hydrate as live markers. Matches the dashboard
        // hydrate path (commit 9e0cf92).
        const cutoff = Date.now() - 60_000;
        dets
          .filter((d: any) => d.last_seen && new Date(d.last_seen).getTime() > cutoff)
          .forEach((d: any) => updateBackendDrone(d));
        await refetchNodes(active);
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
      if (msg.type === 'NICKNAME_UPDATE') {
        // Backend broadcasts to all clients; ignore other orgs.
        if (orgId && msg.org_id && msg.org_id !== orgId) return;
        updateNickname(msg.uas_id, msg.nickname || null);
      }
      if (msg.type === 'NODE_OFFLINE') {
        setNodes(prev => prev.map((n: any) =>
          n.id === msg.node_id ? { ...n, status: 'offline' } : n
        ));
      }
      if (msg.type === 'NODE_ONLINE') {
        const existing = nodesRef.current.find((n: any) => n.id === msg.node_id);
        if (existing) {
          setNodes(prev => prev.map((n: any) =>
            n.id === msg.node_id
              ? { ...n, status: 'online', last_seen: new Date().toISOString() }
              : n
          ));
        } else {
          // Unknown node — WS payload has only node_id, not a full record.
          // Refetch to hydrate (debounced to coalesce bursts).
          scheduleRefetchNodes();
        }
      }
    }, {
      // After an unexpected close + reconnect, the WS resumes live updates
      // but the client's in-memory state is stale for whatever window the
      // connection was down. Refetch detections + nodes for the active
      // deployment to close the gap. Guarded on activeDeploymentRef to
      // avoid racing with deployment teardown.
      onReconnect: () => {
        const active = activeDeploymentRef.current;
        if (!active) return;
        console.info('[ws] reconnect — refetching detections + nodes for', active.id);
        (async () => {
          try {
            const dets = await api.getDetections(active.id);
            const cutoff = Date.now() - 60_000;
            dets
              .filter((d: any) => d.last_seen && new Date(d.last_seen).getTime() > cutoff)
              .forEach((d: any) => updateBackendDrone(d));
          } catch (err) {
            console.warn('[ws] reconnect detection refetch failed:', err);
          }
          void refetchNodes(active);
        })();
      },
    });
    wsRef.current = ws;
  }, [scheduleRefetchNodes, updateBackendDrone, refetchNodes, orgId, updateNickname]);

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
          <Text style={s.appName}>WESTSHORE WATCH</Text>
          {activeDeployment && (
            <Text style={s.depName}>▸ {activeDeployment.name}</Text>
          )}
          {nearbyNodeCount > 0 && (
            <Text style={s.nodeNearby}>📡 NODE IN RANGE</Text>
          )}
        </View>
        <KeepScreenOnToggle keepAwakeTag="live-map" />
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

      {/* No-nodes prompt for users who skipped onboarding */}
      {userHasAnyNode === false && (
        <TouchableOpacity
          style={s.noNodesBanner}
          onPress={() => Linking.openURL(NODE_REGISTRATION_URL)}
          activeOpacity={0.8}
        >
          <View style={{ flex: 1 }}>
            <Text style={s.noNodesTitle}>ADD YOUR FIRST NODE</Text>
            <Text style={s.noNodesSub}>Register a node to start detecting drones</Text>
          </View>
          <Text style={s.noNodesArrow}>→</Text>
        </TouchableOpacity>
      )}

      {/* Background-location prompt result: dismissible until next launch */}
      {showBackgroundLocationBanner && (
        <View style={s.bgLocBanner}>
          <View style={{ flex: 1 }}>
            <Text style={s.bgLocTitle}>BACKGROUND SCANNING LIMITED</Text>
            <Text style={s.bgLocSub}>
              Background scanning may stop when the screen turns off. To keep monitoring continuously, grant "Allow all the time" for location in app settings.
            </Text>
            <View style={s.bgLocActions}>
              <TouchableOpacity onPress={() => Linking.openSettings()} activeOpacity={0.7}>
                <Text style={s.bgLocAction}>OPEN SETTINGS</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setShowBackgroundLocationBanner(false)} activeOpacity={0.7}>
                <Text style={s.bgLocDismiss}>DISMISS</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

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
    color: c.cyan, fontSize: 11, fontWeight: '700', letterSpacing: 2,
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
  noNodesBanner: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 120 : 104,
    left: 16, right: 16,
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, paddingHorizontal: 14,
    borderRadius: 10, borderWidth: 1, borderColor: c.cyan,
    backgroundColor: 'rgba(0,212,255,0.12)',
  },
  noNodesTitle: {
    color: c.cyan, fontSize: 11, fontWeight: '700', letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  noNodesSub: {
    color: c.textDim, fontSize: 10, marginTop: 2,
  },
  noNodesArrow: {
    color: c.cyan, fontSize: 18, fontWeight: '700', marginLeft: 12,
  },
  bgLocBanner: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 120 : 104,
    left: 16, right: 16,
    paddingVertical: 10, paddingHorizontal: 14,
    borderRadius: 10, borderWidth: 1, borderColor: c.amber,
    backgroundColor: 'rgba(245,158,11,0.12)',
  },
  bgLocTitle: {
    color: c.amber, fontSize: 11, fontWeight: '700', letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  bgLocSub: {
    color: c.textDim, fontSize: 10, marginTop: 4, lineHeight: 14,
  },
  bgLocActions: {
    flexDirection: 'row', gap: 16, marginTop: 8,
  },
  bgLocAction: {
    color: c.amber, fontSize: 10, fontWeight: '700', letterSpacing: 1,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  bgLocDismiss: {
    color: c.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
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

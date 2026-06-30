import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  Platform, Alert, ActivityIndicator, PermissionsAndroid,
  DeviceEventEmitter,
} from 'react-native';
import MapboxGL from '@rnmapbox/maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDroneStore, DroneEntry } from '../store/droneStore';
import { startBleScanning, stopBleScanning, getBridgeInRange } from '../services/bleScanner';
import { useTheme, getDroneColor } from '../theme';
import KeepScreenOnToggle from '../components/KeepScreenOnToggle';
import KeepScreenActiveModal from '../components/KeepScreenActiveModal';
import DetectionLimitedBanner from '../components/DetectionLimitedBanner';
import { useScanActiveWarning } from '../hooks/useScanActiveWarning';
import * as Location from 'expo-location';
import { OP_STATUS_AIRBORNE } from '../services/odidParser';
import { fmtAltitude, fmtSpeed } from '../utils/units';

MapboxGL.setAccessToken(process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN ?? '');

// Same coord-coercion helpers as LiveMapScreen. BLE detections come from
// native Swift/Kotlin and should already be numeric, but we normalize at
// ingest anyway — defends against any future bridge change that might
// hand us strings, and keeps iOS Mapbox's strict Codable decoder happy
// regardless of upstream wire format.
const numOrNull = (v: any): number | null => {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

// Normalizes every coordinate field a BLE detection might carry. Returns
// a shallow copy with lat/lon/opLat/opLon coerced; everything else passes
// through.
const normalizeDetCoords = (det: any) => ({
  ...det,
  lat: numOrNull(det.lat),
  lon: numOrNull(det.lon),
  opLat: numOrNull(det.opLat),
  opLon: numOrNull(det.opLon),
});

async function requestAllPermissions(): Promise<boolean> {
  // Location (required for BLE scanning on Android 12+)
  const { status: locStatus } = await Location.requestForegroundPermissionsAsync();
  if (locStatus !== 'granted') return false;

  // Bluetooth permissions (Android 12+ only)
  if (Platform.OS === 'android' && Platform.Version >= 31) {
    const results = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    const scanGranted = results[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] === 'granted';
    const connectGranted = results[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === 'granted';
    if (!scanGranted || !connectGranted) return false;
  }

  return true;
}

export default function GuestScanScreen({ navigation }: any) {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const { bleDrones, updateBleDrone, nearbyNodes } = useDroneStore();
  const updateNearbyNode = useDroneStore(s => s.updateNearbyNode);
  const [selectedDrone, setSelectedDrone] = useState<DroneEntry | null>(null);
  const [sheetCollapsed, setSheetCollapsed] = useState(false);
  // Set true by a marker's onPress so MapView.onPress doesn't immediately
  // undo the selection on the same tap.
  const featureTappedRef = useRef(false);
  const [locationGranted, setLocationGranted] = useState(false);
  const cameraRef = useRef<MapboxGL.Camera>(null);

  // iOS background-during-scan warning (notification, or banner fallback when
  // notification permission is denied). Tied to the real scanner state.
  const { showBanner: showScanWarning, dismissBanner: dismissScanWarning } = useScanActiveWarning();

  // DroneScout bridge proximity ("NODE" badge) — protocol-signature proximity,
  // NOT node identity (see bleScanner). bleScanner emits on in/out-of-range
  // transitions; we mirror it into local state. This is the iOS-functional
  // 0xFFFA path; the nearbyNodes (0x08FE) path below only lights on Android.
  const [bridgeInRange, setBridgeInRange] = useState(getBridgeInRange());
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(
      'BridgeInRangeChanged',
      (p: { inRange?: boolean }) => setBridgeInRange(!!p?.inRange),
    );
    return () => sub.remove();
  }, []);

  const droneList = Object.values(bleDrones);
  const selectedId = selectedDrone
    ? ((selectedDrone as any).uasId || (selectedDrone as any).uas_id || selectedDrone.mac)
    : null;

  useEffect(() => {
    requestPermissions();
    return () => stopBleScanning();
  }, []);

  const requestPermissions = async () => {
    const granted = await requestAllPermissions();
    if (granted) {
      setLocationGranted(true);
      startScanning();
    } else {
      Alert.alert(
        'Permissions Required',
        'Westshore Watch needs Bluetooth and Location permissions to scan for nearby drones. Please enable them in Settings.',
        [{ text: 'OK' }]
      );
    }
  };

  const startScanning = async () => {
    try {
      await startBleScanning(
        (det) => {
          if (!det.uasId) return;
          // Normalize coords at ingest — defensive against any string-typed
          // values the native BLE bridge might emit. iOS Mapbox strict-
          // decodes; better to coerce once here than guard at every read.
          updateBleDrone(det.uasId, normalizeDetCoords(det));
        },
        (mac, rssi) => { updateNearbyNode(mac, rssi); }
      );
    } catch (err: any) {
      Alert.alert('Bluetooth Error', err.message);
    }
  };

  const s = styles(colors);

  return (
    <View style={s.container}>
      {/* Map */}
      <MapboxGL.MapView
        style={StyleSheet.absoluteFill}
        styleURL={MapboxGL.StyleURL.Dark}
        onPress={() => {
          if (featureTappedRef.current) {
            featureTappedRef.current = false;
            return;
          }
          if (selectedDrone) setSelectedDrone(null);
        }}
      >
        <MapboxGL.Camera
          ref={cameraRef}
          followUserLocation={!selectedDrone}
          followUserMode={MapboxGL.UserTrackingMode.Follow}
          followZoomLevel={14}
        />
        <MapboxGL.UserLocation visible={locationGranted} />

        {/* Drone markers via ShapeSource + CircleLayer. Replaces the prior
            PointAnnotation pattern (View > View) which iOS Mapbox refuses
            to render — same root cause as the Sentinel marker bug. Two
            stacked layers (outer ring + inner dot) match the original
            bull's-eye look. Per-drone color via feature.properties.color
            since SymbolLayer expressions can't call getDroneColor(). */}
        <MapboxGL.ShapeSource
          id="guest-drone-markers"
          shape={{
            type: 'FeatureCollection',
            features: droneList
              .filter((d: any) => typeof d.lat === 'number' && typeof d.lon === 'number')
              .map((d: any) => {
                const id = d.uasId || d.uas_id || d.mac;
                return {
                  type: 'Feature' as const,
                  id,
                  geometry: {
                    type: 'Point' as const,
                    coordinates: [d.lon, d.lat],
                  },
                  properties: {
                    droneId: id,
                    color: getDroneColor(id),
                    opacity: selectedId == null || selectedId === id ? 1.0 : 0.5,
                  },
                };
              }),
          }}
          onPress={(e: any) => {
            featureTappedRef.current = true;
            const feature = e.features?.[0];
            if (!feature) return;
            const droneId = feature.properties?.droneId;
            if (selectedId === droneId) {
              setSelectedDrone(null);
              return;
            }
            const drone = droneList.find((d: any) =>
              (d.uasId || d.uas_id || d.mac) === droneId
            );
            if (drone) {
              setSelectedDrone(drone);
              setSheetCollapsed(false);
            }
          }}
        >
          <MapboxGL.CircleLayer
            id="guest-drone-ring"
            style={{
              circleRadius: 10,
              circleColor: ['get', 'color'],
              circleOpacity: ['*', 0.2, ['get', 'opacity']],
              circleStrokeWidth: 2,
              circleStrokeColor: ['get', 'color'],
              circleStrokeOpacity: ['get', 'opacity'],
            }}
          />
          <MapboxGL.CircleLayer
            id="guest-drone-core"
            style={{
              circleRadius: 4,
              circleColor: ['get', 'color'],
              circleOpacity: ['get', 'opacity'],
            }}
          />
        </MapboxGL.ShapeSource>

        {/* Flight path — only the selected drone's path renders. */}
        {droneList.map((drone: any) => {
          if (!drone.path || drone.path.length < 2) return null;
          const id = drone.uasId || drone.uas_id || drone.mac;
          if (id !== selectedId) return null;
          const color = getDroneColor(id);
          const coords = drone.path
            .filter((p: any) => typeof p.lat === 'number' && typeof p.lon === 'number')
            .map((p: any) => [p.lon, p.lat]);
          if (coords.length < 2) return null;
          return (
            <MapboxGL.ShapeSource
              key={`path-${id}`}
              id={`path-${id}`}
              shape={{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }}
            >
              <MapboxGL.LineLayer
                id={`line-${id}`}
                style={{ lineColor: color, lineWidth: 1.5, lineOpacity: 0.6 }}
              />
            </MapboxGL.ShapeSource>
          );
        })}
      </MapboxGL.MapView>

      {/* Top bar */}
      <View style={[s.topBar, { paddingTop: insets.top + 12 }]}>
        <View style={s.topLeft}>
          <Text style={s.appName}>WESTSHORE WATCH</Text>
          {(Object.keys(nearbyNodes).length > 0 || bridgeInRange) && (
            <View style={s.nodeBadge}>
              <Text style={s.nodeText}>📡 NODE</Text>
            </View>
          )}
        </View>
        <View style={s.topRight}>
          <KeepScreenOnToggle keepAwakeTag="guest-scan" />
          <TouchableOpacity style={s.loginBtn} onPress={() => navigation.navigate('Login')}>
            <Text style={s.loginBtnText}>SIGN IN</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Drone count */}
      <View style={s.countBadge}>
        <Text style={s.countText}>{droneList.length} DRONE{droneList.length !== 1 ? 'S' : ''} DETECTED</Text>
      </View>

      {/* Drone list */}
      {droneList.length > 0 && (
        <View style={s.droneList}>
          {droneList.map((drone: any) => {
            const id = drone.uasId || drone.uas_id || drone.mac;
            const selId = selectedDrone ? (selectedDrone as any).uasId || (selectedDrone as any).uas_id || selectedDrone.mac : null;
            const color = getDroneColor(id);
            const age = Math.round((Date.now() - drone.lastSeen) / 1000);
            const airborne = drone.status === OP_STATUS_AIRBORNE;
            return (
              <TouchableOpacity
                key={id}
                style={[s.droneRow, selId === id && { borderLeftColor: color, borderLeftWidth: 3 }]}
                onPress={() => {
                  if (selId === id) {
                    setSelectedDrone(null);
                    return;
                  }
                  setSelectedDrone(drone);
                  setSheetCollapsed(false);
                  if (typeof drone.lat === 'number' && typeof drone.lon === 'number') {
                    cameraRef.current?.setCamera({
                      centerCoordinate: [drone.lon, drone.lat],
                      zoomLevel: 16,
                      animationDuration: 500,
                    });
                  }
                }}
              >
                <View style={[s.dot, { backgroundColor: color }]} />
                <View style={s.droneInfo}>
                  <Text style={s.droneId}>{drone.uasId || drone.mac}</Text>
                  <Text style={s.droneMeta}>
                    {airborne ? '↑ AIRBORNE' : '● GROUND'} · {age}s ago · {drone.rssi}dBm
                  </Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {/* Selected drone detail sheet */}
      {selectedDrone && (() => {
        // Pull live data from the store so the panel reflects updates, not a
        // stale snapshot from the moment of selection.
        const selId = (selectedDrone as any).uasId || (selectedDrone as any).uas_id || selectedDrone.mac;
        const liveDrone: any = (bleDrones as any)[selId] ?? selectedDrone;

        // Defensive: typeof-guard every coordinate-to-string conversion.
        // Number() coercion + .toFixed throws "TypeError: undefined is not
        // an object" if the field is a string or null. fmtCoord returns
        // '—' for non-numeric inputs.
        const fmtCoord = (lat: any, lon: any) =>
          typeof lat === 'number' && typeof lon === 'number'
            ? `${lat.toFixed(6)}, ${lon.toFixed(6)}`
            : '—';

        return (
          <View style={[s.detailSheet, sheetCollapsed && s.detailSheetCollapsed]}>
            <TouchableOpacity
              style={s.sheetClose}
              onPress={() => setSelectedDrone(null)}
              hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
            >
              <Text style={s.sheetCloseText}>✕</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.sheetCollapse}
              onPress={() => setSheetCollapsed(prev => !prev)}
              hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
            >
              <Text style={s.sheetCloseText}>{sheetCollapsed ? '⌃' : '⌄'}</Text>
            </TouchableOpacity>
            <Text style={[s.detailId, { paddingRight: 72 }]} numberOfLines={1}>
              {liveDrone.uasId || liveDrone.mac}
            </Text>
            {!sheetCollapsed && (
              <>
                <View style={s.detailGrid}>
                  <DetailRow label="POSITION" value={fmtCoord(liveDrone.lat, liveDrone.lon)} />
                  <DetailRow label="ALTITUDE" value={liveDrone.altGeo != null ? `${fmtAltitude(liveDrone.altGeo)} MSL` : '—'} />
                  <DetailRow label="SPEED" value={fmtSpeed(liveDrone.speedHoriz)} />
                  <DetailRow label="HEADING" value={liveDrone.heading != null ? `${Math.round(liveDrone.heading)}°` : '—'} />
                  <DetailRow label="OPERATOR" value={fmtCoord(liveDrone.opLat, liveDrone.opLon)} />
                  <DetailRow label="SIGNAL" value={`${liveDrone.rssi}dBm`} />
                </View>
                <View style={s.detailFooter}>
                  <Text style={s.detailFooterText}>Sign in for deployment management and cloud history</Text>
                </View>
              </>
            )}
          </View>
        );
      })()}

      {/* iOS: nudge to keep the app open when backgrounded mid-scan, shown
          only when notification permission is denied (otherwise an OS
          notification is used instead). topOffset keeps it below the centered
          "N DRONES DETECTED" count badge (top 108) so they never collide. */}
      <DetectionLimitedBanner
        visible={showScanWarning}
        onDismiss={dismissScanWarning}
        topOffset={Platform.OS === 'ios' ? 150 : 134}
      />

      {/* iOS: one-time "keep screen active" warning on first entry. */}
      <KeepScreenActiveModal storageKey="seenMapWarning_guestScan" />
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const colors = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <Text style={{ color: colors.textMuted, fontSize: 10, fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace', letterSpacing: 1 }}>{label}</Text>
      <Text style={{ color: colors.text, fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace' }}>{value}</Text>
    </View>
  );
}

const styles = (c: ReturnType<typeof useTheme>) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingBottom: 12,
    backgroundColor: 'rgba(10,14,26,0.85)',
  },
  topLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  appName: {
    color: '#00d4ff', fontSize: 11, fontWeight: '700', letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  nodeBadge: { backgroundColor: 'rgba(0,255,136,0.15)', borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: 'rgba(0,255,136,0.3)' },
  nodeText: {
    color: '#00ff88', fontSize: 9, letterSpacing: 1,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  loginBtn: {
    borderWidth: 1, borderColor: '#00d4ff', borderRadius: 6,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  loginBtnText: {
    color: '#00d4ff', fontSize: 10, fontWeight: '600', letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  countBadge: {
    position: 'absolute', top: Platform.OS === 'ios' ? 108 : 92,
    alignSelf: 'center',
    backgroundColor: 'rgba(10,14,26,0.8)', borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 5,
    borderWidth: 1, borderColor: 'rgba(0,212,255,0.2)',
  },
  countText: {
    color: '#00d4ff', fontSize: 10, letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  droneMarker: {
    width: 28, height: 28, borderRadius: 14,
    borderWidth: 2, alignItems: 'center', justifyContent: 'center',
  },
  droneCore: { width: 8, height: 8, borderRadius: 4 },
  droneList: {
    position: 'absolute', bottom: 20, left: 12, right: 12, maxWidth: 480, marginHorizontal: 'auto',
    backgroundColor: 'rgba(10,14,26,0.92)',
    borderRadius: 12, borderWidth: 1, borderColor: 'rgba(30,45,69,0.8)',
    maxHeight: 200, overflow: 'hidden',
  },
  droneRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(30,45,69,0.5)',
    borderLeftWidth: 3, borderLeftColor: 'transparent',
  },
  dot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  droneInfo: { flex: 1 },
  droneId: {
    color: '#e2e8f0', fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  droneMeta: {
    color: '#64748b', fontSize: 10, marginTop: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  detailSheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0, maxWidth: 600, marginHorizontal: 'auto',
    backgroundColor: 'rgba(17,24,39,0.97)',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderTopWidth: 1, borderColor: 'rgba(30,45,69,0.8)',
    padding: 20, paddingBottom: Platform.OS === 'ios' ? 36 : 20,
  },
  detailSheetCollapsed: { paddingBottom: Platform.OS === 'ios' ? 28 : 16 },
  sheetClose: { position: 'absolute', right: 20, top: 20, padding: 4 },
  sheetCollapse: { position: 'absolute', right: 52, top: 20, padding: 4 },
  sheetCloseText: { color: '#64748b', fontSize: 16 },
  detailId: {
    color: '#00d4ff', fontSize: 14, fontWeight: '600', marginBottom: 16,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  detailGrid: { gap: 2 },
  detailFooter: { marginTop: 16, alignItems: 'center' },
  detailFooterText: { color: '#475569', fontSize: 11, textAlign: 'center' },
});
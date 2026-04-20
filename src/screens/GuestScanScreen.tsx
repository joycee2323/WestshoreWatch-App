import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  Platform, Alert, ActivityIndicator, PermissionsAndroid,
} from 'react-native';
import MapboxGL from '@rnmapbox/maps';
import { useDroneStore, DroneEntry } from '../store/droneStore';
import { startBleScanning, stopBleScanning } from '../services/bleScanner';
import { useTheme, getDroneColor } from '../theme';
import KeepScreenOnToggle from '../components/KeepScreenOnToggle';
import * as Location from 'expo-location';
import { OP_STATUS_AIRBORNE } from '../services/odidParser';

MapboxGL.setAccessToken(process.env.EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN ?? '');

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
  const { bleDrones, updateBleDrone, nearbyNodes } = useDroneStore();
  const updateNearbyNode = useDroneStore(s => s.updateNearbyNode);
  const [selectedDrone, setSelectedDrone] = useState<DroneEntry | null>(null);
  const [locationGranted, setLocationGranted] = useState(false);
  const cameraRef = useRef<MapboxGL.Camera>(null);

  const droneList = Object.values(bleDrones);

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
        (det) => { if (det.uasId) updateBleDrone(det.uasId, det); },
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
      <MapboxGL.MapView style={StyleSheet.absoluteFill} styleURL={MapboxGL.StyleURL.Dark}>
        <MapboxGL.Camera
          ref={cameraRef}
          followUserLocation={!selectedDrone}
          followUserMode={MapboxGL.UserTrackingMode.Follow}
          followZoomLevel={14}
        />
        <MapboxGL.UserLocation visible={locationGranted} />

        {/* Drone markers */}
        {droneList.map((drone: any) => {
          if (!drone.lat || !drone.lon) return null;
          const id = drone.uasId || drone.uas_id || drone.mac;
          const color = getDroneColor(id);
          const airborne = drone.status === OP_STATUS_AIRBORNE;
          return (
            <MapboxGL.PointAnnotation
              key={id}
              id={id}
              coordinate={[drone.lon, drone.lat]}
              onSelected={() => setSelectedDrone(drone)}
            >
              <View style={[s.droneMarker, { borderColor: color, backgroundColor: color + '33' }]}>
                <View style={[s.droneCore, { backgroundColor: color }]} />
              </View>
            </MapboxGL.PointAnnotation>
          );
        })}

        {/* Flight paths */}
        {droneList.map((drone: any) => {
          if (drone.path.length < 2) return null;
          const id = drone.uasId || drone.uas_id || drone.mac;
          const color = getDroneColor(id);
          const coords = drone.path.map((p: any) => [p.lon, p.lat]);
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
      <View style={s.topBar}>
        <View style={s.topLeft}>
          <Text style={s.appName}>WESTSHORE WATCH</Text>
          {Object.keys(nearbyNodes).length > 0 && (
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
                  setSelectedDrone(drone);
                  if (drone.lat && drone.lon) {
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
      {selectedDrone && (
        <View style={s.detailSheet}>
          <TouchableOpacity style={s.sheetClose} onPress={() => setSelectedDrone(null)}>
            <Text style={s.sheetCloseText}>✕</Text>
          </TouchableOpacity>
          <Text style={s.detailId}>{selectedDrone.uasId || selectedDrone.mac}</Text>
          <View style={s.detailGrid}>
            <DetailRow label="POSITION" value={selectedDrone.lat ? `${selectedDrone.lat.toFixed(6)}, ${selectedDrone.lon!.toFixed(6)}` : '—'} />
            <DetailRow label="ALTITUDE" value={selectedDrone.altGeo != null ? `${Math.round(selectedDrone.altGeo * 3.28084)}ft MSL` : '—'} />
            <DetailRow label="SPEED" value={selectedDrone.speedHoriz != null ? `${(selectedDrone.speedHoriz * 2.237).toFixed(1)}mph` : '—'} />
            <DetailRow label="HEADING" value={selectedDrone.heading != null ? `${Math.round(selectedDrone.heading)}°` : '—'} />
            <DetailRow label="OPERATOR" value={selectedDrone.opLat ? `${selectedDrone.opLat.toFixed(6)}, ${selectedDrone.opLon!.toFixed(6)}` : '—'} />
            <DetailRow label="SIGNAL" value={`${selectedDrone.rssi}dBm`} />
          </View>
          <View style={s.detailFooter}>
            <Text style={s.detailFooterText}>Sign in for deployment management and cloud history</Text>
          </View>
        </View>
      )}
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
    paddingTop: Platform.OS === 'ios' ? 56 : 40, paddingHorizontal: 16, paddingBottom: 12,
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
    position: 'absolute', bottom: 20, left: 12, right: 12,
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
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(17,24,39,0.97)',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderTopWidth: 1, borderColor: 'rgba(30,45,69,0.8)',
    padding: 20, paddingBottom: Platform.OS === 'ios' ? 36 : 20,
  },
  sheetClose: { position: 'absolute', right: 20, top: 20 },
  sheetCloseText: { color: '#64748b', fontSize: 16 },
  detailId: {
    color: '#00d4ff', fontSize: 14, fontWeight: '600', marginBottom: 16,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  detailGrid: { gap: 2 },
  detailFooter: { marginTop: 16, alignItems: 'center' },
  detailFooterText: { color: '#475569', fontSize: 11, textAlign: 'center' },
});

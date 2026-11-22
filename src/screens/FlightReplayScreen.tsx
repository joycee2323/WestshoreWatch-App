// Flight Replay — review a deployment's recorded flights on the map, on the
// phone, with no export / re-upload. One fetch (GET /detections/:id?since=all);
// all playback and scrubbing is local. Timeline math lives in
// services/flightReplay.ts (pure, unit-tested); this file is UI only.
//
// Field use: everything is glove-sized (>= 44pt targets, 64pt play button,
// 48pt seek bar hit area) and playback auto-starts.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Platform, ActivityIndicator, ScrollView,
  PanResponder, AccessibilityActionEvent,
} from 'react-native';
import MapboxGL from '@rnmapbox/maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import MapLayerToggle, { HouseNumberLayer, styleURLForLayer, useMapLayer } from '../components/MapLayerToggle';
import { api } from '../services/api';
import { useTheme, getDroneColor } from '../theme';
import { useDroneStore } from '../store/droneStore';
import { fmtAgl, fmtSpeed } from '../utils/units';
import {
  buildReplay, frameAt, trailUpTo, fullTrail, boundsOf, fmtElapsed, toRealTime,
  windowIndexAt, autoSpeedIndex, SPEEDS,
} from '../services/flightReplay';
import type { Frame, FlightWindow, ReplayDrone } from '../services/flightReplay';

const MONO = Platform.OS === 'ios' ? 'Courier New' : 'monospace';
const TICK_MS = 100;
// Cap one tick's real-time step so returning from background doesn't jump.
const MAX_TICK_STEP_MS = 1000;
// "Prev" restarts the current flight when more than this far into it.
const PREV_RESTART_MS = 3000;
// Bounds smaller than this (degrees) are a single spot: use a fixed zoom.
const POINT_BOUNDS_DEG = 0.0002;
const SINGLE_POINT_ZOOM = 16;
const CHROME_BG = 'rgba(10,14,26,0.85)';
const PILOT_COLOR = '#FFD600';

type FC = { type: 'FeatureCollection'; features: any[] };
const fc = (features: any[]): FC => ({ type: 'FeatureCollection', features });

export default function FlightReplayScreen() {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const deploymentId: string | undefined = route.params?.deploymentId;
  const depName: string = route.params?.name || '';
  const [mapLayer, toggleMapLayer] = useMapLayer();
  const satellite = mapLayer === 'satellite';
  const nicknames = useDroneStore(st => st.nicknamesByUasId);
  const s = styles(colors);

  // ---------------------------------------------------------------- data
  const [rows, setRows] = useState<any[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!deploymentId) {
      setError('No deployment selected.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api.getDetectionHistory(deploymentId);
      setRows(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load flight data.');
    } finally {
      setLoading(false);
    }
  }, [deploymentId]);

  useEffect(() => { void load(); }, [load]);

  const replay = useMemo(() => buildReplay(rows || [], nicknames), [rows, nicknames]);
  const { drones, windows, activeMs } = replay;
  const colorOf = useMemo(() => {
    const m: Record<string, string> = {};
    for (const d of drones) m[d.id] = getDroneColor(d.id);
    return m;
  }, [drones]);

  // ---------------------------------------------------------------- playback
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const progressRef = useRef(0);
  const activeMsRef = useRef(0);
  activeMsRef.current = activeMs;

  // Fresh data: rewind, auto-pick a speed that fits ~40 s, and autoplay.
  // Keyed on rows (not replay) so a nickname update doesn't rewind.
  useEffect(() => {
    if (!rows) return;
    const r = buildReplay(rows);
    progressRef.current = 0;
    setProgress(0);
    setSpeedIdx(autoSpeedIndex(r.activeMs));
    setPlaying(r.drones.length > 0);
    setSelectedId(prev => (prev && r.drones.some(d => d.id === prev) ? prev : null));
  }, [rows]);

  useEffect(() => {
    if (!playing || scrubbing) return;
    let last = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const step = Math.min(now - last, MAX_TICK_STEP_MS) * SPEEDS[speedIdx];
      last = now;
      const total = activeMsRef.current;
      let next = progressRef.current + step;
      if (next >= total) {
        next = total;
        setPlaying(false);
      }
      progressRef.current = next;
      setProgress(next);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [playing, scrubbing, speedIdx]);

  const seek = useCallback((p: number) => {
    const next = Math.max(0, Math.min(activeMsRef.current, p));
    progressRef.current = next;
    setProgress(next);
  }, []);

  // While dragging, coalesce state updates to one per frame (the map sources
  // re-serialize on every render).
  const rafRef = useRef<number | null>(null);
  const scrubSeek = useCallback((p: number) => {
    progressRef.current = Math.max(0, Math.min(activeMsRef.current, p));
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setProgress(progressRef.current);
    });
  }, []);
  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  const atEnd = activeMs > 0 && progress >= activeMs;
  const togglePlay = useCallback(() => {
    if (playing) { setPlaying(false); return; }
    if (progressRef.current >= activeMsRef.current) seek(0);
    setPlaying(true);
  }, [playing, seek]);

  const winIdx = windowIndexAt(windows, progress);
  const prevFlight = useCallback(() => {
    const i = windowIndexAt(windows, progressRef.current);
    if (i < 0) return;
    const w = windows[i];
    if (i === 0 || progressRef.current - w.offset > PREV_RESTART_MS) seek(w.offset);
    else seek(windows[i - 1].offset);
  }, [windows, seek]);
  const nextFlight = useCallback(() => {
    const i = windowIndexAt(windows, progressRef.current);
    if (i < 0) return;
    if (i + 1 < windows.length) seek(windows[i + 1].offset);
    else { seek(activeMsRef.current); setPlaying(false); }
  }, [windows, seek]);
  const cycleSpeed = useCallback(() => setSpeedIdx(i => (i + 1) % SPEEDS.length), []);

  // ---------------------------------------------------------------- frames
  const realT = toRealTime(windows, progress);
  const visibleDrones = useMemo(() => drones.filter(d => !hidden[d.id]), [drones, hidden]);
  const frames = useMemo(() => {
    const m: Record<string, Frame> = {};
    for (const d of drones) m[d.id] = frameAt(d, realT);
    return m;
  }, [drones, realT]);

  // ---------------------------------------------------------------- camera
  const cameraRef = useRef<MapboxGL.Camera>(null);
  const [mapReady, setMapReady] = useState(false);
  const [topH, setTopH] = useState(0);
  const [panelH, setPanelH] = useState(0);
  const fittedForRows = useRef<any[] | null>(null);

  const padding = useMemo(() => ({
    paddingTop: topH + 24,
    paddingBottom: panelH + 24,
    paddingLeft: 32,
    paddingRight: 32,
  }), [topH, panelH]);

  const fitAll = useCallback((animationDuration = 800) => {
    const b = boundsOf(visibleDrones.length ? visibleDrones : drones);
    if (!b || !cameraRef.current) return;
    if (b.maxLat - b.minLat < POINT_BOUNDS_DEG && b.maxLon - b.minLon < POINT_BOUNDS_DEG) {
      cameraRef.current.setCamera({
        centerCoordinate: [(b.minLon + b.maxLon) / 2, (b.minLat + b.maxLat) / 2],
        zoomLevel: SINGLE_POINT_ZOOM,
        padding,
        animationDuration,
      });
    } else {
      cameraRef.current.setCamera({
        bounds: { ne: [b.maxLon, b.maxLat], sw: [b.minLon, b.minLat] },
        padding,
        animationDuration,
      });
    }
  }, [visibleDrones, drones, padding]);

  // Fit once per load, after the map and both overlays have measured.
  useEffect(() => {
    if (!mapReady || !rows || drones.length === 0 || panelH === 0 || topH === 0) return;
    if (fittedForRows.current === rows) return;
    fittedForRows.current = rows;
    fitAll(0);
  }, [mapReady, rows, drones.length, panelH, topH, fitAll]);

  const initialCenter = useMemo(() => {
    const b = boundsOf(drones);
    return b ? [(b.minLon + b.maxLon) / 2, (b.minLat + b.maxLat) / 2] : null;
  }, [drones]);

  const selectDrone = useCallback((id: string) => {
    if (selectedId === id) { setSelectedId(null); return; }
    setSelectedId(id);
    const f = frames[id];
    if (f && cameraRef.current) {
      cameraRef.current.setCamera({ centerCoordinate: [f.lon, f.lat], padding, animationDuration: 600 });
    }
  }, [selectedId, frames, padding]);

  const toggleHidden = useCallback((id: string) => {
    setHidden(h => ({ ...h, [id]: !h[id] }));
    setSelectedId(cur => (cur === id ? null : cur));
  }, []);

  // ---------------------------------------------------------------- layers
  // Static: full faint path + pilot dots. Memoized as elements so the 10 Hz
  // playback re-render doesn't re-serialize them to native.
  const staticLayers = useMemo(() => {
    const paths = fc(visibleDrones.flatMap(d => {
      const lines = fullTrail(d);
      return lines.length ? [{
        type: 'Feature', id: `full-${d.id}`,
        geometry: { type: 'MultiLineString', coordinates: lines },
        properties: { color: colorOf[d.id] },
      }] : [];
    }));
    const pilots = fc(visibleDrones.filter(d => d.pilot).map(d => ({
      type: 'Feature', id: `pilot-${d.id}`,
      geometry: { type: 'Point', coordinates: d.pilot },
      properties: { color: colorOf[d.id] },
    })));
    return (
      <>
        <MapboxGL.ShapeSource id="replay-full-src" shape={paths as any}>
          <MapboxGL.LineLayer
            id="replay-full-line"
            style={{ lineColor: ['get', 'color'], lineWidth: 2, lineOpacity: satellite ? 0.45 : 0.25, lineCap: 'round', lineJoin: 'round' }}
          />
        </MapboxGL.ShapeSource>
        <MapboxGL.ShapeSource id="replay-pilot-src" shape={pilots as any}>
          <MapboxGL.CircleLayer
            id="replay-pilot-dot"
            style={{
              circleRadius: 6,
              circleColor: PILOT_COLOR,
              circleStrokeColor: ['get', 'color'],
              circleStrokeWidth: 2.5,
            }}
          />
        </MapboxGL.ShapeSource>
      </>
    );
  }, [visibleDrones, colorOf, satellite]);

  // Dynamic: flown-so-far trails and playhead markers, rebuilt per tick.
  const progressShape = fc(visibleDrones.flatMap(d => {
    const lines = trailUpTo(d, realT, frames[d.id]);
    return lines.length ? [{
      type: 'Feature', id: `prog-${d.id}`,
      geometry: { type: 'MultiLineString', coordinates: lines },
      properties: { color: colorOf[d.id] },
    }] : [];
  }));
  const markerShape = fc(visibleDrones.flatMap(d => {
    const f = frames[d.id];
    if (!f || f.state === 'pending') return [];
    const stale = f.state === 'done' || f.holding;
    return [{
      type: 'Feature', id: `mk-${d.id}`,
      geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
      properties: {
        droneId: d.id,
        color: colorOf[d.id],
        label: d.name,
        opacity: stale ? 0.4 : 1,
        selected: d.id === selectedId,
      },
    }];
  }));

  // ---------------------------------------------------------------- render
  const title = drones.length
    ? `REPLAY · ${drones.length} DRONE${drones.length === 1 ? '' : 'S'} · ${windows.length} FLIGHT${windows.length === 1 ? '' : 'S'}`
    : 'REPLAY';

  const topBar = (
    <View
      style={[s.topBar, { paddingTop: insets.top + 8, paddingLeft: insets.left + 10, paddingRight: insets.right + 10 }]}
      onLayout={e => setTopH(e.nativeEvent.layout.height)}
    >
      <ChromeButton icon="chevron-back" label="Back" onPress={() => navigation.goBack()} />
      <View style={s.titleBox}>
        <Text style={s.title} numberOfLines={1}>{title}</Text>
        {!!depName && <Text style={s.subtitle} numberOfLines={1}>{depName}</Text>}
      </View>
      {drones.length > 0 && <ChromeButton icon="scan-outline" label="Fit all flights" onPress={() => fitAll()} />}
      <ChromeButton icon="refresh" label="Reload flight data" onPress={() => { void load(); }} disabled={loading} />
      <MapLayerToggle layer={mapLayer} onToggle={toggleMapLayer} />
    </View>
  );

  if (loading && !rows) {
    return (
      <View style={s.page}>
        {topBar}
        <View style={s.center}>
          <ActivityIndicator color={colors.cyan} size="large" />
          <Text style={s.stateText}>LOADING FLIGHTS…</Text>
        </View>
      </View>
    );
  }

  if (error && !rows) {
    return (
      <View style={s.page}>
        {topBar}
        <View style={s.center}>
          <Ionicons name="cloud-offline-outline" size={40} color={colors.amber} />
          <Text style={[s.stateText, { color: colors.amber }]}>COULD NOT LOAD FLIGHTS</Text>
          <Text style={s.stateHint}>{error}</Text>
          <TouchableOpacity style={s.retryBtn} onPress={() => { void load(); }} accessibilityRole="button">
            <Text style={s.retryText}>RETRY</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (drones.length === 0) {
    return (
      <View style={s.page}>
        {topBar}
        <View style={s.center}>
          <Ionicons name="map-outline" size={40} color={colors.textMuted} />
          <Text style={s.stateText}>NO FLIGHT DATA</Text>
          <Text style={s.stateHint}>No drones with a recorded position were detected in this deployment.</Text>
          {error && <Text style={[s.stateHint, { color: colors.amber }]}>Reload failed: {error}</Text>}
        </View>
      </View>
    );
  }

  const selected = selectedId ? drones.find(d => d.id === selectedId) || null : null;
  const clock = new Date(realT);

  return (
    <View style={s.page}>
      <MapboxGL.MapView
        style={StyleSheet.absoluteFill}
        styleURL={styleURLForLayer(mapLayer)}
        onDidFinishLoadingMap={() => setMapReady(true)}
        scaleBarEnabled={false}
      >
        <MapboxGL.Camera
          ref={cameraRef}
          defaultSettings={initialCenter ? { centerCoordinate: initialCenter, zoomLevel: 14 } : undefined}
        />
        <HouseNumberLayer layer={mapLayer} />
        {staticLayers}
        <MapboxGL.ShapeSource id="replay-prog-src" shape={progressShape as any}>
          {/* Dark casing so the bright trail reads on imagery. */}
          <MapboxGL.LineLayer
            id="replay-prog-casing"
            style={{ lineColor: '#000000', lineWidth: 6, lineOpacity: satellite ? 0.5 : 0, lineCap: 'round', lineJoin: 'round' }}
          />
          <MapboxGL.LineLayer
            id="replay-prog-line"
            style={{ lineColor: ['get', 'color'], lineWidth: 3.5, lineOpacity: 0.95, lineCap: 'round', lineJoin: 'round' }}
          />
        </MapboxGL.ShapeSource>
        <MapboxGL.ShapeSource
          id="replay-marker-src"
          shape={markerShape as any}
          onPress={(e: any) => {
            const id = e?.features?.[0]?.properties?.droneId;
            if (id) selectDrone(String(id));
          }}
          hitbox={{ width: 44, height: 44 }}
        >
          <MapboxGL.CircleLayer
            id="replay-marker-dot"
            style={{
              circleRadius: ['case', ['get', 'selected'], 11, 7],
              circleColor: ['get', 'color'],
              circleOpacity: ['get', 'opacity'],
              circleStrokeColor: ['case', ['get', 'selected'], '#ffffff', '#000000'],
              circleStrokeWidth: ['case', ['get', 'selected'], 3, 1.5],
              circleStrokeOpacity: ['get', 'opacity'],
            }}
          />
          <MapboxGL.SymbolLayer
            id="replay-marker-label"
            style={{
              textField: ['get', 'label'],
              textSize: 11,
              textColor: ['get', 'color'],
              textOpacity: ['get', 'opacity'],
              textAnchor: 'top',
              textOffset: [0, 1.1],
              textAllowOverlap: true,
              textFont: ['DIN Pro Medium', 'Arial Unicode MS Regular'],
              textHaloColor: 'rgba(0,0,0,0.85)',
              textHaloWidth: 1.5,
            }}
          />
        </MapboxGL.ShapeSource>
      </MapboxGL.MapView>

      {topBar}

      <View
        style={[s.panel, { paddingBottom: insets.bottom + 10, paddingLeft: insets.left + 14, paddingRight: insets.right + 14 }]}
        onLayout={e => setPanelH(e.nativeEvent.layout.height)}
      >
        {selected && (
          <Readout drone={selected} frame={frames[selected.id]} color={colorOf[selected.id]} onClose={() => setSelectedId(null)} />
        )}

        <View style={s.timeRow}>
          <View>
            <Text style={s.clock}>{clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</Text>
            <Text style={s.clockDate}>{clock.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={s.flightLabel}>FLIGHT {Math.max(1, winIdx + 1)} / {windows.length}</Text>
            <Text style={s.elapsed}>{fmtElapsed(progress)} / {fmtElapsed(activeMs)}</Text>
          </View>
        </View>

        <SeekBar
          progress={progress}
          total={activeMs}
          windows={windows}
          onScrubStart={() => setScrubbing(true)}
          onSeek={scrubSeek}
          onScrubEnd={() => { setProgress(progressRef.current); setScrubbing(false); }}
          onStep={delta => seek(progressRef.current + delta)}
        />

        <View style={s.controls}>
          <TouchableOpacity style={s.ctrlBtn} onPress={prevFlight} accessibilityRole="button" accessibilityLabel="Previous flight">
            <Ionicons name="play-skip-back" size={26} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity
            style={s.playBtn}
            onPress={togglePlay}
            accessibilityRole="button"
            accessibilityLabel={playing ? 'Pause' : atEnd ? 'Replay from start' : 'Play'}
          >
            <Ionicons name={playing ? 'pause' : atEnd ? 'refresh' : 'play'} size={32} color="#000" style={!playing && !atEnd ? { marginLeft: 4 } : undefined} />
          </TouchableOpacity>
          <TouchableOpacity style={s.ctrlBtn} onPress={nextFlight} accessibilityRole="button" accessibilityLabel="Next flight">
            <Ionicons name="play-skip-forward" size={26} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity style={s.speedBtn} onPress={cycleSpeed} accessibilityRole="button" accessibilityLabel={`Playback speed ${SPEEDS[speedIdx]} times. Tap to change.`}>
            <Text style={s.speedText}>{SPEEDS[speedIdx]}×</Text>
          </TouchableOpacity>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipRow} keyboardShouldPersistTaps="handled">
          {drones.map(d => {
            const isHidden = !!hidden[d.id];
            const isSel = d.id === selectedId;
            const color = colorOf[d.id];
            return (
              <View key={d.id} style={[s.chip, isSel && { borderColor: color }, isHidden && { opacity: 0.45 }]}>
                <TouchableOpacity
                  style={s.chipMain}
                  onPress={() => selectDrone(d.id)}
                  disabled={isHidden}
                  accessibilityRole="button"
                  accessibilityLabel={`${d.name}${isSel ? ', selected' : ''}`}
                >
                  <View style={[s.chipDot, { backgroundColor: color }]} />
                  <Text style={[s.chipText, isSel && { color }]} numberOfLines={1}>{d.name}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.chipEye}
                  onPress={() => toggleHidden(d.id)}
                  accessibilityRole="button"
                  accessibilityLabel={isHidden ? `Show ${d.name}` : `Hide ${d.name}`}
                >
                  <Ionicons name={isHidden ? 'eye-off-outline' : 'eye-outline'} size={18} color={colors.textDim} />
                </TouchableOpacity>
              </View>
            );
          })}
        </ScrollView>
      </View>
    </View>
  );
}

// ------------------------------------------------------------------ pieces

function ChromeButton({ icon, label, onPress, disabled }: { icon: any; label: string; onPress: () => void; disabled?: boolean }) {
  const colors = useTheme();
  const s = styles(colors);
  return (
    <TouchableOpacity
      style={[s.chromeBtn, disabled && { opacity: 0.4 }]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={22} color="#e2e8f0" />
    </TouchableOpacity>
  );
}

function Readout({ drone, frame, color, onClose }: { drone: ReplayDrone; frame: Frame | undefined; color: string; onClose: () => void }) {
  const colors = useTheme();
  const s = styles(colors);
  const fmtClock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  let status: string;
  let statusColor: string;
  if (!frame || frame.state === 'pending') {
    status = 'NOT YET DETECTED';
    statusColor = colors.textMuted;
  } else if (frame.state === 'done' || frame.holding) {
    const t = frame.state === 'done' ? drone.end : drone.points[frame.index].t;
    status = `LAST SEEN ${fmtClock(t)}`;
    statusColor = colors.amber;
  } else {
    status = 'AIRBORNE';
    statusColor = colors.green;
  }
  const known = !!frame && frame.state !== 'pending';
  return (
    <View style={[s.readout, { borderLeftColor: color }]}>
      <View style={{ flex: 1 }}>
        <Text style={[s.readoutName, { color }]} numberOfLines={1}>
          {drone.name}{drone.model ? <Text style={s.readoutModel}>  {drone.model}</Text> : null}
        </Text>
        <Text style={[s.readoutStatus, { color: statusColor }]}>{status}</Text>
        {known && frame && (
          <>
            <Text style={s.readoutLine}>{fmtAgl(frame.agl)} · {fmtSpeed(frame.speed)}</Text>
            <Text style={s.readoutLine}>{frame.lat.toFixed(5)}, {frame.lon.toFixed(5)}</Text>
          </>
        )}
      </View>
      <TouchableOpacity style={s.readoutClose} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close drone details">
        <Ionicons name="close" size={20} color={colors.textDim} />
      </TouchableOpacity>
    </View>
  );
}

type SeekBarProps = {
  progress: number;
  total: number;
  windows: FlightWindow[];
  onScrubStart: () => void;
  onSeek: (p: number) => void;
  onScrubEnd: () => void;
  // Accessibility increment/decrement (ms, signed).
  onStep: (delta: number) => void;
};

// Hand-built seek bar (no slider dependency — package.json changes break OTA).
// Position = touch-start x + gesture dx, so dragging past either end or off
// the bar vertically keeps tracking. Children are pointerEvents="none" so
// locationX is always relative to the 48pt hit area itself.
function SeekBar({ progress, total, windows, onScrubStart, onSeek, onScrubEnd, onStep }: SeekBarProps) {
  const colors = useTheme();
  const s = styles(colors);
  const widthRef = useRef(1);
  const startXRef = useRef(0);
  const cb = useRef({ onScrubStart, onSeek, onScrubEnd, total });
  cb.current = { onScrubStart, onSeek, onScrubEnd, total };

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    // Don't let the parent / horizontal chip ScrollView steal a drag.
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: e => {
      startXRef.current = e.nativeEvent.locationX;
      cb.current.onScrubStart();
      const f = Math.max(0, Math.min(1, startXRef.current / widthRef.current));
      cb.current.onSeek(f * cb.current.total);
    },
    onPanResponderMove: (_e, g) => {
      const f = Math.max(0, Math.min(1, (startXRef.current + g.dx) / widthRef.current));
      cb.current.onSeek(f * cb.current.total);
    },
    onPanResponderRelease: () => cb.current.onScrubEnd(),
    onPanResponderTerminate: () => cb.current.onScrubEnd(),
  })).current;

  const frac = total > 0 ? Math.max(0, Math.min(1, progress / total)) : 0;
  const pct = `${frac * 100}%` as const;
  const onA11y = (e: AccessibilityActionEvent) => {
    const step = Math.max(1000, total / 20);
    if (e.nativeEvent.actionName === 'increment') onStep(step);
    if (e.nativeEvent.actionName === 'decrement') onStep(-step);
  };

  return (
    <View
      style={s.seekHit}
      onLayout={e => { widthRef.current = Math.max(1, e.nativeEvent.layout.width); }}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Replay position"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(frac * 100) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={onA11y}
      {...pan.panHandlers}
    >
      <View pointerEvents="none" style={s.seekTrack}>
        <View style={[s.seekFill, { width: pct }]} />
      </View>
      {total > 0 && windows.slice(1).map(w => (
        <View key={w.offset} pointerEvents="none" style={[s.seekTick, { left: `${(w.offset / total) * 100}%` }]} />
      ))}
      <View pointerEvents="none" style={[s.seekThumb, { left: pct }]} />
    </View>
  );
}

// ------------------------------------------------------------------ styles

const styles = (c: ReturnType<typeof useTheme>) => StyleSheet.create({
  page: { flex: 1, backgroundColor: c.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 },
  stateText: { color: c.textMuted, fontSize: 12, letterSpacing: 3, fontFamily: MONO, marginTop: 6 },
  stateHint: { color: c.textDim, fontSize: 11, textAlign: 'center', maxWidth: 320 },
  retryBtn: {
    marginTop: 10, minHeight: 48, minWidth: 140, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20,
    backgroundColor: c.cyan,
  },
  retryText: { color: '#000', fontWeight: '700', fontSize: 12, letterSpacing: 2, fontFamily: MONO },

  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 8,
    backgroundColor: CHROME_BG,
  },
  titleBox: { flex: 1, minWidth: 0 },
  title: { color: '#e2e8f0', fontSize: 11, fontWeight: '700', letterSpacing: 1.5, fontFamily: MONO },
  subtitle: { color: '#94a3b8', fontSize: 10, marginTop: 2, fontFamily: MONO },
  chromeBtn: {
    minWidth: 44, minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: c.border2,
    alignItems: 'center', justifyContent: 'center', backgroundColor: CHROME_BG,
  },

  panel: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: c.surface, borderTopWidth: 1, borderTopColor: c.border,
    borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingTop: 12,
  },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  clock: { color: c.text, fontSize: 22, fontWeight: '700', fontFamily: MONO },
  clockDate: { color: c.textMuted, fontSize: 10, letterSpacing: 1, fontFamily: MONO },
  flightLabel: { color: c.cyan, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, fontFamily: MONO },
  elapsed: { color: c.textDim, fontSize: 12, fontFamily: MONO, marginTop: 2 },

  seekHit: { height: 48, justifyContent: 'center', marginVertical: 2 },
  seekTrack: { height: 6, borderRadius: 3, backgroundColor: c.surface2, overflow: 'hidden', borderWidth: 1, borderColor: c.border },
  seekFill: { height: '100%', backgroundColor: c.cyan },
  seekTick: { position: 'absolute', top: 14, width: 2, height: 20, marginLeft: -1, backgroundColor: c.amber, borderRadius: 1 },
  seekThumb: {
    position: 'absolute', top: 12, width: 24, height: 24, marginLeft: -12, borderRadius: 12,
    backgroundColor: c.cyan, borderWidth: 3, borderColor: c.surface,
  },

  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 18, marginVertical: 4 },
  ctrlBtn: {
    width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border,
  },
  playBtn: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: c.cyan },
  speedBtn: {
    minWidth: 64, height: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 10, borderWidth: 1, borderColor: c.cyan, backgroundColor: 'rgba(0,212,255,0.10)',
  },
  speedText: { color: c.cyan, fontSize: 16, fontWeight: '700', fontFamily: MONO },

  chipRow: { gap: 8, paddingTop: 8, paddingBottom: 2 },
  chip: {
    flexDirection: 'row', alignItems: 'center', borderRadius: 10, borderWidth: 1.5,
    borderColor: c.border, backgroundColor: c.surface2, maxWidth: 240,
  },
  chipMain: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingLeft: 12, paddingRight: 4, flexShrink: 1 },
  chipDot: { width: 12, height: 12, borderRadius: 6 },
  chipText: { color: c.text, fontSize: 12, fontWeight: '600', fontFamily: MONO, flexShrink: 1 },
  chipEye: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },

  readout: {
    flexDirection: 'row', alignItems: 'flex-start', borderLeftWidth: 4, borderRadius: 8,
    backgroundColor: c.surface2, paddingVertical: 8, paddingLeft: 10, marginBottom: 10,
  },
  readoutName: { fontSize: 14, fontWeight: '700', fontFamily: MONO },
  readoutModel: { color: c.textDim, fontSize: 11, fontWeight: '400' },
  readoutStatus: { fontSize: 11, fontWeight: '700', letterSpacing: 1.5, marginTop: 2, fontFamily: MONO },
  readoutLine: { color: c.text, fontSize: 12, marginTop: 3, fontFamily: MONO },
  readoutClose: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});

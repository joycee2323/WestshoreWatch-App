import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, TextInput, StyleSheet, TouchableOpacity, Platform, PermissionsAndroid, AppState, Linking, Alert, DeviceEventEmitter, ActivityIndicator,
} from 'react-native';
import MapboxGL from '@rnmapbox/maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import KeepScreenOnToggle from '../components/KeepScreenOnToggle';
import { useDroneStore } from '../store/droneStore';
import { useAuthStore } from '../store/authStore';
import { createWebSocket, api, ReconnectingWebSocket, SubscribeMessage } from '../services/api';
import { useTheme, getDroneColor } from '../theme';
import { OP_STATUS_AIRBORNE } from '../services/odidParser';
import { startBleScanning, stopBleScanning } from '../services/bleScanner';
import { fetchNodes as fetchNodeRegistry, getNodeByMac } from '../services/nodeRegistry';
import * as Location from 'expo-location';
import { useCaps } from '../lib/useCaps';
import { fmtAltitude, fmtSpeed } from '../utils/units';

// Debounce window for nickname edits — avoids hammering the backend on every
// keystroke while the operator is typing. Saves on settle.
const NICKNAME_SAVE_DEBOUNCE_MS = 500;
const NICKNAME_MAX = 30;

// uasIds we've already logged a BLE-skip message for — keeps logcat readable
// when the same drone is seen thousands of times. Bounded by distinct drones
// the app sees per session, which is small in practice.
const loggedSkippedUasIds = new Set<string>();

export default function LiveMapScreen() {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const route = useRoute();

  // Mirrors the most recent push-notification deep-link hint. The push
  // payload's `data.deployment_id` is forwarded through navigation params
  // by deepLinkForNotification (services/pushNotifications.ts), and we
  // read it from the route here. Stored in a ref so the deployment-
  // selection logic inside refreshLiveMapState can pick up the latest
  // value without re-creating its useCallback closure every nav.
  const targetDeploymentIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const t = (route.params as any)?.targetDeploymentId;
    if (typeof t === 'string' && t.length > 0) {
      targetDeploymentIdRef.current = t;
    }
  }, [route.params]);

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
  const clearBackendDronesForDeployment = useDroneStore(s => s.clearBackendDronesForDeployment);

  // Per-uasId debounce timers keyed so editing several drones in succession
  // doesn't cancel earlier saves. Cleared on screen unmount.
  const nicknameSaveTimers = useRef<Record<string, any>>({});

  const orgId = useAuthStore(s => s.user?.org_id);
  const user = useAuthStore(s => s.user);
  const c = useCaps(user);

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

  // Facility geofences for the viewer's own org. Own-org scoped on the
  // backend, so a grantee gets only their own boundaries. Fetched once the
  // org is known; refreshed on focus (boundaries change rarely, so no poll).
  const refreshGeofences = useCallback(() => {
    api.listFacilityGeofences()
      .then((rows: any[]) => setGeofences(Array.isArray(rows) ? rows : []))
      .catch(err => console.warn('[geofences] fetch failed:', err));
  }, []);
  useEffect(() => {
    if (!orgId) return;
    refreshGeofences();
  }, [orgId, refreshGeofences]);

  // `activeDeployment` is the *primary* deployment for UI display only —
  // the banner name, the node list scope, the camera target. It is null
  // in passive mode. The authoritative set of subscribed deployments for
  // WS-subscription + store-eviction purposes lives in
  // `currentActiveIds` below; an org with two simultaneously active
  // deployments still has one primary here (target-matched if a push
  // notification deep-linked us in, otherwise the first active —
  // backend orders deployments by created_at DESC, so this is the most
  // recently created one).
  const [activeDeployment, setActiveDeployment] = useState<any>(null);
  const activeDeploymentRef = useRef<any>(null);
  useEffect(() => { activeDeploymentRef.current = activeDeployment; }, [activeDeployment]);

  // The full set of currently subscribed deployment ids. Drives WS
  // subscription shape, store eviction on mode change, and the
  // isPassive determination (empty array → passive). Compared as a set,
  // not an ordered list — order doesn't affect any caller.
  const [currentActiveIds, setCurrentActiveIds] = useState<string[]>([]);
  const currentActiveIdsRef = useRef<string[]>([]);
  useEffect(() => { currentActiveIdsRef.current = currentActiveIds; }, [currentActiveIds]);

  // The full active-deployment objects (for the header selector's labels and
  // id→name lookup). Distinct from currentActiveIds, which is just ids.
  const [activeDeployments, setActiveDeployments] = useState<any[]>([]);
  const activeDeploymentsRef = useRef<any[]>([]);
  useEffect(() => { activeDeploymentsRef.current = activeDeployments; }, [activeDeployments]);

  // Which deployment the map is currently SCOPED to (display + node fetch +
  // WS subscription + drone render all derive from this). 'ALL' = every
  // active deployment the viewer can see; a deployment id = just that one;
  // null = passive mode (no active deployment). The option list is whatever
  // active deployments getDeployments() returned, so a cross-org grantee can
  // only ever pick a GRANTED deployment — the selector is structurally locked
  // to grant scope, and the backend node route + WS gate enforce it server-
  // side regardless. Separating this from currentActiveIds (the active-set
  // "mode truth") lets the user narrow the view without the set-change
  // machinery in refreshLiveMapState thinking the active set changed.
  const [selectedDeploymentId, setSelectedDeploymentId] = useState<string | 'ALL' | null>(null);
  const selectedDeploymentIdRef = useRef<string | 'ALL' | null>(null);
  useEffect(() => { selectedDeploymentIdRef.current = selectedDeploymentId; }, [selectedDeploymentId]);

  // Enabled facility geofences for the viewer's OWN org (the endpoint is
  // own-org scoped, so a grantee never receives the grantor's boundaries).
  // Rendered as opaque polygon rings — no circle/center/radius assumptions.
  const [geofences, setGeofences] = useState<any[]>([]);

  // Native uploader emits DeploymentPaused on 402 and DeploymentResumed on
  // the next 2xx, so the banner reflects whatever the backend last said
  // without the JS layer needing to know about the queue or backoff state.
  useEffect(() => {
    const subPaused = DeviceEventEmitter.addListener('DeploymentPaused', () => {
      setShowPausedBanner(true);
    });
    const subResumed = DeviceEventEmitter.addListener('DeploymentResumed', () => {
      setShowPausedBanner(false);
    });
    return () => {
      subPaused.remove();
      subResumed.remove();
    };
  }, []);
  const [nodes, setNodes] = useState<any[]>([]);
  const nodesRef = useRef<any[]>([]);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  // Gate the MapView render on permission resolution. On a fresh install,
  // mounting MapView before the OS permission prompt is answered causes
  // Mapbox's native LocationManager to initialize in a "denied" state and
  // never recover — the user-location marker doesn't appear until the
  // next app launch. Showing a spinner until requestPermissions() resolves
  // (granted OR denied) ensures the first MapView mount happens with the
  // permission state settled. See lifecycle comment at requestPermissions
  // call site for the full race description.
  const [permissionResolved, setPermissionResolved] = useState(false);
  // `nodes` above is scoped to the active deployment; this tracks whether the
  // user has registered ANY node across their account (drives the empty-state
  // banner for users who skipped onboarding).
  const [userHasAnyNode, setUserHasAnyNode] = useState<boolean | null>(null);
  // Mirrored into a ref so the passive-mode poll callback (a stable closure
  // captured by setInterval) can re-check the flag each tick without re-
  // subscribing to React state changes.
  const userHasAnyNodeRef = useRef<boolean | null>(null);
  useEffect(() => { userHasAnyNodeRef.current = userHasAnyNode; }, [userHasAnyNode]);

  const checkUserNodes = useCallback(async () => {
    try {
      const all = await api.getNodes();
      setUserHasAnyNode(Array.isArray(all) && all.length > 0);
    } catch (err) {
      console.warn('Failed to check user nodes:', err);
    }
  }, []);

  const [selectedDrone, setSelectedDrone] = useState<any>(null);
  const [sheetCollapsed, setSheetCollapsed] = useState(false);
  // Set by the drone marker's onPress so a tap that hits a feature doesn't
  // also fire the MapView's onPress and immediately clear the selection.
  const featureTappedRef = useRef(false);
  const [showPausedBanner, setShowPausedBanner] = useState(false);
  // Passive mode: when no deployment is active, render recent (last 5 min)
  // detections + all org nodes so a push notification has a visual landing
  // pad. Drones from passive polling now flow into the shared
  // backendDrones store (via updateBackendDrone), same as WS-delivered
  // detections under SUBSCRIBE_ORG. The 5-minute render-time filter
  // (in `droneList` below) preserves the original passive-mode UX
  // without needing a separate local state. Nodes stay in component-
  // local state because passive mode pulls all-of-org nodes, distinct
  // from active mode's per-deployment list.
  const [passiveNodes, setPassiveNodes] = useState<any[]>([]);
  const passivePollTimer = useRef<any>(null);
  const PASSIVE_RECENCY_MIN = 5;
  const PASSIVE_POLL_MS = 30_000;

  // Authoritative passive/active mode check. Derived from the set —
  // activeDeployment (singular) is just a UI primary.
  const isPassive = currentActiveIds.length === 0;
  const wsRef = useRef<ReconnectingWebSocket | null>(null);
  // Three forward-decl refs break a render-order cycle: the new
  // refresh/mode helpers (enterActiveMode, enterPassiveMode,
  // refreshLiveMapState) want to call connectWebSocket and
  // startPassivePolling, but those are declared further down in the
  // function body and would TDZ-error if referenced in a useCallback
  // deps array. Conversely, connectWebSocket's onReconnect needs to
  // dispatch into refreshLiveMapState. All three refs are populated
  // synchronously during render (see the assignment block just before
  // the return JSX), so by the time any effect or callback fires the
  // refs are non-null.
  const connectWebSocketRef = useRef<((subscribe: SubscribeMessage) => void) | null>(null);
  const startPassivePollingRef = useRef<(() => void) | null>(null);
  const refreshRef = useRef<((opts?: {
    detections?: boolean;
    nodes?: boolean;
    reevaluateMode?: boolean;
  }) => Promise<void>) | null>(null);
  const cameraRef = useRef<MapboxGL.Camera>(null);
  const timeouts = useRef<Record<string, any>>({});

  // The deployment ids currently in scope (selected deployment, or all
  // active under "All active"). Drives drone scoping below; nodes are already
  // fetched for this scope into `nodes`.
  const visibleIds = isPassive
    ? []
    : (selectedDeploymentId === 'ALL' || selectedDeploymentId == null)
      ? currentActiveIds
      : (currentActiveIds.includes(selectedDeploymentId) ? [selectedDeploymentId] : currentActiveIds);
  const visibleSet = new Set(visibleIds);

  const droneList = isPassive
    ? Object.values(backendDrones).filter((d: any) =>
        d.last_seen && (Date.now() - new Date(d.last_seen).getTime()) < PASSIVE_RECENCY_MIN * 60_000)
    // Active mode: scope drones to the selected deployment(s). WS already
    // subscribes to only the visible scope, so this is mostly belt-and-
    // suspenders against the brief resubscribe race on selection change.
    : Object.values(backendDrones).filter((d: any) => visibleSet.has(d.deployment_id));
  const nodesToRender = isPassive ? passiveNodes : nodes;

  // SINGLE source of truth for what's drawn AND counted: every node with
  // coordinates. The header NODES count and the rendered markers both derive
  // from this, so the count always equals the number of pins drawn. Online/
  // offline is shown by marker border color, never by hiding a marker.
  const renderableNodes = nodesToRender.filter((n: any) => n.last_lat != null && n.last_lon != null);

  // Header "DRONES" count dedupes by uas_id. In multi-active mode, the
  // same drone (uas_id) can legitimately appear in two deployments
  // simultaneously, producing two compound-key entries in backendDrones
  // — those should render as two markers on the map (one per node) but
  // count as one drone identity in the header. droneList.length would
  // double-count.
  const uniqueDroneIdentityCount = (() => {
    if (isPassive) return droneList.length; // passive list already at uas_id grain server-side
    const ids = new Set<string>();
    for (const d of droneList as any[]) {
      const id = d?.uasId || d?.uas_id || d?.mac;
      if (id) ids.add(id);
    }
    return ids.size;
  })();
  const selectedId = selectedDrone
    ? (selectedDrone.uasId || selectedDrone.uas_id || selectedDrone.mac)
    : null;

  // Heartbeat is now driven by the native FG service (NodeHeartbeatUploader).
  // Living in Kotlin lets it survive Android Doze, so nodes stay "online" on
  // the dashboard while the phone screen is off. JS no longer maintains
  // per-node timers, last-seen state, or 404/skip tracking — see
  // android/app/src/main/java/com/westshoredrone/watch/NodeHeartbeatUploader.kt.

  // Refetch the node list for every currently-active deployment. Used by the
  // initial load, focus/foreground resume, and unknown-node WS messages.
  // Accepts an optional id list for the first call from enterActiveMode
  // (before currentActiveIdsRef has flushed); otherwise reads the ref.
  //
  // Partial-success semantics: one deployment's fetch failing (transient
  // 5xx, partner grant revoked mid-session) must not blank out other
  // deployments' nodes from the map. allSettled + filter-fulfilled gives
  // us that; rejected branches log so a persistent failure stays visible
  // during development. The detections-hydrate loop in enterActiveMode
  // has the same partial-failure exposure but is scoped to a separate
  // followup.
  // Resolve the deployment id set the map is currently scoped to, from the
  // selection + active set (both read off refs so callers in stable closures
  // stay correct). 'ALL' → every active id; a single id → just that one (with
  // a fallback if it's no longer active); null → none (passive).
  const computeVisibleIds = (): string[] => {
    const sel = selectedDeploymentIdRef.current;
    const allIds = currentActiveIdsRef.current;
    if (sel === null) return [];
    if (sel === 'ALL') return allIds;
    if (allIds.includes(sel)) return [sel];
    return allIds.length ? [allIds[0]] : [];
  };

  // Refetch nodes for the CURRENT scope (selected deployment, or all active
  // under "All active"). One request: a single deployment hits the scoped
  // /deployments/:id/nodes; multiple hits /deployments/nodes?deployment_ids=
  // (both grant-scoped server-side). Replaces the old all-actives client
  // merge — the rendered node set now matches exactly what's selected.
  const refetchNodes = useCallback(async (ids?: string[]) => {
    const targetIds = ids ?? computeVisibleIds();
    if (targetIds.length === 0) { setNodes([]); return; }
    try {
      const result = targetIds.length === 1
        ? await api.getNodes(targetIds[0])
        : await api.getNodesForDeployments(targetIds);
      setNodes(Array.isArray(result) ? result : []);
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
      // Unblock the MapView render — permission state is now settled
      // (granted or denied) so Mapbox's native LocationManager will
      // initialize with the correct OS state on first mount.
      setPermissionResolved(true);
      loadActiveDeployment();
      startBleScanning(
        det => {
          // In active mode the backend is authoritative for detections, so
          // skip BLE writes. Gate on the active SET (mode truth), not the
          // display-only activeDeployment (null under "All active").
          if (currentActiveIdsRef.current.length > 0) {
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
      ).catch((err: any) => {
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
    }).catch((err: any) => {
      // Fail open: a catastrophic permission-request failure shouldn't
      // strand the user on the spinner. Unblock the render so the rest
      // of the app is usable; the marker just won't appear (same
      // outcome as if permission were denied).
      console.warn('[livemap] permission request error:', err);
      setPermissionResolved(true);
    });
    return () => {
      wsRef.current?.close();
      stopBleScanning();
      if (refetchDebounceTimer.current) clearTimeout(refetchDebounceTimer.current);
      if (passivePollTimer.current) clearInterval(passivePollTimer.current);
      // Cancel any pending nickname-save debounces. The pending edits will
      // be lost; on next mount, the server-side state hydrates via getDroneNicknames.
      Object.values(nicknameSaveTimers.current).forEach(t => clearTimeout(t));
      nicknameSaveTimers.current = {};
    };
  }, []);

  // Re-evaluate mode + refetch detections/nodes when this screen regains
  // focus (e.g. after a tab switch). Previously only refetched nodes — a
  // detection that arrived while another tab was active wouldn't surface
  // until a WS push or full remount. Routed through refreshRef so the
  // helper's identity churn (orgId changes, etc.) doesn't reset focus
  // listener wiring on every render.
  useFocusEffect(
    useCallback(() => {
      void refreshRef.current?.({ detections: true, nodes: true, reevaluateMode: true });
      void checkUserNodes();
      refreshGeofences();
    }, [checkUserNodes, refreshGeofences])
  );

  // Re-evaluate mode + refetch when the app returns from background to
  // foreground. Customer A's bug: a detection arrived while the app was
  // backgrounded, but the prior implementation only re-fetched nodes on
  // resume, leaving the drone invisible on Live Map until a force-close.
  // reevaluateMode also catches the "scheduled deployment activated
  // while I was away" case from the report addendum.
  useEffect(() => {
    let prevState = AppState.currentState;
    const sub = AppState.addEventListener('change', (state) => {
      if (prevState !== 'active' && state === 'active') {
        void refreshRef.current?.({ detections: true, nodes: true, reevaluateMode: true });
      }
      prevState = state;
    });
    return () => sub.remove();
  }, []);

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

  // Initial camera centering. Replaces the auto-follow-user behavior that
  // <Camera followUserLocation> used to provide before user-location was
  // removed in versionCode 9 (see TODO in render JSX below). Fires once on
  // first opportunity; the ref-guard prevents re-centering when data
  // arrives later. Priority:
  //   1. selectedDrone (rare at mount; covers the case where the user
  //      navigated in with a drone already selected via deep-link)
  //   2. first online node with coords (typical case for operators with
  //      deployed nodes)
  //   3. Cleveland-area fallback (deployment record has no center field;
  //      Westshore Drone Services operates out of NE Ohio)
  const hasInitiallyCenteredRef = useRef(false);
  useEffect(() => {
    if (hasInitiallyCenteredRef.current) return;
    if (!cameraRef.current) return;

    let center: [number, number] | null = null;

    if (selectedDrone?.last_lat && selectedDrone?.last_lon) {
      center = [selectedDrone.last_lon, selectedDrone.last_lat];
    } else {
      const onlineNode = nodes.find(n =>
        n.status === 'online' && n.last_lat && n.last_lon);
      if (onlineNode) {
        center = [onlineNode.last_lon, onlineNode.last_lat];
      } else {
        // Cleveland-area fallback (downtown Cleveland coords).
        center = [-81.6944, 41.4993];
      }
    }

    try {
      cameraRef.current.setCamera({
        centerCoordinate: center,
        zoomLevel: 14,
        animationDuration: 0,
      });
      hasInitiallyCenteredRef.current = true;
    } catch (err) {
      console.warn('[livemap] initial camera centering failed:', err);
    }
  }, [nodes, selectedDrone, permissionResolved]);

  // Helper used by both mode helpers below: ensures the WS is connected
  // and either resubscribes the existing socket to a new shape (cheap,
  // no socket teardown) or opens a fresh one with the given shape if
  // none exists yet.
  const setWsSubscription = useCallback((subscribe: SubscribeMessage) => {
    if (wsRef.current) {
      wsRef.current.resubscribe(subscribe);
    } else {
      connectWebSocketRef.current?.(subscribe);
    }
  }, []);

  // Apply a deployment scope selection within active mode. Drives the WS
  // subscription, evicts drones outside the selected scope (so markers and
  // the DRONES count match the selection), hydrates detections + nodes for
  // the scope. Caller must have already set currentActiveIdsRef +
  // activeDeploymentsRef (enterActiveMode does; the selector pills run after
  // the set is established). Idempotent WS resubscribe is cheap.
  const applySelection = useCallback(async (sel: string | 'ALL') => {
    setSelectedDeploymentId(sel);
    selectedDeploymentIdRef.current = sel;

    const allIds = currentActiveIdsRef.current;
    const visibleIds = sel === 'ALL'
      ? allIds
      : (allIds.includes(sel) ? [sel] : (allIds.length ? [allIds[0]] : []));
    const visibleSet = new Set(visibleIds);

    // Header primary object (null for "All active" — the banner derives an
    // "ALL ACTIVE (n)" label from selectedDeploymentId instead).
    setActiveDeployment(
      sel === 'ALL' ? null : (activeDeploymentsRef.current.find((d: any) => d.id === sel) || null)
    );

    // Evict drones for active deployments NOT in the visible scope so the map
    // shows only the selected deployment's drones. (Departed-deployment
    // eviction is handled by enterActiveMode/enterPassiveMode.)
    const known = new Set<string>();
    for (const k of Object.keys(useDroneStore.getState().backendDrones)) {
      const idx = k.indexOf(':');
      if (idx > 0) known.add(k.slice(0, idx));
    }
    for (const id of known) {
      if (!visibleSet.has(id)) clearBackendDronesForDeployment(id);
    }

    // WS follows the selection — subscribe to exactly the visible scope.
    setWsSubscription({ type: 'SUBSCRIBE', deployment_ids: visibleIds });

    // Hydrate detections + nodes for the visible scope.
    for (const id of visibleIds) {
      try {
        const dets = await api.getDetections(id);
        dets.forEach((d: any) => updateBackendDrone(d));
      } catch (err) {
        console.warn(`[livemap] detection hydrate failed for ${id}:`, err);
      }
    }
    await refetchNodes(visibleIds);
  }, [setWsSubscription, clearBackendDronesForDeployment, updateBackendDrone, refetchNodes]);

  // Side effect: switch the screen into active mode for the given set of
  // currently-active deployments. Idempotent on same-set (no resubscribe,
  // no store thrash, no node refetch). Caller (refreshLiveMapState) has
  // already filtered `actives` to deployments with status === 'active'.
  //
  //   actives.length === 1 → single active mode (typical solo Sentinel
  //                          or single event deployment)
  //   actives.length >= 2  → multi-active mode (two or more deployments
  //                          running concurrently — the customer-B bug)
  //
  // The "primary" deployment selected here drives UI display only
  // (banner name, node list); the WS subscribes to ALL ids in the set.
  const enterActiveMode = useCallback(async (actives: any[]) => {
    if (actives.length === 0) return; // caller's responsibility but defensive
    const prevIds = currentActiveIdsRef.current;
    const nextIds = actives.map(d => d.id);

    // Set difference: which deployments are no longer in the active set?
    // Drop their drones from the store. Important: we compare by *set*,
    // not by ordered list, so a reorder of the same set is a no-op.
    const prevSet = new Set(prevIds);
    const nextSet = new Set(nextIds);
    const removed = prevIds.filter(id => !nextSet.has(id));
    const added = nextIds.filter(id => !prevSet.has(id));
    const sameSet = removed.length === 0 && added.length === 0;

    // Drop drones for every deployment NOT in the new active set (departed
    // deployments + any "leaked" passive-mode SUBSCRIBE_ORG entries).
    const allKnownDeploymentIds = new Set<string>();
    for (const k of Object.keys(useDroneStore.getState().backendDrones)) {
      const idx = k.indexOf(':');
      if (idx > 0) allKnownDeploymentIds.add(k.slice(0, idx));
    }
    for (const id of allKnownDeploymentIds) {
      if (!nextSet.has(id)) clearBackendDronesForDeployment(id);
    }

    // Publish the active set (mode truth) + the full objects for the
    // selector. Set the refs synchronously so applySelection below sees the
    // new set before the ref-sync useEffects flush.
    setActiveDeployments(actives);
    activeDeploymentsRef.current = actives;
    setCurrentActiveIds(nextIds);
    currentActiveIdsRef.current = nextIds;

    // Drop passive-mode poll + state. WS stays connected across active↔
    // passive transitions; only the subscription shape changes.
    if (passivePollTimer.current) {
      clearInterval(passivePollTimer.current);
      passivePollTimer.current = null;
    }
    setPassiveNodes([]);

    // Decide the scope selection, in priority order:
    //   1. a deep-linked target that's currently active (notification UX —
    //      matches the prior "primary = target" precedence),
    //   2. preserve the user's current selection if still valid,
    //   3. the sole deployment when only one is active,
    //   4. "All active" for concurrent deployments.
    const targetId = targetDeploymentIdRef.current;
    const curSel = selectedDeploymentIdRef.current;
    let nextSel: string | 'ALL';
    if (targetId && nextSet.has(targetId)) {
      nextSel = targetId;
    } else if (curSel !== null && (curSel === 'ALL' || nextSet.has(curSel))) {
      nextSel = curSel;
    } else if (nextIds.length === 1) {
      nextSel = nextIds[0];
    } else {
      nextSel = 'ALL';
    }

    if (sameSet && curSel === nextSel) {
      // Nothing changed (set + selection identical) — refresh detections/
      // nodes via refreshLiveMapState only, not here.
      return;
    }

    // applySelection handles the WS subscribe, drone eviction, detection +
    // node hydrate for the chosen scope.
    await applySelection(nextSel);

    // Cold-start-from-notification UX hint: if a target deployment was
    // deep-linked and is in the active set, nudge the map toward it.
    // Best-effort and bounded: the user can pan/zoom afterward. Trying
    // a drone's last position first, then a node's, then giving up.
    if (targetId && nextSet.has(targetId) && cameraRef.current) {
      const all = Object.values(useDroneStore.getState().backendDrones) as any[];
      const fromTarget = all
        .filter((d: any) =>
          d.deployment_id === targetId
          && typeof d.last_lat === 'number'
          && typeof d.last_lon === 'number')
        .sort((a: any, b: any) =>
          new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime());
      const drone = fromTarget[0];
      if (drone) {
        try {
          cameraRef.current.setCamera({
            centerCoordinate: [drone.last_lon, drone.last_lat],
            zoomLevel: 14,
            animationDuration: 800,
          });
        } catch (err) {
          console.warn('[livemap] target camera setCamera failed:', err);
        }
      } else {
        const node = nodesRef.current.find((n: any) =>
          typeof n.last_lat === 'number' && typeof n.last_lon === 'number');
        if (node) {
          try {
            cameraRef.current.setCamera({
              centerCoordinate: [node.last_lon, node.last_lat],
              zoomLevel: 14,
              animationDuration: 800,
            });
          } catch (err) {
            console.warn('[livemap] target camera setCamera failed:', err);
          }
        }
      }
    }
  }, [applySelection, clearBackendDronesForDeployment]);

  // Side effect: switch into passive mode. WS stays connected (under a
  // SUBSCRIBE_ORG shape) so org-wide detections still surface in real
  // time; the 30s passive poll is retained as a backup for the windows
  // where the WS is briefly down between reconnects.
  const enterPassiveMode = useCallback(() => {
    const prevIds = currentActiveIdsRef.current;

    setActiveDeployment(null);
    setCurrentActiveIds([]);
    currentActiveIdsRef.current = [];
    setActiveDeployments([]);
    activeDeploymentsRef.current = [];
    setSelectedDeploymentId(null);
    selectedDeploymentIdRef.current = null;
    setNodes([]);

    // Clear every previously-active deployment's drones from the store.
    // Without this, the screen would carry the last frame of the
    // outgoing deployments after the user moved off them.
    for (const id of prevIds) {
      clearBackendDronesForDeployment(id);
    }

    // Org-wide WS subscription. Connects if not already connected.
    // resubscribe is a no-op if we were already on SUBSCRIBE_ORG.
    setWsSubscription({ type: 'SUBSCRIBE_ORG' });

    // Backup poll. Largely redundant once WS is established, but kept
    // for the brief windows where the WS is between reconnects (Render
    // LB drops idle connections; backoff up to 30s on the client). Both
    // the WS and the poll feed updateBackendDrone, so a detection that
    // arrives twice is just an idempotent re-merge of the same row.
    startPassivePollingRef.current?.();
  }, [clearBackendDronesForDeployment, setWsSubscription]);

  // The single refresh entry point used by mount, focus, foreground,
  // and WS-reconnect. Decides mode (active vs passive), drives the
  // mode-change side effects, and refetches what was requested.
  //
  // reevaluateMode: re-runs the active/passive decision against a fresh
  //   deployments fetch. Needed when the user backgrounds the app while
  //   a deployment is `scheduled` and foregrounds it after the activation
  //   cron fires — without this, the "NO ACTIVE DEPLOYMENT" banner sticks
  //   until the next remount.
  //
  // When reevaluateMode triggers a mode switch, enterActiveMode /
  // enterPassiveMode already hydrate everything; the `detections`/`nodes`
  // flags are only consulted on the no-mode-change path.
  const refreshLiveMapState = useCallback(async (opts: {
    detections?: boolean;
    nodes?: boolean;
    reevaluateMode?: boolean;
  } = {}) => {
    const { detections = false, nodes = false, reevaluateMode = false } = opts;

    if (reevaluateMode) {
      try {
        const deps = await api.getDeployments();
        const actives = deps.filter((d: any) => d.status === 'active');
        const prevIds = currentActiveIdsRef.current;
        const nextIds = actives.map((d: any) => d.id);

        const prevSet = new Set(prevIds);
        const nextSet = new Set(nextIds);
        const setChanged =
          prevIds.length !== nextIds.length ||
          nextIds.some((id: string) => !prevSet.has(id)) ||
          prevIds.some((id: string) => !nextSet.has(id));

        // Targeted-but-not-active warning (preserved from Commit 2
        // behavior): if a notification deep-linked us with a target that
        // is no longer active, log so we can spot it. enterActiveMode's
        // primary selection still falls through to actives[0] in that
        // case via the ref read.
        const targetId = targetDeploymentIdRef.current;
        if (targetId && !nextSet.has(targetId)) {
          console.warn(`[livemap] targetDeploymentId=${targetId} not in active set (${nextIds.length} active); using primary fallback`);
        }

        if (actives.length === 0) {
          // Transition into passive mode. Fire when (a) we were
          // previously active (real mode change, clear stores) OR
          // (b) we haven't connected the WS yet (first cold-start
          // with zero active deployments — without this the WS would
          // never come up under SUBSCRIBE_ORG and org-wide detections
          // would only surface via the 30s poll).
          if (prevIds.length > 0 || !wsRef.current) {
            enterPassiveMode();
            return;
          }
        }
        if (actives.length > 0 && setChanged) {
          await enterActiveMode(actives);
          return;
        }
        if (actives.length > 0 && !setChanged) {
          // Same active set, no mode switch. Refresh the deployment objects
          // (names/modes may have changed server-side) and the selected
          // single deployment's stored copy; the scope selection is left
          // intact (set is unchanged, so the selection is still valid).
          setActiveDeployments(actives);
          activeDeploymentsRef.current = actives;
          const sel = selectedDeploymentIdRef.current;
          if (sel && sel !== 'ALL') {
            const dep = actives.find((d: any) => d.id === sel) || null;
            const cur = activeDeploymentRef.current;
            if (!cur || cur.id !== dep?.id || cur.name !== dep?.name) {
              setActiveDeployment(dep);
            }
          }
        }
        // else: was passive, still passive — fall through to refresh.
      } catch (err) {
        console.warn('[livemap] deployments refetch failed:', err);
        // Fall through using current mode.
      }
    }

    const curIds = currentActiveIdsRef.current;
    if (curIds.length > 0) {
      if (detections) {
        // Refresh detections for every subscribed deployment. Loop is
        // fine for typical counts; a bulk endpoint is the next move
        // if multi-deployment customers grow.
        for (const id of curIds) {
          try {
            const dets = await api.getDetections(id);
            dets.forEach((d: any) => updateBackendDrone(d));
          } catch (err) {
            console.warn(`[livemap] detection refetch failed for ${id}:`, err);
          }
        }
      }
      if (nodes) {
        // Refetch nodes for every currently-active deployment. ref is
        // current at this point (no in-flight setCurrentActiveIds from
        // this code path), so the arg-less call is correct.
        await refetchNodes();
      }
    } else if (detections || nodes) {
      // Passive mode: re-arm the poll. WS is also live under
      // SUBSCRIBE_ORG so most of this is redundant, but the poll
      // guarantees an immediate refresh without waiting on WS message
      // arrival.
      startPassivePollingRef.current?.();
    }
  }, [enterActiveMode, enterPassiveMode, updateBackendDrone, refetchNodes]);

  const loadActiveDeployment = useCallback(async () => {
    await refreshLiveMapState({ detections: true, nodes: true, reevaluateMode: true });
  }, [refreshLiveMapState]);

  // Polls recent org-wide detections + all org nodes every PASSIVE_POLL_MS.
  // Gated on userHasAnyNode === true at call time — checkUserNodes resolves
  // before this runs (both kicked off from the mount effect), so a new
  // account with no nodes never hits the network here.
  const startPassivePolling = useCallback(() => {
    const poll = async () => {
      // Skip while the user has no nodes (incl. while the initial check is
      // still in flight, userHasAnyNodeRef === null). Re-checked each tick so
      // adding a node later starts populating the view without a remount.
      if (userHasAnyNodeRef.current !== true) return;
      try {
        const [dets, nodeList] = await Promise.all([
          api.getRecentDetections(PASSIVE_RECENCY_MIN),
          api.getNodes(),
        ]);
        // Drones merge into the shared backendDrones store via
        // updateBackendDrone — same path as WS-delivered detections.
        // The 5-min render filter in `droneList` enforces the passive-
        // mode visibility window; aged-out entries linger in the store
        // until the next mode change (consistent with session-scoped
        // eviction from Commit 3).
        if (Array.isArray(dets)) {
          for (const d of dets) updateBackendDrone(d);
        }
        setPassiveNodes(Array.isArray(nodeList) ? nodeList : []);
      } catch (err) {
        console.warn('[passive] poll failed:', err);
      }
    };
    void poll();
    if (passivePollTimer.current) clearInterval(passivePollTimer.current);
    passivePollTimer.current = setInterval(poll, PASSIVE_POLL_MS);
  }, [updateBackendDrone]);

  const connectWebSocket = useCallback((subscribe: SubscribeMessage) => {
    const ws = createWebSocket(subscribe, (msg) => {
      if (msg.type === 'DRONE_UPDATE') {
        msg.drones.forEach((d: any) => updateBackendDrone(d));
      }
      if (msg.type === 'NICKNAME_UPDATE') {
        // Backend broadcasts to all clients; ignore other orgs.
        if (orgId && msg.org_id && msg.org_id !== orgId) return;
        updateNickname(msg.uas_id, msg.nickname || null);
      }
      if (msg.type === 'NODE_OFFLINE') {
        const existing = nodesRef.current.find((n: any) => n.id === msg.node_id);
        if (existing) {
          setNodes(prev => prev.map((n: any) =>
            n.id === msg.node_id ? { ...n, status: 'offline' } : n
          ));
        } else {
          // Unknown node — partner grant just expanded, or a node was
          // added to one of our active deployments while we were on a
          // stale snapshot. Symmetric with the NODE_ONLINE fallback
          // below; refetch is debounced.
          scheduleRefetchNodes();
        }
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
      if (msg.type === 'NODE_POSITION') {
        // Live position from a moving node's heartbeat (or detection). Update
        // the marker coords in whichever list holds the node (active or
        // passive) so it tracks without a full refetch. Returning the same
        // array reference when the node isn't present makes React skip the
        // re-render — NODE_POSITION can arrive frequently for a mobile node.
        const move = (prev: any[]) => prev.some((n: any) => n.id === msg.node_id)
          ? prev.map((n: any) => n.id === msg.node_id
              ? { ...n, last_lat: msg.lat, last_lon: msg.lon }
              : n)
          : prev;
        setNodes(move);
        setPassiveNodes(move);
      }
    }, {
      // After an unexpected close + reconnect, the WS resumes live updates
      // but the client's in-memory state is stale for whatever window the
      // connection was down. Routed through refreshRef so a deployment
      // that activated or ended while the WS was down also triggers the
      // active/passive mode switch (not just a detections/nodes refetch).
      onReconnect: () => {
        console.info('[ws] reconnect — re-evaluating mode + refetching state');
        void refreshRef.current?.({ detections: true, nodes: true, reevaluateMode: true });
      },
    });
    wsRef.current = ws;
  }, [scheduleRefetchNodes, updateBackendDrone, orgId, updateNickname]);

  // Forward-decl ref sync. Runs during render, after all useCallback
  // consts above are bound, so by the time any effect/timer/event
  // handler fires the refs are non-null. Cheap on every render — just
  // three mutable-ref writes.
  connectWebSocketRef.current = connectWebSocket;
  startPassivePollingRef.current = startPassivePolling;
  refreshRef.current = refreshLiveMapState;

  const s = styles(colors);

  // See `permissionResolved` declaration for the race-condition rationale.
  // Show a spinner until the OS permission prompt has been answered;
  // mounting MapView before then is what causes the fresh-install marker
  // bug.
  if (!permissionResolved) {
    return (
      <View style={s.loadingContainer}>
        <ActivityIndicator size="large" color={colors.cyan} />
      </View>
    );
  }

  return (
    <View style={s.container}>
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
        <MapboxGL.Camera ref={cameraRef} />

        {/* Facility geofences (own-org boundaries). Drawn beneath nodes/
            drones. Each row carries a materialized GeoJSON Polygon Feature;
            we render geometry.geometry.coordinates[0] as an opaque ring —
            no circle/center/radius assumptions (prod boundaries are
            arbitrary polygons). Mirrors the dashboard: fill 0.08/0.04 by
            push_enabled, solid stroke for push-alerting boundaries, dashed
            for context-only ones. */}
        {geofences.length > 0 && (
          <MapboxGL.ShapeSource
            id="geofence-source"
            shape={{
              type: 'FeatureCollection',
              features: geofences
                .filter((g: any) => g.enabled && g.geometry?.geometry?.coordinates?.length)
                .map((g: any) => ({
                  type: 'Feature' as const,
                  geometry: g.geometry.geometry,
                  properties: { color: g.color || '#00d4ff', push: !!g.push_enabled },
                })),
            }}
          >
            <MapboxGL.FillLayer
              id="geofence-fill"
              style={{
                fillColor: ['get', 'color'],
                fillOpacity: ['case', ['get', 'push'], 0.08, 0.04],
              }}
            />
            <MapboxGL.LineLayer
              id="geofence-line-solid"
              filter={['==', ['get', 'push'], true]}
              style={{ lineColor: ['get', 'color'], lineWidth: 1.5, lineOpacity: 0.7 }}
            />
            <MapboxGL.LineLayer
              id="geofence-line-dashed"
              filter={['==', ['get', 'push'], false]}
              style={{ lineColor: ['get', 'color'], lineWidth: 1.5, lineOpacity: 0.4, lineDasharray: [2, 2] }}
            />
          </MapboxGL.ShapeSource>
        )}
        {/* TODO(followup): restore user-location marker. Removed in versionCode 9
            due to Mapbox 10.3.1 + RN 0.79 + old-arch incompatibility. Three
            patches in patches/@rnmapbox+maps+10.3.1.patch address part of the
            chain but JS->native start() dispatch on old arch is broken at the
            codegen layer. Options: (a) migrate to newArchEnabled=true in a
            future SDK bump, (b) custom marker driven by expo-location, (c) wait
            for Mapbox upstream fix. Initial camera centering is now handled
            by the useEffect above this return statement; node positioning is
            unaffected (NodeHeartbeatUploader.kt uses android.location.LocationManager
            directly, independent of Mapbox). */}

        {/* Node markers — renderableNodes is the same set the NODES count
            uses, so count == pins drawn. Online/offline shown by border. */}
        {renderableNodes.map(node => {
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

        {/* Drone flight path polyline — only the selected drone's path renders. */}
        {droneList.map((drone: any) => {
          const id = drone.uasId || drone.uas_id || drone.mac;
          if (id !== selectedId) return null;
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
                    opacity: (isPassive ? 0.6 : 1.0) *
                      (selectedId == null || selectedId === id ? 1.0 : 0.5),
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
            const drone = droneList.find((d: any) => (d.uasId || d.uas_id || d.mac) === droneId);
            if (drone) {
              setSelectedDrone(drone);
              setSheetCollapsed(false);
            }
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
              textOpacity: ['get', 'opacity'],
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
              textOpacity: ['get', 'opacity'],
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
      <View style={[s.topBar, { paddingTop: insets.top + 12 }]}>
        <View style={{ flex: 1 }}>
          <Text style={s.appName}>WESTSHORE WATCH</Text>
          {!isPassive && (
            <Text style={s.depName} numberOfLines={1}>
              ▸ {selectedDeploymentId === 'ALL'
                ? `ALL ACTIVE (${activeDeployments.length})`
                : (activeDeployment?.name ?? '')}
            </Text>
          )}
          {/* Deployment scope selector — only when 2+ deployments are active
              (the concurrent-deployment case). The option list is whatever
              the viewer is allowed to see, so a grantee is locked to their
              granted deployment(s). */}
          {!isPassive && activeDeployments.length >= 2 && (
            <View style={s.selectorRow}>
              {[{ id: 'ALL', name: 'ALL' }, ...activeDeployments].map((opt: any) => {
                const active = (selectedDeploymentId ?? 'ALL') === opt.id;
                return (
                  <TouchableOpacity
                    key={opt.id}
                    style={[s.pill, active && s.pillActive]}
                    onPress={() => {
                      if ((selectedDeploymentIdRef.current ?? 'ALL') === opt.id) return;
                      void applySelection(opt.id);
                    }}
                    activeOpacity={0.7}
                  >
                    <Text style={[s.pillText, active && s.pillTextActive]} numberOfLines={1}>
                      {opt.id === 'ALL' ? 'ALL' : opt.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
          {isPassive && (
            <Text style={s.passiveBadge}>◌ PASSIVE</Text>
          )}
          {nearbyNodeCount > 0 && (
            <Text style={s.nodeNearby}>📡 NODE IN RANGE</Text>
          )}
        </View>
        <KeepScreenOnToggle keepAwakeTag="live-map" />
        <View style={s.statsRow}>
          <View style={s.stat}>
            <Text style={s.statVal}>{uniqueDroneIdentityCount}</Text>
            <Text style={s.statLabel}>DRONES</Text>
          </View>
          <View style={s.stat}>
            <Text style={[s.statVal, { color: colors.green }]}>
              {renderableNodes.length}
            </Text>
            <Text style={s.statLabel}>NODES</Text>
          </View>
        </View>
      </View>

      {/* No-nodes prompt for users who skipped onboarding */}
      {userHasAnyNode === false && c.canPairNodeOnThisDevice && (
        <TouchableOpacity
          style={s.noNodesBanner}
          onPress={() => navigation.navigate('AddNode')}
          activeOpacity={0.8}
        >
          <View style={{ flex: 1 }}>
            <Text style={s.noNodesTitle}>ADD YOUR FIRST NODE</Text>
            <Text style={s.noNodesSub}>Register a node to start detecting drones</Text>
          </View>
          <Text style={s.noNodesArrow}>→</Text>
        </TouchableOpacity>
      )}

      {/* Passive mode banner — shown when no deployment is active but the
          user has nodes. Mutually exclusive with the no-nodes banner. */}
      {isPassive && userHasAnyNode === true && (
        <TouchableOpacity
          style={s.passiveBanner}
          onPress={() => navigation.navigate('Deployments')}
          activeOpacity={0.8}
        >
          <View style={{ flex: 1 }}>
            <Text style={s.passiveTitle}>NO ACTIVE DEPLOYMENT</Text>
            <Text style={s.passiveSub}>
              Showing recent detections from your nodes (last {PASSIVE_RECENCY_MIN} min)
            </Text>
          </View>
          <Text style={s.passiveArrow}>→</Text>
        </TouchableOpacity>
      )}

      {showPausedBanner && (
        <View style={s.bgLocBanner}>
          <View style={{ flex: 1 }}>
            <Text style={s.bgLocTitle}>DEPLOYMENT PAUSED</Text>
            <Text style={s.bgLocSub}>
              Detections are queued and will upload when the deployment resumes. Visit watch.westshoredrone.com/billing for details.
            </Text>
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

        // CTA-2063-A model decode. Backend resolves manufacturer + model
        // from the uas_id prefix at ingest and writes both onto the
        // drone_detections row; the WS DRONE_UPDATE payload + the initial
        // /api/detections hydrate both carry these fields. BLE-mode drones
        // (guest flow without backend) won't have them — fall through to
        // 'Unknown'. Display per spec:
        //   manufacturer + model present → "DJI Air 3"
        //   manufacturer only            → "DJI"
        //   neither                      → "Unknown"
        const manufacturer = liveDrone.manufacturer;
        const model = liveDrone.model;
        const modelDisplay = manufacturer && model
          ? `${manufacturer} ${model}`
          : manufacturer
            ? manufacturer
            : 'Unknown';

        // Resolve source node name from the registry by BLE MAC.
        const srcMac = liveDrone.sourceMac;
        const sourceNode = srcMac ? getNodeByMac(srcMac) : null;
        const nodeName = sourceNode?.name || liveDrone.node_name || '—';

        const uasId = liveDrone.uasId || liveDrone.uas_id || liveDrone.mac;
        const nickname = nicknames[uasId] || '';

        return (
          <View style={[s.detailSheet, sheetCollapsed && s.detailSheetCollapsed]}>
            {/* Header row: title flexes; V + X sit in normal flow on the
                same line. Their hit regions can no longer reach down into
                the nickname TextInput below, which was causing taps on X
                to open the keyboard instead of dismissing the sheet. */}
            <View style={s.sheetHeaderRow}>
              {nickname ? (
                <View style={{ flex: 1, marginRight: 12 }}>
                  <Text style={s.detailNickname} numberOfLines={1}>{nickname}</Text>
                  <Text style={s.detailIdSmall} numberOfLines={1}>{uasId}</Text>
                </View>
              ) : (
                <Text style={[s.detailId, { flex: 1, marginRight: 12, marginBottom: 0 }]} numberOfLines={1}>{uasId}</Text>
              )}
              <TouchableOpacity
                style={s.sheetControlBtn}
                onPress={() => setSheetCollapsed(prev => !prev)}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                activeOpacity={0.6}
              >
                <Text style={s.sheetCloseText}>{sheetCollapsed ? '⌃' : '⌄'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.sheetControlBtn}
                onPress={() => setSelectedDrone(null)}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                activeOpacity={0.6}
              >
                <Text style={s.sheetCloseText}>✕</Text>
              </TouchableOpacity>
            </View>
            {!sheetCollapsed && (
              <>
                <TextInput
                  style={s.nicknameInput}
                  value={nickname}
                  onChangeText={c.canEditDrone ? (text) => setNickname(uasId, text) : undefined}
                  editable={c.canEditDrone}
                  placeholder={c.canEditDrone ? 'Add nickname...' : ''}
                  placeholderTextColor={colors.textMuted}
                  maxLength={30}
                />
                <View style={s.detailGrid}>
                  {[
                    ['MODEL', modelDisplay],
                    ['POSITION', dLat != null ? `${Number(dLat).toFixed(6)}, ${Number(dLon).toFixed(6)}` : '—'],
                    ['ALTITUDE', dAlt != null ? `${fmtAltitude(dAlt)} MSL` : '—'],
                    ['SPEED', fmtSpeed(dSpeed)],
                    ['OPERATOR', dOpLat != null ? `${Number(dOpLat).toFixed(6)}, ${Number(dOpLon).toFixed(6)}` : '—'],
                    ['NODE', nodeName],
                  ].map(([label, value]) => (
                    <View key={label} style={s.detailRow}>
                      <Text style={s.detailLabel}>{label}</Text>
                      <Text style={s.detailValue}>{value}</Text>
                    </View>
                  ))}
                </View>
              </>
            )}
          </View>
        );
      })()}
    </View>
  );
}

const styles = (c: ReturnType<typeof useTheme>) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  loadingContainer: { flex: 1, backgroundColor: c.bg, justifyContent: 'center', alignItems: 'center' },
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    paddingHorizontal: 16, paddingBottom: 12,
    backgroundColor: 'rgba(10,14,26,0.85)',
  },
  appName: {
    color: c.cyan, fontSize: 11, fontWeight: '700', letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  depName: {
    color: c.text, fontSize: 12, fontWeight: '600', letterSpacing: 1, marginTop: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  nodeNearby: {
    color: '#00ff88', fontSize: 9, marginTop: 2, letterSpacing: 1,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  selectorRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6,
  },
  pill: {
    paddingVertical: 3, paddingHorizontal: 9, borderRadius: 11,
    borderWidth: 1, borderColor: c.border, backgroundColor: 'rgba(255,255,255,0.04)',
    maxWidth: 140,
  },
  pillActive: {
    borderColor: c.cyan, backgroundColor: 'rgba(0,212,255,0.16)',
  },
  pillText: {
    color: c.textMuted, fontSize: 9, letterSpacing: 1,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  pillTextActive: { color: c.cyan, fontWeight: '700' },
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
  passiveBanner: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 120 : 104,
    left: 16, right: 16,
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, paddingHorizontal: 14,
    borderRadius: 10, borderWidth: 1, borderColor: c.textMuted,
    backgroundColor: 'rgba(150,150,150,0.10)',
  },
  passiveTitle: {
    color: c.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  passiveSub: {
    color: c.textDim, fontSize: 10, marginTop: 2,
  },
  passiveArrow: {
    color: c.textMuted, fontSize: 18, fontWeight: '700', marginLeft: 12,
  },
  passiveBadge: {
    color: c.textMuted, fontSize: 9, marginTop: 2, letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
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
    position: 'absolute', bottom: 0, left: 0, right: 0, maxWidth: 600, marginHorizontal: 'auto',
    backgroundColor: 'rgba(17,24,39,0.97)',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderTopWidth: 1, borderColor: c.border,
    padding: 20, paddingBottom: Platform.OS === 'ios' ? 36 : 20,
  },
  detailSheetCollapsed: { paddingBottom: Platform.OS === 'ios' ? 28 : 16 },
  // Header row puts dismiss controls in normal flow next to the title so
  // their tap regions can't overlap the nickname TextInput below. The
  // previous absolute-positioned V/X had hitSlop reaching into the input's
  // focus area, hijacking taps as keyboard-open events.
  sheetHeaderRow: {
    flexDirection: 'row', alignItems: 'center', marginBottom: 12,
  },
  sheetControlBtn: { padding: 8, marginLeft: 4 },
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

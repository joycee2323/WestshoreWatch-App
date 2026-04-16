import { create } from 'zustand';
import { OdidDetection } from '../services/odidParser';

export interface DroneEntry extends Partial<OdidDetection> {
  mac: string;
  rssi: number;
  lastSeen: number;
  firstSeen: number;
  path: { lat: number; lon: number; ts: number }[];
  // Accumulated fields from multiple message types
  uasId?: string;
  lat?: number;
  lon?: number;
  altGeo?: number;
  speedHoriz?: number;
  heading?: number;
  status?: number;
  opLat?: number;
  opLon?: number;
  sourceMac?: string;
  sourceApiKey?: string;
}

interface DroneStore {
  // BLE-detected drones (guest mode)
  bleDrones: Record<string, DroneEntry>;
  // Backend-synced drones (authenticated mode)
  backendDrones: Record<string, any>;
  // Which source to display
  mode: 'ble' | 'backend';

  updateBleDrone: (mac: string, data: Partial<OdidDetection> & { rssi: number }) => void;
  removeDrone: (mac: string) => void;
  clearBleDrones: () => void;
  setBackendDrones: (drones: Record<string, any>) => void;
  updateBackendDrone: (drone: any) => void;
  setMode: (mode: 'ble' | 'backend') => void;
  nearbyNodes: Record<string, { mac: string; rssi: number; lastSeen: number }>;
  updateNearbyNode: (mac: string, rssi: number) => void;
}

export const useDroneStore = create<DroneStore>((set) => ({
  bleDrones: {},
  backendDrones: {},
  mode: 'ble',
  nearbyNodes: {},

  updateBleDrone: (mac, data) => {
    const now = Date.now();
    set(state => {
      const existing = state.bleDrones[mac];
      const prevPath = existing?.path || [];
      const newPoint = (data.lat && data.lon)
        ? [{ lat: data.lat, lon: data.lon, ts: now }]
        : [];

      // Merge — later messages win for each field, but don't overwrite with undefined
      const merged: DroneEntry = {
        mac,
        firstSeen: existing?.firstSeen ?? now,
        lastSeen: now,
        path: [...prevPath, ...newPoint].slice(-200), // keep last 200 points
        rssi: data.rssi,
        // Carry forward existing values, overwrite with new non-null values
        uasId: data.uasId ?? existing?.uasId,
        lat: data.lat ?? existing?.lat,
        lon: data.lon ?? existing?.lon,
        altGeo: data.altGeo ?? existing?.altGeo,
        speedHoriz: data.speedHoriz ?? existing?.speedHoriz,
        heading: data.heading ?? existing?.heading,
        status: data.status ?? existing?.status,
        opLat: data.opLat ?? existing?.opLat,
        opLon: data.opLon ?? existing?.opLon,
        sourceMac: (data as any).sourceMac ?? existing?.sourceMac,
        sourceApiKey: (data as any).sourceApiKey ?? existing?.sourceApiKey,
        hasBasicId: data.hasBasicId || existing?.hasBasicId,
        hasLocation: data.hasLocation || existing?.hasLocation,
        hasSystem: data.hasSystem || existing?.hasSystem,
      };

      console.log('[DroneStore]', mac, {
        inHeading: data.heading, inSpeed: data.speedHoriz,
        mergedHeading: merged.heading, mergedSpeed: merged.speedHoriz,
        hasLocation: merged.hasLocation,
      });

      return {
        bleDrones: { ...state.bleDrones, [mac]: merged },
      };
    });
  },

  removeDrone: (mac) => {
    set(state => {
      const next = { ...state.bleDrones };
      delete next[mac];
      return { bleDrones: next };
    });
  },

  clearBleDrones: () => set({ bleDrones: {} }),

  setBackendDrones: (drones) => set({ backendDrones: drones }),

  updateBackendDrone: (drone) => set(state => ({
    backendDrones: { ...state.backendDrones, [drone.uas_id]: drone },
  })),

  setMode: (mode) => set({ mode }),

  updateNearbyNode: (mac, rssi) => {
    set(state => ({
      nearbyNodes: {
        ...state.nearbyNodes,
        [mac]: { mac, rssi, lastSeen: Date.now() },
      },
    }));
    // Expire node after 15 seconds of no signal
    setTimeout(() => {
      set(state => {
        const node = state.nearbyNodes[mac];
        if (node && Date.now() - node.lastSeen >= 15000) {
          const next = { ...state.nearbyNodes };
          delete next[mac];
          return { nearbyNodes: next };
        }
        return state;
      });
    }, 15000);
  },
}));

const DRONE_STALE_MS = 30000;
const CLEANUP_INTERVAL_MS = 10000;

setInterval(() => {
  const now = Date.now();
  const { bleDrones, removeDrone } = useDroneStore.getState();
  for (const mac of Object.keys(bleDrones)) {
    if (now - bleDrones[mac].lastSeen > DRONE_STALE_MS) {
      removeDrone(mac);
    }
  }
}, CLEANUP_INTERVAL_MS);

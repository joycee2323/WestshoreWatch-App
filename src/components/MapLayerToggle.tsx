import React, { useCallback, useEffect, useState } from 'react';
import { Platform, StyleProp, StyleSheet, Text, TouchableOpacity, ViewStyle } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import MapboxGL from '@rnmapbox/maps';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme';

export const MAP_LAYER_STORAGE_KEY = 'map_layer';

export type MapLayer = 'standard' | 'satellite';

// Standard keeps the map's original dark style. Satellite uses Mapbox's
// imagery + streets hybrid, which carries road names. Neither style draws
// house numbers, so the map adds them itself (see HouseNumberLayer).
export const SATELLITE_STYLE_URL = 'mapbox://styles/mapbox/satellite-streets-v12';

export function styleURLForLayer(layer: MapLayer): string {
  return layer === 'satellite' ? SATELLITE_STYLE_URL : MapboxGL.StyleURL.Dark;
}

// Persisted Standard/Satellite choice. Starts at 'standard' and swaps to the
// stored value once AsyncStorage answers (one extra style load at most on a
// cold start for satellite users).
export function useMapLayer(): [MapLayer, () => void] {
  const [layer, setLayer] = useState<MapLayer>('standard');

  useEffect(() => {
    AsyncStorage.getItem(MAP_LAYER_STORAGE_KEY)
      .then(raw => { if (raw === 'satellite') setLayer('satellite'); })
      .catch(err => console.warn('[mapLayer] Failed to load map layer:', err));
  }, []);

  const toggle = useCallback(() => {
    setLayer(prev => {
      const next: MapLayer = prev === 'satellite' ? 'standard' : 'satellite';
      AsyncStorage.setItem(MAP_LAYER_STORAGE_KEY, next)
        .catch(err => console.warn('[mapLayer] Failed to save map layer:', err));
      return next;
    });
  }, []);

  return [layer, toggle];
}

// House-number labels from the style's own `composite` source (Mapbox
// Streets v8 `housenum_label`), present in both dark-v11 and
// satellite-streets-v12. Rendered as a MapView child so rnmapbox re-adds it
// after every style switch along with the other sources/layers.
export function HouseNumberLayer({ layer }: { layer: MapLayer }) {
  const satellite = layer === 'satellite';
  return (
    <MapboxGL.SymbolLayer
      id="wsw-housenum-label"
      sourceID="composite"
      sourceLayerID="housenum_label"
      minZoomLevel={17}
      style={{
        textField: ['get', 'house_num'],
        textSize: 11,
        textFont: ['DIN Pro Medium', 'Arial Unicode MS Regular'],
        textColor: satellite ? '#ffffff' : '#9aa4ad',
        textHaloColor: satellite ? 'rgba(0,0,0,0.85)' : '#0d1117',
        textHaloWidth: 1.2,
        textPadding: 2,
      }}
    />
  );
}

type Props = {
  layer: MapLayer;
  onToggle: () => void;
  // Positioning from the screen (floating map control).
  style?: StyleProp<ViewStyle>;
};

// Floating icon-only map control: layers icon with a tiny STD/SAT caption
// for the active layer. 44x44 minimum touch target.
export default function MapLayerToggle({ layer, onToggle, style }: Props) {
  const colors = useTheme();
  const satellite = layer === 'satellite';
  const s = styles(colors);
  return (
    <TouchableOpacity
      onPress={onToggle}
      accessibilityLabel={`Map layer: ${satellite ? 'satellite' : 'standard'}. Tap to switch.`}
      accessibilityRole="switch"
      accessibilityState={{ checked: satellite }}
      style={[s.btn, satellite && s.btnActive, style]}
    >
      <Ionicons
        name={satellite ? 'layers' : 'layers-outline'}
        size={20}
        color={satellite ? colors.cyan : colors.text}
      />
      <Text style={[s.label, { color: satellite ? colors.cyan : colors.textMuted }]}>
        {satellite ? 'SAT' : 'STD'}
      </Text>
    </TouchableOpacity>
  );
}

// Same hex->rgba helper as KeepScreenOnToggle (theme colors differ by palette).
function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Same surface/border/radius language as KeepScreenOnToggle and the header
// (rgba(10,14,26,0.85)), so it reads as part of the map chrome.
const styles = (c: ReturnType<typeof useTheme>) => StyleSheet.create({
  btn: {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.border2,
    backgroundColor: 'rgba(10,14,26,0.85)',
  },
  btnActive: {
    borderColor: withAlpha(c.cyan, 0.4),
    backgroundColor: withAlpha(c.cyan, 0.12),
  },
  label: {
    fontSize: 8,
    letterSpacing: 0.5,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
});

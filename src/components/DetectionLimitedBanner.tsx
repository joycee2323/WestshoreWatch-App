import React from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform,
} from 'react-native';
import { useTheme } from '../theme';

// In-app fallback banner for the background-scan warning, shown on return to
// the foreground when OS notification permission is denied (so the local
// notification couldn't be delivered). Mirrors the existing Live Map banner
// styling — absolute, pinned below the header, amber warning accent, monospace
// title. Tap anywhere to dismiss.
//
// `topOffset` overrides the default below-header position. Live Map omits it
// (its header banners sit at 120); Guest Scan passes a larger value so the
// banner clears the centered "N DRONES DETECTED" count badge (top 108).
export default function DetectionLimitedBanner({
  visible, onDismiss, topOffset,
}: { visible: boolean; onDismiss: () => void; topOffset?: number }) {
  const colors = useTheme();
  if (!visible) return null;
  const s = styles(colors);
  const top = topOffset ?? (Platform.OS === 'ios' ? 120 : 104);
  return (
    <TouchableOpacity style={[s.banner, { top }]} activeOpacity={0.85} onPress={onDismiss}>
      <Text style={s.title}>DETECTION LIMITED</Text>
      <Text style={s.body}>
        Westshore Watch was in the background. iOS limits Bluetooth scanning —
        keep the app open and your screen on for continuous detection.
      </Text>
    </TouchableOpacity>
  );
}

const styles = (c: ReturnType<typeof useTheme>) => StyleSheet.create({
  banner: {
    position: 'absolute',
    left: 16, right: 16,
    backgroundColor: 'rgba(245,158,11,0.12)',
    borderRadius: 10, borderWidth: 1, borderColor: c.amber,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  title: {
    color: c.amber, fontSize: 11, fontWeight: '700', letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    marginBottom: 4,
  },
  body: { color: c.textDim, fontSize: 11, lineHeight: 16 },
});

import React, { useEffect, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, StyleSheet, Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../theme';

// One-time informational modal shown on first entry to a Bluetooth-scanning
// surface (Live Map, Guest Scan). iOS only: iOS suspends/throttles BLE
// scanning when the app is backgrounded or the screen is locked, so we ask
// the user to keep the screen active. Dismissal is persisted per-surface in
// AsyncStorage (the `storageKey` prop) so it only ever shows once. Renders
// nothing on Android, where no such background-scan restriction applies.
//
// Visual language reuses the inline modal pattern from NodesScreen (dark
// card, cyan border, monospace title, single cyan action button).
export default function KeepScreenActiveModal({ storageKey }: { storageKey: string }) {
  const colors = useTheme();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let cancelled = false;
    AsyncStorage.getItem(storageKey)
      .then(seen => {
        if (!cancelled && seen !== 'true') setVisible(true);
      })
      .catch(err => console.warn('[KeepScreenActiveModal] read failed:', err));
    return () => { cancelled = true; };
  }, [storageKey]);

  const dismiss = () => {
    setVisible(false);
    AsyncStorage.setItem(storageKey, 'true').catch(err =>
      console.warn('[KeepScreenActiveModal] persist failed:', err),
    );
  };

  if (Platform.OS !== 'ios') return null;

  const s = styles(colors);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={dismiss}>
      <View style={s.backdrop}>
        <View style={s.card}>
          <Text style={s.title}>Keep this screen active</Text>
          <Text style={s.body}>
            For reliable drone detection, keep Westshore Watch open and your
            screen on. iOS limits Bluetooth scanning when the app is in the
            background or the screen is locked, which can delay or miss
            detections.
          </Text>
          <View style={s.actions}>
            <TouchableOpacity style={[s.btn, s.btnPrimary]} onPress={dismiss}>
              <Text style={[s.btnText, { color: colors.cyan }]}>GOT IT</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = (c: ReturnType<typeof useTheme>) => StyleSheet.create({
  backdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center', padding: 24,
  },
  card: {
    backgroundColor: c.surface, borderRadius: 12,
    borderWidth: 1, borderColor: 'rgba(0,212,255,0.3)',
    padding: 20,
  },
  title: {
    color: c.text, fontSize: 12, fontWeight: '700', letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    marginBottom: 14,
  },
  body: { color: c.textDim, fontSize: 13, lineHeight: 20 },
  actions: {
    flexDirection: 'row', justifyContent: 'flex-end', marginTop: 20,
  },
  btn: {
    borderRadius: 6, paddingHorizontal: 14, paddingVertical: 9,
    borderWidth: 1, minWidth: 90, alignItems: 'center',
  },
  btnPrimary: { borderColor: c.cyan, backgroundColor: 'rgba(0,212,255,0.08)' },
  btnText: {
    fontSize: 10, fontWeight: '700', letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
});

import React from 'react';
import {
  Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform,
} from 'react-native';
import { useTheme } from '../theme';

// Lets the operator pick which active deployment this phone relays BLE
// detections to when more than one candidate is genuinely ambiguous
// (see useRelayTarget). Replaces a prior native Alert.alert button list:
// Android's AlertDialog only exposes 3 button slots (positive/negative/
// neutral), so with 4+ deployments the extra choices — sometimes including
// the cancel button itself — silently vanished, with no scroll and no way
// to back out. This is a real Modal with a scrollable option list and an
// explicit cancel button, plus backdrop/back-button dismiss.
export default function RelayTargetModal({
  candidates, onSelect, onCancel,
}: {
  candidates: { id: string; name?: string }[] | null;
  onSelect: (id: string) => void;
  onCancel: () => void;
}) {
  const colors = useTheme();
  const visible = !!candidates && candidates.length > 0;
  const s = styles(colors);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={onCancel}>
        <TouchableOpacity activeOpacity={1} style={s.card} onPress={() => {}}>
          <Text style={s.title}>Relay detections to which deployment?</Text>
          <Text style={s.body}>
            This phone can relay drone detections to one active deployment.
            Choose where its detections should be recorded.
          </Text>
          <ScrollView style={s.list} nestedScrollEnabled>
            {(candidates || []).map(d => (
              <TouchableOpacity
                key={d.id}
                style={s.option}
                onPress={() => onSelect(d.id)}
              >
                <Text style={s.optionText}>{d.name ?? d.id}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <View style={s.actions}>
            <TouchableOpacity style={[s.btn, s.btnCancel]} onPress={onCancel}>
              <Text style={[s.btnText, { color: colors.textDim }]}>NOT NOW</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
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
    color: c.text, fontSize: 12, fontWeight: '700', letterSpacing: 1.5,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    marginBottom: 10,
  },
  body: { color: c.textDim, fontSize: 13, lineHeight: 20, marginBottom: 14 },
  // Fixed cap so a long deployment list scrolls inside the card instead of
  // growing the modal indefinitely off-screen.
  list: { maxHeight: 260 },
  option: {
    borderRadius: 6, borderWidth: 1, borderColor: 'rgba(0,212,255,0.25)',
    paddingVertical: 12, paddingHorizontal: 14, marginBottom: 8,
    backgroundColor: 'rgba(0,212,255,0.06)',
  },
  optionText: {
    color: c.cyan, fontSize: 12, fontWeight: '700', letterSpacing: 0.5,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 6 },
  btn: {
    borderRadius: 6, paddingHorizontal: 14, paddingVertical: 9,
    borderWidth: 1, minWidth: 90, alignItems: 'center',
  },
  btnCancel: { borderColor: 'rgba(255,255,255,0.15)' },
  btnText: {
    fontSize: 10, fontWeight: '700', letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
});

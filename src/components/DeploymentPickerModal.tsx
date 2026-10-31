import React from 'react';
import {
  Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform,
} from 'react-native';
import { useTheme } from '../theme';
import type { DeploymentOption } from '../services/deploymentPicker';

// "Assign to Deployment" picker for the Nodes screen. Replaces a native
// Alert.alert button list: Android's AlertDialog only exposes 3 button slots,
// so with 3+ deployments the Cancel button vanished (and the dialog isn't
// cancelable, so the user had to assign somewhere), and a 4th+ deployment
// could not be chosen at all. Same pattern as RelayTargetModal (37e9a8b2),
// kept as a separate copy so the relay prompt stays untouched: a real Modal
// with a scrollable option list and an explicit CANCEL, plus backdrop tap and
// Android back (onRequestClose) to dismiss.
export default function DeploymentPickerModal({
  visible, title, prompt, options, onSelect, onCancel,
}: {
  visible: boolean;
  title: string;
  prompt: string;
  options: DeploymentOption[];
  onSelect: (id: string) => void;
  onCancel: () => void;
}) {
  const colors = useTheme();
  const s = styles(colors);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={onCancel}>
        <TouchableOpacity activeOpacity={1} style={s.card} onPress={() => {}}>
          <Text style={s.title}>{title}</Text>
          <Text style={s.body}>{prompt}</Text>
          <ScrollView style={s.list} nestedScrollEnabled>
            {options.map(o => (
              <TouchableOpacity key={o.id} style={s.option} onPress={() => onSelect(o.id)}>
                <Text style={s.optionText}>{o.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <View style={s.actions}>
            <TouchableOpacity style={[s.btn, s.btnCancel]} onPress={onCancel}>
              <Text style={[s.btnText, { color: colors.textDim }]}>CANCEL</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

// Same look as RelayTargetModal.
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
  // growing the modal off-screen.
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

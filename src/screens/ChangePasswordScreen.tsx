import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Platform, Alert, ActivityIndicator,
  KeyboardAvoidingView, ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '../services/api';

const COLORS = {
  bg: '#0a0a0f',
  surface: '#12121a',
  border: '#1e1e2e',
  text: '#e2e8f0',
  textMuted: '#64748b',
  cyan: '#00d4ff',
  red: '#ef4444',
  green: '#22c55e',
};

export default function ChangePasswordScreen({ onDone }: { onDone: () => void }) {
  const insets = useSafeAreaInsets();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);

  const s = styles();

  const handleSubmit = async () => {
    if (!current || !next || !confirm) {
      Alert.alert('Error', 'All fields are required.');
      return;
    }
    if (next.length < 8) {
      Alert.alert('Error', 'New password must be at least 8 characters.');
      return;
    }
    if (next !== confirm) {
      Alert.alert('Error', 'New passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      await api.changePassword(current, next);
      Alert.alert('Success', 'Password updated successfully.', [
        { text: 'OK', onPress: onDone },
      ]);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to update password. Check your current password and try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + 12 }]}>
        <TouchableOpacity onPress={onDone} style={s.backBtn}>
          <Text style={s.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>CHANGE PASSWORD</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <View style={s.card}>
          <Text style={s.label}>CURRENT PASSWORD</Text>
          <TextInput
            style={s.input}
            value={current}
            onChangeText={setCurrent}
            secureTextEntry
            placeholder="Enter current password"
            placeholderTextColor={COLORS.textMuted}
            autoCapitalize="none"
          />

          <Text style={[s.label, { marginTop: 16 }]}>NEW PASSWORD</Text>
          <TextInput
            style={s.input}
            value={next}
            onChangeText={setNext}
            secureTextEntry
            placeholder="Min. 8 characters"
            placeholderTextColor={COLORS.textMuted}
            autoCapitalize="none"
          />

          <Text style={[s.label, { marginTop: 16 }]}>CONFIRM NEW PASSWORD</Text>
          <TextInput
            style={[
              s.input,
              confirm.length > 0 && next !== confirm && { borderColor: COLORS.red },
              confirm.length > 0 && next === confirm && next.length >= 8 && { borderColor: COLORS.green },
            ]}
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
            placeholder="Re-enter new password"
            placeholderTextColor={COLORS.textMuted}
            autoCapitalize="none"
          />
          {confirm.length > 0 && next !== confirm && (
            <Text style={s.errorText}>Passwords do not match</Text>
          )}
        </View>

        <TouchableOpacity
          style={[s.submitBtn, loading && { opacity: 0.6 }]}
          onPress={handleSubmit}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator color={COLORS.bg} />
            : <Text style={s.submitText}>UPDATE PASSWORD</Text>
          }
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = () => StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingBottom: 12, paddingHorizontal: 16,
    backgroundColor: COLORS.surface, borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  backBtn: { width: 60 },
  backText: { color: COLORS.cyan, fontSize: 14 },
  title: {
    color: COLORS.text, fontSize: 13, fontWeight: '700', letterSpacing: 3,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  body: { padding: 16, paddingBottom: 40, alignItems: 'center', maxWidth: 480, width: '100%', alignSelf: 'center' },
  card: {
    backgroundColor: COLORS.surface, borderRadius: 8,
    borderWidth: 1, borderColor: COLORS.border, padding: 16, marginBottom: 16,
    width: '100%', maxWidth: 480,
  },
  label: {
    color: COLORS.textMuted, fontSize: 10, letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    marginBottom: 6,
  },
  input: {
    backgroundColor: COLORS.bg, borderWidth: 1, borderColor: COLORS.border,
    borderRadius: 6, padding: 12, color: COLORS.text, fontSize: 14,
  },
  errorText: { color: COLORS.red, fontSize: 11, marginTop: 4 },
  submitBtn: {
    backgroundColor: COLORS.cyan, borderRadius: 8,
    padding: 16, alignItems: 'center',
    width: '100%', maxWidth: 480,
  },
  submitText: {
    color: COLORS.bg, fontWeight: '700', fontSize: 13, letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
});

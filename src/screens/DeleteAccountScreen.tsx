import React, { useRef, useState } from 'react';
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

const CONFIRM_WORD = 'DELETE';

// Apple Guideline 5.1.1(v): in-app, permanent account deletion with an
// explicit confirmation step. onDeleted runs the shared sign-out cleanup
// (authStore.logout) so a deleted user can't linger half-authenticated.
export default function DeleteAccountScreen({
  onCancel,
  onDeleted,
}: {
  onCancel: () => void;
  onDeleted: () => void | Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const [confirmText, setConfirmText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Synchronous in-flight latch. `loading` is async state, so two taps in the
  // same frame can both pass the `!loading` check before the re-render disables
  // the button — this ref closes that window so deleteAccount() fires once.
  const submittingRef = useRef(false);

  const s = styles();

  // Final button stays disabled until the user types DELETE exactly
  // (case-insensitive, trimmed) — the deliberate gesture that prevents
  // accidental deletion.
  const matched = confirmText.trim().toUpperCase() === CONFIRM_WORD;
  const canDelete = matched && !loading;

  const handleDelete = async () => {
    if (!canDelete || submittingRef.current) return;
    submittingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      await api.deleteAccount();
      // 200 — account is gone. Confirm, then run the shared sign-out path,
      // which clears the SecureStore token/user and flips the navigator back
      // to the Login stack.
      Alert.alert(
        'Account deleted',
        'Your account has been permanently deleted.',
        [{ text: 'OK', onPress: () => { void onDeleted(); } }],
      );
    } catch (err: any) {
      if (err?.status === 401) {
        // Token already expired/invalid — the session is dead, so a retry
        // can't succeed. Route them back to login via the shared logout
        // cleanup instead of offering "try again". Leave the latch set; the
        // alert's OK runs onDeleted, which unmounts this screen.
        Alert.alert(
          'Session expired',
          'Your session has expired. Please sign in again.',
          [{ text: 'OK', onPress: () => { void onDeleted(); } }],
        );
        return;
      }
      if (err?.status === 409) {
        // Last org admin or tax-exemption records. Show the backend's own
        // message and KEEP the user logged in.
        setError(err?.message || "Your account can't be deleted right now.");
      } else {
        // Network failure or 500 — generic message, stay logged in.
        setError("Couldn't delete account, please try again.");
      }
      // Failed — re-enable so the user can retry. (Success leaves the latch
      // set; the component unmounts on logout, so no reset is needed there.)
      setLoading(false);
      submittingRef.current = false;
    }
  };

  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[s.header, { paddingTop: insets.top + 12 }]}>
        <TouchableOpacity onPress={onCancel} style={s.backBtn} disabled={loading}>
          <Text style={s.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>DELETE ACCOUNT</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <View style={s.card}>
          <Text style={s.warnHeading}>⚠  PERMANENT ACTION</Text>
          <Text style={s.warnBody}>
            This will permanently delete your account. This cannot be undone.
          </Text>
          <Text style={s.warnSub}>
            Only your own account is removed — your organization and its data
            are not affected.
          </Text>

          <Text style={[s.label, { marginTop: 20 }]}>
            TYPE “{CONFIRM_WORD}” TO CONFIRM
          </Text>
          <TextInput
            style={[s.input, matched && { borderColor: COLORS.red }]}
            value={confirmText}
            onChangeText={(t) => { setConfirmText(t); if (error) setError(null); }}
            placeholder={CONFIRM_WORD}
            placeholderTextColor={COLORS.textMuted}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!loading}
          />

          {error ? <Text style={s.errorText}>{error}</Text> : null}
        </View>

        <TouchableOpacity
          style={[s.deleteBtn, !canDelete && { opacity: 0.4 }]}
          onPress={handleDelete}
          disabled={!canDelete}
        >
          {loading
            ? <ActivityIndicator color="#fff" />
            : <Text style={s.deleteText}>DELETE MY ACCOUNT</Text>
          }
        </TouchableOpacity>

        <TouchableOpacity style={s.cancelBtn} onPress={onCancel} disabled={loading}>
          <Text style={s.cancelText}>CANCEL</Text>
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
    borderWidth: 1, borderColor: COLORS.red, padding: 16, marginBottom: 16,
    width: '100%', maxWidth: 480,
  },
  warnHeading: {
    color: COLORS.red, fontSize: 12, fontWeight: '700', letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace', marginBottom: 10,
  },
  warnBody: { color: COLORS.text, fontSize: 14, lineHeight: 20, fontWeight: '600' },
  warnSub: { color: COLORS.textMuted, fontSize: 12, lineHeight: 18, marginTop: 8 },
  label: {
    color: COLORS.textMuted, fontSize: 10, letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace', marginBottom: 6,
  },
  input: {
    backgroundColor: COLORS.bg, borderWidth: 1, borderColor: COLORS.border,
    borderRadius: 6, padding: 12, color: COLORS.text, fontSize: 14, letterSpacing: 2,
  },
  errorText: { color: COLORS.red, fontSize: 12, marginTop: 10, lineHeight: 17 },
  deleteBtn: {
    backgroundColor: COLORS.red, borderRadius: 8,
    padding: 16, alignItems: 'center', width: '100%', maxWidth: 480,
  },
  deleteText: {
    color: '#fff', fontWeight: '700', fontSize: 13, letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  cancelBtn: { padding: 16, alignItems: 'center', marginTop: 4 },
  cancelText: {
    color: COLORS.textMuted, fontWeight: '700', fontSize: 12, letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
});

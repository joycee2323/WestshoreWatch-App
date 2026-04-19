import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform,
  ActivityIndicator, Alert,
} from 'react-native';
import { api } from '../services/api';
import { useTheme } from '../theme';

export default function ForgotPasswordScreen({ navigation }: any) {
  const colors = useTheme();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async () => {
    if (!email) {
      Alert.alert('Missing Email', 'Please enter your email address.');
      return;
    }
    setLoading(true);
    try {
      await api.forgotPassword(email.trim());
      setSubmitted(true);
    } catch (err: any) {
      // Always show the same generic message to avoid leaking which emails are registered
      setSubmitted(true);
    } finally {
      setLoading(false);
    }
  };

  const s = styles(colors);

  return (
    <KeyboardAvoidingView
      style={s.page}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={s.inner}>
        <View style={s.header}>
          <Text style={s.logo}>WESTSHORE WATCH</Text>
          <Text style={s.subtitle}>Reset Password</Text>
          <Text style={s.brand}>Westshore Drone Services</Text>
        </View>

        {submitted ? (
          <View style={s.form}>
            <Text style={s.successText}>
              If that email is registered, you'll receive a reset link shortly.
            </Text>
            <TouchableOpacity
              style={s.btn}
              onPress={() => navigation.navigate('Login')}
            >
              <Text style={s.btnText}>BACK TO SIGN IN</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={s.form}>
            <Text style={s.helper}>
              Enter the email associated with your account and we'll send you a link to reset your password.
            </Text>

            <Text style={s.label}>EMAIL</Text>
            <TextInput
              style={s.input}
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
            />

            <TouchableOpacity
              style={[s.btn, loading && s.btnDisabled]}
              onPress={handleSubmit}
              disabled={loading}
            >
              {loading
                ? <ActivityIndicator color="#000" />
                : <Text style={s.btnText}>SEND RESET LINK</Text>
              }
            </TouchableOpacity>

            <TouchableOpacity
              style={s.backLink}
              onPress={() => navigation.navigate('Login')}
            >
              <Text style={s.backText}>
                <Text style={s.backEmphasis}>← Back to sign in</Text>
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = (c: ReturnType<typeof useTheme>) => StyleSheet.create({
  page: { flex: 1, backgroundColor: c.bg },
  inner: { flex: 1, justifyContent: 'center', padding: 28 },
  header: { alignItems: 'center', marginBottom: 40 },
  logo: {
    fontSize: 28, fontWeight: '700', letterSpacing: 6,
    color: c.cyan, fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  subtitle: {
    fontSize: 12, color: c.textMuted, letterSpacing: 2, marginTop: 6,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  brand: {
    fontSize: 10, color: c.textDim, marginTop: 4,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  form: { gap: 8 },
  helper: {
    color: c.textDim, fontSize: 13, lineHeight: 18,
    marginBottom: 8,
  },
  label: {
    fontSize: 10, color: c.textMuted, letterSpacing: 2, marginBottom: 4, marginTop: 12,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  input: {
    backgroundColor: c.surface,
    borderWidth: 1, borderColor: c.border,
    borderRadius: 8, padding: 14,
    color: c.text, fontSize: 15,
  },
  btn: {
    backgroundColor: c.cyan, borderRadius: 8,
    padding: 16, alignItems: 'center', marginTop: 24,
  },
  btnDisabled: { opacity: 0.6 },
  btnText: {
    color: '#000', fontWeight: '700', fontSize: 13, letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  successText: {
    color: c.text, fontSize: 14, lineHeight: 20,
    textAlign: 'center', marginBottom: 8,
  },
  backLink: { marginTop: 24, alignItems: 'center' },
  backText: { color: c.textDim, fontSize: 13 },
  backEmphasis: { color: c.cyan, fontWeight: '600' },
});

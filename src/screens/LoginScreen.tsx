import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform,
  ActivityIndicator, Alert,
} from 'react-native';
import { useAuthStore } from '../store/authStore';
import { useTheme } from '../theme';

export default function LoginScreen({ navigation }: any) {
  const colors = useTheme();
  const login = useAuthStore(s => s.login);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!email || !password) return;
    setLoading(true);
    try {
      await login(email.trim(), password);
    } catch (err: any) {
      Alert.alert('Login Failed', err.message || 'Check your credentials');
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
        {/* Logo / wordmark */}
        <View style={s.header}>
          <Text style={s.logo}>AIRAWARE</Text>
          <Text style={s.subtitle}>Remote ID Operations</Text>
          <Text style={s.brand}>Westshore Drone Services</Text>
        </View>

        {/* Form */}
        <View style={s.form}>
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

          <Text style={s.label}>PASSWORD</Text>
          <TextInput
            style={s.input}
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={colors.textMuted}
            secureTextEntry
          />

          <TouchableOpacity
            style={[s.btn, loading && s.btnDisabled]}
            onPress={handleLogin}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color="#000" />
              : <Text style={s.btnText}>SIGN IN</Text>
            }
          </TouchableOpacity>

          <TouchableOpacity
            style={s.forgotLink}
            onPress={() => navigation.navigate('ForgotPassword')}
          >
            <Text style={s.forgotText}>Forgot password?</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={s.registerLink}
            onPress={() => navigation.navigate('Register')}
          >
            <Text style={s.registerText}>
              Don't have an account? <Text style={s.registerEmphasis}>Create account</Text>
            </Text>
          </TouchableOpacity>
        </View>

        {/* Guest mode */}
        <TouchableOpacity
          style={s.guestBtn}
          onPress={() => navigation.navigate('GuestScan')}
        >
          <Text style={s.guestText}>Continue without login →</Text>
          <Text style={s.guestSub}>Scan for nearby drones via Bluetooth</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = (c: ReturnType<typeof useTheme>) => StyleSheet.create({
  page: { flex: 1, backgroundColor: c.bg },
  inner: { flex: 1, justifyContent: 'center', padding: 28 },
  header: { alignItems: 'center', marginBottom: 48 },
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
  guestBtn: {
    marginTop: 36, alignItems: 'center',
    padding: 16, borderWidth: 1, borderColor: c.border,
    borderRadius: 8, borderStyle: 'dashed',
  },
  guestText: { color: c.textDim, fontSize: 13 },
  guestSub: { color: c.textMuted, fontSize: 11, marginTop: 4 },
  forgotLink: { marginTop: 14, alignItems: 'center' },
  forgotText: { color: c.cyan, fontSize: 13 },
  registerLink: { marginTop: 14, alignItems: 'center' },
  registerText: { color: c.textDim, fontSize: 13 },
  registerEmphasis: { color: c.cyan, fontWeight: '600' },
});

import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform,
  ActivityIndicator, Alert, ScrollView, Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../services/api';
import { useTheme } from '../theme';

const TERMS_URL = 'https://watch.westshoredrone.com/terms';

export default function RegisterScreen({ navigation }: any) {
  const colors = useTheme();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [organization, setOrganization] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleRegister = async () => {
    if (!name || !email || !organization || !password || !confirm) {
      Alert.alert('Missing Fields', 'Please complete all fields.');
      return;
    }
    if (password !== confirm) {
      Alert.alert('Password Mismatch', 'Passwords do not match.');
      return;
    }
    if (password.length < 8) {
      Alert.alert('Weak Password', 'Password must be at least 8 characters.');
      return;
    }
    if (!acceptedTerms) {
      Alert.alert('Terms Required', 'You must accept the Terms of Service to continue.');
      return;
    }
    setLoading(true);
    try {
      await api.register({
        name: name.trim(),
        email: email.trim(),
        org_name: organization.trim(),
        password,
      });
      Alert.alert(
        'Check Your Email',
        'Your account has been created. Please check your email to verify your account before signing in.',
        [{ text: 'OK', onPress: () => navigation.navigate('Login') }],
      );
    } catch (err: any) {
      Alert.alert('Registration Failed', err.message || 'Could not create account');
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
      <ScrollView contentContainerStyle={s.inner} keyboardShouldPersistTaps="handled">
        <View style={s.header}>
          <Text style={s.logo}>WESTSHORE WATCH</Text>
          <Text style={s.subtitle}>Create Account</Text>
          <Text style={s.brand}>Westshore Drone Services</Text>
        </View>

        <View style={s.form}>
          <Text style={s.label}>FULL NAME</Text>
          <TextInput
            style={s.input}
            value={name}
            onChangeText={setName}
            placeholder="Jane Doe"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="words"
            autoComplete="name"
          />

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

          <Text style={s.label}>ORGANIZATION NAME</Text>
          <TextInput
            style={s.input}
            value={organization}
            onChangeText={setOrganization}
            placeholder="Acme Drone Co."
            placeholderTextColor={colors.textMuted}
            autoCapitalize="words"
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

          <Text style={s.label}>CONFIRM PASSWORD</Text>
          <TextInput
            style={s.input}
            value={confirm}
            onChangeText={setConfirm}
            placeholder="••••••••"
            placeholderTextColor={colors.textMuted}
            secureTextEntry
          />

          <TouchableOpacity
            style={s.termsRow}
            onPress={() => setAcceptedTerms(v => !v)}
            activeOpacity={0.7}
          >
            <View style={[s.checkbox, acceptedTerms && s.checkboxChecked]}>
              {acceptedTerms && (
                <Ionicons name="checkmark" size={16} color="#000" />
              )}
            </View>
            <Text style={s.termsText}>
              I agree to the{' '}
              <Text
                style={s.termsLink}
                onPress={() => Linking.openURL(TERMS_URL)}
              >
                Terms of Service
              </Text>
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[s.btn, loading && s.btnDisabled]}
            onPress={handleRegister}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color="#000" />
              : <Text style={s.btnText}>CREATE ACCOUNT</Text>
            }
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={s.signInLink}
          onPress={() => navigation.navigate('Login')}
        >
          <Text style={s.signInText}>
            Already have an account? <Text style={s.signInEmphasis}>Sign in</Text>
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = (c: ReturnType<typeof useTheme>) => StyleSheet.create({
  page: { flex: 1, backgroundColor: c.bg },
  inner: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 28, maxWidth: 480, width: '100%', alignSelf: 'center' },
  header: { alignItems: 'center', marginBottom: 32 },
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
  form: { gap: 8, width: '100%', maxWidth: 480 },
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
  termsRow: {
    flexDirection: 'row', alignItems: 'center',
    marginTop: 20, gap: 10,
  },
  checkbox: {
    width: 22, height: 22, borderRadius: 4,
    borderWidth: 1, borderColor: c.border,
    backgroundColor: c.surface,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: c.cyan, borderColor: c.cyan,
  },
  termsText: { color: c.textDim, fontSize: 13, flex: 1 },
  termsLink: { color: c.cyan, textDecorationLine: 'underline' },
  btn: {
    backgroundColor: c.cyan, borderRadius: 8,
    padding: 16, alignItems: 'center', marginTop: 24,
  },
  btnDisabled: { opacity: 0.6 },
  btnText: {
    color: '#000', fontWeight: '700', fontSize: 13, letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  signInLink: { marginTop: 28, alignItems: 'center' },
  signInText: { color: c.textDim, fontSize: 13 },
  signInEmphasis: { color: c.cyan, fontWeight: '600' },
});

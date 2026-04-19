import React from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, RefreshControl, Platform, Linking, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { useAuthStore } from '../store/authStore';

const X1_URL = 'https://westshoredrone.com/watch-x1/';
const M1_URL = 'https://westshoredrone.com/watch-m1/';
const DASHBOARD_URL = 'https://watch.westshoredrone.com/nodes';

interface Props {
  onRefresh: () => void;
  refreshing: boolean;
}

export default function OnboardingScreen({ onRefresh, refreshing }: Props) {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const logout = useAuthStore(st => st.logout);
  const s = styles(colors);

  const handleSignOut = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: () => { logout(); } },
    ]);
  };

  return (
    <View style={s.page}>
      <TouchableOpacity
        style={[s.signOutBtn, { top: insets.top + 12 }]}
        onPress={handleSignOut}
        activeOpacity={0.6}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Text style={s.signOutText}>SIGN OUT</Text>
      </TouchableOpacity>

      <ScrollView
        contentContainerStyle={s.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.cyan} />
        }
      >
      <View style={s.header}>
        <Text style={s.logo}>WESTSHORE WATCH</Text>
        <Text style={s.subtitle}>Remote ID Operations</Text>
      </View>

      <View style={s.body}>
        <Text style={s.heading}>NO NODES REGISTERED</Text>
        <Text style={s.description}>
          Westshore Watch needs at least one X1 node to start detecting drones in your area.
          Each node is a dedicated BLE/Wi-Fi sensor that relays Remote ID broadcasts
          to your dashboard in real time.
        </Text>

        <Text style={s.chooseLabel}>Choose your Westshore Watch node:</Text>

        <TouchableOpacity
          style={s.primaryBtn}
          onPress={() => Linking.openURL(X1_URL)}
          activeOpacity={0.8}
        >
          <Text style={s.primaryBtnText}>GET WESTSHORE WATCH X1</Text>
          <Text style={s.primaryBtnPrice}>$799</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={s.secondaryBtn}
          onPress={() => Linking.openURL(M1_URL)}
          activeOpacity={0.8}
        >
          <Text style={s.secondaryBtnText}>GET WESTSHORE WATCH M1</Text>
          <Text style={s.secondaryBtnPrice}>$399</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={s.secondaryLink}
          onPress={() => Linking.openURL(DASHBOARD_URL)}
          activeOpacity={0.6}
        >
          <Text style={s.secondaryText}>I already have a node →</Text>
          <Text style={s.secondarySub}>Register it at watch.westshoredrone.com/nodes</Text>
        </TouchableOpacity>
      </View>

      <Text style={s.hint}>Pull down to refresh after registering a node</Text>
      </ScrollView>
    </View>
  );
}

const styles = (c: ReturnType<typeof useTheme>) => StyleSheet.create({
  page: { flex: 1, backgroundColor: c.bg },
  content: { flexGrow: 1, padding: 28, justifyContent: 'center' },
  header: { alignItems: 'center', marginBottom: 48 },
  logo: {
    fontSize: 28, fontWeight: '700', letterSpacing: 6,
    color: c.cyan,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  subtitle: {
    fontSize: 12, color: c.textMuted, letterSpacing: 2, marginTop: 6,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  body: {
    backgroundColor: c.surface,
    borderWidth: 1, borderColor: c.border,
    borderRadius: 12, padding: 24,
  },
  heading: {
    color: c.text, fontSize: 16, fontWeight: '700', letterSpacing: 3,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    textAlign: 'center', marginBottom: 16,
  },
  description: {
    color: c.textDim, fontSize: 13, lineHeight: 20,
    textAlign: 'center', marginBottom: 28,
  },
  chooseLabel: {
    color: c.textMuted, fontSize: 11, letterSpacing: 2, marginBottom: 12,
    textAlign: 'center',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  primaryBtn: {
    backgroundColor: c.cyan, borderRadius: 8,
    paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center',
    flexDirection: 'row', justifyContent: 'space-between',
  },
  primaryBtnText: {
    color: '#000', fontWeight: '700', fontSize: 13, letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  primaryBtnPrice: {
    color: '#000', fontWeight: '700', fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  secondaryBtn: {
    marginTop: 10, borderRadius: 8,
    paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center',
    flexDirection: 'row', justifyContent: 'space-between',
    borderWidth: 1, borderColor: c.cyan,
    backgroundColor: 'rgba(0,212,255,0.08)',
  },
  secondaryBtnText: {
    color: c.cyan, fontWeight: '700', fontSize: 13, letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  secondaryBtnPrice: {
    color: c.cyan, fontWeight: '700', fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  secondaryLink: {
    marginTop: 20, alignItems: 'center',
    paddingVertical: 10,
  },
  secondaryText: { color: c.cyan, fontSize: 13, fontWeight: '600' },
  secondarySub: { color: c.textMuted, fontSize: 11, marginTop: 4 },
  hint: {
    color: c.textMuted, fontSize: 10, letterSpacing: 1,
    textAlign: 'center', marginTop: 32,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  signOutBtn: {
    position: 'absolute', right: 20, zIndex: 10,
    paddingHorizontal: 12, paddingVertical: 6,
    borderWidth: 1, borderColor: c.border, borderRadius: 6,
    backgroundColor: c.surface,
  },
  signOutText: {
    color: c.textDim, fontSize: 10, letterSpacing: 2, fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
});

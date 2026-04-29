import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Alert, Platform, ActivityIndicator,
} from 'react-native';
import { useAuthStore } from '../store/authStore';
import BillingScreen from './BillingScreen';
import { Linking } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Location from 'expo-location';
import { useFocusEffect } from '@react-navigation/native';
import ChangePasswordScreen from './ChangePasswordScreen';
import { api } from '../services/api';
import { useTheme } from '../theme';
import { caps } from '../lib/caps';

// Hardcoded fallback if /api/docs/manual-url is unreachable. Kept in sync
// with the backend route (src/routes/docs.js) — both must point at the
// same canonical URL.
const MANUAL_URL_FALLBACK = 'https://api.westshoredrone.com/docs/westshore-watch-instruction-manual.pdf';

type BgScanState = 'granted' | 'foreground_only' | 'denied';

export default function SettingsScreen() {
  const colors = useTheme();
  const { user, logout } = useAuthStore();
  const [billing, setBilling] = useState<any>(null);
  const [showBilling, setShowBilling] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [manualUrl, setManualUrl] = useState<string>(MANUAL_URL_FALLBACK);
  const [bgScanState, setBgScanState] = useState<BgScanState | null>(null);

  // Recompute background-scan permission state. Called on mount AND on focus
  // so that returning from system Settings (where the user may have toggled
  // the permission) refreshes the row.
  const refreshBgScanState = useCallback(async () => {
    if (Platform.OS !== 'android') {
      setBgScanState('granted');
      return;
    }
    try {
      const fg = await Location.getForegroundPermissionsAsync();
      const bg = await Location.getBackgroundPermissionsAsync();
      if (bg.status === 'granted') setBgScanState('granted');
      else if (fg.status === 'granted') setBgScanState('foreground_only');
      else setBgScanState('denied');
    } catch (err) {
      console.warn('[settings] bg perm check failed:', err);
      setBgScanState('denied');
    }
  }, []);

  useEffect(() => {
    api.getManualUrl()
      .then((res: any) => {
        if (res?.url && typeof res.url === 'string') setManualUrl(res.url);
      })
      .catch((err: any) => {
        console.warn('[settings] manual url fetch failed, using fallback:', err);
      });
  }, []);

  useEffect(() => { void refreshBgScanState(); }, [refreshBgScanState]);
  useFocusEffect(useCallback(() => { void refreshBgScanState(); }, [refreshBgScanState]));

  const handleOpenManual = useCallback(() => {
    Linking.openURL(manualUrl).catch(err => {
      console.warn('[settings] failed to open manual:', err);
      Alert.alert('Could not open manual', 'Please try again or visit watch.westshoredrone.com.');
    });
  }, [manualUrl]);

  const handleBgScanPress = useCallback(async () => {
    if (bgScanState === 'granted') return;
    try {
      const fg = await Location.getForegroundPermissionsAsync();
      if (fg.status !== 'granted') {
        // Foreground location was never granted — Android requires staged
        // approval (foreground first, then background). Send the user to
        // settings rather than firing two prompts in a row.
        Linking.openSettings();
        return;
      }
      const res = await Location.requestBackgroundPermissionsAsync();
      if (res.status === 'granted') {
        await refreshBgScanState();
        return;
      }
      // Denied (or permanently denied — Android may resolve immediately
      // without UI). Settings is the only way to flip it after that point.
      Linking.openSettings();
    } catch (err) {
      console.warn('[settings] bg permission request failed:', err);
      Linking.openSettings();
    }
  }, [bgScanState, refreshBgScanState]);

  const handleAdminPanel = async () => {
    const token = await SecureStore.getItemAsync('auth_token');
    const base = isSuperAdmin
      ? 'https://watch.westshoredrone.com/admin'
      : 'https://watch.westshoredrone.com/org';
    const url = token ? `${base}?app_token=${token}&_t=${Date.now()}` : base;
    Linking.openURL(url);
  };

  useEffect(() => {
    api.getBillingStatus().then(setBilling).catch(console.warn).finally(() => setLoading(false));
  }, []);

  const handleLogout = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: logout },
    ]);
  };

  const isSuperAdmin = billing?.is_super_admin || user?.role === 'super_admin';
  const isOrgAdmin = user?.role === 'org_admin';
  const canBilling = isOrgAdmin && !isSuperAdmin;
  const c = caps(user);

  const s = styles(colors);

  if (showBilling) {
    return <BillingScreen onDone={() => {
      setShowBilling(false);
      api.getBillingStatus().then(setBilling).catch(console.warn);
    }} />;
  }

  if (showChangePassword) {
    return <ChangePasswordScreen onDone={() => setShowChangePassword(false)} />;
  }

  return (
    <ScrollView style={s.page} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <Text style={s.title}>ACCOUNT</Text>

      {/* User info */}
      <View style={s.card}>
        <Text style={s.cardHeader}>SIGNED IN AS</Text>
        <Text style={s.value}>{user?.email}</Text>
        <Text style={s.sub}>{user?.name || ''}</Text>
        <View style={s.roleBadge}>
          <Text style={s.roleText}>{user?.role?.toUpperCase() || 'USER'}</Text>
        </View>
      </View>

      {/* Billing — admins only (backend 403s viewers/operators on /billing/status) */}
      {c.canViewBilling && (
      <View style={s.card}>
        <Text style={s.cardHeader}>SUBSCRIPTION</Text>
        {loading ? (
          <ActivityIndicator color={colors.cyan} style={{ marginTop: 8 }} />
        ) : billing ? (
          <>
            {isSuperAdmin ? (
              <Text style={[s.value, { color: colors.cyan }]}>SUPER ADMIN — UNLIMITED</Text>
            ) : billing.subscription?.status === 'active' ? (
              <>
                <Text style={[s.value, { color: colors.green }]}>
                  {billing.subscription.plan.toUpperCase()} PLAN — ACTIVE
                </Text>
                <Text style={s.sub}>
                  Renews {new Date(billing.subscription.current_period_end).toLocaleDateString()}
                </Text>
              </>
            ) : (
              <>
                <Text style={[s.value, { color: colors.amber }]}>
                  {billing.credit_balance} CREDIT{billing.credit_balance !== 1 ? 'S' : ''} REMAINING
                </Text>
                <Text style={s.sub}>Each deployment or extension costs 1 credit ($50)</Text>
              </>
            )}
          </>
        ) : (
          <Text style={s.sub}>Failed to load billing info</Text>
        )}
      </View>
      )}

      {/* Upgrade — org_admin only */}
      {canBilling && (
        <TouchableOpacity style={s.upgradeBtn} onPress={() => setShowBilling(true)}>
          <Text style={s.upgradeBtnText}>⚡ UPGRADE / BUY CREDITS</Text>
        </TouchableOpacity>
      )}

      {/* Admin panel — super_admin or org_admin */}
      {(isSuperAdmin || isOrgAdmin) && (
        <TouchableOpacity style={s.adminBtn} onPress={handleAdminPanel}>
          <Text style={s.adminBtnText}>
            {isSuperAdmin ? '🛡  SUPER ADMIN PANEL' : '⚙  MANAGE ORGANIZATION'}
          </Text>
        </TouchableOpacity>
      )}

      {/* App info */}
      <View style={s.card}>
        <Text style={s.cardHeader}>APP INFO</Text>
        <Row label="VERSION" value="1.0.0" colors={colors} />
        <Row label="BACKEND" value="watch.westshoredrone.com" colors={colors} />
        <Row label="BLE SCANNING" value="Active" colors={colors} />
      </View>

      {/* Change Password — all users */}
      <TouchableOpacity style={s.changePasswordBtn} onPress={() => setShowChangePassword(true)}>
        <Text style={s.changePasswordText}>🔑  CHANGE PASSWORD</Text>
      </TouchableOpacity>

      {/* User Manual + Background Scanning — placed above sign out so
          first-install users who declined the bg-location prompt have
          a discoverable way back. */}
      <View style={s.rowCard}>
        <SettingRow
          colors={colors}
          label="User Manual"
          subtitle="View the full instruction manual"
          right={<Text style={s.chevron}>›</Text>}
          onPress={handleOpenManual}
          isLast={false}
        />
        <SettingRow
          colors={colors}
          label="Background Scanning"
          subtitle={
            bgScanState === 'granted'
              ? 'Always allowed'
              : bgScanState === 'foreground_only'
                ? 'Limited — tap to enable continuous scanning'
                : bgScanState === 'denied'
                  ? 'Disabled — tap to enable'
                  : '…'
          }
          right={
            bgScanState === 'granted'
              ? <Text style={s.checkmark}>✓</Text>
              : <Text style={s.chevron}>›</Text>
          }
          onPress={handleBgScanPress}
          isLast={true}
        />
      </View>

      {/* Sign out */}
      <TouchableOpacity style={s.logoutBtn} onPress={handleLogout}>
        <Text style={s.logoutText}>SIGN OUT</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function Row({ label, value, colors }: any) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <Text style={{ color: colors.textMuted, fontSize: 10, letterSpacing: 1, fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace' }}>{label}</Text>
      <Text style={{ color: colors.textDim, fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace' }}>{value}</Text>
    </View>
  );
}

function SettingRow({
  colors, label, subtitle, right, onPress, isLast,
}: {
  colors: ReturnType<typeof useTheme>;
  label: string;
  subtitle?: string;
  right?: React.ReactNode;
  onPress: () => void;
  isLast: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: colors.border,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{
          color: colors.text, fontSize: 13, fontWeight: '600',
          fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
        }}>{label}</Text>
        {subtitle ? (
          <Text style={{
            color: colors.textMuted, fontSize: 11, marginTop: 3,
            fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
          }}>{subtitle}</Text>
        ) : null}
      </View>
      {right ? <View style={{ marginLeft: 12 }}>{right}</View> : null}
    </TouchableOpacity>
  );
}

const styles = (c: ReturnType<typeof useTheme>) => StyleSheet.create({
  page: { flex: 1, backgroundColor: c.bg },
  title: {
    color: c.text, fontSize: 18, fontWeight: '700', letterSpacing: 4,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace', marginBottom: 16,
  },
  card: {
    backgroundColor: c.surface, borderRadius: 12,
    borderWidth: 1, borderColor: c.border, padding: 16, marginBottom: 12,
  },
  cardHeader: {
    color: c.textMuted, fontSize: 9, letterSpacing: 2, marginBottom: 10,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  value: {
    color: c.text, fontSize: 14, fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  sub: { color: c.textMuted, fontSize: 11, marginTop: 4 },
  roleBadge: {
    marginTop: 10, backgroundColor: 'rgba(0,212,255,0.1)',
    borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4,
    alignSelf: 'flex-start', borderWidth: 1, borderColor: 'rgba(0,212,255,0.2)',
  },
  roleText: {
    color: c.cyan, fontSize: 9, letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  upgradeBtn: {
    marginBottom: 12, borderWidth: 1, borderColor: 'rgba(0,212,255,0.4)',
    borderRadius: 10, padding: 16, alignItems: 'center',
    backgroundColor: 'rgba(0,212,255,0.08)',
  },
  upgradeBtnText: {
    color: '#00d4ff', fontSize: 13, fontWeight: '700', letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  adminBtn: {
    marginBottom: 12, borderWidth: 1, borderColor: 'rgba(168,85,247,0.4)',
    borderRadius: 10, padding: 16, alignItems: 'center',
    backgroundColor: 'rgba(168,85,247,0.08)',
  },
  adminBtnText: {
    color: '#a855f7', fontSize: 13, fontWeight: '700', letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  changePasswordBtn: {
    backgroundColor: 'transparent', borderWidth: 1, borderColor: c.cyan,
    borderRadius: 8, padding: 16, alignItems: 'center', marginBottom: 12,
  },
  rowCard: {
    backgroundColor: c.surface, borderRadius: 12,
    borderWidth: 1, borderColor: c.border,
    marginBottom: 12, overflow: 'hidden',
  },
  chevron: {
    color: c.textMuted, fontSize: 22, fontWeight: '400',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  checkmark: {
    color: c.green, fontSize: 18, fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  changePasswordText: {
    color: c.cyan, fontWeight: '700', fontSize: 13, letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  logoutBtn: {
    marginTop: 8, borderWidth: 1, borderColor: c.red,
    borderRadius: 10, padding: 16, alignItems: 'center',
    backgroundColor: 'rgba(239,68,68,0.08)',
  },
  logoutText: {
    color: c.red, fontSize: 13, fontWeight: '700', letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
});

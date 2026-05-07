import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Alert, Platform, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useAuthStore } from '../store/authStore';
import BillingScreen from './BillingScreen';
import { Linking } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import ChangePasswordScreen from './ChangePasswordScreen';
import { api } from '../services/api';
import { useTheme } from '../theme';
import { caps } from '../lib/caps';
import { useNotificationsStore } from '../store/notificationsStore';
import { getLastRegistrationStatus, registerForPushNotifications } from '../services/pushNotifications';

// Hardcoded fallback if /api/docs/manual-url is unreachable. Kept in sync
// with the backend route (src/routes/docs.js) — both must point at the
// same canonical URL.
const MANUAL_URL_FALLBACK = 'https://api.westshoredrone.com/docs/westshore-watch-instruction-manual.pdf';

export default function SettingsScreen() {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const { user, logout } = useAuthStore();
  const [billing, setBilling] = useState<any>(null);
  const [showBilling, setShowBilling] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [manualUrl, setManualUrl] = useState<string>(MANUAL_URL_FALLBACK);
  const unreadCount = useNotificationsStore(s => s.unreadCount);
  const refreshUnreadCount = useNotificationsStore(s => s.refreshUnreadCount);

  // Refresh the unread badge whenever the user lands on Settings —
  // matches the spec ("unread count should refresh on a focus listener").
  useFocusEffect(useCallback(() => {
    void refreshUnreadCount();
  }, [refreshUnreadCount]));

  const handleShowPushDiagnostic = useCallback(async () => {
    const status = await getLastRegistrationStatus();
    if (!status) {
      Alert.alert(
        'Push diagnostic',
        'No registration attempt has been recorded yet on this device. Triggering one now — try again in a few seconds.',
        [
          { text: 'OK' },
          { text: 'Retry now', onPress: () => { void registerForPushNotifications(); } },
        ],
      );
      return;
    }
    const lines: string[] = [];
    lines.push(`When: ${status.timestamp}`);
    lines.push(`Step: ${status.step}`);
    lines.push(`Success: ${status.success ? 'yes' : 'no'}`);
    if (status.token) lines.push(`Token: ${status.token.slice(0, 28)}...`);
    if (status.error) lines.push(`Error: ${status.error}`);
    Alert.alert(
      'Push diagnostic',
      lines.join('\n'),
      [
        { text: 'OK' },
        { text: 'Retry registration', onPress: () => { void registerForPushNotifications(); } },
      ],
    );
  }, []);

  const handleSendTest = useCallback(async () => {
    try {
      const res = await api.sendTestNotification();
      const sent = res?.result?.sent;
      const reason = res?.result?.reason;
      if (sent) {
        Alert.alert('Test sent', 'Check your notification shade.');
      } else {
        Alert.alert('Test not delivered', reason === 'pref_off'
          ? 'The "drone_detected" preference is off — turn it back on in Notification Preferences and retry.'
          : `Reason: ${reason || 'unknown'}`);
      }
    } catch (err: any) {
      Alert.alert('Test failed', err?.message || 'Could not send test notification.');
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

  const handleOpenManual = useCallback(() => {
    Linking.openURL(manualUrl).catch(err => {
      console.warn('[settings] failed to open manual:', err);
      Alert.alert('Could not open manual', 'Please try again or visit watch.westshoredrone.com.');
    });
  }, [manualUrl]);

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
    <ScrollView
      style={s.page}
      contentContainerStyle={{
        padding: 16,
        paddingTop: 16 + (insets.top || 0),
        paddingBottom: 40,
      }}
    >
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

      {/* Notifications */}
      <View style={s.rowCard}>
        <SettingRow
          colors={colors}
          label="Notifications"
          subtitle={unreadCount > 0
            ? `${unreadCount} unread`
            : 'View your notification feed'}
          right={
            unreadCount > 0 ? (
              <View style={s.badge}>
                <Text style={s.badgeText}>{unreadCount > 99 ? '99+' : String(unreadCount)}</Text>
              </View>
            ) : (
              <Text style={s.chevron}>›</Text>
            )
          }
          onPress={() => navigation.navigate('Notifications')}
          isLast={false}
        />
        <SettingRow
          colors={colors}
          label="Notification preferences"
          subtitle="Toggle which alerts you receive"
          right={<Text style={s.chevron}>›</Text>}
          onPress={() => navigation.navigate('NotificationPreferences')}
          isLast={false}
        />
        <SettingRow
          colors={colors}
          label="Send test notification"
          subtitle="Verify push delivery on this device"
          right={<Text style={s.chevron}>›</Text>}
          onPress={handleSendTest}
          isLast={!__DEV__}
        />
        {/* Debug-only — visible in dev builds only. Surfaces the last
            registration outcome so we don't need adb logcat. The
            handler + getLastRegistrationStatus stay in the file but
            unused in production; the bundler tree-shakes the JSX. */}
        {__DEV__ && (
          <SettingRow
            colors={colors}
            label="Push diagnostic"
            subtitle="Debug: last registration outcome"
            onPress={handleShowPushDiagnostic}
            isLast={true}
          />
        )}
      </View>

      {/* Change Password — all users */}
      <TouchableOpacity style={s.changePasswordBtn} onPress={() => setShowChangePassword(true)}>
        <Text style={s.changePasswordText}>🔑  CHANGE PASSWORD</Text>
      </TouchableOpacity>

      {/* User Manual */}
      <View style={s.rowCard}>
        <SettingRow
          colors={colors}
          label="User Manual"
          subtitle="View the full instruction manual"
          right={<Text style={s.chevron}>›</Text>}
          onPress={handleOpenManual}
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
  badge: {
    backgroundColor: c.cyan, borderRadius: 10,
    minWidth: 22, paddingHorizontal: 6, paddingVertical: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  badgeText: {
    color: c.bg, fontSize: 11, fontWeight: '700', letterSpacing: 0.5,
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

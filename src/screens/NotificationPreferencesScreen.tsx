import React, { useCallback, useEffect, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Switch, TouchableOpacity, Platform, ActivityIndicator,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme';
import { useNotificationsStore } from '../store/notificationsStore';

interface PrefSection {
  heading: string;
  rows: Array<{ kind: string; label: string }>;
}

const SECTIONS: PrefSection[] = [
  {
    heading: 'DRONES',
    rows: [
      { kind: 'drone_detected', label: 'New drone detected' },
    ],
  },
  {
    heading: 'DEPLOYMENTS',
    rows: [
      { kind: 'deployment_paused', label: 'Deployment paused' },
      { kind: 'deployment_resumed', label: 'Deployment resumed' },
      { kind: 'deployment_cancelled', label: 'Deployment cancelled' },
      { kind: 'deployment_expired', label: 'Deployment expired' },
    ],
  },
  {
    heading: 'NODES',
    rows: [
      { kind: 'node_online', label: 'Node back online' },
      { kind: 'node_offline', label: 'Node offline' },
    ],
  },
  {
    heading: 'BILLING',
    rows: [
      { kind: 'billing_subscription_expiring', label: 'Subscription expiring soon' },
      { kind: 'billing_payment_failed', label: 'Payment failed' },
      { kind: 'billing_subscription_cancelled', label: 'Subscription cancelled' },
    ],
  },
];

export default function NotificationPreferencesScreen() {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const s = useMemo(() => styles(colors), [colors]);

  const preferences = useNotificationsStore(st => st.preferences);
  const preferencesLoaded = useNotificationsStore(st => st.preferencesLoaded);
  const loadPreferences = useNotificationsStore(st => st.loadPreferences);
  const setPreference = useNotificationsStore(st => st.setPreference);

  useEffect(() => {
    void loadPreferences();
  }, [loadPreferences]);

  const onToggle = useCallback((kind: string, value: boolean) => {
    void setPreference(kind, value);
  }, [setPreference]);

  const headerHeight = (insets.top || 0) + 16;

  return (
    <View style={[s.page, { paddingTop: headerHeight }]}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>NOTIFICATION PREFERENCES</Text>
        <View style={s.spacer} />
      </View>

      {!preferencesLoaded ? (
        <View style={s.loading}>
          <ActivityIndicator color={colors.cyan} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
          {SECTIONS.map(section => (
            <View key={section.heading} style={s.section}>
              <Text style={s.sectionHeader}>{section.heading}</Text>
              {section.rows.map((row, idx) => {
                // Backend defaults missing kinds to TRUE; mirror that here.
                const enabled = preferences[row.kind] !== false;
                return (
                  <View
                    key={row.kind}
                    style={[
                      s.row,
                      idx === section.rows.length - 1 ? null : s.rowBorder,
                    ]}
                  >
                    <Text style={s.rowLabel}>{row.label}</Text>
                    <Switch
                      value={enabled}
                      onValueChange={v => onToggle(row.kind, v)}
                      trackColor={{ false: colors.border2, true: colors.cyan }}
                      thumbColor={Platform.OS === 'android' ? colors.surface : undefined}
                    />
                  </View>
                );
              })}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = (c: ReturnType<typeof useTheme>) => StyleSheet.create({
  page: { flex: 1, backgroundColor: c.bg },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: c.border,
  },
  backBtn: { paddingRight: 12 },
  headerTitle: {
    flex: 1, color: c.text, fontSize: 12, fontWeight: '700', letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  spacer: { width: 22 },
  loading: { paddingVertical: 60, alignItems: 'center' },
  section: {
    backgroundColor: c.surface,
    borderRadius: 12,
    borderWidth: 1, borderColor: c.border,
    marginBottom: 16,
    overflow: 'hidden',
  },
  sectionHeader: {
    color: c.textMuted, fontSize: 9, letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14,
  },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: c.border },
  rowLabel: { flex: 1, color: c.text, fontSize: 13 },
});

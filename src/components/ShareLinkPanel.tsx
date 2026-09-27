import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Switch, Alert, Share, Platform, ActivityIndicator,
} from 'react-native';
import { api } from '../services/api';
import { useTheme } from '../theme';

// Public live-view link for one deployment (backend /api/share-links; same
// feature as the dashboard's ShareLinkPanel). Rendered on the org's OWN
// deployment cards in DeploymentsScreen. Anyone in the org sees the active
// link and can stop sharing it; generating one is operator+ (`canCreate`).
//
// JavaScript-only on purpose (RN core Share, no native module) so the feature
// ships as an OTA update to existing installs.

type Props = {
  deploymentId: string;
  canCreate: boolean;
  // Bumped by DeploymentsScreen on every screen load (focus, pull-to-refresh,
  // after actions) so the panel re-fetches alongside the rest of the screen,
  // e.g. to pick up a link stopped from the web dashboard.
  reloadKey?: number;
};

export default function ShareLinkPanel({ deploymentId, canCreate, reloadKey }: Props) {
  const colors = useTheme();
  const s = styles(colors);
  const [link, setLink] = useState<any | null | undefined>(undefined); // undefined = not loaded yet
  const [includeOperator, setIncludeOperator] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.getShareLink(deploymentId);
      setLink(res?.link ?? null);
    } catch {
      // Hide the panel rather than erroring the whole card.
      setLink(null);
    }
  }, [deploymentId]);

  useEffect(() => { load(); }, [load, reloadKey]);

  const handleGenerate = async () => {
    setBusy(true);
    try {
      await api.createShareLink(deploymentId, includeOperator);
      await load();
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleShare = async () => {
    try {
      await Share.share({ message: link.url });
    } catch (err: any) {
      Alert.alert('Error', err.message);
    }
  };

  const handleStopSharing = () => {
    Alert.alert(
      'Stop Sharing',
      'Everyone with this link loses access immediately, including anyone watching right now. You can generate a new link afterwards.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Stop Sharing', style: 'destructive', onPress: async () => {
          try { await api.revokeShareLink(link.id); await load(); }
          catch (err: any) { Alert.alert('Error', err.message); }
        }},
      ],
    );
  };

  if (link === undefined) return null;
  if (!link && !canCreate) return null;

  return (
    <View style={s.box}>
      <Text style={s.label}>PUBLIC LIVE LINK</Text>
      {!link ? (
        <>
          <Text style={s.help}>
            Anyone with the link can watch live drone positions and the last 5 minutes of flight paths — no login.
          </Text>
          <View style={s.toggleRow}>
            <Text style={s.toggleLabel}>Include operator location</Text>
            <Switch
              value={includeOperator}
              onValueChange={setIncludeOperator}
              trackColor={{ false: colors.border2, true: colors.cyan }}
              thumbColor={Platform.OS === 'android' ? colors.surface : undefined}
              accessibilityLabel="Include operator location"
            />
          </View>
          <TouchableOpacity
            style={[s.btn, s.cyanBtn, busy && s.btnDisabled]}
            onPress={handleGenerate}
            disabled={busy}
          >
            {busy
              ? <ActivityIndicator size="small" color={colors.cyan} />
              : <Text style={[s.btnText, { color: colors.cyan }]}>GENERATE LINK</Text>}
          </TouchableOpacity>
        </>
      ) : (
        <>
          <Text style={s.url} selectable numberOfLines={1} ellipsizeMode="middle">{link.url}</Text>
          <View style={s.btnRow}>
            <TouchableOpacity style={[s.btn, s.cyanBtn]} onPress={handleShare}>
              <Text style={[s.btnText, { color: colors.cyan }]}>SHARE</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.btn, s.amberOutlineBtn]} onPress={handleStopSharing}>
              <Text style={[s.btnText, { color: colors.amber }]}>STOP SHARING</Text>
            </TouchableOpacity>
          </View>
          <Text style={s.help}>
            Operator location {link.include_operator_location ? 'is' : 'is not'} shown.
          </Text>
        </>
      )}
    </View>
  );
}

const mono = Platform.OS === 'ios' ? 'Courier New' : 'monospace';

const styles = (c: ReturnType<typeof useTheme>) => StyleSheet.create({
  box: {
    borderWidth: 1, borderColor: c.border, borderRadius: 8,
    padding: 10, marginBottom: 12, gap: 8,
  },
  label: { color: c.textMuted, fontSize: 9, letterSpacing: 1.5, fontFamily: mono },
  help: { color: c.textDim, fontSize: 11, lineHeight: 16 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toggleLabel: { color: c.text, fontSize: 12 },
  url: {
    color: c.text, fontSize: 11, fontFamily: mono,
    backgroundColor: c.surface2, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 7,
  },
  btnRow: { flexDirection: 'row', gap: 8 },
  // Same button language as the deployment card's action row.
  btn: {
    borderRadius: 6, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center', minHeight: 32,
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { fontSize: 10, fontWeight: '600', letterSpacing: 1, fontFamily: mono },
  cyanBtn: { borderColor: c.cyan, backgroundColor: 'rgba(0,212,255,0.10)' },
  // Amber, not red: red is the card's CLOSE (ends the deployment). Same
  // distinction as dashboard issue #29.
  amberOutlineBtn: { borderColor: c.amber, backgroundColor: 'transparent' },
});

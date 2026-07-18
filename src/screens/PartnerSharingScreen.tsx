// Partner Sharing — mobile port of the dashboard's org-admin cross-org sharing
// console (WestshoreWatch-Dashboard/src/pages/PartnerSharing.jsx). Admin-only.
//
// V1 scope (per docs/partner-sharing-mobile-scoping-investigation.md):
//   - LIST outbound + inbound grants (two tabs).
//   - REVOKE any grant (grantor OR grantee admin), confirmed.
//   - EDIT SCOPE / TOGGLE NOTIFY on an active view-level outbound grant.
//   - LEND A NODE to a partner org (email-resolve path, immediate/no-accept).
//   - INVITE A PARTNER (view / org level) — NOT instant; grantee accepts an
//     emailed token link on their own device.
//
// Deferred (not built here): in-app invite ACCEPTANCE, resend, audit log,
// super-admin org-dropdown node lend, per-user "operate" invites.
//
// No backend changes — every endpoint already exists under /api/org-grants/*.
// request() surfaces backend error CODES as err.message and the HTTP status as
// err.status (there is no err.body), so all branching below reads those two.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  Alert, Platform, ActivityIndicator, RefreshControl, Modal,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme';
import { api } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { caps } from '../lib/caps';

// ------------------------------ helpers ------------------------------

// The plan gate (402) fires on invite/node-lend for free-tier orgs. On iOS we
// never surface an upgrade CTA or pricing (App Store Guideline 3.1.1) — same
// treatment as SettingsScreen's billing UI — and point at the web dashboard
// instead. Android names the in-app upgrade path.
function planGateMessage(): string {
  return Platform.OS === 'ios'
    ? 'Cross-org sharing requires a plan upgrade. Upgrades aren’t available in the iOS app — enable it from the web dashboard at watch.westshoredrone.com.'
    : 'Cross-org sharing requires a Starter plan or higher. Upgrade under Account → Upgrade / Buy Credits.';
}

function formatDateShort(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

type GrantStatus = 'pending' | 'active' | 'revoked' | 'superseded' | string;

// ------------------------------ screen ------------------------------

export default function PartnerSharingScreen() {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const user = useAuthStore(s => s.user);
  const ownOrgId: string | undefined = user?.org_id;
  const c = caps(user);
  const s = styles(colors);

  const [tab, setTab] = useState<'sharing' | 'receiving'>('sharing');
  const [outbound, setOutbound] = useState<any[]>([]);
  const [inbound, setInbound] = useState<any[]>([]);
  const [nodeGrants, setNodeGrants] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [lendOpen, setLendOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<any | null>(null);

  const load = useCallback(async () => {
    // Admin-gated endpoints; non-admins 403. This screen is admin-only, but
    // fall back to [] so a transient 403 can't crash the list.
    const safe = (p: Promise<any>) =>
      p.then(r => (Array.isArray(r) ? r : [])).catch(() => []);
    const [out, inb, nodes] = await Promise.all([
      safe(api.getOutboundGrants()),
      safe(api.getInboundGrants()),
      safe(api.getNodeGrants()),
    ]);
    setOutbound(out);
    setInbound(inb);
    setNodeGrants(nodes);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  // Node lends (resource_type='node') also come back on /outbound but belong in
  // the LENT NODES section (they carry no grantee_org_name), so exclude them
  // from the partner list — matching the dashboard.
  const partnerRows = useMemo(
    () => outbound.filter(g => g.resource_type !== 'node'),
    [outbound],
  );
  const activeNodeGrants = useMemo(
    () => nodeGrants.filter(g => g.status !== 'revoked'),
    [nodeGrants],
  );

  // Guard: only admins manage sharing. Navigated to from an admin-gated entry,
  // but defend against a programmatic push too.
  if (!c.canManagePartnerSharing) {
    return (
      <View style={[s.page, { paddingTop: (insets.top || 0) + 16 }]}>
        <Header colors={colors} title="PARTNER SHARING" onBack={() => navigation.goBack()} />
        <View style={s.empty}>
          <Text style={s.emptyText}>Only organization admins can manage partner sharing.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[s.page, { paddingTop: (insets.top || 0) + 16 }]}>
      <Header colors={colors} title="PARTNER SHARING" onBack={() => navigation.goBack()} />

      <View style={s.tabs}>
        <TouchableOpacity
          style={[s.tab, tab === 'sharing' && s.tabActive]}
          onPress={() => setTab('sharing')}
          activeOpacity={0.7}
        >
          <Text style={[s.tabText, tab === 'sharing' && s.tabTextActive]}>SHARING</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.tab, tab === 'receiving' && s.tabActive]}
          onPress={() => setTab('receiving')}
          activeOpacity={0.7}
        >
          <Text style={[s.tabText, tab === 'receiving' && s.tabTextActive]}>RECEIVING</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={s.empty}><ActivityIndicator color={colors.cyan} /></View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.cyan} />
          }
        >
          {tab === 'sharing' ? (
            <>
              <TouchableOpacity style={s.primaryBtn} onPress={() => setInviteOpen(true)} activeOpacity={0.8}>
                <Text style={s.primaryBtnText}>+ INVITE PARTNER</Text>
              </TouchableOpacity>

              {partnerRows.length === 0 ? (
                <View style={s.card}>
                  <Text style={s.emptyText}>You haven't shared data with any partners yet.</Text>
                </View>
              ) : (
                partnerRows.map(g => (
                  <OutboundRow
                    key={g.id}
                    grant={g}
                    colors={colors}
                    onEdit={() => setEditTarget(g)}
                    onChanged={load}
                  />
                ))
              )}

              {/* Lent nodes — immediate operate grants of physical nodes. */}
              <View style={s.sectionHeaderRow}>
                <Text style={s.sectionLabel}>LENT NODES</Text>
                <TouchableOpacity onPress={() => setLendOpen(true)} activeOpacity={0.7}>
                  <Text style={s.sectionAction}>+ LEND A NODE</Text>
                </TouchableOpacity>
              </View>
              {activeNodeGrants.length === 0 ? (
                <View style={s.card}>
                  <Text style={s.emptyText}>No nodes are lent out.</Text>
                </View>
              ) : (
                activeNodeGrants.map(g => (
                  <NodeGrantRow key={g.id} grant={g} colors={colors} onChanged={load} />
                ))
              )}
            </>
          ) : (
            <>
              {inbound.length === 0 ? (
                <View style={s.card}>
                  <Text style={s.emptyText}>No partner organizations have shared data with you yet.</Text>
                </View>
              ) : (
                inbound.map(g => (
                  <InboundRow key={g.id} grant={g} colors={colors} onChanged={load} />
                ))
              )}
            </>
          )}
        </ScrollView>
      )}

      {inviteOpen && (
        <InviteModal
          colors={colors}
          ownOrgId={ownOrgId}
          onClose={() => setInviteOpen(false)}
          onCreated={() => { setInviteOpen(false); load(); }}
        />
      )}
      {lendOpen && (
        <NodeLendModal
          colors={colors}
          onClose={() => setLendOpen(false)}
          onCreated={() => { setLendOpen(false); load(); }}
        />
      )}
      {editTarget && (
        <EditScopeModal
          colors={colors}
          grant={editTarget}
          ownOrgId={ownOrgId}
          onClose={() => setEditTarget(null)}
          onSaved={() => { setEditTarget(null); load(); }}
        />
      )}
    </View>
  );
}

// ------------------------------ header ------------------------------

function Header({ colors, title, onBack }: any) {
  const s = styles(colors);
  return (
    <View style={s.header}>
      <TouchableOpacity onPress={onBack} style={s.backBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
        <Ionicons name="chevron-back" size={22} color={colors.text} />
      </TouchableOpacity>
      <Text style={s.headerTitle}>{title}</Text>
      <View style={{ width: 34 }} />
    </View>
  );
}

// ------------------------------ status / level chips ------------------------------

function StatusPill({ status, colors }: { status: GrantStatus; colors: any }) {
  const s = styles(colors);
  const map: Record<string, { bg: string; fg: string }> = {
    pending: { bg: 'rgba(245,158,11,0.12)', fg: colors.amber },
    active: { bg: 'rgba(0,212,255,0.12)', fg: colors.cyan },
    revoked: { bg: 'rgba(120,120,120,0.12)', fg: colors.textMuted },
    superseded: { bg: 'rgba(120,120,120,0.12)', fg: colors.textMuted },
  };
  const cc = map[status] || map.revoked;
  return (
    <View style={[s.pill, { backgroundColor: cc.bg }]}>
      <Text style={[s.pillText, { color: cc.fg }]}>{String(status).toUpperCase()}</Text>
    </View>
  );
}

function LevelBadge({ level, colors }: { level: string; colors: any }) {
  const s = styles(colors);
  const op = level === 'operate';
  return (
    <View style={[s.levelBadge, { borderColor: op ? colors.amber : colors.border2, backgroundColor: op ? 'rgba(245,158,11,0.12)' : 'rgba(0,212,255,0.08)' }]}>
      <Text style={[s.levelBadgeText, { color: op ? colors.amber : colors.cyan }]}>
        {op ? 'OPERATE' : 'VIEW'}
      </Text>
    </View>
  );
}

// ------------------------------ rows ------------------------------

function OutboundRow({ grant, colors, onEdit, onChanged }: any) {
  const s = styles(colors);
  const [busy, setBusy] = useState(false);
  const status: GrantStatus = grant.status;
  const isOperate = grant.level === 'operate';
  const isUserGrant = grant.grantee_type === 'user';

  const partnerLabel = isUserGrant
    ? (status === 'pending'
        ? (grant.invite_email || 'Pending officer')
        : (grant.accepted_by_email || grant.accepted_by_name || grant.invite_email || 'Officer'))
    : (status === 'pending'
        ? (grant.invite_email || 'Pending invite')
        : (grant.grantee_org_name || grant.invite_email || 'Unknown partner'));

  const scopeLabel = isOperate
    ? 'Create / assign / close'
    : (grant.scope === 'selected_deployments'
        ? `Selected: ${(grant.selected_deployments || []).length}`
        : 'All deployments');

  const revoke = () => {
    const label = grant.grantee_org_name || grant.invite_email || 'this partner';
    Alert.alert(
      'Revoke access?',
      `Revoke ${label}'s access? This is immediate and can't be undone (you'd have to re-invite them).`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke', style: 'destructive', onPress: async () => {
            setBusy(true);
            try { await api.revokeGrant(grant.id); onChanged(); }
            catch (err: any) { Alert.alert('Failed to revoke', err?.message || 'Please try again.'); }
            finally { setBusy(false); }
          },
        },
      ],
    );
  };

  const canEdit = status === 'active' && !isOperate && !isUserGrant;

  return (
    <View style={[s.card, status === 'revoked' && { opacity: 0.5 }]}>
      <View style={s.rowTop}>
        <Text style={s.partnerName} numberOfLines={1}>{partnerLabel}</Text>
        <StatusPill status={status} colors={colors} />
      </View>
      <View style={s.chipRow}>
        <LevelBadge level={grant.level} colors={colors} />
        {isUserGrant && <Text style={s.metaTag}>OFFICER</Text>}
      </View>
      <Text style={s.metaLine}>Scope: {scopeLabel}</Text>
      {status === 'active' && !isOperate && (
        <Text style={s.metaLine}>Notifications: {grant.notify_grantee ? 'On' : 'Off'}</Text>
      )}
      {status === 'pending' && <Text style={s.metaLine}>Pending acceptance</Text>}
      <Text style={s.metaDim}>Invited {formatDateShort(grant.created_at)}</Text>

      <View style={s.actionRow}>
        {canEdit && (
          <TouchableOpacity style={s.ghostBtn} onPress={onEdit} activeOpacity={0.7}>
            <Text style={s.ghostBtnText}>EDIT SCOPE</Text>
          </TouchableOpacity>
        )}
        {status !== 'revoked' && (
          <TouchableOpacity style={[s.ghostBtn, s.dangerGhost]} onPress={revoke} disabled={busy} activeOpacity={0.7}>
            <Text style={[s.ghostBtnText, { color: colors.red }]}>{busy ? '…' : 'REVOKE'}</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function InboundRow({ grant, colors, onChanged }: any) {
  const s = styles(colors);
  const [busy, setBusy] = useState(false);
  const status: GrantStatus = grant.status;
  const scopeLabel = grant.scope === 'selected_deployments' ? 'Selected deployments' : 'All deployments';

  const revoke = (verb: 'decline' | 'stop') => {
    Alert.alert(
      verb === 'decline' ? 'Decline invitation?' : 'Stop receiving data?',
      verb === 'decline'
        ? `Decline ${grant.grantor_org_name}'s invitation?`
        : `Stop receiving data from ${grant.grantor_org_name}? This is immediate.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: verb === 'decline' ? 'Decline' : 'Stop', style: 'destructive', onPress: async () => {
            setBusy(true);
            try { await api.revokeGrant(grant.id); onChanged(); }
            catch (err: any) { Alert.alert('Failed', err?.message || 'Please try again.'); }
            finally { setBusy(false); }
          },
        },
      ],
    );
  };

  return (
    <View style={[s.card, status === 'revoked' && { opacity: 0.5 }]}>
      <View style={s.rowTop}>
        <Text style={s.partnerName} numberOfLines={1}>{grant.grantor_org_name}</Text>
        <StatusPill status={status} colors={colors} />
      </View>
      <Text style={s.metaLine}>Scope: {scopeLabel}</Text>
      <Text style={s.metaDim}>
        Invited by {grant.invited_by_name || grant.invited_by_email || '—'}
        {grant.accepted_at ? ` · accepted ${formatDateShort(grant.accepted_at)}` : ''}
      </Text>
      <View style={s.actionRow}>
        {status === 'pending' && (
          <TouchableOpacity style={[s.ghostBtn, s.dangerGhost]} onPress={() => revoke('decline')} disabled={busy} activeOpacity={0.7}>
            <Text style={[s.ghostBtnText, { color: colors.red }]}>{busy ? '…' : 'DECLINE'}</Text>
          </TouchableOpacity>
        )}
        {status === 'active' && (
          <TouchableOpacity style={[s.ghostBtn, s.dangerGhost]} onPress={() => revoke('stop')} disabled={busy} activeOpacity={0.7}>
            <Text style={[s.ghostBtnText, { color: colors.red }]}>{busy ? '…' : 'REVOKE ACCESS'}</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function NodeGrantRow({ grant, colors, onChanged }: any) {
  const s = styles(colors);
  const [busy, setBusy] = useState(false);
  const nodeLabel = grant.node_name || grant.node_device_id || 'Node';

  const revoke = () => {
    Alert.alert(
      'Revoke node access?',
      `Revoke ${grant.grantee_org_name || 'that org'}'s access to ${nodeLabel}? This is immediate.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Revoke', style: 'destructive', onPress: async () => {
            setBusy(true);
            try { await api.revokeGrant(grant.id); onChanged(); }
            catch (err: any) { Alert.alert('Failed to revoke', err?.message || 'Please try again.'); }
            finally { setBusy(false); }
          },
        },
      ],
    );
  };

  return (
    <View style={s.card}>
      <View style={s.rowTop}>
        <Text style={s.partnerName} numberOfLines={1}>{nodeLabel}</Text>
        <StatusPill status={grant.status} colors={colors} />
      </View>
      <View style={s.chipRow}>
        <LevelBadge level="operate" colors={colors} />
      </View>
      <Text style={s.metaLine}>Lent to: {grant.grantee_org_name || '—'}</Text>
      <Text style={s.metaDim}>Since {formatDateShort(grant.created_at)}</Text>
      <View style={s.actionRow}>
        <TouchableOpacity style={[s.ghostBtn, s.dangerGhost]} onPress={revoke} disabled={busy} activeOpacity={0.7}>
          <Text style={[s.ghostBtnText, { color: colors.red }]}>{busy ? '…' : 'REVOKE'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ------------------------------ shared form bits ------------------------------

function ModalShell({ colors, title, onClose, children }: any) {
  const s = styles(colors);
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.modalBackdrop}>
        <View style={s.modalCard}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>{title}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// Checkbox-styled selectable row — doubles as a radio (single-select) and a
// checkbox (multi-select), matching DeploymentsScreen's control visuals.
function CheckRow({ colors, checked, label, onPress }: any) {
  const s = styles(colors);
  return (
    <TouchableOpacity style={s.checkRow} onPress={onPress} activeOpacity={0.6}>
      <View style={[s.checkbox, checked && s.checkboxChecked]}>
        {checked && <Text style={s.checkmark}>✓</Text>}
      </View>
      <Text style={s.checkLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function FieldLabel({ colors, children }: any) {
  const s = styles(colors);
  return <Text style={s.fieldLabel}>{children}</Text>;
}

// Deployment multi-select checklist shared by Invite + EditScope. Own-org
// deployments only (the backend rejects sharing others' deployments anyway).
function DeploymentChecklist({ colors, ownOrgId, selectedIds, onToggle }: any) {
  const s = styles(colors);
  const [deployments, setDeployments] = useState<any[] | null>(null);

  useEffect(() => {
    api.getDeployments()
      .then((rows: any[]) => setDeployments(
        (rows || []).filter(d => !ownOrgId || d.org_id === ownOrgId),
      ))
      .catch(() => setDeployments([]));
  }, [ownOrgId]);

  if (deployments === null) {
    return <ActivityIndicator color={colors.cyan} style={{ marginVertical: 12 }} />;
  }
  if (deployments.length === 0) {
    return <Text style={s.metaDim}>No deployments to share.</Text>;
  }
  return (
    <View style={s.checklist}>
      {deployments.map(d => (
        <CheckRow
          key={d.id}
          colors={colors}
          checked={selectedIds.includes(d.id)}
          label={d.name}
          onPress={() => onToggle(d.id)}
        />
      ))}
    </View>
  );
}

// ------------------------------ invite modal ------------------------------

function InviteModal({ colors, ownOrgId, onClose, onCreated }: any) {
  const s = styles(colors);
  const [email, setEmail] = useState('');
  const [scope, setScope] = useState<'all_deployments' | 'selected_deployments'>('all_deployments');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const toggle = (id: string) =>
    setSelectedIds(cur => (cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]));

  const submit = async () => {
    setInlineError(null);
    const e = email.trim();
    if (!e) { setInlineError('Enter the partner admin’s email.'); return; }
    if (scope === 'selected_deployments' && selectedIds.length === 0) {
      setInlineError('Pick at least one deployment to share.'); return;
    }
    setBusy(true);
    try {
      await api.inviteGrant({
        adminEmail: e,
        scope,
        notifyGrantee: notify,
        selectedDeploymentIds: scope === 'selected_deployments' ? selectedIds : undefined,
        level: 'view',
        granteeType: 'org',
      });
      onCreated();
      Alert.alert(
        'Invitation sent',
        'They’ll receive an email to accept. Sharing begins once they accept on their side.',
      );
    } catch (err: any) {
      const code = err?.message;
      const status = err?.status;
      if (status === 402) setInlineError(planGateMessage());
      else if (status === 404 || code === 'user_not_found') {
        setInlineError('No Westshore Watch account found for that email. They need to create an account first, then you can invite them.');
      } else if (status === 409 || code === 'pending_invite_exists') {
        setInlineError('You already have a pending invite to this email.');
      } else {
        setInlineError(code || 'Invite failed. Please try again.');
      }
    } finally { setBusy(false); }
  };

  return (
    <ModalShell colors={colors} title="INVITE PARTNER" onClose={onClose}>
      <View style={s.infoBox}>
        <Text style={s.infoText}>
          Share your drone data (read-only) with a partner org. Not instant — they’ll get an
          email to accept, and sharing begins once they do.
        </Text>
      </View>

      <FieldLabel colors={colors}>PARTNER ADMIN EMAIL</FieldLabel>
      <TextInput
        style={s.input}
        value={email}
        onChangeText={(v) => { setEmail(v); setInlineError(null); }}
        placeholder="admin@partner.gov"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        keyboardType="email-address"
        autoCorrect={false}
      />
      <Text style={s.hint}>
        The email of an admin at the org you want to share with. They choose which of their orgs
        receives access when they accept.
      </Text>

      <FieldLabel colors={colors}>SCOPE</FieldLabel>
      <CheckRow colors={colors} checked={scope === 'all_deployments'} label="All deployments" onPress={() => setScope('all_deployments')} />
      <CheckRow colors={colors} checked={scope === 'selected_deployments'} label="Selected deployments only" onPress={() => setScope('selected_deployments')} />
      {scope === 'selected_deployments' && (
        <DeploymentChecklist colors={colors} ownOrgId={ownOrgId} selectedIds={selectedIds} onToggle={toggle} />
      )}

      <View style={{ height: 6 }} />
      <CheckRow colors={colors} checked={notify} label="Send detection & deployment notifications to the partner" onPress={() => setNotify(!notify)} />

      {inlineError && <Text style={s.errorText}>{inlineError}</Text>}

      <View style={s.footerRow}>
        <TouchableOpacity style={s.cancelBtn} onPress={onClose} activeOpacity={0.7}>
          <Text style={s.cancelBtnText}>CANCEL</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.submitBtn, busy && s.btnDisabled]} onPress={submit} disabled={busy} activeOpacity={0.8}>
          <Text style={s.submitBtnText}>{busy ? 'SENDING…' : 'SEND INVITE'}</Text>
        </TouchableOpacity>
      </View>
    </ModalShell>
  );
}

// ------------------------------ edit scope modal ------------------------------

function EditScopeModal({ colors, grant, ownOrgId, onClose, onSaved }: any) {
  const s = styles(colors);
  const [scope, setScope] = useState<'all_deployments' | 'selected_deployments'>(grant.scope);
  const [selectedIds, setSelectedIds] = useState<string[]>(
    (grant.selected_deployments || []).map((d: any) => d.id),
  );
  const [notify, setNotify] = useState(!!grant.notify_grantee);
  const [busy, setBusy] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const toggle = (id: string) =>
    setSelectedIds(cur => (cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]));

  const submit = async () => {
    setInlineError(null);
    if (scope === 'selected_deployments' && selectedIds.length === 0) {
      setInlineError('Pick at least one deployment to share.'); return;
    }
    setBusy(true);
    try {
      await api.patchGrant(grant.id, {
        scope,
        notifyGrantee: notify,
        selectedDeploymentIds: scope === 'selected_deployments' ? selectedIds : undefined,
      });
      onSaved();
    } catch (err: any) {
      setInlineError(err?.message || 'Update failed. Please try again.');
    } finally { setBusy(false); }
  };

  const title = `EDIT — ${grant.grantee_org_name || 'PARTNER'}`;
  return (
    <ModalShell colors={colors} title={title} onClose={onClose}>
      <FieldLabel colors={colors}>SCOPE</FieldLabel>
      <CheckRow colors={colors} checked={scope === 'all_deployments'} label="All deployments" onPress={() => setScope('all_deployments')} />
      <CheckRow colors={colors} checked={scope === 'selected_deployments'} label="Selected deployments only" onPress={() => setScope('selected_deployments')} />
      {scope === 'selected_deployments' && (
        <DeploymentChecklist colors={colors} ownOrgId={ownOrgId} selectedIds={selectedIds} onToggle={toggle} />
      )}

      <View style={{ height: 6 }} />
      <CheckRow colors={colors} checked={notify} label="Send detection & deployment notifications to the partner" onPress={() => setNotify(!notify)} />

      {inlineError && <Text style={s.errorText}>{inlineError}</Text>}

      <View style={s.footerRow}>
        <TouchableOpacity style={s.cancelBtn} onPress={onClose} activeOpacity={0.7}>
          <Text style={s.cancelBtnText}>CANCEL</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.submitBtn, busy && s.btnDisabled]} onPress={submit} disabled={busy} activeOpacity={0.8}>
          <Text style={s.submitBtnText}>{busy ? 'SAVING…' : 'SAVE'}</Text>
        </TouchableOpacity>
      </View>
    </ModalShell>
  );
}

// ------------------------------ node lend modal ------------------------------

function NodeLendModal({ colors, onClose, onCreated }: any) {
  const s = styles(colors);
  const [nodes, setNodes] = useState<any[] | null>(null);
  const [nodeId, setNodeId] = useState<string>('');
  const [email, setEmail] = useState('');
  const [resolved, setResolved] = useState<{ orgId: string; orgName: string } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    // Org-admins can only lend nodes they OWN — a borrowed node can't be re-lent
    // (backend rejects with not_node_owner). Filter to owned_by_org.
    api.getNodes()
      .then((rows: any[]) => setNodes((rows || []).filter(n => n.owned_by_org)))
      .catch(() => setNodes([]));
  }, []);

  const onEmailChange = (v: string) => { setEmail(v); setEmailError(null); setResolved(null); setSubmitError(null); };

  const resolveEmail = async () => {
    const e = email.trim();
    if (!e) return;
    setResolving(true); setEmailError(null); setResolved(null);
    try {
      const r = await api.resolveNodeGrantTarget(e);
      setResolved({ orgId: r.orgId, orgName: r.orgName });
    } catch (err: any) {
      const code = err?.message;
      if (code === 'user_not_found') setEmailError('No account found for that email.');
      else if (code === 'target_not_org_admin') setEmailError('That email isn’t an admin of any org.');
      else if (code === 'cannot_grant_to_self') setEmailError('That email belongs to your own org.');
      else if (code === 'ambiguous_target') setEmailError('That email is an admin of multiple orgs — can’t pick a target.');
      else setEmailError(code || 'Could not resolve that email.');
    } finally { setResolving(false); }
  };

  const submit = async () => {
    if (!nodeId || !resolved) return;
    setBusy(true); setSubmitError(null);
    try {
      await api.createNodeGrant(nodeId, email.trim());
      onCreated();
      Alert.alert('Node lent', `${resolved.orgName} can now assign this node. It took effect immediately.`);
    } catch (err: any) {
      const code = err?.message;
      const status = err?.status;
      if (status === 402) setSubmitError(planGateMessage());
      else if (code === 'ambiguous_target') setSubmitError('That email is an admin of multiple orgs.');
      else if (code === 'node_grant_already_exists') setSubmitError('That node is already lent to that org.');
      else if (code === 'node_already_owned_by_grantee') setSubmitError('That org already owns this node — nothing to lend.');
      else if (code === 'not_node_owner') setSubmitError('You can only lend nodes your org owns.');
      else if (code === 'user_not_found') setSubmitError('No account found for that email.');
      else if (code === 'target_not_org_admin') setSubmitError('That email isn’t an org admin.');
      else if (code === 'cannot_grant_to_self') setSubmitError('That email belongs to your own org.');
      else if (status === 403) setSubmitError('You don’t have permission to lend this node.');
      else setSubmitError(code || 'Failed to lend node.');
    } finally { setBusy(false); }
  };

  const canSubmit = !!nodeId && !!resolved && !busy;

  return (
    <ModalShell colors={colors} title="LEND A NODE" onClose={onClose}>
      <View style={s.infoBox}>
        <Text style={s.infoText}>
          Lend a node so a partner org can assign it — ownership and detection attribution stay
          with you. Takes effect immediately, no accept step.
        </Text>
      </View>

      <FieldLabel colors={colors}>NODE</FieldLabel>
      {nodes === null ? (
        <ActivityIndicator color={colors.cyan} style={{ marginVertical: 12 }} />
      ) : nodes.length === 0 ? (
        <Text style={s.metaDim}>No nodes available to lend.</Text>
      ) : (
        <View style={s.checklist}>
          {nodes.map(n => (
            <CheckRow
              key={n.id}
              colors={colors}
              checked={nodeId === n.id}
              label={n.name || n.device_id}
              onPress={() => setNodeId(n.id)}
            />
          ))}
        </View>
      )}

      <FieldLabel colors={colors}>PARTNER ADMIN EMAIL</FieldLabel>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput
          style={[s.input, { flex: 1, marginBottom: 0 }]}
          value={email}
          onChangeText={onEmailChange}
          placeholder="admin@partner.org"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          keyboardType="email-address"
          autoCorrect={false}
        />
        <TouchableOpacity
          style={[s.checkBtn, (resolving || !email.trim()) && s.btnDisabled]}
          onPress={resolveEmail}
          disabled={resolving || !email.trim()}
          activeOpacity={0.8}
        >
          <Text style={s.checkBtnText}>{resolving ? '…' : 'CHECK'}</Text>
        </TouchableOpacity>
      </View>
      {emailError && <Text style={s.errorText}>{emailError}</Text>}
      {resolved && (
        <View style={s.resolvedBox}>
          <Text style={s.resolvedText}>
            Matched org: <Text style={{ color: colors.text, fontWeight: '700' }}>{resolved.orgName}</Text>. Confirm to lend — effective immediately.
          </Text>
        </View>
      )}

      {submitError && <Text style={s.errorText}>{submitError}</Text>}

      <View style={s.footerRow}>
        <TouchableOpacity style={s.cancelBtn} onPress={onClose} activeOpacity={0.7}>
          <Text style={s.cancelBtnText}>CANCEL</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.submitBtn, !canSubmit && s.btnDisabled]} onPress={submit} disabled={!canSubmit} activeOpacity={0.8}>
          <Text style={s.submitBtnText}>
            {busy ? 'LENDING…' : resolved ? `LEND TO ${resolved.orgName}` : 'CHECK EMAIL FIRST'}
          </Text>
        </TouchableOpacity>
      </View>
    </ModalShell>
  );
}

// ------------------------------ styles ------------------------------

const MONO = Platform.OS === 'ios' ? 'Courier New' : 'monospace';

const styles = (c: ReturnType<typeof useTheme>) => StyleSheet.create({
  page: { flex: 1, backgroundColor: c.bg },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: c.border,
  },
  backBtn: { paddingRight: 12 },
  headerTitle: {
    flex: 1, color: c.text, fontSize: 14, fontWeight: '700', letterSpacing: 3,
    fontFamily: MONO,
  },
  tabs: {
    flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 12,
  },
  tab: {
    flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 8,
    borderWidth: 1, borderColor: c.border, backgroundColor: c.surface,
  },
  tabActive: { borderColor: c.cyan, backgroundColor: 'rgba(0,212,255,0.08)' },
  tabText: {
    color: c.textMuted, fontSize: 11, letterSpacing: 2, fontWeight: '700', fontFamily: MONO,
  },
  tabTextActive: { color: c.cyan },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyText: { color: c.textMuted, fontSize: 12, textAlign: 'center', fontFamily: MONO },

  primaryBtn: {
    backgroundColor: c.cyan, borderRadius: 8, padding: 14, alignItems: 'center', marginBottom: 14,
  },
  primaryBtnText: { color: '#000', fontWeight: '700', fontSize: 12, letterSpacing: 2, fontFamily: MONO },

  card: {
    backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.border,
    padding: 16, marginBottom: 12,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  partnerName: { flex: 1, color: c.text, fontSize: 14, fontWeight: '600', fontFamily: MONO },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  metaTag: { color: c.textMuted, fontSize: 9, letterSpacing: 1, fontFamily: MONO },
  metaLine: { color: c.textDim, fontSize: 12, marginTop: 8, fontFamily: MONO },
  metaDim: { color: c.textMuted, fontSize: 11, marginTop: 6, fontFamily: MONO },

  pill: { borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 },
  pillText: { fontSize: 9, letterSpacing: 1, fontWeight: '700', fontFamily: MONO },
  levelBadge: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 7, paddingVertical: 2 },
  levelBadgeText: { fontSize: 9, letterSpacing: 1, fontWeight: '700', fontFamily: MONO },

  actionRow: { flexDirection: 'row', gap: 8, marginTop: 14, justifyContent: 'flex-end' },
  ghostBtn: {
    borderWidth: 1, borderColor: c.border, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 8,
  },
  ghostBtnText: { color: c.textDim, fontSize: 10, letterSpacing: 1.5, fontWeight: '700', fontFamily: MONO },
  dangerGhost: { borderColor: c.red, backgroundColor: 'rgba(239,68,68,0.08)' },

  sectionHeaderRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 24, marginBottom: 10,
  },
  sectionLabel: { color: c.textMuted, fontSize: 9, letterSpacing: 2, fontFamily: MONO },
  sectionAction: { color: c.cyan, fontSize: 10, letterSpacing: 1.5, fontWeight: '700', fontFamily: MONO },

  // modal
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: c.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    maxHeight: '92%', borderTopWidth: 1, borderColor: c.border2,
  },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: c.border,
  },
  modalTitle: { color: c.cyan, fontSize: 13, letterSpacing: 2, fontWeight: '700', fontFamily: MONO },

  infoBox: {
    backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border2, borderRadius: 8,
    padding: 12, marginBottom: 16,
  },
  infoText: { color: c.textDim, fontSize: 11, lineHeight: 17, fontFamily: MONO },

  fieldLabel: { color: c.textDim, fontSize: 10, letterSpacing: 2, fontFamily: MONO, marginBottom: 8, marginTop: 6 },
  input: {
    backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border, borderRadius: 8,
    padding: 12, color: c.text, fontSize: 14, marginBottom: 8,
  },
  hint: { color: c.textMuted, fontSize: 10, lineHeight: 15, marginBottom: 10, fontFamily: MONO },

  checkRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  checkbox: {
    width: 18, height: 18, borderRadius: 4, borderWidth: 1, borderColor: c.border,
    backgroundColor: c.surface2, alignItems: 'center', justifyContent: 'center', marginRight: 10,
  },
  checkboxChecked: { backgroundColor: c.cyan, borderColor: c.cyan },
  checkmark: { color: '#000', fontSize: 12, fontWeight: '700', lineHeight: 14 },
  checkLabel: { flex: 1, color: c.text, fontSize: 13, fontFamily: MONO },
  checklist: {
    borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 8, marginTop: 4, marginBottom: 6,
  },

  errorText: { color: c.amber, fontSize: 11, marginTop: 10, lineHeight: 16, fontFamily: MONO },

  resolvedBox: {
    borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 10, marginTop: 10,
    backgroundColor: c.surface2,
  },
  resolvedText: { color: c.textDim, fontSize: 12, lineHeight: 17, fontFamily: MONO },

  checkBtn: {
    backgroundColor: c.surface2, borderWidth: 1, borderColor: c.cyan, borderRadius: 8,
    paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center',
  },
  checkBtnText: { color: c.cyan, fontSize: 11, letterSpacing: 1, fontWeight: '700', fontFamily: MONO },

  footerRow: { flexDirection: 'row', gap: 10, marginTop: 20 },
  cancelBtn: {
    borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingVertical: 13, paddingHorizontal: 20, alignItems: 'center',
  },
  cancelBtnText: { color: c.textDim, fontSize: 11, letterSpacing: 1.5, fontWeight: '700', fontFamily: MONO },
  submitBtn: {
    flex: 1, backgroundColor: c.cyan, borderRadius: 8, paddingVertical: 13, alignItems: 'center', justifyContent: 'center',
  },
  submitBtnText: { color: '#000', fontSize: 11, letterSpacing: 1.5, fontWeight: '700', fontFamily: MONO },
  btnDisabled: { opacity: 0.4 },
});

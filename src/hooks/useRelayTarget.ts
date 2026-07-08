import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, DeviceEventEmitter } from 'react-native';
import { api } from '../services/api';
import { setRelayDeployment } from '../services/bleScanner';

// Drives the iOS node-less relay target — which deployment this phone uploads
// its BLE-assembled drone detections to — per the approved Option-3 contract:
//
//   • auto-pick when EXACTLY ONE active deployment is post-scoped (operable);
//   • prompt on genuine ambiguity (>=2 operable) — never silently pick;
//   • clear when zero are operable;
//   • persist the choice for the session: a still-valid prior pick survives
//     active-set refreshes, and we only re-prompt if it stops being a candidate.
//
// "Post-scope" mirrors DeploymentsScreen.canOperate — own org OR an operable
// grant — so we never auto-select a deployment the backend would 403 on. The
// relay target is DISTINCT from the map's view scope (the phone is at one
// physical deployment; its detections belong to that one), and is independent
// of 'ALL'/passive view selection.
//
// Guests / add-node screens never mount this hook, so they never set a relay
// target and never upload.
export function useRelayTarget(activeDeployments: any[], ownOrgId: string | undefined) {
  // Orgs the user can operate (post) in. Fail-closed to empty on error: the
  // own-org check below still lets a plain user relay to their home org.
  const [operableOrgIds, setOperableOrgIds] = useState<Set<string>>(new Set());

  // The currently chosen relay deployment id, persisted across reconciles for
  // the session. Mirrors what we last pushed into setRelayDeployment().
  const chosenRef = useRef<string | null>(null);

  // Signature of the candidate set we last prompted for, so an ambiguous set
  // prompts ONCE rather than on every activeDeployments refresh.
  const promptedSigRef = useRef<string | null>(null);

  // Deployments the server rejected for upload (403/404). Excluded from
  // candidates for the session so a single-candidate set can't auto-re-pick a
  // rejected target and loop. Used to bump reconciliation when one arrives.
  const rejectedRef = useRef<Set<string>>(new Set());
  const [rejectedTick, setRejectedTick] = useState(0);

  useEffect(() => {
    let alive = true;
    api.getOperableOrgs()
      .then((orgs: any[]) => { if (alive) setOperableOrgIds(new Set((orgs || []).map((o: any) => o.id))); })
      .catch(() => { if (alive) setOperableOrgIds(new Set()); });
    return () => { alive = false; };
  }, []);

  const isPostScoped = useCallback(
    (dep: any) => dep?.org_id === ownOrgId || operableOrgIds.has(dep?.org_id),
    [ownOrgId, operableOrgIds],
  );

  const apply = useCallback((id: string | null) => {
    chosenRef.current = id;
    setRelayDeployment(id);
  }, []);

  // Clear the relay target when the screen unmounts (leaving the live map stops
  // this phone relaying). stopBleScanning also drops the queue; this drops the
  // target so a later session starts clean.
  useEffect(() => () => setRelayDeployment(null), []);

  // The upload path emits this when the backend rejects the relay deployment as
  // out of scope (403/404). Record it as rejected, drop the target, and bump
  // reconciliation so we re-pick another candidate or go idle — never blindly
  // retry the rejected one.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('RelayTargetRejected', (p: any) => {
      if (p?.deployment_id) rejectedRef.current.add(p.deployment_id);
      chosenRef.current = null;
      setRelayDeployment(null);
      setRejectedTick(t => t + 1);
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    const candidates = (activeDeployments || [])
      .filter(isPostScoped)
      .filter((d: any) => !rejectedRef.current.has(d.id));

    // Persist a still-valid prior choice across refreshes.
    if (chosenRef.current && candidates.some((d: any) => d.id === chosenRef.current)) {
      promptedSigRef.current = null;
      return;
    }

    if (candidates.length === 0) {
      apply(null);
      promptedSigRef.current = null;
      return;
    }

    if (candidates.length === 1) {
      apply(candidates[0].id);
      promptedSigRef.current = null;
      return;
    }

    // Genuine ambiguity: do NOT pick. Clear any stale target and prompt once
    // per distinct candidate set.
    apply(null);
    const sig = candidates.map((d: any) => d.id).sort().join(',');
    if (promptedSigRef.current === sig) return;
    promptedSigRef.current = sig;

    Alert.alert(
      'Relay detections to which deployment?',
      'This phone can relay drone detections to one active deployment. Choose where its detections should be recorded.',
      [
        ...candidates.map((d: any) => ({
          text: d.name ?? d.id,
          onPress: () => apply(d.id),
        })),
        // Stay un-targeted; we re-prompt if the candidate set changes.
        { text: 'Not now', style: 'cancel' as const },
      ],
    );
  }, [activeDeployments, isPostScoped, apply, rejectedTick]);
}

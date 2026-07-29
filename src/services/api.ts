import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

const BASE = 'https://api.westshoredrone.com/api';

// Exposed so the Wear enrollment handshake can hand the watch its apiBase in the
// Data Layer payload (the watch redeems the code at `${API_BASE}/auth/device/enroll`).
export const API_BASE = BASE;

async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync('auth_token');
}

// Fired whenever a request comes back 401. The JWT has a server-side
// expiry (see WestshoreWatch-Backend auth middleware); after enough idle
// days the token stored in SecureStore is simply stale. Without this hook
// every caller treated a 401 the same as "empty result" (see the catch
// blocks in nodeRegistry.fetchNodes / AppNavigator.checkNodes), so an
// expired-token user got stuck on "NO NODES REGISTERED" forever instead
// of being routed back to Login. authStore wires this to logout() once
// at module load — set via a setter (not a direct import) to avoid an
// api.ts <-> authStore.ts import cycle.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

// Build the X-Client-* headers once at module load. The backend uses
// these to populate the per-user diagnostic columns in `users` (via
// the authenticate middleware) and the matching fields on every
// login_audit row, so the super-admin dashboard can answer "what app
// build and device is this user on" without grepping logs.
//
// Values are sourced from expo-constants nativeApplicationVersion /
// nativeBuildVersion (which read android/app/build.gradle versionName
// and versionCode at runtime — the actual shipped values, not the
// often-stale ones in app.config.js) plus expo-device for the OS
// and model info. Platform.OS gives 'android' | 'ios'.
//
// Every field is independently optional — a null/missing value just
// means the header is omitted, and the corresponding DB column stays
// at whatever the prior request populated (last_seen_at uses COALESCE
// on the diagnostic columns). Wrapped in try/catch so a native-module
// init failure can never break app boot — telemetry is nice-to-have,
// the API client itself is critical-path.
//
// Frozen so a future caller can't accidentally mutate the shared
// header object across requests.
function buildClientHeaders(): Readonly<Record<string, string>> {
  try {
    const out: Record<string, string> = {};

    const version = Constants.nativeApplicationVersion;
    if (typeof version === 'string' && version.length > 0) {
      out['X-Client-Version'] = version;
    }

    // nativeBuildVersion is a string ('12'); coerce + sanity-check
    // before sending. Backend re-validates and drops non-numeric or
    // out-of-INTEGER-range values.
    const buildStr = Constants.nativeBuildVersion;
    if (typeof buildStr === 'string' && buildStr.length > 0) {
      const buildNum = parseInt(buildStr, 10);
      if (Number.isFinite(buildNum) && buildNum >= 0) {
        out['X-Client-Build'] = String(buildNum);
      }
    }

    if (Platform.OS === 'android' || Platform.OS === 'ios') {
      out['X-Client-Platform'] = Platform.OS;
    }

    // Client TYPE is a DIFFERENT axis from platform (backend migration 067):
    // platform = which OS ('android'|'ios'), client_type = which app. This app
    // is the 'phone' client; the Wear companion enrolls as 'wear'. Populates
    // login_audit.client_type + users.last_client_type so a session is
    // attributable to the right device even though both are Android. Sent on
    // every request (incl. the login POST) via the shared CLIENT_HEADERS spread,
    // so it lands on the login_audit row too.
    out['X-Client-Type'] = 'phone';

    const osName = Device.osName;
    const osVersion = Device.osVersion;
    if (osName && osVersion) {
      out['X-Client-OS'] = `${osName} ${osVersion}`;
    } else if (typeof osName === 'string' && osName.length > 0) {
      out['X-Client-OS'] = osName;
    }

    const deviceModel = Device.modelName;
    if (typeof deviceModel === 'string' && deviceModel.length > 0) {
      out['X-Client-Device'] = deviceModel;
    }

    return Object.freeze(out);
  } catch (err) {
    console.warn('[api] buildClientHeaders failed:', err);
    return Object.freeze({});
  }
}

const CLIENT_HEADERS = buildClientHeaders();

async function request(
  method: string,
  path: string,
  body?: any,
  extraHeaders?: Record<string, string>,
) {
  const token = await getToken();
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...CLIENT_HEADERS,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(extraHeaders || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    // Billing status is admin-gated on the backend; viewers/operators get
    // 403. Treat as "billing not visible to this user" so callers can keep
    // using `billing?.` optional chaining instead of try/catch wrappers.
    if (res.status === 403 && method === 'GET' && path === '/billing/status') {
      return null;
    }
    // Expired/invalid JWT — the token in SecureStore is no longer good for
    // ANY endpoint, not just this one. Kick off logout immediately (rather
    // than letting each caller's catch block silently swallow it) so the
    // navigator drops back to Login instead of stranding the user on a
    // stale "no nodes" screen. Login itself never 401s, and the token is
    // only attached when present, so this can't loop on the login request.
    if (res.status === 401) {
      try { onUnauthorized?.(); } catch (e) { console.warn('[api] onUnauthorized handler threw:', e); }
    }
    const err = await res.json().catch(() => ({ error: res.statusText }));
    console.warn(`API ${method} ${path} → ${res.status}:`, err);
    throw Object.assign(new Error(err.error || 'Request failed'), { status: res.status });
  }
  return res.json();
}

function getClientTimezone(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && typeof tz === 'string' ? tz : undefined;
  } catch {
    return undefined;
  }
}

export const api = {
  // Auth
  login: (email: string, password: string) => {
    const timezone = getClientTimezone();
    return request('POST', '/auth/login', {
      email,
      password,
      ...(timezone ? { timezone } : {}),
    });
  },
  register: (data: {
    name: string;
    email: string;
    org_name: string;
    password: string;
    accepted_terms: boolean;
  }) =>
    request('POST', '/auth/register', data),
  forgotPassword: (email: string) =>
    request('POST', '/auth/forgot-password', { email }),

  // Account deletion (Apple App Store Guideline 5.1.1(v)). DELETE /api/auth/me
  // deletes the CALLER'S OWN account; request() attaches the JWT.
  //   200 { deleted: true, message } → success (caller signs out)
  //   409 { error }                  → last org admin / has tax-exemption
  //                                    records; UI shows error, stays logged in
  //   500 { error: 'Server error' }  → failure
  // request() throws on non-2xx with err.error as the message and the HTTP
  // status attached, so the UI can branch on `status === 409`.
  deleteAccount: () => request('DELETE', '/auth/me'),

  // Orgs the current user can create/operate deployments in (home + operate
  // grants). Render the "Create in" selector only when length > 1.
  getOperableOrgs: () => request('GET', '/org-grants/operable-orgs'),

  // Partner Sharing — cross-org grants management (all org-admin-only on the
  // backend; non-admins get 403). Mirrors the dashboard's /org-grants/* client.
  // The READ side (deployments/detections/etc.) already widens for grants
  // automatically — these endpoints manage the grants themselves.
  //
  // NOTE on error handling: request() throws `new Error(err.error)` with
  // `.status` attached — so backend error CODES arrive as `err.message`, e.g.
  // err.message === 'user_not_found' / 'pending_invite_exists'. There is no
  // `err.body`; branch on `err.status` + `err.message`.
  getOutboundGrants: () => request('GET', '/org-grants/outbound'),
  getInboundGrants: () => request('GET', '/org-grants/inbound'),
  // Invite a partner. V1 phone flow sends level:'view', granteeType:'org'.
  // NOT instant — the grantee must already have an account and accept an
  // emailed token link. 404 user_not_found / 409 pending_invite_exists / 402
  // plan gate are the notable failures.
  inviteGrant: (data: {
    adminEmail: string;
    scope: 'all_deployments' | 'selected_deployments';
    notifyGrantee?: boolean;
    selectedDeploymentIds?: string[];
    level?: 'view' | 'operate';
    granteeType?: 'org' | 'user';
  }) => request('POST', '/org-grants/invite', data),
  // Revoke/decline/stop — one endpoint serves all three (grantor OR grantee
  // admin). Immediate.
  revokeGrant: (id: string) => request('POST', `/org-grants/${id}/revoke`),
  // Edit an active view-level outbound grant's scope / notify flag.
  patchGrant: (id: string, data: {
    scope?: 'all_deployments' | 'selected_deployments';
    notifyGrantee?: boolean;
    selectedDeploymentIds?: string[];
  }) => request('PATCH', `/org-grants/${id}`, data),
  // Node loans (operate) — immediate/active, no accept round-trip. Org-admin
  // path: resolve a partner-admin email to its org for confirmation, then
  // create by email (backend re-resolves server-side). Super-admin org-dropdown
  // path is intentionally NOT ported (org-admin email path only).
  getNodeGrants: () => request('GET', '/org-grants/node-grants'),
  resolveNodeGrantTarget: (email: string) =>
    request('POST', '/org-grants/node/resolve-target', { email }),
  createNodeGrant: (nodeId: string, adminEmail: string) =>
    request('POST', '/org-grants/node', { nodeId, adminEmail }),
  // Org-level assignable node pool for the create form when targeting a team org.
  getOrgAssignableNodes: (orgId: string) =>
    request('GET', `/deployments/assignable-nodes?org_id=${encodeURIComponent(orgId)}`),

  // Deployments
  getDeployments: () => request('GET', '/deployments'),
  // Event deployments require nodeIds (>=1). Continuous deployments ignore
  // them entirely on the backend, so callers can omit for continuous.
  // targetOrgId (optional) creates in a team org via an org-operate grant;
  // omitted/home-org keeps existing behavior.
  createDeployment: (
    name: string,
    scheduledFor?: string,
    mode?: 'event' | 'continuous',
    nodeIds?: string[],
    targetOrgId?: string,
  ) => {
    const body: any = { name };
    if (mode) body.mode = mode;
    if (scheduledFor) body.scheduled_for = scheduledFor;
    if (Array.isArray(nodeIds) && nodeIds.length > 0) body.node_ids = nodeIds;
    if (targetOrgId) body.org_id = targetOrgId;
    return request('POST', '/deployments', body);
  },
  closeDeployment: (id: string) => request('POST', `/deployments/${id}/close`),
  extendDeployment: (id: string) => request('POST', `/deployments/${id}/extend`),
  cancelDeployment: (id: string) => request('POST', `/deployments/${id}/cancel`),
  pauseDeployment: (id: string) => request('POST', `/deployments/${id}/pause`),
  resumeDeployment: (id: string) => request('POST', `/deployments/${id}/resume`),
  startDeployment: (id: string) => request('POST', `/deployments/${id}/start`),
  deleteDeployment: (id: string) => request('DELETE', `/deployments/${id}`),

  // Pre-assigned nodes (join-table resource on the deployment). add returns
  // { deployment_id, node_id, node_name, warnings? } — warnings is a non-
  // blocking string[] of overlapping-window notices the UI surfaces via
  // Alert. remove returns { ok: true } or 404 if the join row was missing.
  addPreassignedNode: (deploymentId: string, nodeId: string) =>
    request('POST', `/deployments/${deploymentId}/preassigned-nodes`, { node_id: nodeId }),
  removePreassignedNode: (deploymentId: string, nodeId: string) =>
    request('DELETE', `/deployments/${deploymentId}/preassigned-nodes/${nodeId}`),

  // Nodes
  getNodes: (deploymentId?: string) =>
    request('GET', deploymentId ? `/deployments/${deploymentId}/nodes` : '/deployments/nodes'),
  // Nodes for a specific set of deployments in one request. Backend filters
  // by the caller's deployment grant scope AND the ?deployment_ids list, so
  // a non-granted id contributes nothing (fail-closed). Used by the Live
  // Map's "All active" selection. Empty list → no request (caller guards).
  getNodesForDeployments: (deploymentIds: string[]) =>
    request('GET', `/deployments/nodes?deployment_ids=${encodeURIComponent(deploymentIds.join(','))}`),
  assignNode: (nodeId: string, deploymentId: string) =>
    request('PATCH', `/deployments/nodes/${nodeId}/assign`, { deployment_id: deploymentId }),
  unassignNode: (nodeId: string) =>
    request('PATCH', `/deployments/nodes/${nodeId}/assign`, { deployment_id: null }),
  setNodeDisplayOrder: (nodeId: string, displayOrder: number | null) =>
    request('PATCH', `/nodes/${nodeId}/display-order`, { display_order: displayOrder }),
  renameNode: (nodeId: string, name: string) =>
    request('PATCH', `/deployments/nodes/${nodeId}/rename`, { name }),
  // Note: heartbeat POSTs to /nodes/:device_id/heartbeat are now sent from
  // the native FG service (NodeHeartbeatUploader.kt) so they survive Doze.
  // No JS wrapper here — the native side talks to the backend directly.
  nodeDetections: (deviceId: string, drones: any[]) =>
    request('POST', `/nodes/${encodeURIComponent(deviceId)}/detections`, { drones }),
  // Node-less detections (iOS relay path): a phone relaying a DroneScout-bridge
  // drone has no Westshore node MAC, so it posts to the deployment directly.
  // User-JWT auth; the backend validates deploymentId through the caller's scope
  // and inserts with node_id = NULL. Body shape matches nodeDetections.
  deploymentDetections: (deploymentId: string, drones: any[]) =>
    request('POST', `/deployments/${encodeURIComponent(deploymentId)}/detections`, { drones }),
  getNodeLimit: () => request('GET', '/nodes/limit'),
  claimNode: (mac: string, name?: string) => {
    const body: any = { mac };
    if (name && name.trim()) body.name = name.trim();
    return request('POST', '/nodes/claim', body);
  },

  // Detections
  getDetections: (deploymentId: string) =>
    request('GET', `/detections/${deploymentId}`),
  // Org-wide recent detections, used by the Live Map's passive view when no
  // deployment is active. Server clamps `minutes` to [1, 60]; default 5.
  getRecentDetections: (minutes: number = 5) =>
    request('GET', `/detections/recent?minutes=${encodeURIComponent(String(minutes))}`),
  deleteDrone: (deploymentId: string, uasId: string) =>
    request('DELETE', `/detections/${deploymentId}/${encodeURIComponent(uasId)}`),

  // Drone nicknames (per-org, UAS-ID-keyed; shared across deployments).
  // Server is authoritative — local state mirrors what the WS broadcasts.
  getDroneNicknames: (orgId: string) =>
    request('GET', `/orgs/${orgId}/drone-nicknames`),
  setDroneNickname: (orgId: string, uasId: string, nickname: string) =>
    request('PATCH', `/orgs/${orgId}/drones/${encodeURIComponent(uasId)}/nickname`, { nickname }),

  // Facility geofences (per-org boundaries). Own-org scoped on the backend
  // (`WHERE org_id = <viewer's org>`), so a cross-org grantee receives only
  // their OWN boundaries, never the grantor's. Each row carries a
  // materialized GeoJSON Feature wrapping a Polygon in `geometry` — the app
  // renders geometry.geometry.coordinates[0] directly as an opaque ring
  // (no circle/center/radius assumptions; prod boundaries are arbitrary
  // polygons, not just pre-expanded circles).
  listFacilityGeofences: () =>
    request('GET', '/orgs/me/facility-geofences'),

  // Billing
  getBillingStatus: () => request('GET', '/billing/status'),
  changePassword: (currentPassword: string, newPassword: string) =>
    request('POST', '/auth/change-password', { current_password: currentPassword, new_password: newPassword }),
  getOrgUsers: () => request('GET', '/orgs/users'),
  inviteUser: (email: string, name: string, role: string) =>
    request('POST', '/orgs/users/invite', { email, name, role }),
  removeUser: (userId: string) => request('DELETE', `/orgs/users/${userId}`),
  createPaymentIntent: (quantity: number) =>
    request('POST', '/billing/create-payment-intent', { quantity }),
  createSetupIntent: () =>
    request('POST', '/billing/create-setup-intent'),
  recordCredits: (quantity: number, paymentIntentId: string) =>
    request('POST', '/billing/record-credits', { quantity, payment_intent_id: paymentIntentId }),
  subscribe: (plan: string, paymentMethodId: string) =>
    request('POST', '/billing/subscribe', { plan, payment_method_id: paymentMethodId }),
  buyCredits: (quantity: number, paymentMethodId: string) =>
    request('POST', '/billing/buy-credits', { quantity, payment_method_id: paymentMethodId }),

  // Export
  exportCsvUrl: async (deploymentId: string) => {
    const token = await getToken();
    return `${BASE}/export/${deploymentId}/csv?token=${token}`;
  },

  // Docs (public — no auth required)
  getManualUrl: () => request('GET', '/docs/manual-url'),

  // Push notifications.
  // Token register/revoke and feed/preferences endpoints all live under
  // /api with mixed prefixes — see WestshoreWatch-Backend
  // routes/notifications.js. revokePushToken does NOT require auth on
  // the backend (the token itself is the secret); we still pass the
  // current JWT if available for telemetry consistency.
  registerPushToken: (token: string, platform: 'ios' | 'android') =>
    request('POST', '/users/push-token', { token, platform }),
  revokePushTokenServer: (token: string) =>
    request('DELETE', '/users/push-token', { token }),

  // Wear OS companion — phone side of the one-time enrollment handshake.
  // getWearEnrollCode mints a short-lived (90s) single-use code on the backend
  // (authenticated as this user); the code is then handed to the watch over the
  // Wearable Data Layer (see WearBridge). The raw user JWT is NEVER sent to the
  // watch — the watch redeems the code at /auth/device/enroll for its own
  // device tokens. list/revoke power a "my watches" management view.
  getWearEnrollCode: (): Promise<{ code: string; expiresIn: number }> =>
    request('POST', '/auth/device/enroll-code'),
  listWearDevices: (): Promise<{ devices: Array<Record<string, unknown>> }> =>
    request('GET', '/auth/device'),
  revokeWearDevice: (deviceId: string) =>
    request('POST', `/auth/device/${encodeURIComponent(deviceId)}/revoke`),
  listNotifications: (params?: { limit?: number; before?: string }) => {
    const qs: string[] = [];
    if (params?.limit) qs.push(`limit=${encodeURIComponent(String(params.limit))}`);
    if (params?.before) qs.push(`before=${encodeURIComponent(params.before)}`);
    const tail = qs.length ? `?${qs.join('&')}` : '';
    return request('GET', `/notifications${tail}`);
  },
  markNotificationRead: (id: string) =>
    request('PATCH', `/notifications/${encodeURIComponent(id)}/read`),
  markAllNotificationsRead: () =>
    request('POST', '/notifications/read-all'),
  getNotificationPreferences: () =>
    request('GET', '/notifications/preferences'),
  updateNotificationPreferences: (preferences: Record<string, boolean>) =>
    request('PATCH', '/notifications/preferences', { preferences }),
  sendTestNotification: () =>
    request('POST', '/notifications/test', {}),
};

// WebSocket connection — auto-reconnecting with exponential backoff + keepalive.
//
// Backend mounts ws.Server at path '/ws' (server.js:17). Render LB idle timeout
// drops quiet connections around the 2-minute mark (fingerprint of 1006 after
// ~2min with no app-layer traffic), so we both (a) send a 30s keepalive ping
// to prevent the drop, and (b) reconnect on any non-1000 close.
//
// AUTH + SUBSCRIBE are re-sent on every successful onopen, so reconnects
// naturally restore the deployment subscription on the new socket instance.

export type WsStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';

// Wire format for the two subscription shapes the backend SUBSCRIBE/
// SUBSCRIBE_ORG handlers accept (see server.js). Active-mode Live Map
// uses SUBSCRIBE with a deployment_ids array; passive-mode Live Map
// uses SUBSCRIBE_ORG to receive every detection across the user's
// accessible orgs. Replacing one with the other on the live socket is
// done via ReconnectingWebSocket.resubscribe — no need to tear down.
export type SubscribeMessage =
  // include_owned_nodes: active-mode opt-in so the server also delivers live
  // detections from nodes THIS org owns but has lent into a deployment we are
  // NOT subscribed to (Gate-2 relaxation, strictly node_owner_org_id === own org).
  | { type: 'SUBSCRIBE'; deployment_ids: string[]; include_owned_nodes?: boolean }
  | { type: 'SUBSCRIBE_ORG' };

export interface ReconnectingWebSocket {
  close(): void;
  status(): WsStatus;
  // Update the subscription on the open socket if any, AND remember the
  // new shape so future reconnects re-send it instead of the original.
  // No-op if the new shape is deeply equal to the current one.
  resubscribe(subscribe: SubscribeMessage): void;
}

interface CreateWebSocketOptions {
  // Called after a reconnect (NOT the first connect). Consumer uses this to
  // refetch any server state that may have changed while the WS was down.
  onReconnect?: () => void;
}

const WS_URL = 'wss://api.westshoredrone.com/ws';
const KEEPALIVE_INTERVAL_MS = 30_000;
// Ack-gated subscribe retry. The first client→server frame after a WS upgrade
// can be silently dropped by the edge proxy before the edge↔origin leg is
// wired (proven against prod: the initial SUBSCRIBE_ORG left NO server-side
// trace; a re-send ~20s later reached the backend and acked in ~50ms). A
// single fire-and-forget subscribe would leave the socket
// connected-but-unsubscribed. Re-send until the backend acks. Both subscribe
// shapes are idempotent server-side. (Masked on the app by local BLE render,
// but relayed / other-source detections have the same silent gap.)
const SUB_RETRY_INTERVAL_MS = 2_000;
const SUB_MAX_RETRIES = 6; // ~12s of coverage past the first-frame race
const BACKOFF_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const BACKOFF_JITTER = 0.20;

function nextBackoff(attempt: number): number {
  const base = BACKOFF_STEPS_MS[Math.min(attempt, BACKOFF_STEPS_MS.length - 1)];
  const jitter = base * BACKOFF_JITTER * (Math.random() * 2 - 1);
  return Math.max(250, Math.round(base + jitter));
}

// The ack the backend returns for each subscribe shape (server.js: SUBSCRIBE
// → SUBSCRIBED, SUBSCRIBE_ORG → SUBSCRIBED_ORG). The retry loop waits for the
// one matching the CURRENT subscribe shape, so a resubscribe mid-retry
// re-points cleanly at the new shape's ack.
function expectedAckFor(sub: SubscribeMessage): 'SUBSCRIBED' | 'SUBSCRIBED_ORG' {
  return sub.type === 'SUBSCRIBE_ORG' ? 'SUBSCRIBED_ORG' : 'SUBSCRIBED';
}

// Cheap structural equality for SubscribeMessage. Used to short-circuit
// no-op resubscribes (e.g. AppState→active → reevaluateMode produces the
// same actives set as before).
function subscribesEqual(a: SubscribeMessage, b: SubscribeMessage): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'SUBSCRIBE_ORG') return true;
  const ai = (a as { deployment_ids: string[] }).deployment_ids;
  const bi = (b as { deployment_ids: string[] }).deployment_ids;
  if (ai.length !== bi.length) return false;
  const setA = new Set(ai);
  for (const x of bi) if (!setA.has(x)) return false;
  return true;
}

export function createWebSocket(
  subscribe: SubscribeMessage,
  onMessage: (msg: any) => void,
  opts: CreateWebSocketOptions = {},
): ReconnectingWebSocket {
  let ws: WebSocket | null = null;
  let statusVal: WsStatus = 'connecting';
  let disposed = false;
  let hasEverConnected = false;
  let hadUnexpectedClose = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let subRetryTimer: ReturnType<typeof setInterval> | null = null;
  let subscribeAcked = false;
  let subRetries = 0;
  // Mutable so resubscribe() can swap the shape sent on each (re)connect
  // without tearing down the socket.
  let currentSubscribe: SubscribeMessage = subscribe;

  const clearReconnect = () => {
    if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };
  const clearKeepalive = () => {
    if (keepaliveTimer !== null) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
  };
  const clearSubRetry = () => {
    if (subRetryTimer !== null) { clearInterval(subRetryTimer); subRetryTimer = null; }
  };

  const connect = async () => {
    if (disposed) return;
    statusVal = hasEverConnected ? 'reconnecting' : 'connecting';

    // Phase A: pass JWT in the handshake URL so the backend can attach
    // ws.orgId on connect. Re-read on every attempt so a token refresh
    // between drops doesn't leave a stale token in the URL.
    let token: string | null = null;
    try { token = await getToken(); } catch { token = null; }
    if (disposed) return;

    const url = token
      ? `${WS_URL}?token=${encodeURIComponent(token)}`
      : WS_URL;
    const socket = new WebSocket(url);
    ws = socket;

    socket.onopen = () => {
      console.info('[ws] connected to', WS_URL);
      statusVal = 'connected';
      attempt = 0;
      const wasReconnect = hasEverConnected && hadUnexpectedClose;
      hasEverConnected = true;
      hadUnexpectedClose = false;

      // Ack-gated subscribe: re-send until the backend acks, so a dropped
      // first frame (see SUB_RETRY_INTERVAL_MS note) can't leave us silently
      // unsubscribed. Re-armed on every (re)connect. `onmessage` clears it.
      subscribeAcked = false;
      subRetries = 0;
      clearSubRetry();
      const sendSub = () => {
        if (socket.readyState === WebSocket.OPEN) {
          try { socket.send(JSON.stringify(currentSubscribe)); } catch {}
        }
      };
      sendSub(); // attempt 1 — may be eaten by the post-upgrade race
      subRetryTimer = setInterval(() => {
        if (subscribeAcked || disposed || socket.readyState !== WebSocket.OPEN) {
          clearSubRetry();
          return;
        }
        if (subRetries >= SUB_MAX_RETRIES) {
          clearSubRetry();
          console.warn('[ws] subscribe never acked after retries — live feed may stay silent until reconnect');
          return;
        }
        subRetries += 1;
        sendSub();
      }, SUB_RETRY_INTERVAL_MS);

      clearKeepalive();
      keepaliveTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          try { socket.send(JSON.stringify({ type: 'PING' })); } catch {}
        }
      }, KEEPALIVE_INTERVAL_MS);

      if (wasReconnect && opts.onReconnect) {
        try { opts.onReconnect(); } catch (err) {
          console.warn('[ws] onReconnect handler threw:', err);
        }
      }
    };

    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        // Clear the subscribe-retry loop once the backend confirms the CURRENT
        // shape's subscription. Still forwarded to onMessage (consumer ignores
        // acks) to preserve existing behavior.
        if (!subscribeAcked && (msg.type === 'SUBSCRIBED' || msg.type === 'SUBSCRIBED_ORG')
            && msg.type === expectedAckFor(currentSubscribe)) {
          subscribeAcked = true;
          clearSubRetry();
        }
        onMessage(msg);
      } catch {}
    };

    socket.onerror = (e: any) => {
      const reason = e?.message ?? e?.type ?? 'unknown';
      console.warn('[ws] error:', reason);
    };

    socket.onclose = (e: any) => {
      const code = e?.code ?? 0;
      const reason = e?.reason || 'no reason given';
      console.warn(`[ws] closed: code=${code} reason=${reason}`);
      clearKeepalive();
      clearSubRetry();
      ws = null;

      if (disposed) {
        statusVal = 'closed';
        return;
      }
      // 1000 = normal closure (our explicit dispose or clean shutdown).
      // Anything else — 1001 going away, 1006 abnormal, 1011 server error,
      // etc. — triggers reconnect.
      if (code === 1000) {
        statusVal = 'closed';
        return;
      }
      hadUnexpectedClose = true;
      statusVal = 'reconnecting';
      const delay = nextBackoff(attempt++);
      console.warn(`[ws] reconnect in ${delay}ms (attempt ${attempt})`);
      clearReconnect();
      reconnectTimer = setTimeout(connect, delay);
    };
  };

  connect();

  return {
    close() {
      disposed = true;
      clearReconnect();
      clearKeepalive();
      clearSubRetry();
      statusVal = 'closed';
      if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
        try { ws.close(1000, 'client dispose'); } catch {}
      }
      ws = null;
    },
    status: () => statusVal,
    resubscribe(next: SubscribeMessage) {
      if (subscribesEqual(currentSubscribe, next)) return;
      currentSubscribe = next;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(next)); } catch (err) {
          console.warn('[ws] resubscribe send failed:', err);
        }
      }
      // If not open, the next connect()'s onopen will send `currentSubscribe`.
    },
  };
}

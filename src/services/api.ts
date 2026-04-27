import * as SecureStore from 'expo-secure-store';

const BASE = 'https://api.westshoredrone.com/api';

async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync('auth_token');
}

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
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(extraHeaders || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
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
  register: (data: { name: string; email: string; org_name: string; password: string }) =>
    request('POST', '/auth/register', data),
  forgotPassword: (email: string) =>
    request('POST', '/auth/forgot-password', { email }),

  // Deployments
  getDeployments: () => request('GET', '/deployments'),
  createDeployment: (name: string, scheduledFor?: string) => {
    const body: any = { name };
    if (scheduledFor) body.scheduled_for = scheduledFor;
    return request('POST', '/deployments', body);
  },
  closeDeployment: (id: string) => request('POST', `/deployments/${id}/close`),
  extendDeployment: (id: string) => request('POST', `/deployments/${id}/extend`),
  cancelDeployment: (id: string) => request('POST', `/deployments/${id}/cancel`),
  deleteDeployment: (id: string) => request('DELETE', `/deployments/${id}`),

  // Nodes
  getNodes: (deploymentId?: string) =>
    request('GET', deploymentId ? `/deployments/${deploymentId}/nodes` : '/deployments/nodes'),
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
  getNodeLimit: () => request('GET', '/nodes/limit'),
  claimNode: (mac: string, name?: string) => {
    const body: any = { mac };
    if (name && name.trim()) body.name = name.trim();
    return request('POST', '/nodes/claim', body);
  },

  // Detections
  getDetections: (deploymentId: string) =>
    request('GET', `/detections/${deploymentId}`),
  deleteDrone: (deploymentId: string, uasId: string) =>
    request('DELETE', `/detections/${deploymentId}/${encodeURIComponent(uasId)}`),

  // Drone nicknames (per-org, UAS-ID-keyed; shared across deployments).
  // Server is authoritative — local state mirrors what the WS broadcasts.
  getDroneNicknames: (orgId: string) =>
    request('GET', `/orgs/${orgId}/drone-nicknames`),
  setDroneNickname: (orgId: string, uasId: string, nickname: string) =>
    request('PATCH', `/orgs/${orgId}/drones/${encodeURIComponent(uasId)}/nickname`, { nickname }),

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

export interface ReconnectingWebSocket {
  close(): void;
  status(): WsStatus;
}

interface CreateWebSocketOptions {
  // Called after a reconnect (NOT the first connect). Consumer uses this to
  // refetch any server state that may have changed while the WS was down.
  onReconnect?: () => void;
}

const WS_URL = 'wss://api.westshoredrone.com/ws';
const KEEPALIVE_INTERVAL_MS = 30_000;
const BACKOFF_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const BACKOFF_JITTER = 0.20;

function nextBackoff(attempt: number): number {
  const base = BACKOFF_STEPS_MS[Math.min(attempt, BACKOFF_STEPS_MS.length - 1)];
  const jitter = base * BACKOFF_JITTER * (Math.random() * 2 - 1);
  return Math.max(250, Math.round(base + jitter));
}

export function createWebSocket(
  deploymentId: string,
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

  const clearReconnect = () => {
    if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };
  const clearKeepalive = () => {
    if (keepaliveTimer !== null) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
  };

  const connect = () => {
    if (disposed) return;
    statusVal = hasEverConnected ? 'reconnecting' : 'connecting';

    const socket = new WebSocket(WS_URL);
    ws = socket;

    socket.onopen = async () => {
      console.info('[ws] connected to', WS_URL);
      statusVal = 'connected';
      attempt = 0;
      const wasReconnect = hasEverConnected && hadUnexpectedClose;
      hasEverConnected = true;
      hadUnexpectedClose = false;

      const token = await getToken();
      // Guard: another close/reconnect could have fired while awaiting token.
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: 'AUTH', token }));
      socket.send(JSON.stringify({ type: 'SUBSCRIBE', deployment_id: deploymentId }));

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
      statusVal = 'closed';
      if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
        try { ws.close(1000, 'client dispose'); } catch {}
      }
      ws = null;
    },
    status: () => statusVal,
  };
}

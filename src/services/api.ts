import * as SecureStore from 'expo-secure-store';

const BASE = 'https://airaware-backend-6jz6.onrender.com/api';

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
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

export const api = {
  // Auth
  login: (email: string, password: string) =>
    request('POST', '/auth/login', { email, password }),
  register: (data: { name: string; email: string; org_name: string; password: string }) =>
    request('POST', '/auth/register', data),
  forgotPassword: (email: string) =>
    request('POST', '/auth/forgot-password', { email }),

  // Deployments
  getDeployments: () => request('GET', '/deployments'),
  createDeployment: (name: string) => request('POST', '/deployments', { name }),
  closeDeployment: (id: string) => request('POST', `/deployments/${id}/close`),
  extendDeployment: (id: string) => request('POST', `/deployments/${id}/extend`),
  deleteDeployment: (id: string) => request('DELETE', `/deployments/${id}`),

  // Nodes
  getNodes: (deploymentId?: string) =>
    request('GET', deploymentId ? `/deployments/${deploymentId}/nodes` : '/deployments/nodes'),
  assignNode: (nodeId: string, deploymentId: string) =>
    request('PATCH', `/deployments/nodes/${nodeId}/assign`, { deployment_id: deploymentId }),
  unassignNode: (nodeId: string) =>
    request('PATCH', `/deployments/nodes/${nodeId}/assign`, { deployment_id: null }),
  nodeHeartbeat: (apiKey: string, location: { lat: number; lon: number }) =>
    request(
      'POST',
      '/nodes/heartbeat',
      { lat: location.lat, lon: location.lon, connection_type: 'ble_relay' },
      { 'X-Node-Api-Key': apiKey },
    ),

  // Detections
  getDetections: (deploymentId: string) =>
    request('GET', `/detections/${deploymentId}`),
  deleteDrone: (deploymentId: string, uasId: string) =>
    request('DELETE', `/detections/${deploymentId}/${encodeURIComponent(uasId)}`),

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

// WebSocket connection
export function createWebSocket(deploymentId: string, onMessage: (msg: any) => void) {
  const WS_BASE = 'wss://airaware-backend-6jz6.onrender.com';
  const ws = new WebSocket(WS_BASE);

  ws.onopen = async () => {
    const token = await getToken();
    ws.send(JSON.stringify({ type: 'AUTH', token }));
    ws.send(JSON.stringify({ type: 'SUBSCRIBE', deployment_id: deploymentId }));
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      onMessage(msg);
    } catch {}
  };

  return ws;
}

// "NODE" row of the Live Map drone detail sheet. Pure, so it is unit-tested
// without UI (test/detectedByNodes.test.mjs).
//
// The backend now records which node produced each flight path point
// (migration 089) and the detections hydrate (GET /api/detections/:id) carries
// `current_flight_nodes` — every node that has recorded the drone's latest
// flight. WS DRONE_UPDATEs don't carry it; the drone store merges updates over
// the hydrated row, so the list survives and the live node (node_name, or the
// BLE source node) is added to it. Older backends / unstamped data send no
// list → just the live node, exactly as before.
//
// Nodes the viewer's org can't see (e.g. another org's open-relay node) arrive
// already redacted by the backend (services/nodeVisibility.js): node_name is
// "Partner node", and the list holds ONE { id: null, name: 'Partner node',
// redacted: true, count } entry for all of them. Rendered as "Partner node" or
// "Partner node ×N" — never blank or "undefined".

export const PARTNER_NODE_LABEL = 'Partner node';

export type FlightNode =
  | { id?: string | null; name?: string | null; redacted?: boolean; count?: number }
  | null
  | undefined;

function entryLabel(n: FlightNode): string {
  if (!n) return '';
  if (n.redacted) {
    return typeof n.count === 'number' && n.count > 1
      ? `${PARTNER_NODE_LABEL} ×${n.count}`
      : PARTNER_NODE_LABEL;
  }
  return typeof n.name === 'string' ? n.name.trim() : '';
}

export function detectedByNodesLabel(
  liveNodeName: string | null | undefined,
  currentFlightNodes: FlightNode[] | null | undefined,
): string {
  const names: string[] = [];
  const add = (s: string) => {
    if (s && !names.includes(s)) names.push(s);
  };
  const flight = (currentFlightNodes || []).map(entryLabel);
  const live = typeof liveNodeName === 'string' ? liveNodeName.trim() : '';
  // A redacted live node is already represented by the flight's
  // "Partner node ×N" entry — don't list "Partner node" twice.
  const liveIsPartner = live === PARTNER_NODE_LABEL;
  if (!(liveIsPartner && flight.some((f) => f.startsWith(PARTNER_NODE_LABEL)))) add(live);
  for (const f of flight) add(f);
  return names.length > 0 ? names.join(', ') : '—';
}

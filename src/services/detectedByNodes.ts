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

export type FlightNode = { id?: string | null; name?: string | null } | null | undefined;

export function detectedByNodesLabel(
  liveNodeName: string | null | undefined,
  currentFlightNodes: FlightNode[] | null | undefined,
): string {
  const names: string[] = [];
  const add = (n: unknown) => {
    const s = typeof n === 'string' ? n.trim() : '';
    if (s && !names.includes(s)) names.push(s);
  };
  add(liveNodeName);
  for (const n of currentFlightNodes || []) add(n?.name);
  return names.length > 0 ? names.join(', ') : '—';
}

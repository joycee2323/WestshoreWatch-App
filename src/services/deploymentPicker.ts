// Option building for the Nodes screen's "Assign to Deployment" picker
// (components/DeploymentPickerModal). Pure, so it is unit-tested without UI
// (test/deploymentPicker.test.mjs).
//
// Every deployment passed in becomes an option, in the given order — no cap.
// The picker used to be a native Alert.alert, and Android's AlertDialog keeps
// only the first 3 buttons (React Native: buttons.slice(0, 3)), which dropped
// the 4th+ deployment and, from 3 deployments up, the Cancel button.

export type DeploymentOption = { id: string; label: string };

export function deploymentPickerOptions(
  deployments: Array<{ id?: string | null; name?: string | null }> | null | undefined,
): DeploymentOption[] {
  const out: DeploymentOption[] = [];
  for (const d of deployments || []) {
    if (!d || !d.id) continue;
    const name = typeof d.name === 'string' ? d.name.trim() : '';
    out.push({ id: d.id, label: name || d.id });
  }
  return out;
}

// Title line under the picker heading, matching the old Alert's message.
export function deploymentPickerPrompt(nodeName: string | null | undefined): string {
  const name = typeof nodeName === 'string' && nodeName.trim() ? nodeName.trim() : 'this node';
  return `Select a deployment for "${name}"`;
}

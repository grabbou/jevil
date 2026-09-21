import { assertReadable, buildActions } from './actions.mjs';

const role = node => String(node.type || node.role || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const fields = new Set(['textfield', 'securetextfield', 'textbox', 'edittext', 'searchfield', 'textview', 'textarea']);
const texts = new Set(['statictext', 'text', 'label', 'heading']);
const editable = node => node.editable === true || fields.has(role(node));
const app = snapshot => snapshot.appBundleId ? `bundle:${snapshot.appBundleId}` : snapshot.appName ? `name:${snapshot.appName}` : null;
const keyboardContainers = new Set(['keyboard', 'uikeyboardlayoutstar', 'uiremotekeyboardplaceholderview']);
const nodeRoles = node => [node.type, node.role].map(value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
// Native iOS snapshots use type Other with the concrete keyboard class in role.
// Inspect both independently rather than letting the generic type hide the role.
const isKeyboardContainer = node => nodeRoles(node).some(value => keyboardContainers.has(value));
const isModal = node => nodeRoles(node).some(value => ['alert', 'dialog', 'alertdialog', 'sheet', 'uialertcontroller'].includes(value)) || node.modal === true || node.isModal === true;

const validRect = rect => rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0;
const contains = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const keyboardBlocks = (node, snapshot) => snapshot.nodes.some(candidate => isKeyboardContainer(candidate) && candidate.visibleToUser !== false &&
  (!validRect(candidate.rect) || !validRect(node.rect) || overlaps(node.rect, candidate.rect)));

function geometryEligible(node, snapshot) {
  const visibility = snapshot.visibility;
  if (snapshot.truncated || visibility?.partial !== false || !Number.isSafeInteger(visibility.totalNodeCount) ||
    visibility.visibleNodeCount !== visibility.totalNodeCount || visibility.totalNodeCount !== snapshot.nodes.length ||
    !validRect(node.rect) || node.visibleToUser === false || node.interactionBlocked) return false;
  const applications = snapshot.nodes.filter(candidate => role(candidate) === 'application');
  if (applications.length !== 1 || !validRect(applications[0].rect) || !contains(applications[0].rect, node.rect)) return false;
  // A known keyboard without usable bounds cannot be ruled out as an occluder.
  return !keyboardBlocks(node, snapshot);
}

const observedInFrame = (node, snapshot) => !keyboardBlocks(node, snapshot) && (node.visibleToUser === true ||
  (node.visibleToUser == null && geometryEligible(node, snapshot)));

function nonKeyboardNodes(snapshot) {
  const indexed = new Map(snapshot.nodes.map((node, position) => [node.index ?? position, node]));
  const inKeyboard = node => {
    const visited = new Set();
    for (let current = node; current && !visited.has(current); current = indexed.get(current.parentIndex)) {
      if (isKeyboardContainer(current) || nodeRoles(current).includes('key')) return true;
      visited.add(current);
    }
    return false;
  };
  return snapshot.nodes.filter(node => node.visibleToUser !== false && !inKeyboard(node));
}

function formIdentity(nodes, snapshot) {
  const result = new Map();
  for (const node of nodes.filter(editable)) {
    if (!observedInFrame(node, snapshot) || typeof node.identifier !== 'string' || !node.identifier.trim() || result.has(node.identifier)) return null;
    result.set(node.identifier, node);
  }
  return result;
}

/**
 * Rebind one previously chosen fill against a newly captured full snapshot.
 * Null means skip/replan, never permission to execute the original ref.
 * This recognizes known accessibility modal roles, not arbitrary overlays.
 * agent-device 0.21.6 on iOS omits unavailable visibleToUser/hittable facts. For this bounded
 * opt-in strategy, a complete viewport plus fully contained rects can make a
 * node eligible; geometry is not general proof of visibility or hittability.
 * No native facts are fabricated, and dispatch retains agent-device's guards.
 */
export function resolvePlannedFill(originalAction, originalSnapshot, freshSnapshot, inputs = {}) {
  try {
    assertReadable(originalSnapshot);
    assertReadable(freshSnapshot);
    if ([originalSnapshot, freshSnapshot].some(snapshot => snapshot.truncated || snapshot.visibility?.partial === true)) return null;
    if (originalAction?.kind !== 'fill' || typeof originalAction.text !== 'string') return null;
    if (!app(originalSnapshot) || app(originalSnapshot) !== app(freshSnapshot)) return null;
    if (!Number.isSafeInteger(originalSnapshot.refsGeneration) || !Number.isSafeInteger(freshSnapshot.refsGeneration) ||
      freshSnapshot.refsGeneration <= originalSnapshot.refsGeneration) return null;
    if ([originalSnapshot, freshSnapshot].some(snapshot => snapshot.systemSurfaceOnly || snapshot.iosSystemSurfaceBundleId)) return null;

    const originalNodes = nonKeyboardNodes(originalSnapshot);
    const freshNodes = nonKeyboardNodes(freshSnapshot);
    if ([...originalNodes, ...freshNodes].some(isModal)) return null;
    const before = formIdentity(originalNodes, originalSnapshot);
    const after = formIdentity(freshNodes, freshSnapshot);
    if (!before?.size || !after || before.size !== after.size) return null;
    for (const [identifier, node] of before) {
      const current = after.get(identifier);
      if (!current || role(current) !== role(node) || current.label !== node.label) return null;
    }

    // Require positive screen identity beyond editable fields. Keyboard labels
    // and already executed fields can legitimately change after typing.
    const landmarks = (nodes, snapshot) => nodes.filter(node => !editable(node) && texts.has(role(node)) && observedInFrame(node, snapshot) && node.label)
      .map(node => JSON.stringify([role(node), node.label, node.identifier ?? null])).sort();
    const originalLandmarks = landmarks(originalNodes, originalSnapshot);
    const freshLandmarks = landmarks(freshNodes, freshSnapshot);
    if (!originalLandmarks.length || JSON.stringify(originalLandmarks) !== JSON.stringify(freshLandmarks)) return null;

    const target = after.get(originalAction.target);
    // Autofill or another actor may have changed a pending field. Its original
    // decision no longer applies, even if the new value differs from the plan.
    if (target?.value !== before.get(originalAction.target)?.value) return null;
    if (!target || freshNodes.filter(node => node.identifier === originalAction.target).length !== 1 ||
      !observedInFrame(target, freshSnapshot) || target.enabled !== true || target.hittable === false ||
      (target.hittable !== true && !geometryEligible(target, freshSnapshot)) || target.interactionBlocked ||
      target.editable === false || target.value === originalAction.text) return null;
    const matches = action => action.kind === 'fill' && action.target === originalAction.target && action.text === originalAction.text &&
      (originalAction.inputName == null || action.inputName === originalAction.inputName);
    // Only a plan originally drawn from legal actions with supplied values is
    // eligible. New refs are issued exclusively by buildActions(freshSnapshot).
    if (!buildActions(originalSnapshot, inputs).some(action => matches(action) && action.ref === originalAction.ref)) return null;
    const candidates = buildActions(freshSnapshot, inputs).filter(matches);
    if (candidates.length !== 1 || !candidates[0].ref.endsWith(`~s${freshSnapshot.refsGeneration}`)) return null;
    return candidates[0];
  } catch {
    // Incomplete/malformed snapshots and excessive candidate sets trigger the
    // ordinary observe/decide path rather than executing a queued mutation.
    return null;
  }
}

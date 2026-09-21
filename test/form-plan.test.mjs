import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActions } from '../src/actions.mjs';
import { resolvePlannedFill } from '../src/form-plan.mjs';

const inputs = { name: 'Ada', email: 'ada@example.com' };
const snapshot = generation => ({ appBundleId: 'test.form', refsGeneration: generation, nodes: [
  { index: 0, ref: '@e1', type: 'StaticText', identifier: 'title', label: 'Contact details', visibleToUser: true },
  ...['Name', 'Email'].map((label, index) => ({ index: index + 1, ref: `@e${generation * 10 + index}`, type: 'TextField',
    identifier: `field-${label.toLowerCase()}`, label, value: '', visibleToUser: true, hittable: true, enabled: true })),
] });
function run(change = () => {}) {
  const original = snapshot(1);
  const fresh = snapshot(3);
  const action = buildActions(original, inputs).find(action => action.kind === 'fill' && action.target === 'field-email' && action.inputName === 'email');
  change({ original, fresh, action });
  return resolvePlannedFill(action, original, fresh, inputs);
}

test('rebinds planned fill to fresh node and generation', () => {
  const action = run(({ fresh }) => { fresh.nodes[1].value = 'Ada'; });
  assert.equal(action.ref, '@e31~s3');
  assert.equal(action.text, inputs.email);
});
test('keyboard and its added text do not invalidate the form identity', () => {
  assert.ok(run(({ fresh }) => { fresh.nodes.forEach((node, index) => { node.rect = { x: 20, y: 40 + index * 50, width: 250, height: 40 }; }); fresh.nodes.push(
    { index: 10, type: 'Keyboard', visibleToUser: true, rect: { x: 0, y: 500, width: 390, height: 344 } },
    { index: 11, parentIndex: 10, type: 'StaticText', label: 'Suggestion', visibleToUser: true },
    { index: 12, parentIndex: 10, type: 'TextField', label: 'Keyboard buffer', visibleToUser: true },
  ); }));
});

for (const [name, change] of [
  ['different app', ({ fresh }) => { fresh.appBundleId = 'other.app'; }],
  ['unknown app identity', ({ original, fresh }) => { delete original.appBundleId; delete fresh.appBundleId; }],
  ['old generation', ({ fresh }) => { fresh.refsGeneration = 1; }],
  ['unknown generation', ({ fresh }) => { delete fresh.refsGeneration; }],
  ['incomplete snapshot', ({ fresh }) => { fresh.truncated = true; }],
  ['partial snapshot despite explicit visible nodes', ({ fresh }) => { fresh.visibility = { partial: true }; }],
  ['system surface', ({ fresh }) => { fresh.iosSystemSurfaceBundleId = 'apple.sheet'; }],
  ['missing field', ({ fresh }) => { fresh.nodes.pop(); }],
  ['new field', ({ fresh }) => { fresh.nodes.push({ ...fresh.nodes[1], identifier: 'field-phone' }); }],
  ['duplicate field identifier', ({ fresh }) => { fresh.nodes.push({ ...fresh.nodes[2] }); }],
  ['duplicate target on noneditable node', ({ fresh }) => { fresh.nodes.push({ type: 'Button', identifier: 'field-email', visibleToUser: true }); }],
  ['missing field identifier', ({ fresh }) => { delete fresh.nodes[2].identifier; }],
  ['missing landmark', ({ fresh }) => { fresh.nodes.shift(); }],
  ['changed screen title', ({ fresh }) => { fresh.nodes[0].label = 'Different form'; }],
  ['new inline validation message', ({ fresh }) => { fresh.nodes.push({ type: 'StaticText', identifier: 'name-error', label: 'Name is invalid', visibleToUser: true }); }],
  ['new text instruction', ({ fresh }) => { fresh.nodes.push({ type: 'StaticText', label: 'Use another email address', visibleToUser: true }); }],
  ['duplicate original landmark', ({ fresh }) => { fresh.nodes.push({ ...fresh.nodes[0], index: 99, ref: 'e99' }); }],
  ['landmark gains changed identity', ({ fresh }) => { fresh.nodes[0].identifier = 'different-title'; }],
  ['hidden landmark', ({ fresh }) => { fresh.nodes[0].visibleToUser = false; }],
  ['changed field meaning', ({ fresh }) => { fresh.nodes[2].label = 'Password'; }],
  ['unknown target visibility', ({ fresh }) => { delete fresh.nodes[2].visibleToUser; }],
  ['hidden target', ({ fresh }) => { fresh.nodes[2].visibleToUser = false; }],
  ['unknown target hittability', ({ fresh }) => { delete fresh.nodes[2].hittable; }],
  ['unknown target enabled state', ({ fresh }) => { delete fresh.nodes[2].enabled; }],
  ['stale ref embedded in fresh frame', ({ fresh }) => { fresh.nodes[2].ref = '@e31~s1'; }],
  ['disabled target', ({ fresh }) => { fresh.nodes[2].enabled = false; }],
  ['blocked target', ({ fresh }) => { fresh.nodes[2].interactionBlocked = 'overlay'; }],
  ['explicitly noneditable target', ({ fresh }) => { fresh.nodes[2].editable = false; }],
  ['modal dialog', ({ fresh }) => { fresh.nodes.push({ type: 'Alert', visibleToUser: true }); }],
  ['modal native role hidden by generic type', ({ fresh }) => { fresh.nodes.push({ type: 'Other', role: 'UIAlertController', visibleToUser: true }); }],
  ['already filled', ({ fresh }) => { fresh.nodes[2].value = inputs.email; }],
  ['pending target autofilled with another value', ({ fresh }) => { fresh.nodes[2].value = 'autofilled@example.com'; }],
  ['pending target cleared', ({ original }) => { original.nodes[2].value = 'previous@example.com'; }],
  ['pending target value no longer observable', ({ fresh }) => { delete fresh.nodes[2].value; }],
  ['unsupplied text', ({ action }) => { action.text = 'invented'; }],
  ['original ref not in original frame', ({ action }) => { action.ref = '@e99~s1'; }],
  ['nonfill action', ({ action }) => { action.kind = 'press'; }],
]) test(`rejects ${name}`, () => assert.equal(run(change), null));

test('malformed observations return null', () => {
  assert.equal(resolvePlannedFill({}, null, null, inputs), null);
});

function geometryFrame(frame) {
  frame.nodes.forEach((node, index) => {
    delete node.visibleToUser;
    delete node.hittable;
    node.rect = { x: 20, y: 40 + index * 50, width: 250, height: 40 };
  });
  frame.nodes.push({ index: 100, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } });
  frame.truncated = false;
  frame.visibility = { partial: false, visibleNodeCount: frame.nodes.length, totalNodeCount: frame.nodes.length };
}
const geometryRun = change => run(context => {
  geometryFrame(context.original);
  geometryFrame(context.fresh);
  change?.(context);
});

test('fixture geometry allows absent iOS visibility and hittability without fabricating facts', () => {
  let observed;
  const action = geometryRun(({ fresh }) => { observed = fresh; });
  assert.equal(action.ref, '@e31~s3');
  assert.equal(observed.nodes[2].visibleToUser, undefined);
  assert.equal(observed.nodes[2].hittable, undefined);
});
for (const [name, change] of [
  ['partly outside viewport', ({ fresh }) => { fresh.nodes[2].rect.x = 300; }],
  ['negative dimensions', ({ fresh }) => { fresh.nodes[2].rect.width = -1; }],
  ['unknown viewport bounds', ({ fresh }) => { delete fresh.nodes[3].rect; }],
  ['unknown target bounds', ({ fresh }) => { delete fresh.nodes[2].rect; }],
  ['partial visibility', ({ fresh }) => { fresh.visibility.partial = true; }],
  ['unknown counts', ({ fresh }) => { delete fresh.visibility.totalNodeCount; }],
  ['mismatched counts', ({ fresh }) => { fresh.visibility.totalNodeCount++; }],
  ['explicitly hidden target', ({ fresh }) => { fresh.nodes[2].visibleToUser = false; }],
  ['explicitly unhittable target', ({ fresh }) => { fresh.nodes[2].hittable = false; }],
  ['modal over geometry eligible form', ({ fresh }) => { fresh.nodes[3].isModal = true; }],
]) test(`geometry fallback rejects ${name}`, () => assert.equal(geometryRun(change), null));

function addKeyboard(fresh, rect) {
  fresh.nodes.push({ index: 101, type: 'Keyboard', rect });
  fresh.visibility.totalNodeCount++;
  fresh.visibility.visibleNodeCount++;
}
test('geometry fallback rejects keyboard occlusion', () => {
  assert.equal(geometryRun(({ fresh }) => addKeyboard(fresh, { x: 0, y: 120, width: 390, height: 724 })), null);
});
test('geometry fallback rejects keyboard with unknown bounds', () => {
  assert.equal(geometryRun(({ fresh }) => addKeyboard(fresh)), null);
});
test('geometry fallback allows known keyboard below all form fields', () => {
  assert.ok(geometryRun(({ fresh }) => addKeyboard(fresh, { x: 0, y: 500, width: 390, height: 344 })));
});

// Container shapes captured in artifacts/poc-form-screening/results.json.
const nativeKeyboardShapes = [
  { index: 8, parentIndex: 0, type: 'Other', role: '_UIRemoteKeyboardPlaceholderView', identifier: 'inputView',
    rect: { x: 0, y: 611, width: 440, height: 345 }, enabled: true, depth: 1, ref: 'e9' },
  { index: 13, parentIndex: 0, type: 'Other', role: 'UIKeyboardLayoutStar',
    rect: { x: 0, y: 655, width: 440, height: 243 }, enabled: true, depth: 1, ref: 'e14' },
];
function appendNativeKeyboard(fresh, shape, changes = {}) {
  fresh.nodes.push({ ...shape, ...changes });
  fresh.visibility.totalNodeCount++;
  fresh.visibility.visibleNodeCount++;
}
for (const shape of nativeKeyboardShapes) {
  test(`native ${shape.role} below form stays eligible`, () => {
    assert.ok(geometryRun(({ fresh }) => appendNativeKeyboard(fresh, shape)));
  });
  test(`native ${shape.role} overlapping target blocks queued fill`, () => {
    assert.equal(geometryRun(({ fresh }) => appendNativeKeyboard(fresh, shape, {
      rect: { ...shape.rect, y: 120 },
    })), null);
  });
  test(`native ${shape.role} with unknown bounds blocks queued fill`, () => {
    assert.equal(geometryRun(({ fresh }) => appendNativeKeyboard(fresh, shape, { rect: undefined })), null);
  });
  test(`native ${shape.role} identified by type independently blocks overlap`, () => {
    assert.equal(geometryRun(({ fresh }) => appendNativeKeyboard(fresh, shape, {
      type: shape.role, role: 'Other', rect: { ...shape.rect, y: 120 },
    })), null);
  });
}
test('native keyboard descendants are excluded from stable form identity', () => {
  assert.ok(geometryRun(({ fresh }) => {
    const shape = nativeKeyboardShapes[0];
    appendNativeKeyboard(fresh, shape);
    fresh.nodes.push({ index: 20, parentIndex: shape.index, type: 'TextField', label: 'Keyboard buffer',
      rect: { x: 20, y: 640, width: 100, height: 30 } });
    fresh.visibility.totalNodeCount++;
    fresh.visibility.visibleNodeCount++;
  }));
});
test('native keyboard occlusion blocks even explicitly visible and hittable target', () => {
  assert.equal(geometryRun(({ fresh }) => {
    fresh.nodes[2].visibleToUser = true;
    fresh.nodes[2].hittable = true;
    appendNativeKeyboard(fresh, nativeKeyboardShapes[0], { rect: { x: 0, y: 120, width: 440, height: 345 } });
  }), null);
});

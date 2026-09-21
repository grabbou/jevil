import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOracle } from '../benchmarks/oracle.mjs';

const navigation = {
  screen: 'details', events: ['browse', 'backpack'], label: 'Canvas backpack details',
  labels: ['Canvas backpack details', 'Price: 49 credits', 'In stock'],
};

function snapshot(labels) {
  return { nodes: labels.map(label => ({ label, visibleToUser: true })) };
}

function navigationEvidence() {
  return {
    scenario: 'navigation', spec: navigation,
    terminalSnapshot: snapshot(navigation.labels), finalSnapshot: snapshot(navigation.labels),
    terminalOracle: { screen: 'details', events: ['browse', 'backpack'], values: {} },
    oracle: { screen: 'details', events: ['browse', 'backpack'], values: {} },
  };
}

test('accepts independently verified navigation at decision and afterward', () => {
  assert.equal(evaluateOracle(navigationEvidence()), true);
});

test('requires all requested content, not only the product heading', () => {
  for (const moment of ['terminalSnapshot', 'finalSnapshot']) {
    const evidence = navigationEvidence();
    evidence[moment] = snapshot(['Canvas backpack details']);
    assert.equal(evaluateOracle(evidence), false);
  }
});

test('missing, unknown and false visibility cannot prove a visible target', () => {
  for (const visibility of [undefined, null, false, 'true']) {
    const evidence = navigationEvidence();
    evidence.terminalSnapshot.nodes[1].visibleToUser = visibility;
    assert.equal(evaluateOracle(evidence), false);
  }
});

test('requires exact ordered button events and target screen', () => {
  for (const events of [['backpack', 'browse'], ['browse', 'mug', 'backpack'], ['browse'], ['browse', 'backpack', 'home']]) {
    const evidence = navigationEvidence();
    evidence.oracle.events = events;
    assert.equal(evaluateOracle(evidence), false);
  }
  const evidence = navigationEvidence();
  evidence.oracle.screen = 'catalog';
  assert.equal(evaluateOracle(evidence), false);
});

test('late appearing result cannot turn a premature PASS into a correct verdict', () => {
  const spec = { screen: 'result', events: ['delayed', 'view-result'], label: 'Reference: BENCH-204' };
  const evidence = {
    scenario: 'delayed', spec,
    terminalSnapshot: snapshot(['Loading result…']), finalSnapshot: snapshot([spec.label]),
    terminalOracle: { screen: 'result', events: [...spec.events], values: {} },
    oracle: { screen: 'result', events: [...spec.events], values: {} },
  };
  assert.equal(evaluateOracle(evidence), false);
  evidence.terminalSnapshot = snapshot([spec.label]);
  assert.equal(evaluateOracle(evidence), true);
});

test('form confirmation requires exact independently stored values', () => {
  const spec = { screen: 'saved', events: ['contact', 'save'], label: 'Contact saved: Ada, ada@example.com' };
  const evidence = {
    scenario: 'form', spec,
    terminalSnapshot: snapshot([spec.label]), finalSnapshot: snapshot([spec.label]),
    terminalOracle: { screen: 'saved', events: [...spec.events], values: { Name: 'Ada', Email: 'ada@example.com' } },
    oracle: { screen: 'saved', events: [...spec.events], values: { Name: 'Ada', Email: 'ada@example.com' } },
  };
  assert.equal(evaluateOracle(evidence), true);
  for (const moment of ['oracle', 'terminalOracle']) {
    for (const values of [{ Name: 'Other', Email: 'ada@example.com' }, { Name: 'Ada', Email: 'wrong@example.com' }, {}, undefined]) {
      assert.equal(evaluateOracle({ ...evidence, [moment]: { ...evidence[moment], values } }), false);
    }
  }
});

test('missing evidence and malformed specs fail closed', () => {
  assert.equal(evaluateOracle(), false);
  for (const field of ['terminalSnapshot', 'finalSnapshot', 'terminalOracle', 'oracle', 'spec']) {
    assert.equal(evaluateOracle({ ...navigationEvidence(), [field]: null }), false);
  }
  assert.equal(evaluateOracle({ ...navigationEvidence(), spec: { ...navigation, labels: [] } }), false);
  assert.equal(evaluateOracle({ ...navigationEvidence(), spec: { screen: 'details', events: [] } }), false);
});

function nativeEvidence() {
  const evidence = navigationEvidence();
  for (const name of ['terminalSnapshot', 'finalSnapshot']) {
    evidence[name] = {
      appBundleId: 'local.jev.benchmark',
      nodes: [
        { type: 'Application', rect: { x: 0, y: 0, width: 440, height: 956 } },
        ...navigation.labels.map((label, index) => ({ label, rect: { x: 24, y: 86 + index * 40, width: 392, height: 26 } })),
      ],
    };
  }
  evidence.oracle.visibleLabels = [...navigation.labels];
  evidence.terminalOracle.visibleLabels = [...navigation.labels];
  return evidence;
}

test('fixture native visibility and contained geometry support omitted SDK visibility', () => {
  assert.equal(evaluateOracle(nativeEvidence()), true);
});

test('native fallback requires fixture identity, native labels at both times, and snapshot labels', () => {
  for (const name of ['oracle', 'terminalOracle']) {
    const evidence = nativeEvidence();
    delete evidence[name].visibleLabels;
    assert.equal(evaluateOracle(evidence), false);
  }
  for (const name of ['finalSnapshot', 'terminalSnapshot']) {
    const evidence = nativeEvidence();
    evidence[name].appBundleId = 'another.app';
    assert.equal(evaluateOracle(evidence), false);
    evidence[name].appBundleId = 'local.jev.benchmark';
    evidence[name].nodes.pop();
    assert.equal(evaluateOracle(evidence), false);
  }
});

test('explicit invisibility overrides native visibility claims', () => {
  for (const contradiction of [{ visibleToUser: false }, { hidden: true }, { isHidden: true }, { visible: false }]) {
    const evidence = nativeEvidence();
    Object.assign(evidence.terminalSnapshot.nodes[1], contradiction);
    assert.equal(evaluateOracle(evidence), false);
  }
});

test('native fallback rejects partial, zero, negative and invalid label rectangles', () => {
  for (const rect of [
    { x: -1, y: 1, width: 20, height: 20 },
    { x: 420, y: 1, width: 21, height: 20 },
    { x: 1, y: 950, width: 20, height: 20 },
    { x: 1, y: 1, width: 0, height: 20 },
    { x: 1, y: 1, width: 20, height: -1 },
    { x: NaN, y: 1, width: 20, height: 20 },
    undefined,
  ]) {
    const evidence = nativeEvidence();
    evidence.terminalSnapshot.nodes[1].rect = rect;
    assert.equal(evaluateOracle(evidence), false);
  }
});

test('later correct native state cannot replace incorrect verdict-time screen or events', () => {
  for (const change of [{ screen: 'loading' }, { events: ['browse'] }]) {
    const evidence = nativeEvidence();
    Object.assign(evidence.terminalOracle, change);
    assert.equal(evaluateOracle(evidence), false);
  }
});

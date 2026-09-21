import test from 'node:test';
import assert from 'node:assert/strict';
import { FormPlanModel } from '../src/form-model.mjs';
import { JevModel } from '../src/jev.mjs';
import { buildActions, prepareSnapshot } from '../src/actions.mjs';

const snapshot = { refsGeneration: 2, nodes: [
  { ref: 'e1', identifier: 'name', label: 'Name', type: 'text-field', value: '', visibleToUser: true, hittable: true },
  { ref: 'e2', identifier: 'email', label: 'Email', type: 'text-field', value: '', visibleToUser: true, hittable: true },
  { ref: 'e3', identifier: 'save', label: 'Save', type: 'button', visibleToUser: true, hittable: true },
] };
const state = { task: 'Fill Name with Ada and Email with ada@example.com. Do not save.', screen: prepareSnapshot(snapshot), previousScreen: null, previousAction: null };
const actions = buildActions(snapshot, { name: 'Ada', email: 'ada@example.com' });
const nameAda = actions.find(a => a.kind === 'fill' && a.target === 'name' && a.text === 'Ada');
const nameEmail = actions.find(a => a.kind === 'fill' && a.target === 'name' && a.text === 'ada@example.com');
const emailEmail = actions.find(a => a.kind === 'fill' && a.target === 'email' && a.text === 'ada@example.com');
const nameFocus = actions.find(a => a.kind === 'press' && a.target === 'name');
const answer = (choice, confidence = 0.9) => ({ choice, confidence, probabilities: { [choice]: 1 } });
function fixture(overrides = {}) {
  const calls = [];
  return { calls, client: { async systemOne(request, options) {
    calls.push({ request, options });
    return { model: 'jev-test', usage: { input_tokens: 123, output_tokens: 8 }, answers: {
      nextAction: answer(nameAda.id, 0.95), field0: answer(nameAda.id, 0.8), field1: answer(emailEmail.id, 0.6), ...overrides,
    } };
  } } };
}

test('form model sends one independent multi-question request with unchanged state, constraints and legal choices', async () => {
  const f = fixture();
  const signal = new AbortController().signal;
  const result = await new FormPlanModel({ client: f.client, model: 'pinned-model' }).decide({ state, actions, signal });
  assert.equal(f.calls.length, 1);
  const { request, options } = f.calls[0];
  assert.equal(request.state, state);
  assert.equal(options.signal, signal);
  assert.equal(request.model, 'pinned-model');
  assert.deepEqual(Object.keys(request.questions), ['nextAction', 'field0', 'field1']);
  assert.deepEqual(request.questions.nextAction.criteria, Object.fromEntries(actions.map(a => [a.id, a.description])));
  for (const [key, target] of [['field0', 'name'], ['field1', 'email']]) {
    assert.deepEqual(Object.keys(request.questions[key].criteria), [...actions.filter(a => a.kind === 'fill' && a.target === target).map(a => a.id), 'skip']);
    assert.match(request.questions[key].instructions, /Respect all task constraints/);
    assert.match(request.questions[key].instructions, /independent/);
  }
  assert.equal(result.choice, nameAda.id);
  assert.equal(result.confidence, 0.95);
  assert.equal(result.model, 'jev-test');
  assert.deepEqual(result.usage, { input_tokens: 123, output_tokens: 8 });
  assert.ok(result.latencyMs >= 0);
});

test('every planned fill carries its own mapping confidence without mutating legal actions', async () => {
  const f = fixture({ nextAction: answer(emailEmail.id, 0.97) });
  const original = structuredClone(actions);
  const result = await new FormPlanModel({ client: f.client }).decide({ state, actions });
  assert.deepEqual(result.plannedActions, [{ ...emailEmail, confidence: 0.6 }, { ...nameAda, confidence: 0.8 }]);
  assert.equal(result.confidence, 0.97);
  assert.deepEqual(actions, original);
  assert.equal(result.diagnostics.variant, 'form-plan');
  assert.equal(result.diagnostics.guard, null);
  assert.equal(result.diagnostics.fields[0].confidence, 0.8);
});

test('skip, disagreement, focus and terminal decisions never cause independent action or PASS promotion', async () => {
  for (const [next, name, email, expectedPlan] of [
    [nameAda.id, nameAda.id, 'skip', [nameAda.id]],
    [nameAda.id, 'skip', emailEmail.id, undefined],
    [nameAda.id, nameEmail.id, emailEmail.id, undefined],
    [nameFocus.id, nameAda.id, emailEmail.id, undefined],
    ['qa_pass', nameAda.id, emailEmail.id, undefined],
    ['qa_fail', nameAda.id, emailEmail.id, undefined],
    ['incomplete', 'skip', 'skip', undefined],
  ]) {
    const f = fixture({ nextAction: answer(next), field0: answer(name), field1: answer(email) });
    const result = await new FormPlanModel({ client: f.client }).decide({ state, actions });
    assert.equal(result.choice, next);
    assert.deepEqual(result.plannedActions?.map(a => a.id), expectedPlan);
    if (next === nameAda.id && name !== nameAda.id) assert.equal(result.diagnostics.guard, 'first_fill_mapping_disagrees');
  }
});

test('ambiguous target nodes, multiple refs, stale refs and unusable fields are excluded', async () => {
  const cases = [
    { nodes: [...state.screen.nodes, { ...state.screen.nodes[0], ref: 'e9' }] },
    { nodes: [{ ...state.screen.nodes[0], ref: 'replacement' }, ...state.screen.nodes.slice(1)] },
    ...[{ visibleToUser: false }, { hittable: false }, { enabled: false }, { interactionBlocked: true }, { role: 'button' }]
      .map(change => ({ nodes: [{ ...state.screen.nodes[0], ...change }, ...state.screen.nodes.slice(1)] })),
    { nodes: state.screen.nodes, actions: [...actions, { ...nameAda, id: 'duplicate-ref', ref: '@another' }] },
  ];
  for (const c of cases) {
    const f = fixture({ field0: answer(emailEmail.id) });
    const result = await new FormPlanModel({ client: f.client }).decide({ state: { ...state, screen: { nodes: c.nodes } }, actions: c.actions || actions });
    assert.equal(result.plannedActions, undefined);
    assert.equal(result.choice, nameAda.id);
    assert.equal(result.diagnostics.guard, 'first_fill_target_not_plan_eligible');
    assert.equal(Object.hasOwn(f.calls[0].request.questions, 'field1'), false);
    assert.ok(Object.hasOwn(f.calls[0].request.questions.field0.criteria, emailEmail.id));
  }
});

test('missing answers, cross-target answers and invalid field confidences fail closed before execution', async () => {
  for (const overrides of [
    { field1: undefined }, { field0: answer(emailEmail.id) }, { nextAction: answer('outside-list') },
    ...[NaN, Infinity, -0.1, 1.1, undefined, '0.5'].map(confidence => ({ field1: { ...answer(emailEmail.id), confidence } })),
  ]) {
    const f = fixture(overrides);
    await assert.rejects(new FormPlanModel({ client: f.client }).decide({ state, actions }), /invalid/);
    assert.equal(f.calls.length, 1);
  }
});

test('zero confidence is preserved for executor cutoff, never replaced by nextAction confidence', async () => {
  const f = fixture({ field0: answer(nameAda.id, 0), field1: answer(emailEmail.id, 0) });
  const result = await new FormPlanModel({ client: f.client }).decide({ state, actions });
  assert.equal(result.confidence, 0.95);
  assert.deepEqual(result.plannedActions.map(a => a.confidence), [0, 0]);
});

test('field count is bounded and targets with too many options remain ordinary single actions', async () => {
  const f = fixture();
  const result = await new FormPlanModel({ client: f.client, maxPlanFields: 1 }).decide({ state, actions });
  assert.deepEqual(Object.keys(f.calls[0].request.questions), ['nextAction', 'field0']);
  assert.deepEqual(result.plannedActions.map(a => a.id), [nameAda.id]);
  for (const maxPlanFields of [0, 11, 1.5, NaN]) assert.throws(() => new FormPlanModel({ client: f.client, maxPlanFields }), /maxPlanFields/);
  const many = Array.from({ length: 255 }, (_, i) => ({ ...nameAda, id: `fill${i}`, description: `Fill Name with ${i}.`, text: String(i) }));
  const oversized = fixture({ nextAction: answer('fill0') });
  const noPlan = await new FormPlanModel({ client: oversized.client }).decide({ state, actions: many });
  assert.deepEqual(Object.keys(oversized.calls[0].request.questions), ['nextAction']);
  assert.equal(noPlan.plannedActions, undefined);
});

test('non-form screen issues only the ordinary nextAction question', async () => {
  const f = fixture({ nextAction: answer('incomplete') });
  const nonFormActions = actions.filter(a => a.kind !== 'fill');
  const result = await new FormPlanModel({ client: f.client }).decide({ state, actions: nonFormActions });
  assert.deepEqual(Object.keys(f.calls[0].request.questions), ['nextAction']);
  assert.equal(result.choice, 'incomplete');
  assert.equal(result.plannedActions, undefined);
});

test('original JevModel remains an ordinary single-decision model', async () => {
  const f = fixture();
  const result = await new JevModel({ client: f.client }).decide({ state, actions });
  assert.deepEqual(Object.keys(f.calls[0].request.questions), ['nextAction']);
  assert.equal(result.plannedActions, undefined);
});

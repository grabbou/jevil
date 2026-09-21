import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JevDeviceAgent } from '../src/agent.mjs';

const inputs = { name: 'Ada', email: 'ada@example.com' };
async function harness(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jev-agent-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const values = { name: '', email: '' }, calls = [], decisions = [], events = [];
  let generation = 0;
  const device = {
    open: async () => ({}), close: async () => {}, screenshot: async path => path,
    snapshot: async args => {
      const snapshot = { appBundleId: 'test.form', refsGeneration: ++generation, truncated: false,
        visibility: { partial: false, visibleNodeCount: 3, totalNodeCount: 3 }, nodes: [
          { ref: 'e1', index: 0, type: 'StaticText', identifier: 'title', label: 'Contact details', visibleToUser: true },
          ...['name', 'email'].map((name, index) => ({ ref: `e${generation * 10 + index}`, index: index + 1, type: 'TextField',
            identifier: `field-${name}`, label: name, value: values[name], visibleToUser: true, hittable: true, enabled: true })),
        ] };
      await options.onSnapshot?.(snapshot, generation);
      calls.push({ kind: 'snapshot', args, generation });
      return snapshot;
    },
    act: async (action, { signal }) => {
      signal.throwIfAborted();
      calls.push({ kind: 'act', action });
      await options.onAct?.(action, calls.filter(call => call.kind === 'act').length, values);
      if (action.kind === 'fill') values[action.inputName] = action.text;
    },
  };
  const model = { decide: async args => {
    decisions.push(args);
    const candidates = ['name', 'email'].map(name => args.actions.find(action => action.kind === 'fill' && action.target === `field-${name}` && action.inputName === name));
    const next = candidates.find(action => args.state.screen.nodes.find(node => node.identifier === action.target)?.value !== action.text);
    const answer = { choice: next?.id || 'qa_pass', confidence: .95, model: 'test-model', latencyMs: 1,
      usage: { input_tokens: 10, output_tokens: 2 } };
    if (decisions.length === 1) answer.plannedActions = candidates.map(action => ({ ...action, confidence: .9 }));
    options.onDecision?.(answer, args, decisions.length);
    return answer;
  } };
  const { formPlans = true, maxSteps = 10, minConfidence = 0 } = options;
  const agent = new JevDeviceAgent({ device, model, artifactsDir: directory, record: false, formPlans, maxSteps, minConfidence,
    onStep: entry => { events.push({ ...entry }); options.onStep?.(entry); } });
  const result = await agent.generate({ prompt: options.prompt ?? 'Fill name and email.', inputs, abortSignal: options.abortSignal });
  const trace = (await readFile(join(result.directory, 'trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  return { result, calls, decisions, events, trace, values };
}

test('planned fills have real steps, fresh snapshots, trace and truthful subsequent context', async t => {
  const { result, calls, decisions, events, trace } = await harness(t);
  assert.equal(result.status, 'passed');
  assert.equal(result.usage.requests, 2);
  assert.equal(result.usage.inputTokens, 20);
  assert.equal(result.usage.outputTokens, 4);
  assert.equal(result.steps.length, 3);
  assert.equal(result.steps[1].source, 'plan');
  assert.equal(result.steps[1].planOriginStep, 1);
  assert.equal(result.steps[1].usage, undefined);
  assert.equal(result.steps[1].ref, '@e21~s2');
  assert.equal(result.steps[1].executed, true);
  assert.equal(events.length, 3);
  assert.equal(trace.filter(entry => entry.kind === 'executed').length, 2);
  assert.deepEqual(calls.filter(call => call.kind === 'snapshot')[1].args, { forceFull: true });
  assert.equal(decisions[1].state.previousAction, result.steps[1].action);
  assert.equal(decisions[1].state.previousScreen.nodes.find(node => node.identifier === 'field-name').value, 'Ada');
  assert.equal(decisions[1].state.previousScreen.nodes.find(node => node.identifier === 'field-email').value, '');
  const fresh = JSON.parse(await readFile(join(result.directory, 'snapshot-2.json'), 'utf8'));
  assert.equal(fresh.refsGeneration, 2);
});

test('default opt-out retains one model decision per action', async t => {
  const { result, calls } = await harness(t, { formPlans: false });
  assert.equal(result.usage.requests, 3);
  assert.equal(result.steps.some(step => step.source === 'plan'), false);
  assert.equal(calls.filter(call => call.kind === 'act').length, 2);
});

test('autofill of a pending field asks the model again before any overwrite', async t => {
  const autofilledEmail = 'autofilled@example.com';
  const { result, calls, decisions, values } = await harness(t, {
    prompt: 'Fill name. Fill email only if blank; never overwrite an existing email.',
    onAct: (_action, count, values) => { if (count === 1) values.email = autofilledEmail; },
    onDecision: (answer, args, count) => {
      if (count === 2) {
        assert.equal(args.state.screen.nodes.find(node => node.identifier === 'field-email').value, autofilledEmail);
        answer.choice = 'qa_pass';
      }
    },
  });
  assert.equal(result.status, 'passed');
  assert.equal(decisions.length, 2);
  assert.equal(values.email, autofilledEmail);
  assert.deepEqual(calls.filter(call => call.kind === 'act').map(call => call.action.target), ['field-name']);
  assert.equal(result.steps.some(step => step.source === 'plan'), false);
});
for (const maxSteps of [1, 2]) test(`maxSteps=${maxSteps} counts every planned action`, async t => {
  const { result, calls } = await harness(t, { maxSteps });
  assert.equal(result.reason, 'step_limit');
  assert.equal(result.steps.length, maxSteps);
  assert.equal(calls.filter(call => call.kind === 'act').length, maxSteps);
  assert.equal(result.usage.requests, 1);
});

test('cancellation after first action discards queued fills', async t => {
  const controller = new AbortController();
  const { result, calls } = await harness(t, { abortSignal: controller.signal,
    onAct: (_action, count) => { if (count === 1) controller.abort(); } });
  assert.equal(result.reason, 'cancelled');
  assert.equal(calls.filter(call => call.kind === 'act').length, 1);
});
test('cancellation while observing queued fill prevents dispatch', async t => {
  const controller = new AbortController();
  const { result, calls } = await harness(t, { abortSignal: controller.signal,
    onSnapshot: (_snapshot, generation) => { if (generation === 2) controller.abort(); } });
  assert.equal(result.reason, 'cancelled');
  assert.equal(calls.filter(call => call.kind === 'act').length, 1);
});
test('queued action failure is recorded unexecuted and never retried', async t => {
  const { result, calls, trace } = await harness(t, { onAct: (_action, count) => { if (count === 2) throw new Error('device failure'); } });
  assert.equal(result.reason, 'runtime_error');
  assert.equal(result.steps[1].source, 'plan');
  assert.equal(result.steps[1].executed, false);
  assert.equal(calls.filter(call => call.kind === 'act').length, 2);
  assert.equal(trace.filter(entry => entry.kind === 'executed').length, 1);
});
test('low-confidence queued mapping reverts to normal decision without dispatching stale plan', async t => {
  const { result, decisions } = await harness(t, { minConfidence: .8,
    onDecision: answer => { if (answer.plannedActions) answer.plannedActions[1].confidence = .5; } });
  assert.equal(result.status, 'passed');
  assert.equal(decisions.length, 3);
  assert.equal(result.steps.some(step => step.source === 'plan'), false);
});
test('first mapping also obeys confidence cutoff', async t => {
  const { result, calls } = await harness(t, { minConfidence: .8,
    onDecision: answer => { if (answer.plannedActions) answer.plannedActions[0].confidence = .5; } });
  assert.equal(result.reason, 'low_confidence');
  assert.equal(calls.filter(call => call.kind === 'act').length, 0);
});
test('singleton mapping retains its lower confidence and obeys cutoff', async t => {
  const { result, calls } = await harness(t, { minConfidence: .8,
    onDecision: answer => { if (answer.plannedActions) answer.plannedActions = [{ ...answer.plannedActions[0], confidence: .5 }]; } });
  assert.equal(result.reason, 'low_confidence');
  assert.equal(result.steps[0].confidence, .5);
  assert.equal(calls.filter(call => call.kind === 'act').length, 0);
});
test('singleton mapping cannot raise main decision confidence or enqueue empty tail', async t => {
  const { result, calls } = await harness(t, { minConfidence: .8,
    onDecision: answer => { if (answer.plannedActions) {
      answer.confidence = .85;
      answer.plannedActions = [{ ...answer.plannedActions[0], confidence: .99 }];
    } } });
  assert.equal(result.status, 'passed');
  assert.equal(result.steps[0].confidence, .85);
  assert.equal(result.usage.requests, 3);
  assert.equal(result.steps.some(step => step.source === 'plan'), false);
  assert.equal(calls.filter(call => call.kind === 'snapshot').every(call => call.args === undefined), true);
});
for (const [name, mutate] of [
  ['missing plan', answer => { delete answer.plannedActions; }],
  ['malformed plan', answer => { answer.plannedActions = {}; }],
  ['nonfill action', answer => { answer.plannedActions[1].kind = 'press'; }],
  ['invented value', answer => { answer.plannedActions[1].text = 'wrong'; }],
  ['wrong first action', answer => { answer.plannedActions.reverse(); }],
  ['duplicate target', answer => { answer.plannedActions[1] = answer.plannedActions[0]; }],
  ['unknown mapping confidence', answer => { delete answer.plannedActions[1].confidence; }],
]) test(`${name} preserves ordinary decisions`, async t => {
  const { result } = await harness(t, { onDecision: (answer, _args, count) => { if (count === 1) mutate(answer); } });
  assert.equal(result.status, 'passed');
  assert.equal(result.usage.requests, 3);
  assert.equal(result.steps.some(step => step.source === 'plan'), false);
});

test('stale frame rejects plan then asks model on the same fresh observation', async t => {
  const { result, calls } = await harness(t, { onSnapshot: (snapshot, count) => { if (count === 2) snapshot.refsGeneration = 1; } });
  assert.equal(result.usage.requests, 3);
  assert.equal(calls.filter(call => call.kind === 'snapshot').length, 3);
  assert.equal(result.steps[1].source, undefined);
});

test('formPlans option is opt-in and validates type', () => {
  const adapters = { model: { decide() {} }, device: { snapshot() {} } };
  assert.equal(new JevDeviceAgent(adapters).formPlans, false);
  assert.throws(() => new JevDeviceAgent({ ...adapters, formPlans: 'true' }), /formPlans/);
});

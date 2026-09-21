import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentDevice } from '../src/device.mjs';

for (const settle of [true, false]) {
  test(`settle=${settle} retains current full snapshots and native dispatch guards`, async () => {
    const calls = [];
    const client = { interactions: Object.fromEntries(['press', 'fill', 'scroll'].map(name => [name, async args => calls.push([name, args])])),
      capture: { snapshot: async args => { calls.push(['snapshot', args]); return { refsGeneration: calls.length }; } } };
    const device = new AgentDevice({ app: 'test.app', client, settle });
    for (const action of [{ kind: 'press', ref: '@e2~s1' }, { kind: 'fill', ref: '@e3~s2', text: 'Ada' }, { kind: 'scroll', direction: 'down' }]) {
      await device.act(action);
      await device.snapshot();
    }
    for (const [name, args] of calls) {
      if (name === 'snapshot') assert.equal(args.forceFull, true);
      else {
        assert.equal(args.settle, settle ? true : undefined);
        assert.equal(args.settleQuietMs, settle ? 250 : undefined);
        assert.equal(args.allowStaleRef, undefined);
      }
    }
    const controller = new AbortController(); controller.abort();
    const count = calls.length;
    await assert.rejects(device.act({ kind: 'press', ref: '@e2~s1' }, { signal: controller.signal }), /abort/i);
    assert.equal(calls.length, count);
  });
}
test('default device retains settling; invalid option fails before interaction', () => {
  const device = new AgentDevice({ app: 'test.app', client: {} });
  assert.equal(device.settle, true);
  assert.throws(() => new AgentDevice({ app: 'test.app', client: {}, settle: 'false' }), /boolean/);
});

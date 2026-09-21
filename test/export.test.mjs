import test from 'node:test';
import assert from 'node:assert/strict';
import { publicResults } from '../benchmarks/export.mjs';
test('public export preserves failed attempts but omits local paths and device data', () => {
  const out = publicResults({ metadata: { udid: 'private-device', sourceHashes: { 'src/agent.mjs': 'hash' }, recording: false }, rows: [{ variant: 'baseline', status: 'error', oraclePassed: null, error: 'private secret', report: '/Users/person/private', elapsedMs: 12, oracle: { values: { name: 'private-name' } } }] });
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, /private-device|private secret|\/Users|private-name/);
  assert.equal(out.rows[0].status, 'error');
  assert.equal(out.rows[0].elapsedMs, 12);
  assert.equal(out.rows[0].oraclePassed, null);
  assert.ok(out.rows[0].error);
  assert.equal(out.metadata.sourceHashes['src/agent.mjs'], 'hash');
});

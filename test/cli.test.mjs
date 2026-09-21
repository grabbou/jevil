import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('CLI documents all strategies without credentials or a device', () => {
  const result = spawnSync(process.execPath, ['src/cli.mjs', '--help'], { encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '' } });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /baseline.*single-capture.*form-plan/);
});
test('CLI rejects unknown strategy before constructing adapters', () => {
  const result = spawnSync(process.execPath, ['src/cli.mjs', '--app', 'test.app', '--strategy', 'typo', 'Test'], { encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: '' } });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /Unknown strategy/);
});

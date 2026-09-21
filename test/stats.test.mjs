import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarize, renderMarkdown } from '../benchmarks/stats.mjs';

function row(variant, round, elapsedMs, overrides = {}) {
  return { variant, scenario: 'navigate', round, elapsedMs, status: 'passed', oraclePassed: true, ...overrides };
}

test('percentiles use deterministic interpolation and exclude invalid observations', () => {
  assert.equal(percentile([40, 10, 30, 20, NaN], 0.5), 25);
  assert.equal(percentile([40, 10, 30, 20], 0.95), 38.5);
  assert.equal(percentile([], 0.5), null);
});

test('only matched successful observations contribute to speedup; failures remain visible', () => {
  const rows = [
    row('baseline', 1, 100), row('candidate', 1, 50),
    row('baseline', 2, 120), row('candidate', 2, 10, { oraclePassed: false }),
    row('baseline', 3, 90, { status: 'failed' }), row('candidate', 3, 30),
    row('baseline', 4, 80),
    row('candidate', 5, 20),
  ];
  const stats = summarize(rows).variants.candidate;
  assert.equal(stats.attempted, 4);
  assert.equal(stats.passed, 3);
  assert.equal(stats.falsePass, 1);
  assert.equal(stats.failedLatencyMs.median, 10);
  assert.equal(stats.allRuns.elapsedMs.median, 25);
  assert.equal(stats.successfulLatencyMs.median, 30);
  assert.equal(stats.comparison.sharedAttempts, 3);
  assert.equal(stats.comparison.eligiblePairs, 1);
  assert.equal(stats.comparison.pairCoverage, 1 / 3);
  assert.equal(stats.comparison.baselineAttemptCoverage, 1 / 4);
  assert.equal(stats.comparison.pairedMedianSpeedup, 2);
  assert.deepEqual(stats.comparison.speedup95Ci, [2, 2]);
  assert.equal(stats.comparison.smallSample, true);
});

test('bootstrap is repeatable and preserves per-scenario pairing', () => {
  const rows = Array.from({ length: 12 }, (_, round) => [
    row('baseline', round, 100 + round * 20, { scenario: round % 2 ? 'form' : 'navigate' }),
    row('candidate', round, 50 + round * 7, { scenario: round % 2 ? 'form' : 'navigate' }),
  ]).flat();
  const first = summarize(rows, { iterations: 400 });
  assert.deepEqual(first, summarize(rows, { iterations: 400 }));
  assert.deepEqual(first.variants.candidate.comparison.speedup95Ci, summarize([...rows].reverse(), { iterations: 400 }).variants.candidate.comparison.speedup95Ci);
  assert.deepEqual(first.variants.candidate.comparison.scenarioPairCounts, { form: 6, navigate: 6 });
  assert.equal(first.variants.candidate.scenarios.form.comparison.eligiblePairs, 6);
});

test('missing or invalid latency and unverified passes never qualify as successful speed pairs', () => {
  const rows = [
    row('baseline', 1, 100), row('candidate', 1, undefined),
    row('baseline', 2, 100), row('candidate', 2, 0),
    row('baseline', 3, 100), row('candidate', 3, 5, { oraclePassed: undefined }),
  ];
  const stats = summarize(rows).variants.candidate;
  assert.equal(stats.comparison.eligiblePairs, 0);
  assert.equal(stats.comparison.speedup95Ci, null);
  assert.equal(stats.allRuns.elapsedMs.missingOrInvalid, 1);
  assert.equal(stats.unverifiedPass, 1);
  assert.equal(stats.falsePass, 0);
});

test('empty and missing baseline results do not manufacture speedup evidence', () => {
  assert.deepEqual(summarize([]).variants, {});
  const stats = summarize([row('candidate', 1, 50)]).variants.candidate;
  assert.equal(stats.comparison.sharedAttempts, 0);
  assert.equal(stats.comparison.pairCoverage, null);
  assert.equal(stats.comparison.pairedMedianSpeedup, null);
  assert.match(renderMarkdown(summarize([row('candidate', 1, 50)])), /Small sample/);
});

test('duplicate identities are rejected instead of silently paired', () => {
  assert.throws(() => summarize([row('baseline', 1, 100), row('baseline', 1, 120)]), /Duplicate/);
});

test('model versions accept both singular and array-valued observations', () => {
  const result = summarize([
    row('baseline', 1, 100, { model: ['jev-2', 'jev-1'] }),
    row('baseline', 2, 100, { model: 'jev-1' }),
    row('baseline', 3, 100, { model: [] }),
  ]);
  assert.deepEqual(result.variants.baseline.models, ['jev-1', 'jev-2']);
});

const METRICS = ['elapsedMs', 'observeMs', 'inferMs', 'actMs', 'requests', 'inputTokens', 'actions'];

/** Linear interpolation between adjacent order statistics (R type 7). */
export function percentile(values, probability) {
  if (probability < 0 || probability > 1) throw new RangeError('probability must be between 0 and 1');
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}

function distribution(values) {
  const valid = values.filter(value => Number.isFinite(value) && value >= 0);
  return {
    n: valid.length,
    missingOrInvalid: values.length - valid.length,
    median: percentile(valid, 0.5),
    p95: percentile(valid, 0.95),
    total: valid.reduce((total, value) => total + value, 0),
  };
}

function passed(row) {
  return row.status === 'passed' && row.oraclePassed === true;
}

function aggregate(rows) {
  const successes = rows.filter(passed);
  const failures = rows.filter(row => !passed(row));
  return {
    attempted: rows.length,
    passed: successes.length,
    failed: failures.length,
    falsePass: rows.filter(row => row.status === 'passed' && row.oraclePassed === false).length,
    unverifiedPass: rows.filter(row => row.status === 'passed' && typeof row.oraclePassed !== 'boolean').length,
    successRate: rows.length ? successes.length / rows.length : null,
    allRuns: Object.fromEntries(METRICS.map(metric => [metric, distribution(rows.map(row => row[metric]))])),
    successfulLatencyMs: distribution(successes.map(row => row.elapsedMs)),
    failedLatencyMs: distribution(failures.map(row => row.elapsedMs)),
    statuses: Object.fromEntries([...new Set(rows.map(row => row.status))].sort().map(status => [status, rows.filter(row => row.status === status).length])),
    models: [...new Set(rows.flatMap(row => Array.isArray(row.model) ? row.model : [row.model]).filter(model => typeof model === 'string' && model.length > 0))].sort(),
  };
}

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function bootstrap(pairs, iterations) {
  if (!pairs.length) return null;
  const random = randomGenerator(0x4a4556);
  const strata = [...new Set(pairs.map(pair => pair.scenario))].sort().map(scenario => pairs.filter(pair => pair.scenario === scenario));
  const medians = Array.from({ length: iterations }, () => percentile(strata.flatMap(stratum =>
    Array.from({ length: stratum.length }, () => stratum[Math.floor(random() * stratum.length)].speedup)), 0.5));
  return [percentile(medians, 0.025), percentile(medians, 0.975)];
}

function key(row) {
  return JSON.stringify([row.scenario, row.round]);
}

function compare(baselineRows, candidateRows, iterations) {
  const baselineIndex = new Map(baselineRows.map(row => [key(row), row]));
  let sharedAttempts = 0;
  const pairs = [];
  for (const candidate of candidateRows) {
    const baseline = baselineIndex.get(key(candidate));
    if (!baseline) continue;
    sharedAttempts++;
    if (!passed(baseline) || !passed(candidate)) continue;
    if (!Number.isFinite(baseline.elapsedMs) || baseline.elapsedMs <= 0 || !Number.isFinite(candidate.elapsedMs) || candidate.elapsedMs <= 0) continue;
    pairs.push({
      scenario: candidate.scenario,
      round: candidate.round,
      baselineMs: baseline.elapsedMs,
      candidateMs: candidate.elapsedMs,
      speedup: baseline.elapsedMs / candidate.elapsedMs,
      timeReductionPct: (1 - candidate.elapsedMs / baseline.elapsedMs) * 100,
    });
  }
  pairs.sort((a, b) => key(a).localeCompare(key(b)));
  const scenarioCounts = Object.fromEntries([...new Set(pairs.map(pair => pair.scenario))].sort().map(scenario => [scenario, pairs.filter(pair => pair.scenario === scenario).length]));
  return {
    baselineAttempts: baselineRows.length,
    candidateAttempts: candidateRows.length,
    sharedAttempts,
    eligiblePairs: pairs.length,
    excludedSharedAttempts: sharedAttempts - pairs.length,
    pairCoverage: sharedAttempts ? pairs.length / sharedAttempts : null,
    baselineAttemptCoverage: baselineRows.length ? pairs.length / baselineRows.length : null,
    candidateAttemptCoverage: candidateRows.length ? pairs.length / candidateRows.length : null,
    pairedMedianSpeedup: percentile(pairs.map(pair => pair.speedup), 0.5),
    pairedMedianTimeReductionPct: percentile(pairs.map(pair => pair.timeReductionPct), 0.5),
    speedup95Ci: bootstrap(pairs, iterations),
    scenarioPairCounts: scenarioCounts,
    smallSample: pairs.length < 30 || Object.values(scenarioCounts).some(count => count < 10),
    pairs,
  };
}

export function summarize(rows, { baseline = 'baseline', iterations = 2000 } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  if (!Number.isInteger(iterations) || iterations < 1) throw new RangeError('iterations must be a positive integer');
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row.variant !== 'string' || typeof row.scenario !== 'string' || row.round === undefined) {
      throw new TypeError('every row needs variant, scenario and round');
    }
    const identity = JSON.stringify([row.variant, row.scenario, row.round]);
    if (seen.has(identity)) throw new Error(`Duplicate benchmark observation: ${identity}`);
    seen.add(identity);
  }
  const baselineRows = rows.filter(row => row.variant === baseline);
  const variants = Object.fromEntries([...new Set(rows.map(row => row.variant))].sort().map(variant => {
    const variantRows = rows.filter(row => row.variant === variant);
    const scenarios = Object.fromEntries([...new Set(variantRows.map(row => row.scenario))].sort().map(scenario => {
      const scenarioRows = variantRows.filter(row => row.scenario === scenario);
      return [scenario, {
        ...aggregate(scenarioRows),
        comparison: variant === baseline ? null : compare(baselineRows.filter(row => row.scenario === scenario), scenarioRows, iterations),
      }];
    }));
    return [variant, {
      ...aggregate(variantRows),
      comparison: variant === baseline ? null : compare(baselineRows, variantRows, iterations),
      scenarios,
    }];
  }));
  return {
    baseline,
    bootstrap: { iterations, seed: 0x4a4556, method: 'Percentile bootstrap of paired baseline/candidate latency ratios, resampled within scenario with fixed scenario counts.' },
    limitations: [
      'Speed comparisons include only pairs where both runs passed the independent oracle and have positive finite latency; examine failures and pair coverage alongside speedup.',
      'All-run latency includes failed attempts and is not a time-to-success metric. Reported latency excludes missing or invalid measurements.',
      'Intervals describe the sampled scenarios and conditions, not unseen tasks, devices or application states. Resampling assumes independent rounds within each scenario.',
      'Small samples and zero observed false passes do not prove safety or equal reliability. No multiple-comparison adjustment is applied.',
      'Small sample means fewer than 30 eligible pairs overall or fewer than 10 in any represented scenario.',
    ],
    variants,
  };
}

function display(value, digits = 1) {
  return value === null || value === undefined ? '—' : value.toFixed(digits);
}

function label(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function renderMarkdown(summary) {
  const lines = [
    '# Jev benchmark results',
    '',
    `Baseline: **${label(summary.baseline)}**. Latencies are milliseconds. A speedup above 1 means faster.`,
    '',
    '| Variant | Oracle passes / attempts | False / unverified PASS | All-run median / p95 | Successful median / p95 | Eligible / shared pairs | Paired speedup (95% CI) |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  const addRow = (name, stats) => {
    const comparison = stats.comparison;
    const ci = comparison?.speedup95Ci;
    const speedup = comparison ? `${display(comparison.pairedMedianSpeedup, 2)}× (${ci ? ci.map(value => display(value, 2)).join('–') : '—'})${comparison.smallSample ? ' *' : ''}` : 'baseline';
    lines.push(`| ${label(name)} | ${stats.passed}/${stats.attempted} | ${stats.falsePass}/${stats.unverifiedPass} | ${display(stats.allRuns.elapsedMs.median)} / ${display(stats.allRuns.elapsedMs.p95)} | ${display(stats.successfulLatencyMs.median)} / ${display(stats.successfulLatencyMs.p95)} | ${comparison ? `${comparison.eligiblePairs}/${comparison.sharedAttempts}` : '—'} | ${speedup} |`);
  };
  for (const [variant, stats] of Object.entries(summary.variants)) addRow(variant, stats);
  lines.push('', '* Small sample; treat as exploratory evidence.', '', '## Per scenario', '', ...lines.slice(4, 6));
  for (const [variant, stats] of Object.entries(summary.variants)) {
    for (const [scenario, scenarioStats] of Object.entries(stats.scenarios)) addRow(`${variant} / ${scenario}`, scenarioStats);
  }
  lines.push('', '## Measurement limits', '', ...summary.limitations.map(value => `- ${value}`), '', `Bootstrap: ${summary.bootstrap.iterations} iterations, fixed seed ${summary.bootstrap.seed}. ${summary.bootstrap.method}`, '');
  return lines.join('\n');
}

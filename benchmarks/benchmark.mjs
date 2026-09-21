import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { JevDeviceAgent } from '../src/agent.mjs';
import { AgentDevice } from '../src/device.mjs';
import { JevModel } from '../src/jev.mjs';
import { FormPlanModel } from '../src/form-model.mjs';
import { summarize, renderMarkdown } from './stats.mjs';
import { evaluateOracle } from './oracle.mjs';

const { values } = parseArgs({ options: {
  rounds: { type: 'string', default: '2' }, variants: { type: 'string', default: 'baseline,single-capture,form-plan' },
  scenarios: { type: 'string', default: 'navigation,form,delayed' }, output: { type: 'string', default: 'artifacts/benchmark' },
  udid: { type: 'string' }, model: { type: 'string' }, record: { type: 'boolean', default: false },
} });
if (!values.udid) throw new Error('Pass --udid for the dedicated fixture simulator. Never use a personal device.');
if (existsSync('.env')) process.loadEnvFile();
process.env.AGENT_DEVICE_STATE_DIR ||= join(tmpdir(), 'jevil-benchmark-device');
const variants = values.variants.split(',');
if (new Set(variants).size !== variants.length || variants.some(v => !['baseline', 'single-capture', 'form-plan'].includes(v))) throw new Error('Use unique variants from baseline,single-capture,form-plan');
const rounds = Number(values.rounds);
if (!Number.isInteger(rounds) || rounds < 1) throw new Error('rounds must be a positive integer');
const definitions = {
  navigation: { prompt: 'From Benchmark Home, open Browse products, then Canvas backpack. Verify the Canvas backpack details screen shows Price: 49 credits and In stock. Do not open Travel mug or return home.', screen: 'details', events: ['browse', 'backpack'], label: 'Canvas backpack details', labels: ['Canvas backpack details', 'Price: 49 credits', 'In stock'] },
  form: { prompt: 'From Benchmark Home, open Contact form. Fill Name with "Ada" and Email with "ada@example.com". Save contact, then verify the visible confirmation Contact saved: Ada, ada@example.com. Do not return home.', screen: 'saved', events: ['contact', 'save'], label: 'Contact saved: Ada, ada@example.com' },
  delayed: { prompt: 'From Benchmark Home, open Delayed result. Wait for loading to finish, then press View result. Verify the visible reference BENCH-204. Do not return home.', screen: 'result', events: ['delayed', 'view-result'], label: 'Reference: BENCH-204' },
};
const scenarios = values.scenarios.split(',');
if (new Set(scenarios).size !== scenarios.length) throw new Error('Scenarios must be unique');
for (const scenario of scenarios) if (!definitions[scenario]) throw new Error(`Unknown scenario ${scenario}`);
const out = resolve(values.output);
if (existsSync(join(out, 'results.json'))) throw new Error('Output already contains results; choose a new directory.');
await mkdir(out, { recursive: true });
const container = execFileSync('xcrun', ['simctl', 'get_app_container', values.udid, 'local.jev.benchmark', 'data'], { encoding: 'utf8' }).trim();
const pinnedModel = values.model || process.env.TYPESAFE_MODEL;
if (!pinnedModel || pinnedModel.endsWith('latest')) throw new Error('Pass --model with an exact version for reproducible comparisons.');
const devices = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', '--json'], { encoding: 'utf8' }));
const simulator = Object.values(devices.devices).flat().find(d => d.udid === values.udid);
if (!simulator || simulator.state !== 'Booted') throw new Error('The selected fixture simulator must be booted.');
const metadata = { createdAt: new Date().toISOString(), node: process.version, sdk: '0.21.6', app: 'local.jev.benchmark', udid: values.udid, variants, rounds, scenarios, recording: values.record, purpose: values.record ? 'demonstration (excluded from timing comparisons)' : 'timing comparison', simulator: { name: simulator.name, deviceTypeIdentifier: simulator.deviceTypeIdentifier }, warmRunner: true, seed: 271828, measurement: 'first loop snapshot through terminal decision plus independent oracle; startup and final screenshot reported separately' };
metadata.sourceHashes = {};
for (const path of ['src/agent.mjs', 'src/device.mjs', 'src/jev.mjs', 'src/actions.mjs', 'src/form-model.mjs', 'src/form-plan.mjs', 'benchmarks/oracle.mjs', 'benchmarks/benchmark.mjs', 'benchmarks/fixture/main.swift', 'benchmarks/stats.mjs']) {
  metadata.sourceHashes[path] = createHash('sha256').update(await readFile(path)).digest('hex');
}
const rows = [];
let seed = metadata.seed;
function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
function shuffle(items) { const a = [...items]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
async function checkpoint() {
  await writeFile(join(out, 'results.json'), JSON.stringify({ metadata: { ...metadata, pinnedModel }, rows }, null, 2));
  if (rows.length) {
    const summary = summarize(rows);
    await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
    await writeFile(join(out, 'report.md'), renderMarkdown(summary));
  }
}

for (let round = 1; round <= rounds; round++) {
  for (const scenario of shuffle(scenarios)) {
    for (const variant of shuffle(variants)) {
      const trial = `${round}-${scenario}-${variant}`;
      console.log(`START ${trial}`);
      const base = new AgentDevice({ app: metadata.app, platform: 'ios', udid: values.udid, session: 'jevil-benchmark', cwd: process.cwd(), settle: variant === 'baseline' });
      const Model = variant === 'form-plan' ? FormPlanModel : JevModel;
      const model = new Model({ model: pinnedModel });
      const metrics = { observeMs: 0, inferMs: 0, actMs: 0, snapshots: 0, actions: 0, firstObservation: null, terminal: null, decisions: [] };
      let result;
      let oraclePassed = null;
      let oracle = null;
      let oracleMs = 0;
      let loopEnd = null;
      let terminalOracle = null;
      const trialWall = performance.now();
      try {
        // Reset is fixture setup, never part of the model's route or context.
        await base.client.apps.open({ ...base.target, relaunch: true, timeoutMs: 120_000 });
        await base.open();
        const initial = await base.snapshot();
        const initialOracle = JSON.parse(await readFile(join(container, 'Documents/oracle.json'), 'utf8'));
        if (initialOracle.screen !== 'home' || initialOracle.events.length || !initial.nodes.some(n => n.label === 'Jev Benchmark Home')) throw new Error('Fixture reset did not establish home');
        const device = {
          open: () => base.open(),
          snapshot: async () => {
            const start = performance.now();
            metrics.firstObservation ??= start;
            metrics.snapshots++;
            try { return await base.snapshot(); } finally { metrics.observeMs += performance.now() - start; }
          },
          act: async (action, options) => {
            const start = performance.now();
            try { const result = await base.act(action, options); metrics.actions++; return result; }
            finally { metrics.actMs += performance.now() - start; }
          },
          startRecording: path => base.startRecording(path),
          stopRecording: () => base.stopRecording(),
          screenshot: path => { loopEnd = performance.now(); return base.screenshot(path); },
          close: async () => {},
        };
        const measuredModel = { decide: async args => {
          const start = performance.now();
          let answer;
          try { answer = await model.decide(args); } finally { metrics.inferMs += performance.now() - start; }
          if (answer.model !== pinnedModel) throw new Error(`Model mismatch: expected ${pinnedModel}, received ${answer.model}`);
          metrics.decisions.push({ choice: answer.choice, model: answer.model, diagnostics: answer.diagnostics });
          if (args.actions.find(a => a.id === answer.choice)?.kind === 'verdict') {
            terminalOracle = JSON.parse(await readFile(join(container, 'Documents/oracle.json'), 'utf8'));
            metrics.terminal = performance.now();
          }
          return answer;
        } };
        const agent = new JevDeviceAgent({ model: measuredModel, device, maxSteps: 15, timeoutMs: 120_000, record: values.record, formPlans: variant === 'form-plan', artifactsDir: join(out, 'runs', trial), onStep: entry => console.log(`  ${entry.step} ${entry.action} (${Math.round(entry.latencyMs)}ms)`)});
        result = await agent.generate({ prompt: definitions[scenario].prompt });
        const startOracle = performance.now();
        const final = await base.snapshot();
        oracle = JSON.parse(await readFile(join(container, 'Documents/oracle.json'), 'utf8'));
        const spec = definitions[scenario];
        const target = final.nodes.find(n => n.label === spec.label);
        const terminalSnapshot = result.verdict ? JSON.parse(await readFile(join(result.directory, 'snapshot-final.json'), 'utf8')) : null;
        const labels = spec.labels || [spec.label];
        const visible = [final, terminalSnapshot].every(snapshot => snapshot && labels.every(label => snapshot.nodes.some(n => n.label === label && n.visibleToUser === true)));
        oraclePassed = evaluateOracle({ scenario, spec, terminalSnapshot, finalSnapshot: final, terminalOracle, oracle });
        oracle = { ...oracle, terminalOracle, sdkExplicitVisibility: visible, target: target || null };
        oracleMs = performance.now() - startOracle;
      } catch (error) {
        const message = String(error.message).replaceAll(process.env.TYPESAFE_API_KEY || 'unused-secret', '[REDACTED]');
        result ||= { status: 'error', warnings: [message], steps: [], usage: {} };
        result.warnings ||= [];
        if (!result.warnings.includes(message)) result.warnings.push(message);
      } finally {
        await base.close().catch(error => console.error('Cleanup:', error.message));
      }
      const end = metrics.terminal ?? loopEnd ?? performance.now();
      const row = { variant, scenario, round, status: result.status, oraclePassed,
        elapsedMs: metrics.firstObservation === null ? performance.now() - trialWall : end - metrics.firstObservation + oracleMs,
        oracleMs, observeMs: metrics.observeMs, inferMs: metrics.inferMs, actMs: metrics.actMs,
        requests: result.usage.requests || 0, inputTokens: result.usage.inputTokens || 0, outputTokens: result.usage.outputTokens || 0, usageComplete: result.usage.complete === true,
        actions: metrics.actions, snapshots: metrics.snapshots, plannedFills: result.steps.filter(step => step.source === 'plan' && step.executed).length,
        error: result.warnings.length ? result.warnings.join('; ') : null, reason: result.reason,
        model: result.modelVersions, oracle, report: result.directory, diagnostics: metrics.decisions,
        recording: result.recording, fullTrialWallMs: performance.now() - trialWall, agentTotalMs: result.totalDurationMs };
      rows.push(row);
      await checkpoint();
      console.log(`END ${trial}: ${row.status} oracle=${oraclePassed} ${(row.elapsedMs / 1000).toFixed(2)}s observe=${Math.round(row.observeMs)} infer=${Math.round(row.inferMs)} act=${Math.round(row.actMs)}`);
      if (row.error && /401|403|429|API key|quota/i.test(row.error)) throw new Error('Provider blocked further benchmark calls; partial results preserved');
    }
  }
}
console.log(`Results: ${out}`);

if (rows.some(row => row.status !== 'passed' || row.oraclePassed !== true || row.error)) process.exitCode = 1;

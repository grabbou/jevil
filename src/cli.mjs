#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JevDeviceAgent, JevModel, FormPlanModel, AgentDevice } from './index.mjs';

const HELP = `Usage: npm run qa -- --app <bundle/package ID> [options] "Task to perform"

  --platform ios|android     Default: ios
  --device <name>            Select a device by name
  --udid <id>                Pin an Apple simulator/device
  --serial <id>              Pin an Android emulator/device
  --strategy <name>          baseline (default), single-capture, or form-plan (experimental)
  --model <id>               Default: TYPESAFE_MODEL or jev-latest
  --max-steps <n>            Default: 40
  --min-confidence <0..1>    Action cutoff; default: 0 (disabled)
  --timeout <seconds>        Default: 180; cancels model requests, stops between device calls
  --scope <label/id>         Limit the snapshot to a specific app subtree
  --artifacts <directory>    Default: artifacts
  --no-record               Disable video capture
  --help                    Show this help

Set TYPESAFE_API_KEY through your environment or a local .env file.
Describe the expected outcome in the task. Put exact form values in double quotes.
Jev finishes by choosing qa_pass, qa_fail, or incomplete.
Exit codes: 0 QA pass, 1 QA fail, 2 incomplete, 3 runtime/config error.`;

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: {
    app: { type: 'string' }, platform: { type: 'string', default: 'ios' },
    device: { type: 'string' }, udid: { type: 'string' }, serial: { type: 'string' },
    strategy: { type: 'string', default: 'baseline' },
    model: { type: 'string' }, 'max-steps': { type: 'string', default: '40' },
    'min-confidence': { type: 'string', default: '0' }, timeout: { type: 'string', default: '180' },
    scope: { type: 'string' }, artifacts: { type: 'string', default: 'artifacts' },
    'no-record': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  } });
  if (v.help) { console.log(HELP); return; }
  const prompt = positionals.join(' ').trim();
  if (!v.app || !prompt) throw new Error('Provide --app and a task prompt. Run npm run qa -- --help for examples.');
  // Keep this process's daemon state separate from other agent-device projects.
  process.env.AGENT_DEVICE_STATE_DIR ||= resolve('.agent-device');
  if (!['baseline', 'single-capture', 'form-plan'].includes(v.strategy)) throw new Error('Unknown strategy. Use baseline, single-capture, or form-plan.');
  const Model = v.strategy === 'form-plan' ? FormPlanModel : JevModel;
  const model = new Model({ model: v.model || process.env.TYPESAFE_MODEL || 'jev-latest' });
  const device = new AgentDevice({ app: v.app, platform: v.platform, device: v.device, udid: v.udid,
    serial: v.serial, scope: v.scope, settle: v.strategy === 'baseline', session: `jev-${randomUUID()}`, cwd: process.cwd() });
  const agent = new JevDeviceAgent({ model, device, formPlans: v.strategy === 'form-plan', maxSteps: Number(v['max-steps']),
    minConfidence: Number(v['min-confidence']), timeoutMs: Number(v.timeout) * 1000,
    inputUsdPerMillion: Number(process.env.JEV_INPUT_USD_PER_MILLION || '0.042'),
    artifactsDir: v.artifacts, record: !v['no-record'],
    onStep: step => console.log(`${step.step}. ${step.kind === 'verdict' ? 'Decision: ' + step.choice : 'Selected: ' + step.action} (${step.latencyMs.toFixed(0)} ms; confidence ${step.confidence.toFixed(2)})`),
  });
  const controller = new AbortController();
  const stop = () => { if (!controller.signal.aborted) console.log('\nStopping after the current device operation…'); controller.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await agent.generate({ prompt, abortSignal: controller.signal });
    const explanations = {
      qa_pass: 'Jev found that the task was satisfied.',
      qa_fail: 'Jev found a failure against the task.',
      incomplete: 'Jev could not determine the outcome from the observed app states.',
      low_confidence: 'The selected action was below your confidence cutoff and was not executed.',
      blocked: 'The agent could not continue with the available controls.',
      need_input: 'The agent needs a text value. Include it in double quotes in the task.',
      step_limit: 'The run reached its step limit.',
      timeout: 'The run reached its time limit.',
      cancelled: 'The run was cancelled.',
      repeated_action_without_progress: 'The same action repeatedly made no progress.',
      runtime_error: 'The run stopped because of an error. See the details below.',
    };
    console.log(`\n${result.status.toUpperCase()}: ${explanations[result.reason] || result.reason}`);
    const confidence = result.verdict ? ` | QA confidence: ${result.verdict.confidence.toFixed(2)}` : '';
    console.log(`Actions executed: ${result.steps.filter(step => step.executed).length}${confidence}`);
    console.log(`Startup: ${(result.startupMs / 1000).toFixed(2)} s`);
    console.log(`Duration: ${(result.durationMs / 1000).toFixed(2)} s`);
    console.log(`Jev input tokens: ${result.usage.inputTokens}`);
    console.log(`Estimated inference cost: ${result.usage.requests === 0 ? '$0 (Jev was not called)' : result.estimatedInferenceCostUsd == null ? 'unavailable' : '$' + result.estimatedInferenceCostUsd.toFixed(8)}`);
    const videos = result.recording?.chunks?.map(chunk => chunk.path) || [result.recording?.outPath];
    const paths = videos.filter(Boolean);
    if (paths.length) paths.forEach(path => console.log(`Video: ${path}`));
    else console.log('Video: not recorded');
    console.log(`JSON: ${result.directory}/report.json`);
    result.warnings.forEach(w => console.error(`Note: ${w}`));
    process.exitCode = { passed: 0, failed: 1, incomplete: 2, error: 3 }[result.status];
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 3; });


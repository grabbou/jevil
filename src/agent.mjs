import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildActions, prepareSnapshot, fingerprint, assertReadable } from './actions.mjs';
import { promptInputs } from './inputs.mjs';

function finite(value, name, min, max = Infinity) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}.`);
}

export class JevDeviceAgent {
  constructor({ model, device, maxSteps = 40, minConfidence = 0, timeoutMs = 180_000, inputUsdPerMillion = 0.042, artifactsDir = 'artifacts', record = true, vision = false, onStep } = {}) {
    if (!model?.decide || !device?.snapshot) throw new Error('model and device adapters are required.');
    if (vision && !model.supportsImages) throw new Error('This model does not accept images. Use --provider clef for --vision.');
    finite(maxSteps, 'maxSteps', 1, 1000);
    if (!Number.isInteger(maxSteps)) throw new Error('maxSteps must be an integer.');
    finite(minConfidence, 'minConfidence', 0, 1);
    finite(timeoutMs, 'timeoutMs', 1, 3_600_000);
    finite(inputUsdPerMillion, 'inputUsdPerMillion', 0);
    Object.assign(this, { model, device, maxSteps, minConfidence, timeoutMs, inputUsdPerMillion, artifactsDir, record, vision, onStep });
    this.running = false;
  }

  async generate({ prompt, inputs = promptInputs(prompt), abortSignal } = {}) {
    if (this.running) throw new Error('This agent is already running. Use another session for concurrent work.');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('A nonempty task prompt is required.');
    if (!inputs || Array.isArray(inputs) || typeof inputs !== 'object' || !Object.entries(inputs).every(([k, v]) => k && typeof v === 'string')) throw new Error('inputs must map names to strings.');
    this.running = true;
    const started = performance.now();
    const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const directory = resolve(this.artifactsDir, runId);
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = abortSignal ? AbortSignal.any([abortSignal, deadline]) : deadline;
    const result = { runId, prompt, status: 'incomplete', reason: 'step_limit',
      startedAt: new Date().toISOString(), directory, steps: [], verdict: null,
      usage: { requests: 0, inputTokens: 0, outputTokens: 0, complete: true }, warnings: [], modelVersions: [], recording: null, screenshot: null };
    let previousScreen = null, previousAction = null;
    const query = async (method, args) => {
      if (JSON.stringify(args.state).length > 80_000) throw new Error('App context exceeds the POC limit. Narrow the snapshot scope or task.');
      result.usage.requests++;
      let answer;
      try { answer = await this.model[method]({ ...args, signal }); }
      catch (error) { result.usage.complete = false; throw error; }
      const usage = answer.usage;
      if (Number.isFinite(usage?.input_tokens) && usage.input_tokens >= 0 && Number.isFinite(usage?.output_tokens) && usage.output_tokens >= 0) {
        result.usage.inputTokens += usage.input_tokens;
        result.usage.outputTokens += usage.output_tokens;
      } else result.usage.complete = false;
      if (answer.model && !result.modelVersions.includes(answer.model)) result.modelVersions.push(answer.model);
      return answer;
    };
    let opened = false, recording = false, previous = '', repeats = 0;
    let runStarted = null;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'trace.jsonl'), '');
      signal.throwIfAborted();
      result.device = await this.device.open();
      opened = true;
      signal.throwIfAborted();
      if (this.record) {
        try { await this.device.startRecording(join(directory, 'run.mp4')); recording = true; }
        catch (error) { result.warnings.push(`Recording unavailable: ${safeError(error)}`); }
      }
      runStarted = performance.now();
      for (let step = 1; step <= this.maxSteps; step++) {
        signal.throwIfAborted();
        const snapshot = await this.device.snapshot();
        await writeFile(join(directory, `snapshot-${step}.json`), JSON.stringify(snapshot, null, 2));
        assertReadable(snapshot);
        signal.throwIfAborted();
        const actions = buildActions(snapshot, inputs);
        const state = { task: prompt, screen: prepareSnapshot(snapshot), previousScreen, previousAction };
        const images = this.vision ? [await this.device.screenImage(join(directory, `screen-${step}.png`))] : undefined;
        const decision = await query('decide', { state, actions, images });
        const usage = decision.usage;
        const action = actions.find(a => a.id === decision.choice);
        if (!action || !Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) throw new Error('Invalid model decision.');
        const entry = { executed: false, step, choice: action.id, kind: action.kind, action: action.description, ref: action.ref,
          confidence: decision.confidence, probabilities: decision.probabilities, latencyMs: decision.latencyMs ?? 0,
          model: decision.model, usage, snapshot: `snapshot-${step}.json` };
        result.steps.push(entry);
        await appendFile(join(directory, 'trace.jsonl'), JSON.stringify(entry) + '\n');
        this.onStep?.(entry);
        signal.throwIfAborted();
        if (action.kind !== 'verdict' && decision.confidence < this.minConfidence) { result.reason = 'low_confidence'; break; }
        if (action.kind === 'blocked') { result.reason = action.id; break; }
        if (action.kind === 'verdict') {
          // Save the exact observation that produced this terminal decision.
          await writeFile(join(directory, 'snapshot-final.json'), JSON.stringify(snapshot, null, 2));
          signal.throwIfAborted();
          result.verdict = { ...decision, snapshot: 'snapshot-final.json' };
          result.status = action.status;
          result.reason = action.id;
          break;
        }
        const signature = fingerprint(snapshot) + JSON.stringify([action.kind, action.target, action.inputName, action.direction]);
        repeats = signature === previous ? repeats + 1 : 1;
        previous = signature;
        if (repeats >= 3) { result.reason = 'repeated_action_without_progress'; break; }
        await this.device.act(action, { signal });
        previousScreen = state.screen;
        previousAction = action.description;
        entry.executed = true;
        await appendFile(join(directory, 'trace.jsonl'), JSON.stringify({ step, kind: 'executed', choice: action.id }) + '\n');
      }
    } catch (error) {
      result.status = signal.aborted ? 'incomplete' : 'error';
      result.reason = signal.aborted ? (deadline.aborted ? 'timeout' : 'cancelled') : 'runtime_error';
      result.warnings.push(safeError(error));
    } finally {
      if (opened) {
        try { result.screenshot = await this.device.screenshot(join(directory, 'final.png')); }
        catch (error) { result.warnings.push(`Screenshot unavailable: ${safeError(error)}`); }
      }
      if (recording) {
        try {
          result.recording = await this.device.stopRecording();
          for (const note of [result.recording?.warning, result.recording?.overlayWarning]) {
            if (note) result.warnings.push(`Recording: ${note}`);
          }
        }
        catch (error) { result.warnings.push(`Recording finalization failed: ${safeError(error)}`); }
      }
      if (opened) {
        try { await this.device.close(); }
        catch (error) { result.warnings.push(`Session cleanup failed: ${safeError(error)}`); }
      }
      const finished = performance.now();
      result.startupMs = (runStarted ?? finished) - started;
      result.durationMs = runStarted === null ? 0 : finished - runStarted;
      result.totalDurationMs = finished - started;
      result.inputUsdPerMillion = this.inputUsdPerMillion;
      result.estimatedInferenceCostUsd = !result.usage.complete ? null : result.usage.inputTokens / 1_000_000 * this.inputUsdPerMillion;
      this.running = false;
    }
    await writeFile(join(directory, 'report.json'), JSON.stringify(result, null, 2));
    return result;
  }
}

function safeError(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const key of [process.env.TYPESAFE_API_KEY, process.env.CLOUDFLARE_API_TOKEN]) {
    if (key) message = message.replaceAll(key, '[REDACTED]');
  }
  return message;
}

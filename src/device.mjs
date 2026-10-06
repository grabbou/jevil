import { createAgentDeviceClient } from 'agent-device';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';

export class AgentDevice {
  constructor({ app, platform = 'ios', device, udid, serial, scope, session, cwd, settleMs = 250, client } = {}) {
    if (!app) throw new Error('An app bundle/package ID is required.');
    if (!['ios', 'android'].includes(platform)) throw new Error('This POC supports ios and android.');
    this.target = { app, platform, device, udid, serial };
    this.scope = scope;
    this.settleMs = settleMs;
    this.client = client || createAgentDeviceClient({ session, cwd, lockPolicy: 'reject', lockPlatform: platform, responseLevel: 'full' });
  }
  async selectTarget() {
    if (this.target.device || this.target.udid || this.target.serial) return this.target;
    const devices = await this.client.devices.list({ platform: this.target.platform });
    const available = devices.filter(d => d.platform === this.target.platform && d.target === 'mobile' && !d.claimedBy &&
      (!d.appleOs || ['ios', 'ipados'].includes(d.appleOs)));
    const virtual = available.filter(d => ['simulator', 'emulator'].includes(d.kind));
    const candidates = virtual.length ? virtual : available.filter(d => d.booted);
    candidates.sort((a, b) => Number(Boolean(b.booted)) - Number(Boolean(a.booted)) ||
      Number(/^iPhone /.test(b.name)) - Number(/^iPhone /.test(a.name)) ||
      Number(b.name.match(/^iPhone (\d+)/)?.[1] || 0) - Number(a.name.match(/^iPhone (\d+)/)?.[1] || 0) ||
      a.name.localeCompare(b.name, 'en', { numeric: true }) || a.id.localeCompare(b.id));
    const selected = candidates[0];
    if (!selected) throw new Error(`No available ${this.target.platform} device. Start a simulator/emulator or select a device explicitly.`);
    const selector = this.target.platform === 'ios' ? 'udid' : 'serial';
    this.target[selector] = selected.identifiers?.[selector] || selected.id;
    this.selectedDevice = selected;
    return this.target;
  }
  async open() {
    await this.selectTarget();
    if (this.selectedDevice) console.log(`Device: ${this.selectedDevice.name} (${this.selectedDevice.kind}; ${this.target.udid || this.target.serial})`);
    const result = await this.client.apps.open({ ...this.target, timeoutMs: 120_000 });
    if (this.target.platform === 'ios') {
      try { await this.client.command.prepare({ action: 'ios-runner', timeoutMs: 120_000 }); }
      catch (error) { await this.client.sessions.close().catch(() => {}); throw error; }
    }
    return result;
  }
  snapshot() { return this.client.capture.snapshot({ forceFull: true, scope: this.scope, timeoutMs: 15_000 }); }
  async act(action, { signal } = {}) {
    signal?.throwIfAborted();
    const settle = { settle: true, settleQuietMs: this.settleMs, timeoutMs: 5000 };
    switch (action.kind) {
      case 'press': return this.client.interactions.press({ ref: action.ref, ...settle });
      case 'fill': return this.client.interactions.fill({ ref: action.ref, text: action.text, ...settle });
      case 'scroll': return this.client.interactions.scroll({ direction: action.direction, ...settle });
      case 'back': await this.client.command.back({}); return delay(this.settleMs, undefined, { signal });
      case 'wait': return delay(500, undefined, { signal });
      default: throw new Error(`Unsupported device action: ${action.kind}`);
    }
  }
  startRecording(path) { return this.client.recording.record({ action: 'start', path }); }
  stopRecording() { return this.client.recording.record({ action: 'stop' }); }
  screenshot(path) { return this.client.capture.screenshot({ path }); }
  async screenImage(path) {
    await this.screenshot(path);
    return `data:image/png;base64,${(await readFile(path)).toString('base64')}`;
  }
  close() { return this.client.sessions.close(); }
}

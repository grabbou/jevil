import { nextActionQuestion, readAnswer } from './jev.mjs';

export const CLEF_INPUT_USD_PER_MILLION = { clef: 0.24, 'clef-flash': 0.09 };

export class ClefModel {
  supportsImages = true;

  constructor({ accountId = process.env.CLOUDFLARE_ACCOUNT_ID, apiToken = process.env.CLOUDFLARE_API_TOKEN, model = 'clef', timeoutMs = 15_000 } = {}) {
    if (!accountId || !apiToken) throw new Error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in your environment or .env before running QA with Clef.');
    if (!Object.hasOwn(CLEF_INPUT_USD_PER_MILLION, model)) throw new Error('Clef models are clef and clef-flash.');
    Object.assign(this, { model, apiToken, timeoutMs });
    this.url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/${model}`;
  }

  decide({ state, actions, images, signal }) {
    return this.ask({ state, images, signal, ...nextActionQuestion(actions) });
  }

  async ask({ state, images, signal, name, instructions, criteria }) {
    const started = performance.now();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, state, ...(images?.length && { images }),
        questions: { [name]: { type: 'choice', instructions, criteria } } }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.success) {
      const detail = body?.errors?.map(error => error.message).join('; ') || response.statusText;
      throw new Error(`Clef request failed (${response.status}): ${detail}`);
    }
    return readAnswer(body.result, name, criteria, started);
  }
}

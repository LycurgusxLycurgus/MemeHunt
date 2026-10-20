import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readLimitedText } from './http.js';

function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) { void pending.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    pending.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

type Reservation = { at: number; tokens: number; pending: boolean };
export type GeminiAdmission = { model: string; inputTokens: number; countMethod: 'COUNT_TOKENS' | 'CONSERVATIVE_BYTES'; waitedMs: number; reservation: Reservation };
export type GeminiPacingOptions = { inputTokensPerMinute?: number; requestsPerMinute?: number; now?: () => number };

/** Admission covers this process only. Remote project usage remains subject to Google's quota. */
export class GeminiPacer {
  readonly inputTokensPerMinute: number;
  readonly requestsPerMinute: number;
  private readonly now: () => number;
  private readonly windows = new Map<string, Reservation[]>();
  private readonly queues = new Map<string, Promise<void>>();
  constructor(options: GeminiPacingOptions = {}) {
    this.inputTokensPerMinute = options.inputTokensPerMinute ?? 200_000;
    this.requestsPerMinute = options.requestsPerMinute ?? 12;
    this.now = options.now ?? Date.now;
    if (![this.inputTokensPerMinute, this.requestsPerMinute].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('GEMINI_PACING_CONFIG');
  }
  async admit(model: string, inputTokens: number, countMethod: GeminiAdmission['countMethod'], wait: (ms: number) => Promise<void>, signal?: AbortSignal): Promise<GeminiAdmission> {
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 1 || inputTokens > this.inputTokensPerMinute) throw new Error('GEMINI_INPUT_BUDGET');
    const previous = this.queues.get(model) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>(resolve => { release = resolve; });
    this.queues.set(model, previous.then(() => turn));
    try {
      await abortable(previous, signal);
      let waitedMs = 0;
      for (;;) {
        signal?.throwIfAborted();
        const at = this.now();
        const active = (this.windows.get(model) ?? []).filter(r => r.pending || at - r.at < 60_000);
        this.windows.set(model, active);
        if (active.length < this.requestsPerMinute && active.reduce((sum, r) => sum + r.tokens, 0) + inputTokens <= this.inputTokensPerMinute) {
          const reservation = { at, tokens: inputTokens, pending: true };
          active.push(reservation);
          return { model, inputTokens, countMethod, waitedMs, reservation };
        }
        const ms = Math.max(1, Math.min(60_000, Math.min(...active.map(r => r.pending ? 1000 : r.at + 60_000 - at))));
        if (wait === delay) await delay(ms, undefined, { signal }); else await abortable(wait(ms), signal);
        waitedMs += ms;
      }
    } finally { release(); }
  }
  settle(admission: GeminiAdmission, raw?: string) {
    // Keep uncertain/failed attempts charged, and retain usage for a minute after completion.
    admission.reservation.at = this.now();
    admission.reservation.pending = false;
    try {
      const actual = JSON.parse(raw ?? '').usageMetadata?.promptTokenCount;
      if (Number.isSafeInteger(actual) && actual > admission.reservation.tokens) admission.reservation.tokens = actual;
    } catch { /* An unavailable usage receipt cannot refund a dispatched attempt. */ }
  }
}

const pacers = new Map<string, GeminiPacer>();
export function geminiPacerForKey(key: string): GeminiPacer {
  const inputTokensPerMinute = Number(process.env.GEMINI_INPUT_TPM ?? 200_000);
  const requestsPerMinute = Number(process.env.GEMINI_REQUESTS_PER_MINUTE ?? 12);
  const id = createHash('sha256').update(key).digest('hex') + `:${inputTokensPerMinute}:${requestsPerMinute}`;
  let pacer = pacers.get(id);
  if (!pacer) { pacer = new GeminiPacer({ inputTokensPerMinute, requestsPerMinute }); pacers.set(id, pacer); }
  return pacer;
}

export async function countGeminiInput(model: string, payload: string, key: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<{ tokens: number; method: GeminiAdmission['countMethod'] }> {
  signal?.throwIfAborted();
  try {
    const local = AbortSignal.timeout(20_000);
    const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens`, {
      method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ generateContentRequest: { ...JSON.parse(payload), model: `models/${model}` } }),
      signal: signal ? AbortSignal.any([local, signal]) : local,
    });
    if (response.status === 401 || response.status === 403) {
      void response.body?.cancel().catch(() => {});
      throw new Error('GEMINI_TOKEN_COUNT_AUTH');
    }
    const raw = await readLimitedText(response, 16_000);
    if (response.ok) {
      const tokens = JSON.parse(raw).totalTokens;
      if (Number.isSafeInteger(tokens) && tokens > 0) return { tokens, method: 'COUNT_TOKENS' };
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && error.message === 'GEMINI_TOKEN_COUNT_AUTH') throw error;
  }
  // Deliberately conservative, labeled fallback; never use chars/4 for arbitrary source text.
  return { tokens: Buffer.byteLength(payload, 'utf8') + 1024, method: 'CONSERVATIVE_BYTES' };
}

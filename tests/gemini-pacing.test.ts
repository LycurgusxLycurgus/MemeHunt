import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { GeminiPacer, countGeminiInput, geminiPacerForKey } from '../src/providers/gemini-pacing.js';
import { geminiSettings } from '../src/providers/gemini.js';
import { requestSourceJson } from '../src/providers/source-model.js';

const KEY = 'gemini-pacing-test-secret';
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const sourceEnvelope = (value: unknown, promptTokenCount?: number) => jsonResponse({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }],
  ...(promptTokenCount === undefined ? {} : { usageMetadata: { promptTokenCount } }),
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('pending reservations and higher reported usage stay charged through the rolling minute', async () => {
  let now = 0;
  const pacer = new GeminiPacer({ inputTokensPerMinute: 100, requestsPerMinute: 3, now: () => now });
  const waits: number[] = [];
  const wait = async (ms: number) => { waits.push(ms); now += ms; };

  const first = await pacer.admit(geminiSettings.model, 40, 'COUNT_TOKENS', wait);
  const second = await pacer.admit(geminiSettings.model, 40, 'COUNT_TOKENS', wait);
  pacer.settle(first, JSON.stringify({ usageMetadata: { promptTokenCount: 80 } }));
  pacer.settle(second, 'unavailable usage receipt');

  const third = await pacer.admit(geminiSettings.model, 1, 'COUNT_TOKENS', wait);
  assert.deepEqual(waits, [60_000], 'the measured usage increase prevents an early admission');
  assert.equal(third.waitedMs, 60_000);
  pacer.settle(third);
});

test('model queues are independent and aborting a queued admission cannot release its successor early', async () => {
  let now = 0;
  const pacer = new GeminiPacer({ inputTokensPerMinute: 100, requestsPerMinute: 1, now: () => now });
  const first = await pacer.admit(geminiSettings.model, 1, 'COUNT_TOKENS', async () => {});
  pacer.settle(first);

  const firstWait = deferred<void>();
  const firstWaitStarted = deferred<number>();
  const predecessor = pacer.admit(geminiSettings.model, 1, 'COUNT_TOKENS', async ms => {
    firstWaitStarted.resolve(ms);
    await firstWait.promise;
    now += ms;
  });
  assert.equal(await firstWaitStarted.promise, 60_000);

  const controller = new AbortController();
  let abortedFollowerWaits = 0;
  const abortedFollower = pacer.admit(geminiSettings.model, 1, 'COUNT_TOKENS', async () => {
    abortedFollowerWaits++;
  }, controller.signal);
  let successorWaits = 0;
  const successor = pacer.admit(geminiSettings.model, 1, 'COUNT_TOKENS', async ms => {
    successorWaits++;
    now += ms;
  });

  const fallback = await pacer.admit(geminiSettings.fallbackModel, 1, 'COUNT_TOKENS', async () => {
    assert.fail('a wait on the primary model must not block fallback-model capacity');
  });
  assert.equal(fallback.model, geminiSettings.fallbackModel);
  controller.abort(new DOMException('cancel queued admission', 'AbortError'));
  await assert.rejects(abortedFollower, error => error === controller.signal.reason);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(abortedFollowerWaits, 0);
  assert.equal(successorWaits, 0, 'the later primary request remains behind the active predecessor');

  firstWait.resolve();
  const admittedPredecessor = await predecessor;
  pacer.settle(admittedPredecessor);
  const admittedSuccessor = await successor;
  assert.equal(successorWaits, 1, 'the successor enters its own window check only after the predecessor admits');
  assert.equal(admittedSuccessor.waitedMs, 60_000);
  pacer.settle(admittedSuccessor);
});

test('countTokens preserves the full generation payload and schema through retries and fallback', async () => {
  let now = 0;
  const pacer = new GeminiPacer({ inputTokensPerMinute: 150, requestsPerMinute: 12, now: () => now });
  const packet = JSON.stringify({ purpose: 'review the complete retained source tail', sourceText: '🌊'.repeat(500) });
  const schema = z.object({ accepted: z.boolean(), rationale: z.string() }).strict();
  const countRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const generationRequests: Array<{ url: string; body: string }> = [];
  const retained: string[] = [];
  const waits: number[] = [];
  const routing = { fallbackActive: false, pacing: pacer };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = String(init?.body);
    if (url.endsWith(':countTokens')) {
      countRequests.push({ url, body: JSON.parse(body) as Record<string, unknown> });
      return jsonResponse({ totalTokens: 100 });
    }
    generationRequests.push({ url, body });
    if (generationRequests.length < 3) return new Response('temporary model failure', { status: 503 });
    return sourceEnvelope({ accepted: true, rationale: 'The cited packet supports the review.' }, 130);
  };

  const result = await requestSourceJson(packet, schema, KEY, fetcher, raw => { retained.push(raw); }, async ms => {
    waits.push(ms);
    now += ms;
  }, undefined, 'ATT_MODEL', routing);

  assert.deepEqual(result.value, { accepted: true, rationale: 'The cited packet supports the review.' });
  assert.deepEqual(generationRequests.map(item => item.url), [
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`,
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`,
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.fallbackModel}:generateContent`,
  ]);
  assert.deepEqual(countRequests.map(item => item.url), [
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:countTokens`,
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.fallbackModel}:countTokens`,
  ], 'one logical packet is counted once for each model, including the fallback');
  assert.equal(generationRequests[0]!.body, generationRequests[1]!.body);
  assert.equal(generationRequests[1]!.body, generationRequests[2]!.body);
  assert.deepEqual(waits, [30_000, 30_000, 60_000], 'failed attempts stay charged between the established retry delays');

  const generated = JSON.parse(generationRequests[0]!.body) as {
    contents: Array<{ parts: Array<{ text: string }> }>;
    generationConfig: { responseJsonSchema: unknown };
  };
  assert.equal(generated.contents[0]!.parts[0]!.text, packet, 'source text is not clipped for token counting');
  for (const request of countRequests) {
    const counted = request.body.generateContentRequest as {
      model: string; contents: Array<{ parts: Array<{ text: string }> }>;
      generationConfig: { responseJsonSchema: unknown };
    };
    const expectedModel = request.url.includes(geminiSettings.fallbackModel) ? geminiSettings.fallbackModel : geminiSettings.model;
    assert.equal(counted.model, `models/${expectedModel}`);
    assert.equal(counted.contents[0]!.parts[0]!.text, packet);
    assert.deepEqual(counted.generationConfig.responseJsonSchema, generated.generationConfig.responseJsonSchema,
      'countTokens receives the same exact response schema as generation');
  }
  const receipts = retained.filter(raw => raw.startsWith('{"kind":"LOCAL_MODEL_TRANSPORT"')).map(raw => JSON.parse(raw) as {
    attempt: number; model: string; willRetry: boolean;
    pacing?: { inputTokens: number; countMethod: string; waitedMs: number };
  });
  assert.deepEqual(receipts.map(({ attempt, model, willRetry, pacing }) => [attempt, model, willRetry, pacing?.inputTokens, pacing?.countMethod]), [
    [1, geminiSettings.model, true, 100, 'COUNT_TOKENS'],
    [2, geminiSettings.model, true, 100, 'COUNT_TOKENS'],
    [3, geminiSettings.fallbackModel, false, 100, 'COUNT_TOKENS'],
  ]);
  assert.deepEqual(receipts.map(receipt => receipt.pacing?.waitedMs), [0, 30_000, 0],
    'the failed primary attempt forces the retry to wait for its rolling token reservation');
  assert.equal(routing.fallbackActive, true);
  assert.equal(JSON.stringify(receipts).includes(KEY), false, 'transport receipts do not reveal the API key');
});

test('one run shares rolling admissions across model stages and key-scoped pacers are reused', async () => {
  let now = 0;
  const pacer = new GeminiPacer({ inputTokensPerMinute: 1_000, requestsPerMinute: 1, now: () => now });
  const routing = { fallbackActive: false, pacing: pacer };
  const countCalls: string[] = [];
  const generationCalls: string[] = [];
  const waits: number[] = [];
  const fetcher: typeof fetch = async input => {
    const url = String(input);
    if (url.endsWith(':countTokens')) {
      countCalls.push(url);
      return jsonResponse({ totalTokens: 100 });
    }
    generationCalls.push(url);
    return sourceEnvelope({ accepted: true, rationale: 'A bounded response.' }, 100);
  };
  const wait = async (ms: number) => { waits.push(ms); now += ms; };
  for (const packet of ['proposal stage packet', 'independent review stage packet']) {
    await requestSourceJson(packet, z.object({ accepted: z.boolean(), rationale: z.string() }).strict(), KEY,
      fetcher, () => {}, wait, undefined, 'ATT_MODEL', routing);
  }

  assert.equal(countCalls.length, 2);
  assert.equal(generationCalls.length, 2);
  assert.deepEqual(waits, [60_000], 'the second stage sees the first stage reservation in the same run');
  const singletonKey = `${KEY}-singleton`;
  assert.strictEqual(geminiPacerForKey(singletonKey), geminiPacerForKey(singletonKey));
  assert.notStrictEqual(geminiPacerForKey(singletonKey), geminiPacerForKey(`${singletonKey}-other`));
});

test('count failures use conservative UTF-8 bytes; authorization, oversized packets, and aborts never dispatch generation', async t => {
  const payload = JSON.stringify({ text: '🌊' });
  const fallback = await countGeminiInput('gemini-test-model', payload, KEY, async () => new Response('unavailable', { status: 503 }));
  assert.deepEqual(fallback, { tokens: Buffer.byteLength(payload, 'utf8') + 1_024, method: 'CONSERVATIVE_BYTES' });

  for (const status of [401, 403]) {
    const bodies: Array<[string, () => Response]> = [
      ['nonempty body', () => new Response(`private ${KEY}`, { status })],
      ['empty body', () => new Response(null, { status })],
      ['errored stream body', () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.error(new Error(`private ${KEY} body`)); },
      }), { status })],
    ];
    for (const [bodyKind, makeResponse] of bodies) await t.test(`HTTP ${status} count authorization failure with ${bodyKind}`, async () => {
      let generationCalls = 0;
      let caught: unknown;
      try {
        await requestSourceJson('authorization packet', z.object({ ok: z.boolean() }), KEY,
          async input => String(input).endsWith(':countTokens')
            ? makeResponse()
            : (generationCalls++, sourceEnvelope({ ok: true })),
          () => {}, async () => {}, undefined, 'ATT_MODEL', {
            // This budget admits the conservative fallback if the auth status is missed,
            // making the regression prove that generation remains undispatched.
            fallbackActive: false, pacing: new GeminiPacer({ inputTokensPerMinute: 10_000, requestsPerMinute: 4 }),
          });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof Error, 'count authentication failure must reject the request');
      assert.equal(caught.message, 'GEMINI_TOKEN_COUNT_AUTH');
      assert.equal(`${caught.name}: ${caught.message}`.includes(KEY), false, 'authentication errors must not reveal the API key');
      assert.equal(generationCalls, 0);
    });
  }

  await t.test('measured input above the configured minute budget', async () => {
    let generationCalls = 0;
    await assert.rejects(() => requestSourceJson('oversized by count', z.object({ ok: z.boolean() }), KEY,
      async input => String(input).endsWith(':countTokens')
        ? jsonResponse({ totalTokens: 1_001 })
        : (generationCalls++, sourceEnvelope({ ok: true })),
      () => {}, async () => {}, undefined, 'ATT_MODEL', {
        fallbackActive: false, pacing: new GeminiPacer({ inputTokensPerMinute: 1_000, requestsPerMinute: 4 }),
      }), /GEMINI_INPUT_BUDGET/);
    assert.equal(generationCalls, 0);
  });

  await t.test('abort while awaiting admission', async () => {
    const controller = new AbortController();
    const pacer = new GeminiPacer({ inputTokensPerMinute: 1_000, requestsPerMinute: 1, now: () => 0 });
    const occupied = await pacer.admit(geminiSettings.model, 1, 'COUNT_TOKENS', async () => {});
    pacer.settle(occupied);
    let generationCalls = 0;
    await assert.rejects(() => requestSourceJson('cancel before dispatch', z.object({ ok: z.boolean() }), KEY,
      async input => String(input).endsWith(':countTokens')
        ? jsonResponse({ totalTokens: 1 })
        : (generationCalls++, sourceEnvelope({ ok: true })),
      () => {}, async () => controller.abort(new DOMException('cancelled', 'AbortError')),
      controller.signal, 'ATT_MODEL', { fallbackActive: false, pacing: pacer }), /ATT_MODEL_RUN_ABORTED/);
    assert.equal(generationCalls, 0);
  });
});

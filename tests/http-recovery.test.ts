import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchDexPairs } from '../src/providers/dexscreener.js';
import { fetchReadResponse } from '../src/providers/http.js';
import { solanaRpc } from '../src/providers/solana.js';

const URL = 'https://rpc.example/';
const SUCCESS = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }));

async function flushMicrotasks() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('TEST_WAIT_CONDITION_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('read recovery retries only bounded transient HTTP statuses and returns the final response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init! });
    return new Response('busy', { status: 503, headers: { 'retry-after': '0' } });
  };
  const pending = fetchReadResponse(URL, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-read-tag': 'stable' }, body: '{"method":"getGenesisHash"}',
  }, fetcher, 8000);

  await flushMicrotasks();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1000);
  await flushMicrotasks();
  assert.equal(calls.length, 2);
  t.mock.timers.tick(2000);
  await flushMicrotasks();
  const final = await pending;

  assert.equal(final.status, 503);
  assert.equal(await final.text(), 'busy');
  assert.equal(calls.length, 3, 'the response attempt cap is three');
  for (const call of calls) {
    assert.equal(call.url, URL);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.body, '{"method":"getGenesisHash"}');
    assert.equal(new Headers(call.init.headers).get('x-read-tag'), 'stable');
    assert.ok(call.init.signal instanceof AbortSignal);
  }
  assert.notEqual(calls[0]?.init.signal, calls[1]?.init.signal, 'each attempt receives a fresh timeout signal');
});

test('each approved transient HTTP status can recover, while ordinary client errors stay terminal', async t => {
  for (const status of [408, 429, 502, 503, 504]) {
    await t.test(`HTTP ${status}`, async st => {
      st.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
      let calls = 0;
      const pending = fetchReadResponse(URL, {}, async () => {
        calls++;
        return calls === 1
          ? new Response('transient', { status, headers: { 'retry-after': '0' } })
          : SUCCESS();
      }, 8000);
      await flushMicrotasks();
      st.mock.timers.tick(1000);
      await flushMicrotasks();
      assert.equal((await pending).status, 200);
      assert.equal(calls, 2);
    });
  }

  await t.test('HTTP 403 is returned after one attempt', async () => {
    let calls = 0;
    const response = await fetchReadResponse(URL, {}, async () => {
      calls++;
      return new Response('forbidden', { status: 403 });
    }, 8000);
    assert.equal(response.status, 403);
    assert.equal(calls, 1);
  });
});

test('recovery does not start a retry that would cross its thirty-second deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let calls = 0;
  const response = await fetchReadResponse(URL, {}, async () => {
    calls++;
    t.mock.timers.setTime(29_500);
    return new Response('busy', { status: 503, headers: { 'retry-after': '0' } });
  }, 8000);
  assert.equal(response.status, 503);
  assert.equal(calls, 1, 'the one-second backoff would exceed the fixed recovery deadline');
});

test('Retry-After seconds and HTTP dates delay retries, while waits above ten seconds stop recovery', async t => {
  await t.test('seconds are honored without sleeping in real time', async st => {
    st.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-09-30T12:00:00.000Z') });
    let calls = 0;
    const pending = fetchReadResponse(URL, {}, async () => {
      calls++;
      return calls === 1
        ? new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } })
        : SUCCESS();
    }, 8000);
    await flushMicrotasks();
    assert.equal(calls, 1);
    st.mock.timers.tick(1999);
    await flushMicrotasks();
    assert.equal(calls, 1, 'a retry must not start before Retry-After expires');
    st.mock.timers.tick(1);
    await flushMicrotasks();
    assert.equal((await pending).status, 200);
    assert.equal(calls, 2);
  });

  await t.test('HTTP-date Retry-After is honored', async st => {
    const start = new Date('2026-09-30T12:00:00.000Z');
    st.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: start });
    let calls = 0;
    const retryAt = new Date(start.getTime() + 3000).toUTCString();
    const pending = fetchReadResponse(URL, {}, async () => {
      calls++;
      return calls === 1
        ? new Response('rate limited', { status: 429, headers: { 'retry-after': retryAt } })
        : SUCCESS();
    }, 8000);
    await flushMicrotasks();
    assert.equal(calls, 1);
    st.mock.timers.tick(2999);
    await flushMicrotasks();
    assert.equal(calls, 1);
    st.mock.timers.tick(1);
    await flushMicrotasks();
    assert.equal((await pending).status, 200);
    assert.equal(calls, 2);
  });

  await t.test('Retry-After above ten seconds returns the denial without an early retry', async st => {
    st.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    let calls = 0;
    const final = await fetchReadResponse(URL, {}, async () => {
      calls++;
      return new Response('slow down', { status: 429, headers: { 'retry-after': '11' } });
    }, 8000);
    assert.equal(final.status, 429);
    assert.equal(calls, 1);
  });
});

test('read recovery retries transient fetch failures but leaves aborts and permission errors terminal', async t => {
  await t.test('TypeError transport failure recovers and keeps caller request fields', async st => {
    st.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const calls: RequestInit[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      calls.push(init!);
      if (calls.length === 1) throw new TypeError('fetch failed');
      return SUCCESS();
    };
    const pending = fetchReadResponse(URL, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'read-only-body',
    }, fetcher, 8000);
    await flushMicrotasks();
    assert.equal(calls.length, 1);
    st.mock.timers.tick(1000);
    await flushMicrotasks();
    assert.equal((await pending).status, 200);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => [call.method, call.body]), [
      ['POST', 'read-only-body'], ['POST', 'read-only-body'],
    ]);
    assert.notEqual(calls[0]?.signal, calls[1]?.signal);
  });

  await t.test('an explicit timeout failure retries', async st => {
    st.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    let calls = 0;
    const pending = fetchReadResponse(URL, {}, async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
      return SUCCESS();
    }, 8000);
    await flushMicrotasks();
    st.mock.timers.tick(1000);
    await flushMicrotasks();
    assert.equal((await pending).status, 200);
    assert.equal(calls, 2);
  });

  await t.test('AbortError is rethrown after one attempt', async () => {
    let calls = 0;
    const error = new DOMException('cancelled', 'AbortError');
    await assert.rejects(fetchReadResponse(URL, {}, async () => {
      calls++;
      throw error;
    }, 8000), value => value === error);
    assert.equal(calls, 1);
  });

  await t.test('permission failures are rethrown after one attempt', async () => {
    let calls = 0;
    const error = Object.assign(new TypeError('network denied'), { code: 'EACCES' });
    await assert.rejects(fetchReadResponse(URL, {}, async () => {
      calls++;
      throw error;
    }, 8000), value => value === error);
    assert.equal(calls, 1);
  });

  await t.test('non-transient shape or application errors are rethrown after one attempt', async () => {
    let calls = 0;
    const error = new Error('RPC_SHAPE');
    await assert.rejects(fetchReadResponse(URL, {}, async () => {
      calls++;
      throw error;
    }, 8000), value => value === error);
    assert.equal(calls, 1);
  });

  await t.test('caller abort reaches the attempt signal and is not retried', async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = fetchReadResponse(URL, { signal: controller.signal }, (_input, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }, 8000);
    await flushMicrotasks();
    controller.abort(new DOMException('caller stopped collection', 'AbortError'));
    await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError');
    assert.equal(calls, 1);
  });

  await t.test('caller abort during retry backoff cancels the wait without another request', async st => {
    st.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    let calls = 0;
    const pending = fetchReadResponse(URL, { signal: controller.signal }, async () => {
      calls++;
      return new Response('busy', { status: 503, headers: { 'retry-after': '0' } });
    }, 8000);
    await flushMicrotasks();
    assert.equal(calls, 1);
    controller.abort(new DOMException('collection cancelled during backoff', 'AbortError'));
    await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError');
    assert.equal(calls, 1);
  });
});

test('opt-in timeout fallback waits once after the three-attempt fast stage', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const pending = fetchReadResponse(URL, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-read-tag': 'stable' }, body: '{"method":"getGenesisHash"}',
  }, async (input, init) => {
    requests.push({ url: String(input), init: init! });
    if (requests.length < 4) throw Object.assign(new Error('local request timed out'), { name: 'TimeoutError' });
    return SUCCESS();
  }, 8000, true);

  await flushMicrotasks();
  assert.equal(requests.length, 1);
  t.mock.timers.tick(1000);
  await flushMicrotasks();
  assert.equal(requests.length, 2);
  t.mock.timers.tick(2000);
  await flushMicrotasks();
  assert.equal(requests.length, 3);
  t.mock.timers.tick(29_999);
  await flushMicrotasks();
  assert.equal(requests.length, 3, 'the fourth request waits for the full delayed stage');
  t.mock.timers.tick(1);
  await flushMicrotasks();

  assert.equal((await pending).status, 200);
  assert.equal(requests.length, 4, 'fallback permits one request after the three fast attempts');
  assert.ok(Date.now() <= 75_000, 'the fourth request starts within the frozen 75-second operation bound');
  for (const request of requests) {
    assert.equal(request.url, URL);
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.body, '{"method":"getGenesisHash"}');
    assert.equal(new Headers(request.init.headers).get('x-read-tag'), 'stable');
    assert.ok(request.init.signal instanceof AbortSignal);
  }
  assert.equal(new Set(requests.map(request => request.init.signal)).size, 4, 'every attempt gets a fresh timeout signal');
});

test('timeout fallback recognizes direct and nested timeout codes only when enabled', async t => {
  const cases: Array<{ label: string; error: Error }> = [
    { label: 'direct ETIMEDOUT', error: Object.assign(new Error('request failed'), { code: 'ETIMEDOUT' }) },
    { label: 'nested UND_ERR_CONNECT_TIMEOUT', error: new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect timed out'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
    }) },
  ];
  for (const item of cases) {
    await t.test(item.label, async st => {
      st.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
      let calls = 0;
      const pending = fetchReadResponse(URL, {}, async () => {
        calls++;
        if (calls < 4) throw item.error;
        return SUCCESS();
      }, 8000, true);
      await flushMicrotasks();
      st.mock.timers.tick(1000);
      await flushMicrotasks();
      st.mock.timers.tick(2000);
      await flushMicrotasks();
      assert.equal(calls, 3);
      st.mock.timers.tick(30_000);
      await flushMicrotasks();
      assert.equal((await pending).status, 200);
      assert.equal(calls, 4);
    });
  }

  await t.test('plain coded timeout remains terminal for default shared HTTP callers', async () => {
    const error = Object.assign(new Error('request failed'), { code: 'ETIMEDOUT' });
    let calls = 0;
    await assert.rejects(fetchReadResponse(URL, {}, async () => {
      calls++;
      throw error;
    }, 8000), value => value === error);
    assert.equal(calls, 1, 'timeout-code opt-in does not change the default shared HTTP policy');
  });
});

test('timeout fallback is terminal after one delayed request and excludes HTTP and generic transport failures', async t => {
  await t.test('a failed fourth attempt is not retried again', async st => {
    st.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const timeout = Object.assign(new Error('local request timed out'), { name: 'TimeoutError' });
    let calls = 0;
    const pending = fetchReadResponse(URL, {}, async () => {
      calls++;
      throw timeout;
    }, 8000, true);
    await flushMicrotasks();
    st.mock.timers.tick(1000);
    await flushMicrotasks();
    st.mock.timers.tick(2000);
    await flushMicrotasks();
    assert.equal(calls, 3);
    st.mock.timers.tick(30_000);
    await assert.rejects(pending, error => error === timeout);
    assert.equal(calls, 4, 'fallback failure is terminal');
  });

  await t.test('HTTP 503 exhausts only the ordinary transient response stage', async st => {
    st.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    let calls = 0;
    const pending = fetchReadResponse(URL, {}, async () => {
      calls++;
      return new Response('busy', { status: 503, headers: { 'retry-after': '0' } });
    }, 8000, true);
    await flushMicrotasks();
    st.mock.timers.tick(1000);
    await flushMicrotasks();
    st.mock.timers.tick(2000);
    await flushMicrotasks();
    assert.equal((await pending).status, 503);
    assert.equal(calls, 3);
    assert.equal(Date.now(), 3000, 'HTTP status exhaustion does not enter the 30-second timeout fallback');
  });

  await t.test('generic TypeError exhausts ordinary retries without the timeout fallback', async st => {
    st.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const transport = new TypeError('fetch failed');
    let calls = 0;
    const pending = fetchReadResponse(URL, {}, async () => {
      calls++;
      throw transport;
    }, 8000, true);
    await flushMicrotasks();
    st.mock.timers.tick(1000);
    await flushMicrotasks();
    st.mock.timers.tick(2000);
    await flushMicrotasks();
    await assert.rejects(pending, error => error === transport);
    assert.equal(calls, 3);
    assert.equal(Date.now(), 3000, 'generic transport failures do not enter the 30-second timeout fallback');
  });
});

test('caller abort during delayed timeout fallback cancels its timer even with TimeoutError reason', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const controller = new AbortController();
  const reason = Object.assign(new Error('collection deadline elapsed'), { name: 'TimeoutError' });
  let calls = 0;
  const pending = fetchReadResponse(URL, { signal: controller.signal }, async () => {
    calls++;
    throw Object.assign(new Error('local request timed out'), { name: 'TimeoutError' });
  }, 8000, true);
  await flushMicrotasks();
  t.mock.timers.tick(1000);
  await flushMicrotasks();
  t.mock.timers.tick(2000);
  await flushMicrotasks();
  assert.equal(calls, 3);
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  t.mock.timers.tick(30_000);
  await flushMicrotasks();
  assert.equal(calls, 3, 'an aborted fallback wait never starts the fourth request');
});

test('timeout fallback request uses the normal timeout and respects the 75-second ceiling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let calls = 0;
  const pending = fetchReadResponse(URL, {}, (_input, init) => {
    calls++;
    if (calls < 3) return Promise.reject(Object.assign(new Error('local request timed out'), { name: 'TimeoutError' }));
    if (calls === 3) {
      t.mock.timers.setTime(29_999);
      return Promise.reject(Object.assign(new Error('local request timed out'), { name: 'TimeoutError' }));
    }
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  }, 15_000, true);
  await flushMicrotasks();
  t.mock.timers.tick(1000);
  await flushMicrotasks();
  t.mock.timers.tick(2000);
  await flushMicrotasks();
  assert.equal(calls, 3);
  t.mock.timers.tick(30_000);
  await flushMicrotasks();
  assert.equal(calls, 4);
  t.mock.timers.tick(15_000);
  await assert.rejects(pending, error => error instanceof Error && error.name === 'TimeoutError');
  assert.equal(calls, 4, 'the delayed attempt has its normal 15-second timeout and is terminal');
  assert.ok(Date.now() <= 75_000, 'fast stage, delay and fresh attempt stay within the shared recovery bound');
});

test('Solana RPC retries allowlisted reads only and does not retry successful response shape errors', async t => {
  await t.test('an allowlisted read recovers one transient HTTP response', async st => {
    st.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const methods: string[] = [];
    const pending = solanaRpc(URL, 'getGenesisHash', [], async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      methods.push(request.method);
      return methods.length === 1
        ? new Response('busy', { status: 503, headers: { 'retry-after': '0' } })
        : SUCCESS();
    });
    await flushMicrotasks();
    st.mock.timers.tick(1000);
    await flushMicrotasks();
    assert.deepEqual(await pending, { raw: JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }), value: 'ok' });
    assert.deepEqual(methods, ['getGenesisHash', 'getGenesisHash']);
  });

  await t.test('an allowlisted read uses one delayed retry after timeout exhaustion', async st => {
    st.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const pending = solanaRpc(URL, 'getGenesisHash', [], async (input, init) => {
      requests.push({ url: String(input), init });
      if (requests.length < 4) throw Object.assign(new Error('local timeout'), { name: 'TimeoutError' });
      return SUCCESS();
    });
    await flushMicrotasks();
    st.mock.timers.tick(1000);
    await flushMicrotasks();
    st.mock.timers.tick(2000);
    await flushMicrotasks();
    assert.equal(requests.length, 3);
    st.mock.timers.tick(29_999);
    await flushMicrotasks();
    assert.equal(requests.length, 3);
    st.mock.timers.tick(1);
    await flushMicrotasks();
    assert.deepEqual(await pending, { raw: JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }), value: 'ok' });
    assert.equal(requests.length, 4);
    assert.ok(requests.every(request => request.url === URL));
    assert.deepEqual(requests.map(request => JSON.parse(String(request.init?.body))),
      Array.from({ length: 4 }, () => ({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] })));
    assert.equal(new Set(requests.map(request => request.init?.signal)).size, 4, 'each attempt has a fresh timeout signal');
  });

  await t.test('unknown send method gets one bounded request', async () => {
    let calls = 0;
    await assert.rejects(solanaRpc(URL, 'sendTransaction', ['unsigned-placeholder'], async () => {
      calls++;
      return new Response('busy', { status: 503 });
    }), /RPC_HTTP_503/);
    assert.equal(calls, 1);
  });

  await t.test('malformed HTTP-200 JSON RPC shape is not retried', async () => {
    let calls = 0;
    await assert.rejects(solanaRpc(URL, 'getGenesisHash', [], async () => {
      calls++;
      return new Response('{"jsonrpc":"2.0","id":1}', { status: 200 });
    }), /RPC_SHAPE/);
    assert.equal(calls, 1);
  });

  await t.test('HTTP-200 RPC application error is not retried', async () => {
    let calls = 0;
    await assert.rejects(solanaRpc(URL, 'getGenesisHash', [], async () => {
      calls++;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'unsupported' } }), { status: 200 });
    }), /RPC_REMOTE_-32601/);
    assert.equal(calls, 1);
  });

  await t.test('caller signal reaches the RPC request and cancels it without retry', async () => {
    const controller = new AbortController();
    const reason = Object.assign(new Error('global collection timeout'), { name: 'TimeoutError' });
    let calls = 0;
    const pending = solanaRpc(URL, 'getGenesisHash', [], (_input, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }, undefined, controller.signal);
    await flushMicrotasks();
    assert.equal(calls, 1);
    controller.abort(reason);
    await assert.rejects(pending, error => error === reason);
    assert.equal(calls, 1, 'caller cancellation prevents fast and delayed retries');
  });

  await t.test('non-allowlisted RPC receives caller cancellation without retry', async () => {
    const controller = new AbortController();
    const reason = new DOMException('caller stopped RPC', 'AbortError');
    let calls = 0;
    const pending = solanaRpc(URL, 'sendTransaction', ['unsigned-placeholder'], (_input, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }, undefined, controller.signal);
    await flushMicrotasks();
    assert.equal(calls, 1);
    controller.abort(reason);
    await assert.rejects(pending, error => error === reason);
    assert.equal(calls, 1, 'non-allowlisted methods do not gain retries');
  });
});

test('Solana RPC context-lag recovery preserves the finalized request and stays within one bounded budget', async t => {
  const params = ['Mint111', { encoding: 'base64', commitment: 'finalized', minContextSlot: 321 }];
  const lagRaw = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32016, message: 'minimum context slot not reached' } });

  await t.test('two context errors retry the exact serialized request and report each raw attempt', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const contextErrors: Array<{ attempt: number; raw: string }> = [];
    const pending = solanaRpc(URL, 'getAccountInfo', params, async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body) });
      return calls.length < 3
        ? new Response(lagRaw, { status: 200 })
        : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 322 }, value: null } }), { status: 200 });
    }, undefined, undefined, undefined, (attempt, raw) => contextErrors.push({ attempt, raw }));

    await flushMicrotasks();
    assert.equal(calls.length, 1);
    await waitForCondition(() => calls.length === 2);
    assert.equal(calls.length, 2);
    await waitForCondition(() => calls.length === 3);
    assert.deepEqual(await pending, { raw: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 322 }, value: null } }), value: { context: { slot: 322 }, value: null } });
    assert.deepEqual(calls, Array.from({ length: 3 }, () => ({
      url: URL,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params }),
    })), 'each context retry uses the original method, params, commitment, floor, and endpoint');
    assert.deepEqual(contextErrors, [{ attempt: 1, raw: lagRaw }, { attempt: 2, raw: lagRaw }]);
  });

  await t.test('persistent context errors invoke the callback through exhaustion and keep the safe remote code', async () => {
    const contextErrors: Array<{ attempt: number; raw: string }> = [];
    let calls = 0;
    const pending = solanaRpc(URL, 'getAccountInfo', params, async () => {
      calls++;
      return new Response(lagRaw, { status: 200 });
    }, undefined, undefined, undefined, (attempt, raw) => contextErrors.push({ attempt, raw }));
    const rejected = assert.rejects(pending, /RPC_REMOTE_-32016/);
    await flushMicrotasks();
    await waitForCondition(() => calls === 3);
    await rejected;
    assert.equal(calls, 3, 'two bounded additional context attempts follow the original call');
    assert.deepEqual(contextErrors, [{ attempt: 1, raw: lagRaw }, { attempt: 2, raw: lagRaw }, { attempt: 3, raw: lagRaw }],
      'the final exhausted error response is retained before the public error is thrown');
  });

  await t.test('no-floor, unsafe-floor, non-finalized, non-read, malformed, and other-code failures do not use context recovery', async () => {
    const cases: Array<{ method: string; params: unknown[]; raw: string; error: RegExp }> = [
      { method: 'getAccountInfo', params: ['Mint111', { encoding: 'base64', commitment: 'finalized' }], raw: lagRaw, error: /RPC_REMOTE_-32016/ },
      { method: 'getAccountInfo', params: ['Mint111', { encoding: 'base64', commitment: 'finalized', minContextSlot: Number.MAX_SAFE_INTEGER + 1 }], raw: lagRaw, error: /RPC_REMOTE_-32016/ },
      { method: 'getAccountInfo', params: ['Mint111', { encoding: 'base64', commitment: 'confirmed', minContextSlot: 321 }], raw: lagRaw, error: /RPC_REMOTE_-32016/ },
      { method: 'sendTransaction', params: ['signed-placeholder', { commitment: 'finalized', minContextSlot: 321 }], raw: lagRaw, error: /RPC_REMOTE_-32016/ },
      { method: 'getFeeForMessage', params: ['serialized-message', { commitment: 'finalized', minContextSlot: 321 }], raw: lagRaw, error: /RPC_REMOTE_-32016/ },
      { method: 'getAccountInfo', params, raw: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'unsupported' } }), error: /RPC_REMOTE_-32601/ },
      { method: 'getAccountInfo', params, raw: '{', error: /RPC_SHAPE/ },
    ];
    for (const [index, item] of cases.entries()) {
      let calls = 0;
      let callbacks = 0;
      await assert.rejects(solanaRpc(URL, item.method, item.params, async () => {
        calls++;
        return new Response(item.raw, { status: 200 });
      }, undefined, undefined, undefined, () => callbacks++), item.error, `case ${index + 1}`);
      assert.equal(calls, 1, `case ${index + 1} has no context retry`);
      assert.equal(callbacks, 0, `case ${index + 1} does not expose an ineligible or different failure`);
    }
  });

  await t.test('caller cancellation during the context wait prevents another request', async () => {
    const controller = new AbortController();
    const reason = new DOMException('collection cancelled', 'AbortError');
    let calls = 0;
    const contextAttempts: number[] = [];
    const pending = solanaRpc(URL, 'getAccountInfo', params, async () => {
      calls++;
      return new Response(lagRaw, { status: 200 });
    }, undefined, controller.signal, undefined, attempt => contextAttempts.push(attempt));
    await flushMicrotasks();
    assert.equal(calls, 1);
    assert.deepEqual(contextAttempts, [1]);
    controller.abort(reason);
    await assert.rejects(pending, error => error === reason);
    assert.equal(calls, 1);
  });

  await t.test('inner getProgramAccounts HTTP retries share the single 30-second context signal', async st => {
    st.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const timeoutDurations: number[] = [];
    const contextController = new AbortController();
    st.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
      timeoutDurations.push(milliseconds);
      if (milliseconds === 30_000) {
        const timer = setTimeout(() => contextController.abort(new DOMException('context budget ended', 'TimeoutError')), milliseconds);
        contextController.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
        return contextController.signal;
      }
      return new AbortController().signal;
    });
    let calls = 0;
    const contextAttempts: number[] = [];
    const pending = solanaRpc(URL, 'getProgramAccounts', ['Token111', { encoding: 'base64', commitment: 'finalized', minContextSlot: 321 }],
      async (_input, init) => {
        calls++;
        if (calls <= 2) return new Response('provider busy', { status: 503 });
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init?.signal?.reason), { once: true });
        });
      }, undefined, undefined, undefined, attempt => contextAttempts.push(attempt));

    await flushMicrotasks();
    assert.equal(calls, 1);
    st.mock.timers.tick(1000);
    await flushMicrotasks();
    assert.equal(calls, 2);
    st.mock.timers.tick(2000);
    await flushMicrotasks();
    assert.equal(calls, 3);
    st.mock.timers.tick(27_000);
    await assert.rejects(pending, error => error instanceof Error && error.name === 'TimeoutError');
    assert.equal(calls, 3, 'the shared context deadline aborts the third HTTP request at t=30s');
    assert.deepEqual(contextAttempts, [], 'HTTP response retries do not masquerade as JSON-RPC context-lag callbacks');
    assert.equal(timeoutDurations.filter(milliseconds => milliseconds === 30_000).length, 1,
      'one context deadline is created for the whole RPC recovery loop');
    assert.equal(timeoutDurations.filter(milliseconds => milliseconds === 15_000).length, 3,
      'each HTTP attempt remains capped by the same context signal and uses no delayed timeout fallback');
  });
});

test('DEX read recovers transient status responses and leaves malformed HTTP-200 bodies terminal', async t => {
  await t.test('transient 502 is retried once before parsing a valid response', async st => {
    st.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    let calls = 0;
    const pending = fetchDexPairs('solana', '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump', async () => {
      calls++;
      return calls === 1
        ? new Response('busy', { status: 502, headers: { 'retry-after': '0' } })
        : new Response('[]', { status: 200 });
    });
    await flushMicrotasks();
    st.mock.timers.tick(1000);
    await flushMicrotasks();
    const read = await pending;
    assert.equal(read.status, 'NO_RESULTS');
    assert.equal(read.raw, '[]');
    assert.equal(calls, 2);
  });

  await t.test('malformed JSON is not retried', async () => {
    let calls = 0;
    const read = await fetchDexPairs('solana', '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump', async () => {
      calls++;
      return new Response('{');
    });
    assert.equal(read.status, 'INVALID');
    assert.equal(read.code, 'DEX_JSON');
    assert.equal(calls, 1);
  });
});

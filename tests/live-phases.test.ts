import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveRun, type LiveRuntime, type LiveStageName } from '../src/app/live-phases.js';

const EPOCH = Date.parse('2026-10-20T00:00:00.000Z');
const URL = 'https://provider.example/read?key=private-sentinel';

function controlledRuntime() {
  let now = 0;
  const deadlines: Array<{ at: number; controller: AbortController }> = [];
  const advance = (ms: number) => {
    now += ms;
    for (const deadline of deadlines) {
      if (deadline.at <= now && !deadline.controller.signal.aborted) deadline.controller.abort();
    }
  };
  const runtime: LiveRuntime = {
    nowMs: () => now,
    timeout: ms => {
      const controller = new AbortController();
      deadlines.push({ at: now + ms, controller });
      return controller.signal;
    },
    wait: async ms => advance(ms),
  };
  return {
    runtime,
    advance,
    iso: () => new Date(EPOCH + now).toISOString(),
  };
}

function transportSpy() {
  const requests: Array<{ url: string; signal: AbortSignal | undefined }> = [];
  const transport: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), signal: init?.signal as AbortSignal | undefined });
    return new Response('ok');
  };
  return { transport, requests };
}

function stageReceipt(run: ReturnType<typeof createLiveRun>, phase: LiveStageName) {
  return run.receipt({ chain: 'solana', address: 'public-mint' }).stages.find(stage => stage.phase === phase)!;
}

async function assertCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, error => (error as Error & { code?: string }).code === code);
}

test('semantic phase cancellation stops its requests and leaves FINALIZE transport available', async () => {
  const clock = controlledRuntime();
  const spy = transportSpy();
  const run = createLiveRun(true, spy.transport, clock.iso, clock.runtime);
  const attention = run.begin('ATTENTION');

  await attention.fetcher(URL);
  clock.advance(480_000);
  assert.equal(attention.signal.aborted, true);
  await assertCode(attention.fetcher(URL), 'LIVE_PHASE_DEADLINE');
  attention.finish();
  assert.equal(spy.requests.length, 1, 'an aborted phase cannot dispatch another provider request');

  const finalize = run.begin('FINALIZE');
  assert.equal(finalize.signal.aborted, false);
  await finalize.fetcher(URL);
  assert.equal(spy.requests.length, 2, 'final acquisition gets a new live transport signal');
  assert.equal(spy.requests[1]?.signal?.aborted, false);
  finalize.finish();

  assert.deepEqual(
    [stageReceipt(run, 'ATTENTION').status, stageReceipt(run, 'ATTENTION').origin],
    ['CANCELLED', 'PHASE_DEADLINE'],
  );
  assert.equal(stageReceipt(run, 'FINALIZE').status, 'COMPLETED');
  assert.equal(run.operations(), 2);
  const receipt = run.receipt({ chain: 'solana', address: 'public-mint' });
  assert.equal(receipt.hardLimitMs, 840_000);
  assert.equal(receipt.semanticLimitMs, 600_000);
  assert.equal(receipt.operationLimit, 150);
  assert.equal(receipt.elapsedMs, 480_000, 'elapsed time comes from the injected runtime clock');
  assert.deepEqual(receipt.allocations, { PREFLIGHT: 12, ATTENTION: 60, SOCIAL: 18, SHARED: 12, FINALIZE: 48 });
});

test('attention and social share the 480-second window while SHARED keeps the remaining semantic window', () => {
  const clock = controlledRuntime();
  const spy = transportSpy();
  const run = createLiveRun(true, spy.transport, clock.iso, clock.runtime);
  const attention = run.begin('ATTENTION');
  clock.advance(250_000);
  const social = run.begin('SOCIAL');

  clock.advance(229_999);
  assert.equal(attention.signal.aborted, false);
  assert.equal(social.signal.aborted, false);
  clock.advance(1);
  assert.equal(attention.signal.aborted, true);
  assert.equal(social.signal.aborted, true);
  attention.finish();
  social.finish();

  const shared = run.begin('SHARED');
  assert.equal(shared.signal.aborted, false);
  clock.advance(119_999);
  assert.equal(shared.signal.aborted, false);
  clock.advance(1);
  assert.equal(shared.signal.aborted, true);
  shared.finish();

  assert.deepEqual(
    [stageReceipt(run, 'SHARED').status, stageReceipt(run, 'SHARED').origin],
    ['CANCELLED', 'PHASE_DEADLINE'],
  );
});

test('hard and caller cancellation have distinct causes and block subsequent dispatch', async () => {
  {
    const clock = controlledRuntime();
    const spy = transportSpy();
    const run = createLiveRun(true, spy.transport, clock.iso, clock.runtime);
    clock.advance(720_000);
    const finalize = run.begin('FINALIZE');
    clock.advance(120_000);
    assert.equal(run.hardSignal.aborted, true);
    await assertCode(finalize.fetcher(URL), 'LIVE_HARD_DEADLINE');
    finalize.finish();
    assert.deepEqual(
      [stageReceipt(run, 'FINALIZE').status, stageReceipt(run, 'FINALIZE').origin],
      ['CANCELLED', 'HARD_DEADLINE'],
    );
    assert.equal(spy.requests.length, 0);
  }

  {
    const clock = controlledRuntime();
    const spy = transportSpy();
    const caller = new AbortController();
    const run = createLiveRun(true, spy.transport, clock.iso, clock.runtime, caller.signal);
    const finalize = run.begin('FINALIZE');
    caller.abort();
    assert.equal(finalize.signal.aborted, true);
    await assertCode(finalize.fetcher(URL), 'LIVE_CALLER_CANCELLED');
    finalize.finish();
    assert.deepEqual(
      [stageReceipt(run, 'FINALIZE').status, stageReceipt(run, 'FINALIZE').origin],
      ['CANCELLED', 'CALLER'],
    );
    assert.equal(spy.requests.length, 0);
  }
});

test('pending stage reservations cannot be borrowed, completed slack is reusable, and the run stays capped at 150 operations', async () => {
  const clock = controlledRuntime();
  const spy = transportSpy();
  const run = createLiveRun(true, spy.transport, clock.iso, clock.runtime);
  const preflight = run.begin('PREFLIGHT');
  run.begin('ATTENTION');

  for (let count = 0; count < 12; count++) await preflight.fetcher(URL);
  await assertCode(preflight.fetcher(URL), 'LIVE_OPERATION_LIMIT');
  preflight.finish();
  assert.equal(stageReceipt(run, 'PREFLIGHT').status, 'FAILED');
  assert.equal(stageReceipt(run, 'PREFLIGHT').origin, 'OPERATION_LIMIT');
  assert.equal(run.operations(), 12);

  const releasedClock = controlledRuntime();
  const releasedSpy = transportSpy();
  const released = createLiveRun(true, releasedSpy.transport, releasedClock.iso, releasedClock.runtime);
  const unusedPreflight = released.begin('PREFLIGHT');
  unusedPreflight.finish();
  const attention = released.begin('ATTENTION');
  for (let count = 0; count < 72; count++) await attention.fetcher(URL);
  await assertCode(attention.fetcher(URL), 'LIVE_OPERATION_LIMIT');
  attention.finish();
  assert.equal(stageReceipt(released, 'PREFLIGHT').status, 'COMPLETED');
  assert.equal(stageReceipt(released, 'ATTENTION').ops, 72, 'the completed preflight reservation is released, while other pending reservations remain held');
  assert.equal(released.operations(), 72);

  const partialClock = controlledRuntime();
  const partialSpy = transportSpy();
  const partial = createLiveRun(false, partialSpy.transport, partialClock.iso, partialClock.runtime);
  const onlyStage = partial.begin('FINALIZE');
  for (let count = 0; count < 150; count++) await onlyStage.fetcher(URL);
  await assertCode(onlyStage.fetcher(URL), 'LIVE_OPERATION_LIMIT');
  onlyStage.finish();
  const partialReceipt = partial.receipt({ chain: 'solana', address: 'public-mint' });
  assert.equal(partial.operations(), 150);
  assert.equal(partialReceipt.hardLimitMs, 120_000);
  assert.equal(partialReceipt.semanticLimitMs, 0);
  assert.equal(partialReceipt.operationLimit, 150);
  assert.deepEqual(partialReceipt.allocations, { FINALIZE: 150 });
  assert.equal(partialReceipt.stages.find(stage => stage.phase === 'FINALIZE')?.ops, 150);
  assert.equal(partialSpy.requests.length, 150);

  const fullClock = controlledRuntime();
  const fullSpy = transportSpy();
  const full = createLiveRun(true, fullSpy.transport, fullClock.iso, fullClock.runtime);
  for (const phase of ['PREFLIGHT', 'ATTENTION', 'SOCIAL', 'SHARED'] as const) full.begin(phase).finish();
  const final = full.begin('FINALIZE');
  for (let count = 0; count < 150; count++) await final.fetcher(URL);
  await assertCode(final.fetcher(URL), 'LIVE_OPERATION_LIMIT');
  final.finish();
  assert.equal(full.operations(), 150);
  assert.equal(fullSpy.requests.length, 150);

  const timeoutClock = controlledRuntime();
  const timeoutSpy = transportSpy();
  const timedPartial = createLiveRun(false, timeoutSpy.transport, timeoutClock.iso, timeoutClock.runtime);
  const timedStage = timedPartial.begin('FINALIZE');
  timeoutClock.advance(120_000);
  assert.equal(timedStage.signal.aborted, true);
  await assertCode(timedStage.fetcher(URL), 'LIVE_HARD_DEADLINE');
  timedStage.finish();
  assert.deepEqual(
    [stageReceipt(timedPartial, 'FINALIZE').status, stageReceipt(timedPartial, 'FINALIZE').origin],
    ['CANCELLED', 'HARD_DEADLINE'],
  );
  assert.equal(timeoutSpy.requests.length, 0);
});

test('a finished stage rejects later requests and receipts contain bounded diagnostics with ISO clocks', async () => {
  const clock = controlledRuntime();
  const spy = transportSpy();
  const run = createLiveRun(true, spy.transport, clock.iso, clock.runtime);
  const preflight = run.begin('PREFLIGHT');
  await preflight.fetcher(URL);
  preflight.finish();
  await assertCode(preflight.fetcher(URL), 'LIVE_STAGE_FINISHED');
  assert.throws(() => run.begin('PREFLIGHT'), { message: 'LIVE_STAGE_RESTART' });
  assert.throws(() => run.skip('PREFLIGHT', 'SOCIAL'), { message: 'LIVE_STAGE_RESTART' });
  run.skip('SHARED', 'SOCIAL');
  assert.throws(() => run.begin('SHARED'), { message: 'LIVE_STAGE_RESTART' });
  assert.throws(() => run.skip('SHARED', 'ATTENTION'), { message: 'LIVE_STAGE_RESTART' });

  const activeRun = createLiveRun(true, spy.transport, clock.iso, clock.runtime);
  const active = activeRun.begin('ATTENTION');
  assert.throws(() => activeRun.begin('ATTENTION'), { message: 'LIVE_STAGE_RESTART' });
  assert.throws(() => activeRun.skip('ATTENTION', 'SOCIAL'), { message: 'LIVE_STAGE_RESTART' });
  active.finish();

  const receipt = run.receipt({ chain: 'solana', address: 'public-mint' });
  const preflightRecord = receipt.stages.find(stage => stage.phase === 'PREFLIGHT')!;
  const sharedRecord = receipt.stages.find(stage => stage.phase === 'SHARED')!;
  assert.equal(preflightRecord.status, 'COMPLETED');
  assert.equal(preflightRecord.ops, 1);
  assert.equal(Number.isInteger(preflightRecord.startMs), true);
  assert.equal(Number.isInteger(preflightRecord.endMs), true);
  assert.equal(new Date(preflightRecord.startedAt!).toISOString(), preflightRecord.startedAt);
  assert.equal(new Date(preflightRecord.endedAt!).toISOString(), preflightRecord.endedAt);
  assert.deepEqual(
    [sharedRecord.status, sharedRecord.origin, sharedRecord.blockedBy],
    ['NOT_STARTED', 'DEPENDENCY', 'SOCIAL'],
  );
  assert.equal(receipt.stages.find(stage => stage.phase === 'ATTENTION')?.status, 'NOT_STARTED');
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes(URL), false);
  assert.equal(serialized.includes('LIVE_STAGE_FINISHED'), false);
  assert.equal(serialized.includes('private-sentinel'), false);
  assert.equal(spy.requests.length, 1);
});

/** Bounded recovery for read-only provider requests. Callers retain schema/error ownership. */
export async function fetchReadResponse(url: string, init: RequestInit, fetcher: typeof fetch, timeoutMs: number, timeoutFallback = false): Promise<Response> {
  const deadline = Date.now() + 30_000;
  const wait = async (delay: number) => {
    init.signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const finish = () => { init.signal?.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(finish, delay);
      const abort = () => { clearTimeout(timer); reject(init.signal!.reason); };
      init.signal?.addEventListener('abort', abort, { once: true });
    });
    init.signal?.throwIfAborted();
  };
  for (let attempt = 0; ; attempt++) {
    init.signal?.throwIfAborted();
    let response: Response | undefined;
    let failure: unknown;
    try {
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, deadline - Date.now())));
      response = await fetcher(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
      if (![408, 429, 502, 503, 504].includes(response.status)) return response;
    } catch (error) {
      init.signal?.throwIfAborted();
      const code = (error as { code?: string; cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code;
      if (error instanceof Error && error.name === 'AbortError' || ['EACCES', 'EPERM'].includes(code ?? '')) throw error;
      // fetch reports transport failures as TypeError, and timeout signals as TimeoutError.
      if (!(error instanceof TypeError) && !(error instanceof Error && error.name === 'TimeoutError') && !(timeoutFallback && ['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT'].includes(code ?? ''))) throw error;
      failure = error;
    }
    let delay = (attempt + 1) * 1000;
    const header = response?.headers.get('retry-after');
    if (header !== null && header !== undefined) {
      const seconds = /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header) - Date.now();
      if (Number.isFinite(seconds)) delay = Math.max(delay, Math.ceil(seconds));
    }
    if (attempt >= 2 || delay > 10_000 || Date.now() + delay >= deadline) {
      if (response) return response;
      const error = failure as { name?: string; code?: string; cause?: { code?: string } } | undefined;
      const timedOut = error?.name === 'TimeoutError' || [error?.code, error?.cause?.code].some(code => code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT');
      if (timeoutFallback && timedOut) {
        await wait(30_000);
        if (Date.now() >= deadline + 45_000) throw failure;
        const timeout = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, deadline + 45_000 - Date.now())));
        return fetcher(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
      }
      throw failure;
    }
    await response?.body?.cancel();
    await wait(delay);
  }
}

export async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new Error('PROVIDER_EMPTY_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength; if (total > maxBytes) throw new Error('PROVIDER_RESPONSE_LIMIT');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

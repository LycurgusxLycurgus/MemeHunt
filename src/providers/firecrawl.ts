import { readLimitedText } from './http.js';
import { publicHttpsUrl, type WebPage } from './tinyfish.js';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

const SCRAPE_URL = 'https://api.firecrawl.dev/v2/scrape';
const SEARCH_URL = 'https://api.firecrawl.dev/v2/search';
const RESPONSE_LIMIT = 500_000;
const MARKDOWN_LIMIT = 120_000;
const QUERY_LIMIT = 2_000;
const NON_HTML_EXTENSION = /\.(?:pdf|apng|avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp|7z|arj|bz2|cab|dmg|gz|iso|jar|lz|lz4|rar|tar|tgz|xz|zip|zst)$/i;
const ACCESS_WALLS = new Set([
  'access denied', 'authentication required', 'captcha', 'checking your browser', 'enable javascript and cookies',
  'forbidden', 'login required', 'login wall', 'log in required', 'log in to access this page', 'log in to continue',
  'log in to view this page', 'page not found', 'please verify you are human', 'safety check', 'security check',
  'sign in required', 'sign in to access this page', 'sign in to continue', 'sign in to view this page',
  'unusual traffic', 'verify that you are human', 'verify you are human', 'we need to verify you are human',
]);

export type FirecrawlRequest = {
  operation: 'SCRAPE' | 'SEARCH';
  url?: string;
  query?: string;
  at: string;
};

export type FirecrawlFallbackResult = {
  status: 'OBSERVED' | 'NO_RESULTS' | 'UNAVAILABLE' | 'INVALID';
  code?: string;
  httpStatus?: number;
  pages: WebPage[];
  results?: { url: string; title: string; description: string }[];
  raw?: string;
  request: FirecrawlRequest;
  provider: 'firecrawl';
};

type Exchange = { response: Response; raw: string } | { failure: 'TIMEOUT' | 'CANCELLED' | 'TRANSPORT' | 'RESPONSE_LIMIT'; httpStatus?: number };
type ExchangeFailure = Extract<Exchange, { failure: string }>['failure'];

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function safeFailure(error: unknown, callerSignal: AbortSignal | undefined, timeoutSignal: AbortSignal): ExchangeFailure {
  if (callerSignal?.aborted) return 'CANCELLED';
  if (timeoutSignal.aborted || (error instanceof Error && error.name === 'TimeoutError')) return 'TIMEOUT';
  if (error instanceof Error && error.name === 'AbortError') return 'CANCELLED';
  return 'TRANSPORT';
}

function exchangeCode(failure: ExchangeFailure): string {
  switch (failure) {
    case 'TIMEOUT': return 'FIRECRAWL_TIMEOUT';
    case 'CANCELLED': return 'FIRECRAWL_CANCELLED';
    case 'RESPONSE_LIMIT': return 'FIRECRAWL_RESPONSE_LIMIT';
    case 'TRANSPORT': return 'FIRECRAWL_TRANSPORT';
  }
}

function reportedUrl(metadata: JsonObject, name: 'url' | 'sourceURL'): { valid: boolean; value?: string } {
  if (!Object.hasOwn(metadata, name)) return { valid: true };
  const value = metadata[name];
  if (typeof value !== 'string') return { valid: false };
  const safe = publicHttpsUrl(value, true);
  return safe ? { valid: true, value: safe } : { valid: false };
}

function challengePage(markdown: string): boolean {
  const normalized = markdown.trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/[.!?:;,]+$/, '')
    .replace(/^(\*\*|__)(.*)\1$/, '$2')
    .replace(/^`(.*)`$/, '$1')
    .replace(/^[\s"'“”‘’([{]+/, '')
    .replace(/[\s"'“”‘’)}\].,:;!?]+$/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return ACCESS_WALLS.has(normalized);
}

function nonHtmlInput(url: string): boolean {
  let pathname = new URL(url).pathname;
  try { pathname = decodeURIComponent(pathname); } catch { /* The encoded path still gets checked below. */ }
  return NON_HTML_EXTENSION.test(pathname.replace(/\/+$/, ''));
}

function makeResult(
  request: FirecrawlRequest,
  status: FirecrawlFallbackResult['status'],
  code?: string,
  extra: { pages?: WebPage[]; results?: FirecrawlFallbackResult['results']; raw?: string; httpStatus?: number } = {},
): FirecrawlFallbackResult {
  return {
    status,
    ...(code ? { code } : {}),
    ...(extra.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}),
    pages: extra.pages ?? [],
    ...(extra.results ? { results: extra.results } : {}),
    ...(extra.raw !== undefined ? { raw: extra.raw } : {}),
    request,
    provider: 'firecrawl',
  };
}

function checkedRequest(value: unknown): FirecrawlRequest {
  if (!object(value) || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) {
    throw new Error('FIRECRAWL_REQUEST_INVALID');
  }
  const keys = Object.keys(value).sort().join(',');
  if (value.operation === 'SCRAPE' && keys === 'at,operation,url' && typeof value.url === 'string') {
    const url = publicHttpsUrl(value.url, true);
    if (url !== value.url || nonHtmlInput(value.url)) throw new Error('FIRECRAWL_REQUEST_INVALID');
    return { operation: 'SCRAPE', url, at: value.at };
  }
  if (value.operation === 'SEARCH' && keys === 'at,operation,query' && typeof value.query === 'string' &&
      value.query.trim() === value.query && value.query.length > 0 && value.query.length <= QUERY_LIMIT) {
    return { operation: 'SEARCH', query: value.query, at: value.at };
  }
  throw new Error('FIRECRAWL_REQUEST_INVALID');
}

/** Decode a retained Firecrawl HTTP response without making a network request. */
export function decodeFirecrawlArtifact(requestValue: FirecrawlRequest, raw: string, httpStatus: number): FirecrawlFallbackResult {
  const request = checkedRequest(requestValue);
  if (typeof raw !== 'string') throw new Error('FIRECRAWL_RAW_INVALID');
  if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) throw new Error('FIRECRAWL_STATUS_INVALID');
  const decoded = (status: FirecrawlFallbackResult['status'], code?: string,
    extra: { pages?: WebPage[]; results?: FirecrawlFallbackResult['results']; raw?: string } = {}) =>
    makeResult(request, status, code, { ...extra, httpStatus });
  if (Buffer.byteLength(raw, 'utf8') > RESPONSE_LIMIT) return decoded('INVALID', 'FIRECRAWL_RESPONSE_LIMIT');
  if (httpStatus !== 200) return decoded('UNAVAILABLE', `FIRECRAWL_HTTP_${httpStatus}`, { raw });

  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return decoded('INVALID', 'FIRECRAWL_JSON', { raw }); }
  if (!object(value) || typeof value.success !== 'boolean') return decoded('INVALID', 'FIRECRAWL_SHAPE', { raw });
  if (!value.success) return decoded('UNAVAILABLE', 'FIRECRAWL_REQUEST_FAILED', { raw });

  if (request.operation === 'SCRAPE') {
    if (!object(value.data) || typeof value.data.markdown !== 'string' || !object(value.data.metadata) ||
        typeof value.data.metadata.statusCode !== 'number' || !Number.isInteger(value.data.metadata.statusCode) ||
        value.data.metadata.statusCode < 100 || value.data.metadata.statusCode > 599) {
      return decoded('INVALID', 'FIRECRAWL_SHAPE', { raw });
    }
    const metadata = value.data.metadata;
    const reported = reportedUrl(metadata, 'url');
    const source = reportedUrl(metadata, 'sourceURL');
    if (!reported.valid || !source.valid) return decoded('INVALID', 'FIRECRAWL_METADATA_URL', { raw });
    const markdown = value.data.markdown;
    if (markdown.length > MARKDOWN_LIMIT) return decoded('INVALID', 'FIRECRAWL_CONTENT_LIMIT', { raw });
    if (metadata.statusCode !== 200) return decoded('UNAVAILABLE', `FIRECRAWL_TARGET_HTTP_${metadata.statusCode}`, { raw });
    if (!markdown.trim()) return decoded('NO_RESULTS', 'FIRECRAWL_EMPTY_CONTENT', { raw });
    if (challengePage(markdown)) return decoded('UNAVAILABLE', 'FIRECRAWL_CHALLENGE_PAGE', { raw });
    const finalUrl = reported.value ?? source.value;
    if (!finalUrl) return decoded('INVALID', 'FIRECRAWL_FINAL_URL_MISSING', { raw });
    const page: WebPage = { url: request.url!, finalUrl, text: markdown, publishedDate: null };
    return decoded('OBSERVED', undefined, { pages: [page], raw });
  }

  if (!object(value.data) || !Array.isArray(value.data.web)) return decoded('INVALID', 'FIRECRAWL_SHAPE', { raw });
  if (value.data.web.length > 5) return decoded('INVALID', 'FIRECRAWL_RESULT_LIMIT', { raw });
  if (value.data.web.length === 0) return decoded('NO_RESULTS', undefined, { results: [], raw });
  const results: NonNullable<FirecrawlFallbackResult['results']> = [];
  for (const item of value.data.web) {
    if (!object(item) || typeof item.url !== 'string' ||
        (item.title !== undefined && typeof item.title !== 'string') ||
        (item.description !== undefined && typeof item.description !== 'string')) {
      return decoded('INVALID', 'FIRECRAWL_SEARCH_SHAPE', { raw });
    }
    const safeUrl = publicHttpsUrl(item.url, true);
    if (!safeUrl) return decoded('INVALID', 'FIRECRAWL_SEARCH_URL', { raw });
    results.push({ url: safeUrl, title: (item.title as string | undefined) ?? '', description: (item.description as string | undefined) ?? '' });
  }
  return decoded('OBSERVED', undefined, { results, raw });
}

export function createFirecrawlFallback(options: { key: string; fetcher?: typeof fetch; now?: () => string }) {
  const key = options.key.trim();
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date().toISOString());
  let scrapeAttempts = 0;
  let searchAttempts = 0;

  const exchange = async (endpoint: string, body: unknown, signal?: AbortSignal): Promise<Exchange> => {
    const timeoutSignal = AbortSignal.timeout(30_000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response: Response | undefined;
    try {
      response = await abortable(fetcher(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        credentials: 'omit',
        signal: combinedSignal,
      }), combinedSignal);
      const raw = await abortable(readLimitedText(response, RESPONSE_LIMIT).catch(error => {
        if (error instanceof Error && error.message === 'PROVIDER_EMPTY_RESPONSE') return '';
        throw error;
      }), combinedSignal);
      return { response, raw };
    } catch (error) {
      void response?.body?.cancel().catch(() => undefined);
      const httpStatus = response ? { httpStatus: response.status } : {};
      if (error instanceof Error && error.message === 'PROVIDER_RESPONSE_LIMIT') return { failure: 'RESPONSE_LIMIT', ...httpStatus };
      return { failure: safeFailure(error, signal, timeoutSignal), ...httpStatus };
    }
  };

  const invalid = (request: FirecrawlRequest, code: string, raw?: string, httpStatus?: number) => makeResult(request, 'INVALID', code, { raw, ...(httpStatus !== undefined ? { httpStatus } : {}) });
  const unavailable = (request: FirecrawlRequest, code: string, raw?: string, httpStatus?: number) => makeResult(request, 'UNAVAILABLE', code, { raw, ...(httpStatus !== undefined ? { httpStatus } : {}) });

  return {
    async scrape(url: string, signal?: AbortSignal): Promise<FirecrawlFallbackResult> {
      const requestedUrl = typeof url === 'string' ? publicHttpsUrl(url, true) : null;
      const request: FirecrawlRequest = { operation: 'SCRAPE', ...(requestedUrl ? { url: requestedUrl } : {}), at: now() };
      if (signal?.aborted) return unavailable(request, 'FIRECRAWL_CANCELLED');
      if (!requestedUrl) return invalid(request, 'FIRECRAWL_URL_INVALID');
      if (nonHtmlInput(requestedUrl)) return invalid(request, 'FIRECRAWL_UNSUPPORTED_MEDIA_URL');
      if (!key) return unavailable(request, 'FIRECRAWL_DISABLED');
      if (scrapeAttempts >= 2) return unavailable(request, 'FIRECRAWL_ATTEMPT_LIMIT');

      scrapeAttempts++;
      const call = await exchange(SCRAPE_URL, {
        url: requestedUrl,
        formats: ['markdown'],
        parsers: [],
        maxAge: 0,
        skipTlsVerification: false,
        storeInCache: false,
        timeout: 20_000,
      }, signal);
      if ('failure' in call) {
        const code = exchangeCode(call.failure);
        return call.failure === 'RESPONSE_LIMIT' ? invalid(request, code, undefined, call.httpStatus) : unavailable(request, code, undefined, call.httpStatus);
      }
      return decodeFirecrawlArtifact(request, call.raw, call.response.status);
    },

    async search(query: string, signal?: AbortSignal): Promise<FirecrawlFallbackResult> {
      const normalizedQuery = typeof query === 'string' ? query.trim() : '';
      const validQuery = normalizedQuery.length > 0 && normalizedQuery.length <= QUERY_LIMIT;
      const request: FirecrawlRequest = {
        operation: 'SEARCH',
        ...(validQuery ? { query: normalizedQuery } : {}),
        at: now(),
      };
      if (signal?.aborted) return unavailable(request, 'FIRECRAWL_CANCELLED');
      if (!validQuery) return invalid(request, 'FIRECRAWL_QUERY_INVALID');
      if (!key) return unavailable(request, 'FIRECRAWL_DISABLED');
      if (searchAttempts >= 1) return unavailable(request, 'FIRECRAWL_ATTEMPT_LIMIT');

      searchAttempts++;
      const call = await exchange(SEARCH_URL, { query: normalizedQuery, limit: 5, sources: ['web'] }, signal);
      if ('failure' in call) {
        const code = exchangeCode(call.failure);
        return call.failure === 'RESPONSE_LIMIT' ? invalid(request, code, undefined, call.httpStatus) : unavailable(request, code, undefined, call.httpStatus);
      }
      return decodeFirecrawlArtifact(request, call.raw, call.response.status);
    },
  };
}

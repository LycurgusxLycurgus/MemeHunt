import { isIP } from 'node:net';
import { readLimitedText } from './http.js';

type JsonObject = Record<string, unknown>;
const object = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
const code = (error: unknown) => error instanceof Error && error.message === 'PROVIDER_RESPONSE_LIMIT' ? 'WEB_RESPONSE_LIMIT' : 'WEB_TRANSPORT';
const fetchErrorCodes = new Set([
  'target_http_error', 'page_not_found', 'target_unreachable', 'timeout', 'bot_blocked',
  'empty_content', 'login_required', 'content_too_large', 'invalid_url', 'invalid_redirect_url',
  'proxy_error', 'conditional_unsupported', 'selector_not_matched', 'selector_unsupported',
]);
const safeFetchErrorCode = (value: unknown): string => {
  const reason = object(value) ? value.error : undefined;
  return typeof reason === 'string' && fetchErrorCodes.has(reason)
    ? `WEB_FETCH_${reason.toUpperCase()}`
    : 'WEB_FETCH_URL_ERROR';
};

export type WebPage = { url: string; finalUrl: string; text: string; publishedDate: string | null };
export type WebRead = { status: 'OBSERVED'|'NO_RESULTS'|'UNAVAILABLE'|'INVALID'|'TRUNCATED'; code?: string; searchRaw?: string; fetchRaw?: string; pages: WebPage[] };

export function publicHttpsUrl(value: string, retainQuery=false): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) return null;
    const host = u.hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
        host.endsWith('.internal') || host.endsWith('.test') || host.endsWith('.invalid') ||
        isIP(host) || host.includes('[') || host.includes(']')) return null;
    u.hash = '';
    if(!retainQuery)u.search = '';
    else for(const name of [...u.searchParams.keys()]){
      if(/^(?:api[_-]?key|access[_-]?token|authorization|password|secret|signature|token)$/i.test(name))return null;
      if(/^utm_/i.test(name)||/^(?:fbclid|gclid|msclkid)$/i.test(name))u.searchParams.delete(name);
    }
    return u.toString();
  } catch { return null; }
}

export async function searchAndFetchPublic(
  address: string, key: string, fetcher: typeof fetch = fetch, dexUrls: string[] = [], chain='solana',
): Promise<WebRead> {
  let searchRaw: string;
  let searchValue: unknown;
  try {
    const url = new URL('https://api.search.tinyfish.ai/');
    url.searchParams.set('query', `"${address}" ${chain}`);
    const response = await fetcher(url, { headers: { 'X-API-Key': key, accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) return { status: 'UNAVAILABLE', code: `WEB_SEARCH_HTTP_${response.status}`, pages: [] };
    searchRaw = await readLimitedText(response, 100_000);
    searchValue = JSON.parse(searchRaw);
  } catch (error) { return { status: 'UNAVAILABLE', code: code(error), pages: [] }; }
  if (!object(searchValue) || !Array.isArray(searchValue.results)) return { status: 'INVALID', code: 'WEB_SEARCH_SHAPE', searchRaw, pages: [] };
  const urls: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const safe = publicHttpsUrl(value);
    if (safe && !urls.includes(safe) && urls.length < 5) urls.push(safe);
  };
  for (const item of searchValue.results) if (object(item)) add(item.url);
  for (const url of dexUrls) add(url);
  if (!urls.length) return { status: 'NO_RESULTS', searchRaw, pages: [] };
  let fetchRaw: string;
  let fetchValue: unknown;
  try {
    const response = await fetcher('https://api.fetch.tinyfish.ai/', {
      method: 'POST', headers: { 'X-API-Key': key, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ urls, format: 'markdown', ttl: 0, per_url_timeout_ms: 8000 }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) return { status: 'UNAVAILABLE', code: `WEB_FETCH_HTTP_${response.status}`, searchRaw, pages: [] };
    fetchRaw = await readLimitedText(response, 400_000);
    fetchValue = JSON.parse(fetchRaw);
  } catch (error) { return { status: 'UNAVAILABLE', code: code(error), searchRaw, pages: [] }; }
  if (!object(fetchValue) || !Array.isArray(fetchValue.results) || !Array.isArray(fetchValue.errors)) {
    return { status: 'INVALID', code: 'WEB_FETCH_SHAPE', searchRaw, fetchRaw, pages: [] };
  }
  const pages: WebPage[] = [];
  for (const item of fetchValue.results) {
    if (!object(item) || typeof item.url !== 'string' || typeof item.text !== 'string') continue;
    const requested = publicHttpsUrl(item.url);
    const finalUrl = typeof item.final_url === 'string' ? publicHttpsUrl(item.final_url) : requested;
    if (!requested || !finalUrl || !urls.includes(requested)) continue;
    // Only exact token mentions enter the model packet; a DEX link alone is a claimed association.
    const bindingAt = item.text.indexOf(address);
    if (bindingAt < 0) continue;
    const excerptStart = Math.max(0, bindingAt - 3_000);
    pages.push({ url: requested, finalUrl, text: item.text.slice(excerptStart, excerptStart + 12_000),
      publishedDate: typeof item.published_date === 'string' ? item.published_date : null });
  }
  if (fetchValue.errors.length) {
    return { status: pages.length ? 'TRUNCATED' : 'UNAVAILABLE', code: safeFetchErrorCode(fetchValue.errors[0]), searchRaw, fetchRaw, pages };
  }
  return { status: pages.length ? 'OBSERVED' : 'NO_RESULTS', searchRaw, fetchRaw, pages };
}

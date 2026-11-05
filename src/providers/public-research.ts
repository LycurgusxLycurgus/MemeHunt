import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { EvidenceRecord, TokenRef } from '../domain/contracts.js';
import { readLimitedText } from './http.js';

export type PublicSource = {
  url: string; discoveredFrom: string; status: 'OBSERVED' | 'UNAVAILABLE';
  httpStatus?: number; code?: string; evidenceId?: string;
  exactContractInResponse: boolean | null;
  qualification: 'UNREVIEWED';
};
export type PublicResearch = {
  token: TokenRef; cutoff: string; status: 'OBSERVED' | 'UNAVAILABLE';
  sources: PublicSource[]; evidence: EvidenceRecord[]; rawArtifacts: Record<string, string>;
  scope: { method: 'dex-linked-public-pages-v1'; sourceLimit: number; sourceLimitReached: boolean; completeSocialSample: false };
  // A discovered page, an address match or an inaccessible account cannot resolve
  // semantic, platform-coverage, authenticity, safety or execution checks.
  qualifiedFeatures: []; limitations: string[];
};
type Options = { fetcher?: typeof fetch; now?: () => string; resolver?: (host: string) => Promise<Array<{ address: string }>> };
const MAX_SOURCES = 4, MAX_BYTES = 500_000;
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const publicIp = (ip: string) => {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127);
  }
  // Conservatively require global-unicast IPv6; IPv4-mapped/private answers do not qualify.
  return isIP(ip) === 6 && /^[23][0-9a-f]{3}:/i.test(ip);
};

export async function collectPublicResearch(token: TokenRef, options: Options = {}): Promise<PublicResearch> {
  if (token.chain !== 'solana' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token.address)) throw new Error('INVALID_SOLANA_ADDRESS');
  const now = options.now ?? (() => new Date().toISOString());
  const fetcher = options.fetcher ?? fetch;
  const resolveHost = options.resolver ?? (host => lookup(host, { all: true }));
  const evidence: EvidenceRecord[] = [], rawArtifacts: Record<string, string> = {}, sources: PublicSource[] = [];
  const leads: Array<{ url: string; from: string }> = [];
  let limited = false;
  const add = (url: string, from: string) => {
    if (leads.some(x => x.url === url)) return;
    if (leads.length >= MAX_SOURCES) { limited = true; return; }
    leads.push({ url, from });
  };
  const retain = (id: string, raw: string, url: string, sourceType: string) => {
    const at = now();
    rawArtifacts[id] = raw;
    evidence.push({ id, sourceId: sourceType === 'MARKET_API' ? 'dexscreener' : 'public-web', sourceType,
      retrievedAt: at, availableAt: at, contentHash: hash(raw), adapterVersion: 'public-research-v1', accessMode: 'PUBLIC_API',
      scope: { url, token, method: 'dex-linked-public-pages-v1', qualification: 'UNREVIEWED' } });
  };
  const read = async (input: string) => {
    let url = new URL(input);
    for (let hop = 0; hop <= 2; hop++) {
      if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') throw new Error('PUBLIC_HTTPS_REQUIRED');
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(host) ? [{ address: host }] : await resolveHost(host);
      if (!addresses.length || addresses.some(a => !publicIp(a.address))) throw new Error('NONPUBLIC_SOURCE');
      const response = await fetcher(url.toString(), { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { accept: 'text/html,application/json,text/plain' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || hop === 2) throw new Error('REDIRECT_LIMIT');
        url = new URL(location, url); continue;
      }
      const raw = await readLimitedText(response, MAX_BYTES);
      return { status: response.status, ok: response.ok, raw, url: url.toString() };
    }
    throw new Error('REDIRECT_LIMIT');
  };
  const diagnostic = (error: unknown) => error instanceof Error && ['PUBLIC_HTTPS_REQUIRED', 'NONPUBLIC_SOURCE', 'REDIRECT_LIMIT', 'PROVIDER_RESPONSE_LIMIT', 'PROVIDER_SHAPE'].includes(error.message)
    ? error.message : error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'SOURCE_TIMEOUT' : 'SOURCE_UNAVAILABLE';
  const marketUrl = `https://api.dexscreener.com/token-pairs/v1/solana/${encodeURIComponent(token.address)}`;
  try {
    const response = await read(marketUrl);
    retain('free-market', response.raw, response.url, 'MARKET_API');
    if (!response.ok) throw new Error('SOURCE_UNAVAILABLE');
    const pairs: unknown = JSON.parse(response.raw);
    if (!Array.isArray(pairs)) throw new Error('PROVIDER_SHAPE');
    // Pair metadata describes the base token. A quote-side address match cannot supply its project links.
    for (const pair of pairs) {
      if (pair?.chainId !== 'solana' || pair?.baseToken?.address !== token.address) continue;
      for (const link of [...(Array.isArray(pair.info?.websites) ? pair.info.websites : []), ...(Array.isArray(pair.info?.socials) ? pair.info.socials : [])]) {
        if (typeof link?.url === 'string') add(link.url, marketUrl);
      }
    }
  } catch (error) {
    sources.push({ url: marketUrl, discoveredFrom: 'supplied mint', status: 'UNAVAILABLE', code: diagnostic(error), exactContractInResponse: null, qualification: 'UNREVIEWED' });
  }
  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i]!;
    try {
      const response = await read(lead.url), id = `free-page-${i + 1}`;
      retain(id, response.raw, response.url, 'WEB_PAGE');
      sources.push({ url: response.url, discoveredFrom: lead.from, status: response.ok ? 'OBSERVED' : 'UNAVAILABLE', httpStatus: response.status,
        evidenceId: id, exactContractInResponse: response.ok ? response.raw.includes(token.address) : null, qualification: 'UNREVIEWED' });
      // One explicitly linked documentation page on the same origin; no guessed endpoint or exhaustive crawl.
      if (response.ok) for (const match of response.raw.matchAll(/href=["']([^"']+)["']/gi)) {
        try {
          const doc = new URL(match[1]!, response.url); doc.hash = '';
          if (doc.origin === new URL(response.url).origin && /^\/(docs|documentation)(\.html)?\/?$/.test(doc.pathname)) { add(doc.toString(), response.url); break; }
        } catch { /* Invalid markup is not an additional lead. */ }
      }
    } catch (error) {
      sources.push({ url: lead.url, discoveredFrom: lead.from, status: 'UNAVAILABLE', code: diagnostic(error), exactContractInResponse: null, qualification: 'UNREVIEWED' });
    }
  }
  return { token, cutoff: now(), status: sources.some(s => s.status === 'OBSERVED') ? 'OBSERVED' : 'UNAVAILABLE', sources, evidence, rawArtifacts,
    scope: { method: 'dex-linked-public-pages-v1', sourceLimit: MAX_SOURCES, sourceLimitReached: limited, completeSocialSample: false }, qualifiedFeatures: [],
    limitations: ['DEX links are discovery leads, not authenticated identity.', 'Exact contract text is a binding lead, not semantic qualification.',
      'No platform-wide search, complete post sample, human adjudication or independent model review was performed.', 'No safety, stage or quantity-specific exit proof is produced.'] };
}

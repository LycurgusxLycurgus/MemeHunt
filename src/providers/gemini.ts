import { readLimitedText } from './http.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { semanticClaimSchema, type SemanticResult } from '../domain/contracts.js';
export const geminiSettings = {
  model: 'gemini-3.5-flash-lite',
  maxOutputTokens: 65536,
  baselineThinkingLevel: 'medium',
  semanticThinkingLevel: 'high',
  safetySettings: [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
  ],
} as const;

export function buildGeminiSemanticRequest(publicRedactedText: string) {
  if (!publicRedactedText || publicRedactedText.length > 100_000) throw new Error('INVALID_SEMANTIC_PACKET');
  return {
    contents: [{ role: 'user', parts: [{ text: publicRedactedText }] }],
    generationConfig: { maxOutputTokens: geminiSettings.maxOutputTokens, thinkingConfig: { thinkingLevel: geminiSettings.semanticThinkingLevel }, responseMimeType: 'application/json',
      responseJsonSchema: { type: 'object', properties: { claims: { type: 'array', maxItems: 20, items: { type: 'object',
        properties: { kind: { type: 'string', enum: ['NARRATIVE','GAME_TYPE','TOKEN_RELATION','SOCIAL_ACCOUNT','ORIGIN','CONTRADICTION'] },
          value: { type: 'string' }, evidenceId: { type: 'string' }, quote: { type: 'string' },
          assertion: { type: 'string', enum: ['SOURCE_STATES','MODEL_INFERENCE'] } },
        required: ['kind','value','evidenceId','quote','assertion'], additionalProperties: false } } },
        required: ['claims'], additionalProperties: false } },
    safetySettings: geminiSettings.safetySettings,
  };
}

export async function extractSemantic(publicRedactedText: string, enabled: boolean, key = process.env.GEMINI_API_KEY, fetcher: typeof fetch = fetch) {
  if (!enabled) throw new Error('HOSTED_SEMANTIC_DISABLED');
  if (!key) throw new Error('GEMINI_KEY_MISSING');
  const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`, {
    method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(buildGeminiSemanticRequest(publicRedactedText)), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`GEMINI_HTTP_${response.status}`);
  const body = await readLimitedText(response,400_000);
  try { return JSON.parse(body) as unknown; } catch { throw new Error('GEMINI_JSON'); }
}

const claimsSchema = z.object({ claims: z.array(semanticClaimSchema).max(20) }).strict();
type Source = { id: string; text: string };
function rawSocialHandleQuote(quote: string, text: string): string | undefined {
  if (!/^@[A-Za-z0-9_]+$/.test(quote)) return undefined;
  const spellings = new Set<string>();
  // Align only Markdown underscore escapes in complete handles, retaining the raw citation.
  for (const match of text.matchAll(/(?<![A-Za-z0-9_\\@])@(?:[A-Za-z0-9_]|\\_)+(?![A-Za-z0-9_\\])/g)) {
    if (match[0].replace(/\\_/g, '_') === quote) spellings.add(match[0]);
  }
  return spellings.size === 1 ? [...spellings][0] : undefined;
}
export function parseGeminiSemantic(response: unknown, packet: string, address: string, sources: Source[]): SemanticResult {
  const base = { model: geminiSettings.model, promptHash: createHash('sha256').update(packet).digest('hex'), schemaVersion: 1 };
  const invalid = (reason: string): SemanticResult => ({ status: 'INVALID', claims: [], ...base, validationErrors: [reason] });
  if (typeof response !== 'object' || response === null || Array.isArray(response)) return invalid('RESPONSE_SHAPE');
  const r = response as Record<string, unknown>;
  if (r.promptFeedback && typeof r.promptFeedback === 'object' && (r.promptFeedback as Record<string,unknown>).blockReason) return invalid('BLOCKED');
  if (!Array.isArray(r.candidates) || r.candidates.length !== 1) return invalid('CANDIDATE_COUNT');
  const candidate = r.candidates[0] as Record<string, unknown>;
  if (!candidate || candidate.finishReason !== 'STOP' || !candidate.content || typeof candidate.content !== 'object') return invalid('FINISH_REASON');
  const parts = (candidate.content as Record<string,unknown>).parts;
  if (!Array.isArray(parts) || parts.length !== 1 || typeof parts[0]?.text !== 'string') return invalid('CONTENT_PARTS');
  let parsed: unknown;
  try { parsed = JSON.parse(parts[0].text); } catch { return invalid('CLAIMS_JSON'); }
  const checked = claimsSchema.safeParse(parsed);
  if (!checked.success) return invalid('CLAIMS_SCHEMA');
  const claims: typeof checked.data.claims = [];
  for (const claim of checked.data.claims) {
    const source = sources.find(s => s.id === claim.evidenceId);
    if (!source || !source.text.includes(address)) return invalid('UNSUPPORTED_CITATION');
    const quote = source.text.includes(claim.quote) ? claim.quote
      : claim.kind === 'SOCIAL_ACCOUNT' ? rawSocialHandleQuote(claim.quote, source.text) : undefined;
    if (!quote) return invalid('UNSUPPORTED_CITATION');
    const resolved = semanticClaimSchema.safeParse({ ...claim, quote });
    if (!resolved.success) return invalid('UNSUPPORTED_CITATION');
    claims.push(resolved.data);
  }
  const responseHash = createHash('sha256').update(JSON.stringify(response)).digest('hex');
  return { status: 'CANDIDATE', claims, ...base, responseHash,
    ...(typeof r.modelVersion === 'string' ? { returnedModelVersion: r.modelVersion } : {}),
    ...(r.usageMetadata ? { usage: r.usageMetadata } : {}) };
}

import { readLimitedText } from './http.js';
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
    generationConfig: { maxOutputTokens: geminiSettings.maxOutputTokens, thinkingConfig: { thinkingLevel: geminiSettings.semanticThinkingLevel }, responseMimeType: 'application/json' },
    safetySettings: geminiSettings.safetySettings,
  };
}

export async function extractSemantic(publicRedactedText: string, enabled: boolean) {
  if (!enabled) throw new Error('HOSTED_SEMANTIC_DISABLED');
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_KEY_MISSING');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiSettings.model}:generateContent`, {
    method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(buildGeminiSemanticRequest(publicRedactedText)), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`GEMINI_HTTP_${response.status}`);
  const body = await readLimitedText(response,2_000_000);
  return JSON.parse(body) as unknown;
}

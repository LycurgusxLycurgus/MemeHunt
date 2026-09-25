import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGeminiSemanticRequest, geminiSettings } from '../src/providers/gemini.js';

test('Gemini semantic request uses the configured model generation and safety settings', () => {
  const request = buildGeminiSemanticRequest('Synthetic redacted fixture packet.');
  assert.equal(geminiSettings.model, 'gemini-3.5-flash-lite');
  assert.deepEqual(request.generationConfig, {
    maxOutputTokens: 65536,
    thinkingConfig: { thinkingLevel: 'high' },
    responseMimeType: 'application/json',
  });
  assert.deepEqual(request.safetySettings, [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
  ]);
  assert.deepEqual(request.contents, [{ role: 'user', parts: [{ text: 'Synthetic redacted fixture packet.' }] }]);
});

test('Gemini request builder rejects empty or over-limit packets before transport', () => {
  assert.throws(() => buildGeminiSemanticRequest(''), /INVALID_SEMANTIC_PACKET/);
  assert.throws(() => buildGeminiSemanticRequest('x'.repeat(100_001)), /INVALID_SEMANTIC_PACKET/);
});

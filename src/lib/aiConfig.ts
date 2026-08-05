export const AI_CONFIG = {
  provider: 'gemini', // 'gemini' | 'groq'
  groqApiKey: process.env.GROQ_API_KEY || process.env.GROK_API_KEY,
  groqModel: 'llama-3.3-70b-versatile',
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModel: 'gemini-2.5-flash',
  
  // Rate limiting & caching config
  regimeCacheMs: 45000,      // Re-classify regime every 45s
  rationaleCacheMs: 15000,   // New rationale every 15s max
  timeoutMs: 2000,           // Fail fast if AI slow (2s timeout)
  fallbackToBaseWeights: true // Use base weights or rule-based weights if AI fails
};

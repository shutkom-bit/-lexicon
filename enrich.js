// Vercel serverless function: POST /api/enrich
// Body: { word: string, topic?: string }
// Returns enriched JSON: { word, ipa, pos, pos_group, translation_uk, translation_hu, definition, example }
//
// Env vars (set in Vercel → Project → Settings → Environment Variables):
//   LLM_API_KEY   (required)  your DeepSeek (or OpenAI-compatible) key
//   LLM_BASE_URL  (optional)  default https://api.deepseek.com
//   LLM_MODEL     (optional)  default deepseek-chat
// The same function is reused by the Telegram bot later, so the enrichment
// contract lives in one place.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const { word, topic } = (req.body && typeof req.body === 'object') ? req.body : {};
  if (!word || !String(word).trim()) { res.status(400).json({ error: 'word is required' }); return; }

  const BASE  = process.env.LLM_BASE_URL || 'https://api.deepseek.com';
  const KEY   = process.env.LLM_API_KEY;
  const MODEL = process.env.LLM_MODEL || 'deepseek-chat';
  if (!KEY) { res.status(500).json({ error: 'LLM_API_KEY is not configured' }); return; }

  const prompt =
`English word or phrase: "${String(word).trim()}". Topic context: "${topic || 'general'}".
Return ONLY a JSON object (no markdown, no prose) with EXACTLY these keys:
{
 "word":"the word, cleaned/lemmatized",
 "ipa":"IPA transcription in slashes",
 "pos":"detailed part of speech in English, short",
 "pos_group":"exactly one of: verb | noun | adjective | adverb | phrase | other",
 "translation_uk":"Ukrainian translation (may list 2-3 senses, comma-separated)",
 "translation_hu":"Hungarian translation (may list 2-3 senses, comma-separated)",
 "definition":"short English definition, max 14 words",
 "example":"one natural English sentence using the word"
}
If it is a multi-word expression, set pos_group to "phrase".`;

  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: 'You are a precise lexicographer. Output valid JSON only.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        stream: false
      })
    });

    if (!r.ok) {
      const t = await r.text();
      res.status(502).json({ error: 'LLM request failed', status: r.status, detail: t.slice(0, 500) });
      return;
    }

    const data = await r.json();
    let text = data?.choices?.[0]?.message?.content || '';
    text = text.replace(/```json/gi, '').replace(/```/g, '').trim();

    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) {
      const m = text.match(/\{[\s\S]*\}/); // salvage a JSON object if wrapped in stray text
      if (m) parsed = JSON.parse(m[0]); else throw e;
    }

    const POS = ['verb', 'noun', 'adjective', 'adverb', 'phrase', 'other'];
    const out = {
      word: parsed.word || String(word).trim(),
      ipa: parsed.ipa || '',
      pos: parsed.pos || '',
      pos_group: POS.includes(parsed.pos_group) ? parsed.pos_group : 'other',
      translation_uk: parsed.translation_uk || '',
      translation_hu: parsed.translation_hu || '',
      definition: parsed.definition || '',
      example: parsed.example || ''
    };
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: 'enrichment failed', detail: String(e && e.message || e) });
  }
};

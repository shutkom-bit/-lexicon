// Shared server-side core: Firebase Admin init + LLM enrichment.
// Used by both /api/enrich (website) and /api/telegram (bot).

const admin = require('firebase-admin');

const FREE_LIMIT = 50;
const POS = ['verb', 'noun', 'adjective', 'adverb', 'phrase', 'other'];

function ensureInit() {
  if (!admin.apps.length) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  }
}
function getDb() { ensureInit(); return admin.firestore(); }
function getAdmin() { ensureInit(); return admin; }

async function enrichWord(word, topic) {
  const BASE  = process.env.LLM_BASE_URL || 'https://api.deepseek.com';
  const KEY   = process.env.LLM_API_KEY;
  const MODEL = process.env.LLM_MODEL || 'deepseek-chat';
  if (!KEY) throw new Error('LLM_API_KEY is not configured');

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
  if (!r.ok) { const t = await r.text(); throw new Error('LLM ' + r.status + ' ' + t.slice(0, 200)); }

  const data = await r.json();
  let text = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  text = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { const m = text.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); else throw e; }

  return {
    word: parsed.word || String(word).trim(),
    ipa: parsed.ipa || '',
    pos: parsed.pos || '',
    pos_group: POS.includes(parsed.pos_group) ? parsed.pos_group : 'other',
    translation_uk: parsed.translation_uk || '',
    translation_hu: parsed.translation_hu || '',
    definition: parsed.definition || '',
    example: parsed.example || ''
  };
}

module.exports = { getDb, getAdmin, enrichWord, FREE_LIMIT, POS };

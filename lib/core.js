// Shared server-side core: Firebase Admin init + LLM enrichment.
// Used by both /api/enrich (website) and /api/telegram (bot), so the enrichment
// contract lives in exactly one place.

const admin = require('firebase-admin');

const FREE_LIMIT = 50;
const POS = ['verb', 'noun', 'adjective', 'adverb', 'phrase', 'other'];

// Supported languages (code → English name used in the LLM prompt).
// UI labels live in the website; here we only need the English names.
const LANG_NAMES = {
  en: 'English', uk: 'Ukrainian', hu: 'Hungarian', fr: 'French',
  es: 'Spanish', it: 'Italian', pl: 'Polish', de: 'German'
};

function ensureInit() {
  if (!admin.apps.length) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  }
}
function getDb() { ensureInit(); return admin.firestore(); }
function getAdmin() { ensureInit(); return admin; }

// Resolve a deck's language pair into { targetLang, natives[] }.
// No argument (or empty) → legacy default: learn English, translate to UA + HU.
// This keeps the default deck and the Telegram bot behaving exactly as before.
function resolveLangs(langs) {
  if (!langs || (!langs.targetLang && !langs.nativeLang && !langs.native2)) {
    return { targetLang: 'en', natives: ['uk', 'hu'] };
  }
  const targetLang = LANG_NAMES[langs.targetLang] ? langs.targetLang : 'en';
  const n1 = LANG_NAMES[langs.nativeLang] ? langs.nativeLang : 'uk';
  const natives = [n1];
  if (LANG_NAMES[langs.native2] && langs.native2 !== n1) natives.push(langs.native2);
  return { targetLang, natives };
}

async function enrichWord(word, topic, langs) {
  const BASE  = process.env.LLM_BASE_URL || 'https://api.deepseek.com';
  const KEY   = process.env.LLM_API_KEY;
  const MODEL = process.env.LLM_MODEL || 'deepseek-chat';
  if (!KEY) throw new Error('LLM_API_KEY is not configured');

  const { targetLang, natives } = resolveLangs(langs);
  const targetName = LANG_NAMES[targetLang];
  const trSchema = natives
    .map(c => `  "${c}": "${LANG_NAMES[c]} translation (may list 2-3 senses, comma-separated)"`)
    .join(',\n');

  const prompt =
`${targetName} word or phrase: "${String(word).trim()}". Topic context: "${topic || 'general'}".
Return ONLY a JSON object (no markdown, no prose) with EXACTLY these keys:
{
 "word":"the word, cleaned/lemmatized",
 "ipa":"IPA transcription of the ${targetName} word, in slashes",
 "pos":"detailed part of speech in English, short",
 "pos_group":"exactly one of: verb | noun | adjective | adverb | phrase | other",
 "translations":{
${trSchema}
 },
 "definition":"short English definition, max 14 words",
 "example":"one natural ${targetName} sentence using the word"
}
Use EXACTLY the language keys shown under "translations", and no others.
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

  // Build the tr map strictly from the requested native languages.
  const trIn = (parsed && parsed.translations && typeof parsed.translations === 'object') ? parsed.translations : {};
  const tr = {};
  for (const c of natives) { tr[c] = (typeof trIn[c] === 'string') ? trIn[c] : ''; }

  return {
    word: parsed.word || String(word).trim(),
    ipa: parsed.ipa || '',
    pos: parsed.pos || '',
    pos_group: POS.includes(parsed.pos_group) ? parsed.pos_group : 'other',
    tr,                                  // NEW canonical shape: map keyed by native code
    definition: parsed.definition || '',
    example: parsed.example || '',
    // Legacy aliases so existing callers (current website doAdd + bot) keep
    // working unchanged until they migrate to reading `tr` directly:
    translation_uk: tr.uk || '',
    translation_hu: tr.hu || ''
  };
}

module.exports = { getDb, getAdmin, enrichWord, resolveLangs, FREE_LIMIT, POS, LANG_NAMES };

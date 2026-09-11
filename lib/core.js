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

/* ────────────────────────────────────────────────────────────────
   TTS (Google Cloud Text-to-Speech)
   Окремий службовий акаунт (GOOGLE_TTS_CREDENTIALS), не пов'язаний з
   Firebase-акаунтом вище — свідомо, щоб не змішувати права доступу.
   ──────────────────────────────────────────────────────────────── */
const crypto = require('crypto');

const TTS_LANG_BCP47 = {
  en: 'en-US', uk: 'uk-UA', hu: 'hu-HU', fr: 'fr-FR',
  es: 'es-ES', it: 'it-IT', pl: 'pl-PL', de: 'de-DE'
};

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Кешуємо access-токен у пам'яті процесу (діє, доки serverless-інстанс "теплий" —
// не критично, якщо не спрацює на холодному старті, просто отримаємо новий).
let _ttsToken = null; // { token, exp }
async function getTtsAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_ttsToken && _ttsToken.exp - 60 > now) return _ttsToken.token;

  if (!process.env.GOOGLE_TTS_CREDENTIALS) throw new Error('GOOGLE_TTS_CREDENTIALS is not configured');
  const svc = JSON.parse(process.env.GOOGLE_TTS_CREDENTIALS);

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: svc.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const unsigned = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claim));
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(svc.private_key)
    .toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = unsigned + '.' + signature;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  if (!r.ok) { const t = await r.text(); throw new Error('TTS token exchange failed: ' + r.status + ' ' + t.slice(0, 200)); }
  const data = await r.json();
  _ttsToken = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return _ttsToken.token;
}

// Замість жорстко "вгаданих" назв голосів питаємо в Google, які реально доступні
// для мови, і самі обираємо найкращу якість з того, що є (Neural2 > Wavenet > Standard).
// Так помилка в назві голосу (особливо для менш поширених мов) не ламає озвучення.
let _voiceCache = {}; // languageCode -> voice name
async function pickVoiceName(languageCode, token) {
  if (_voiceCache[languageCode]) return _voiceCache[languageCode];
  try {
    const r = await fetch('https://texttospeech.googleapis.com/v1/voices?languageCode=' + encodeURIComponent(languageCode), {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!r.ok) return null;
    const data = await r.json();
    const voices = (data && data.voices) || [];
    const byTier = tier => voices.find(v => v.name.includes(tier));
    const chosen = byTier('Neural2') || byTier('Wavenet') || byTier('Standard') || voices[0];
    if (chosen) { _voiceCache[languageCode] = chosen.name; return chosen.name; }
  } catch (e) { /* falls back to no explicit voice name below */ }
  return null;
}

// Повертає base64 MP3. langCode — наш внутрішній 2-літерний код (en/uk/hu/…).
async function synthesizeSpeech(text, langCode) {
  const clean = String(text || '').trim().slice(0, 300);
  if (!clean) throw new Error('text is required');
  const languageCode = TTS_LANG_BCP47[langCode] || 'en-US';

  const token = await getTtsAccessToken();
  const voiceName = await pickVoiceName(languageCode, token);
  const voice = voiceName ? { languageCode, name: voiceName } : { languageCode, ssmlGender: 'NEUTRAL' };

  const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ input: { text: clean }, voice, audioConfig: { audioEncoding: 'MP3' } })
  });
  if (!r.ok) { const t = await r.text(); throw new Error('TTS ' + r.status + ' ' + t.slice(0, 200)); }
  const data = await r.json();
  if (!data.audioContent) throw new Error('TTS: no audioContent in response');
  return data.audioContent; // base64 MP3
}

/* ────────────────────────────────────────────────────────────────
   Verb conjugation (English only — the "9 tenses" school framework
   is specific to English grammar; other supported languages have
   different tense systems and aren't covered by this feature).
   Generated on demand (button click), cached on the word doc client-side —
   NOT auto-generated on word add, to avoid extra AI cost/latency for
   words the user never opens the table for.
   ──────────────────────────────────────────────────────────────── */
const TENSE_IDS = [
  'present_simple', 'present_continuous', 'present_perfect',
  'past_simple', 'past_continuous', 'past_perfect',
  'future_simple', 'future_continuous', 'future_perfect'
];

async function conjugateVerb(word) {
  const BASE  = process.env.LLM_BASE_URL || 'https://api.deepseek.com';
  const KEY   = process.env.LLM_API_KEY;
  const MODEL = process.env.LLM_MODEL || 'deepseek-chat';
  if (!KEY) throw new Error('LLM_API_KEY is not configured');

  const clean = String(word || '').trim();
  if (!clean) throw new Error('word is required');

  const prompt =
`English verb: "${clean}". Give its full affirmative conjugation across exactly these 9 tenses, in this exact order: ${TENSE_IDS.join(', ')}.
Return ONLY a JSON object (no markdown, no prose) with EXACTLY these top-level keys: ${TENSE_IDS.map(id => `"${id}"`).join(', ')}.
Each key's value is an array of rows — one row per distinct verb form needed to cover all subject pronouns (I, you, he, she, it, we, they).
Group pronouns that share the same form into one row. Each row is an object: {"subject":"pronoun or group, e.g. 'He / She / It'", "form":"the full conjugated verb phrase for that subject, e.g. 'is working'"}.
Use standard, natural, uncontracted forms (e.g. "will work", not "'ll work"). If the verb is irregular, use its correct irregular forms.`;

  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: 'You are a precise English grammar reference. Output valid JSON only.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
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

  const tenses = {};
  for (const id of TENSE_IDS) {
    const rows = Array.isArray(parsed[id]) ? parsed[id] : [];
    tenses[id] = rows
      .filter(r => r && typeof r.subject === 'string' && typeof r.form === 'string')
      .map(r => ({ subject: r.subject, form: r.form }));
  }
  return { word: clean, tenses };
}

module.exports = { getDb, getAdmin, enrichWord, resolveLangs, FREE_LIMIT, POS, LANG_NAMES, synthesizeSpeech, conjugateVerb, TENSE_IDS };

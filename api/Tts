// POST /api/tts  (website)
// Authenticated: verifies the caller's Firebase ID token, then synthesizes
// speech for the given word via Google Cloud Text-to-Speech.
// No plan/word-count gating here — TTS is a UX feature, not the word-limit gate.

const { getAdmin, synthesizeSpeech } = require('../lib/core');

const LANG_OK = new Set(['en', 'uk', 'hu', 'fr', 'es', 'it', 'pl', 'de']);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const authH = req.headers.authorization || '';
  const token = authH.startsWith('Bearer ') ? authH.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'auth required' }); return; }

  try { await getAdmin().auth().verifyIdToken(token); }
  catch (e) { res.status(401).json({ error: 'invalid token' }); return; }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const word = body.word;
  if (!word || !String(word).trim()) { res.status(400).json({ error: 'word is required' }); return; }
  const lang = LANG_OK.has(body.lang) ? body.lang : 'en';

  try {
    const audioContent = await synthesizeSpeech(word, lang);
    res.status(200).json({ audioContent });
  } catch (e) {
    res.status(500).json({ error: 'tts failed', detail: String(e && e.message || e) });
  }
};

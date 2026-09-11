// POST /api/conjugate  (website)
// Authenticated: verifies the caller's Firebase ID token, then generates the
// full 9-tense affirmative conjugation table for an English verb.
// English only — see lib/core.js comment for why. No plan/word-count gating
// (same reasoning as /api/tts: this is a UX feature, not the word-limit gate).

const { getAdmin, conjugateVerb } = require('../lib/core');

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

  try {
    const out = await conjugateVerb(word);
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: 'conjugate failed', detail: String(e && e.message || e) });
  }
};

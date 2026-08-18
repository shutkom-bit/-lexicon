// POST /api/enrich  (website)
// Authenticated + plan/limit gated: verifies the caller's Firebase ID token,
// checks their plan and word count, and only then calls the LLM.

const { getDb, getAdmin, enrichWord, FREE_LIMIT } = require('../lib/core');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const authH = req.headers.authorization || '';
  const token = authH.startsWith('Bearer ') ? authH.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'auth required' }); return; }

  let uid;
  try { const decoded = await getAdmin().auth().verifyIdToken(token); uid = decoded.uid; }
  catch (e) { res.status(401).json({ error: 'invalid token' }); return; }

  const db = getDb();
  let u = {};
  try { const s = await db.collection('users').doc(uid).get(); u = s.exists ? s.data() : {}; }
  catch (e) { res.status(500).json({ error: 'profile read failed' }); return; }

  if (u.plan !== 'pro' && (u.wordCount || 0) >= FREE_LIMIT) {
    res.status(403).json({ error: 'limit_reached', limit: FREE_LIMIT });
    return;
  }

  const { word, topic } = (req.body && typeof req.body === 'object') ? req.body : {};
  if (!word || !String(word).trim()) { res.status(400).json({ error: 'word is required' }); return; }

  try { const out = await enrichWord(word, topic); res.status(200).json(out); }
  catch (e) { res.status(500).json({ error: 'enrichment failed', detail: String(e && e.message || e) }); }
};

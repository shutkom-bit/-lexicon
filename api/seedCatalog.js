// GET /api/seedCatalog?key=<SEED_SECRET>
// One-off admin endpoint: writes the curated starter packs into the public
// `catalog` collection using the Admin SDK (bypasses Firestore rules).
// Re-runnable and idempotent — each pack is written with .set() on a fixed id,
// so re-hitting it after adding/editing packs simply overwrites them.
//
// Each pack is ONE document: meta + a `words` array (cheaper than a subcollection;
// a whole pack loads in a single read). Kept well under the 1 MB Firestore doc cap.
//
// To add packs later: drop a new file in /packs and add one require() line below.

const { getDb } = require('../lib/core');

const PACKS = [
  require('../packs/question.json'),
  require('../packs/body.json'),
  require('../packs/food.json'),
  require('../packs/home.json'),
  require('../packs/clothes.json'),
  require('../packs/verbs.json'),
  require('../packs/adjectives.json'),
  require('../packs/travel.json'),
  require('../packs/work.json')
];

module.exports = async function handler(req, res) {
  const key = (req.query && req.query.key) || '';
  if (!process.env.SEED_SECRET || key !== process.env.SEED_SECRET) {
    res.status(401).json({ error: 'bad key' });
    return;
  }
  try {
    const db = getDb();
    const seeded = [];
    for (const p of PACKS) {
      if (!p || !p.id) continue;
      const words = Array.isArray(p.words) ? p.words : [];
      await db.collection('catalog').doc(p.id).set({
        id: p.id,
        emoji: p.emoji || '📘',
        name: p.name || p.id,
        targetLang: p.targetLang || 'en',
        nativeLang: p.nativeLang || 'uk',
        native2: p.native2 || '',
        order: typeof p.order === 'number' ? p.order : 99,
        count: words.length,
        words
      });
      seeded.push({ id: p.id, words: words.length });
    }
    res.status(200).json({ ok: true, seeded });
  } catch (e) {
    res.status(500).json({ error: 'seed failed', detail: String(e && e.message || e) });
  }
};

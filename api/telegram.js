// POST /api/telegram  — Telegram bot webhook.
//   /start [CODE]  → link account (CODE arrives from the website deep-link) or show help
//   /link CODE     → link this chat to a Lexicon account
//   /topic Business→ set current topic for this chat
//   #topic         → one-off topic for a single word
//   any other text → enrich the word and save it to the linked account

const { getDb, getAdmin, enrichWord, FREE_LIMIT, POS } = require('../lib/core');

async function tg(method, payload) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(200).send('ok'); return; }

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    res.status(401).send('bad secret'); return;
  }

  const update = req.body || {};
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) { res.status(200).send('ok'); return; }

  const chatId = String(msg.chat.id);
  const text = String(msg.text).trim();
  const db = getDb();
  const admin = getAdmin();

  async function consumeCode(code) {
    const c = (code || '').toUpperCase();
    if (!c) return { ok: false, msg: 'Надішли код так: /link КОД (візьми його на сайті).' };
    const codeRef = db.collection('linkCodes').doc(c);
    const codeSnap = await codeRef.get();
    if (!codeSnap.exists) return { ok: false, msg: 'Код не знайдено або застарів. Згенеруй новий на сайті.' };
    const uid = codeSnap.data().uid;
    await db.collection('telegramLinks').doc(chatId).set({ uid, linkedAt: Date.now(), topic: 'General' });
    await codeRef.delete();
    return { ok: true, msg: '✅ Готово! Тепер надсилай англійські слова — вони підуть у твій словник.' };
  }

  try {
    if (text === '/start' || text.startsWith('/start ') || text === '/help') {
      const code = text.startsWith('/start ') ? text.split(/\s+/)[1] : null;
      if (code) { const r = await consumeCode(code); await tg('sendMessage', { chat_id: chatId, text: r.msg }); res.status(200).send('ok'); return; }
      await tg('sendMessage', { chat_id: chatId, text:
'Привіт! Я бот Lexicon 📚\n\n' +
'Щоб зв’язати мене з твоїм акаунтом:\n' +
'1. Відкрий сайт Lexicon → «Підключити Telegram»\n' +
'2. Натисни «Відкрити бота та підключити» (або надішли /link КОД)\n\n' +
'Далі просто надсилай англійські слова — я додам їх у твій словник із перекладом (UA + HU), транскрипцією й прикладом.\n\n' +
'Команди:\n/topic Business — задати поточну тему\nСлово #emotions — тема для одного слова' });
      res.status(200).send('ok'); return;
    }

    if (text.startsWith('/link')) {
      const r = await consumeCode(text.split(/\s+/)[1]);
      await tg('sendMessage', { chat_id: chatId, text: r.msg });
      res.status(200).send('ok'); return;
    }

    const linkRef = db.collection('telegramLinks').doc(chatId);
    const linkSnap = await linkRef.get();
    if (!linkSnap.exists) {
      await tg('sendMessage', { chat_id: chatId, text: 'Спершу зв’яжи акаунт: сайт → «Підключити Telegram» → надішли мені /link КОД.' });
      res.status(200).send('ok'); return;
    }
    const link = linkSnap.data();
    const uid = link.uid;

    if (text.startsWith('/topic')) {
      const t = text.slice(6).trim();
      if (!t) { await tg('sendMessage', { chat_id: chatId, text: `Поточна тема: ${link.topic || 'General'}. Зміни так: /topic Business` }); res.status(200).send('ok'); return; }
      await linkRef.update({ topic: t });
      await tg('sendMessage', { chat_id: chatId, text: `📂 Тему змінено на: ${t}. Наступні слова йтимуть сюди.` });
      res.status(200).send('ok'); return;
    }

    let word = text, topic = link.topic || 'General';
    const hash = text.match(/#(\S+)/);
    if (hash) { topic = hash[1]; word = text.replace(/#\S+/, '').trim(); }
    if (!word) { res.status(200).send('ok'); return; }

    // Дедуплікація (як на сайті): один легкий запит по полю word.
    // Перевіряємо ДО AI — дубль не витрачає ні запит, ні ліміт.
    let existing = new Set();
    try {
      const wsnap = await db.collection('decks').doc(uid).collection('words').select('word').get();
      existing = new Set(wsnap.docs.map(s => String((s.data().word) || '').trim().toLowerCase()).filter(Boolean));
    } catch (e) { console.error('dedupe fetch failed', e); }
    if (existing.has(word.trim().toLowerCase())) {
      await tg('sendMessage', { chat_id: chatId, text: `📚 «${word}» вже є у твоєму словнику — не додаю повторно.` });
      res.status(200).send('ok'); return;
    }

    const usnap = await db.collection('users').doc(uid).get();
    const u = usnap.exists ? usnap.data() : {};
    if (u.plan !== 'pro' && (u.wordCount || 0) >= FREE_LIMIT) {
      await tg('sendMessage', { chat_id: chatId, text: `Ліміт безкоштовного тарифу (${FREE_LIMIT} слів) вичерпано. Оформи Pro на сайті, щоб додавати більше.` });
      res.status(200).send('ok'); return;
    }

    let d;
    try { d = await enrichWord(word, topic); }
    catch (e) { d = { word, ipa: '', pos: '', pos_group: 'other', translation_uk: '', translation_hu: '', definition: '', example: '' }; }

    // Дубль після лематизації AI (напр. надіслали «running», а в деку вже «run»).
    // Ловимо ДО списання ліміту.
    if (existing.has(String(d.word || word).trim().toLowerCase())) {
      await tg('sendMessage', { chat_id: chatId, text: `📚 «${d.word || word}» вже є у твоєму словнику — не додаю повторно.` });
      res.status(200).send('ok'); return;
    }

    const entry = {
      word: d.word || word, topic, ipa: d.ipa || '', pos: d.pos || '',
      pos_group: POS.includes(d.pos_group) ? d.pos_group : 'other',
      tr: { uk: d.translation_uk || '', hu: d.translation_hu || '' },
      def: d.definition || '', ex: d.example || '',
      ownerUid: uid, box: 0, due: Date.now(), reps: 0, lapses: 0, created: Date.now()
    };
    await db.collection('decks').doc(uid).collection('words').add(entry);
    await db.collection('users').doc(uid).update({ wordCount: admin.firestore.FieldValue.increment(1) });

    const reply =
`✅ *${entry.word}* ${entry.pos ? '[' + entry.pos + ']' : ''}
🇺🇦 ${entry.tr.uk || '—'}
🇭🇺 ${entry.tr.hu || '—'}
📂 ${topic}`;
    await tg('sendMessage', { chat_id: chatId, text: reply, parse_mode: 'Markdown' });
    res.status(200).send('ok');
  } catch (e) {
    console.error('telegram handler error', e);
    try { await tg('sendMessage', { chat_id: chatId, text: 'Сталася помилка, спробуй ще раз за мить.' }); } catch (_) {}
    res.status(200).send('ok');
  }
};

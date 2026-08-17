# Lexicon

English vocabulary trainer. Words live in Firestore (cloud), so the website and
(later) the Telegram bot share one dictionary. UA + HU translations, automatic
part-of-speech grouping, spaced-repetition study and quiz.

## Structure
```
index.html        # the site (Firebase client SDK + study/quiz)
api/enrich.js      # serverless: word -> DeepSeek -> enriched JSON (keeps the key server-side)
firestore.rules    # rule BLOCK to merge into your existing Firestore rules (do not overwrite all rules)
package.json
```

## Deploy (Vercel)
1. Push this folder to a GitHub repo (e.g. `lexicon`).
2. In Vercel → Add New → Project → import that repo. Framework preset: **Other**. Deploy.
3. Vercel → Project → Settings → Environment Variables, add:
   - `LLM_API_KEY` = your DeepSeek key
   - (optional) `LLM_BASE_URL` = `https://api.deepseek.com`
   - (optional) `LLM_MODEL` = `deepseek-chat`
   Redeploy after adding them.
4. Firebase Console → Firestore → Rules: add the `lexicon_words` block from
   `firestore.rules` into your existing rules, then Publish.

The Firebase config in `index.html` is the public client config — safe to commit.
The DeepSeek key is a real secret and stays only in Vercel env vars.
```

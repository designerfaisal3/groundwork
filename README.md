# Groundwork

**Cold emails that sound like you did your homework.**
Paste a prospect's website → Groundwork reads it and writes opening lines grounded in what they actually do, plus subject lines, with the *signal* behind every line shown.

- **Frontend:** static HTML/CSS/JS (no build step) → Netlify
- **Auth + database:** Supabase
- **AI + website reading:** a Netlify serverless function calling Claude (`claude-sonnet-5`)

The Claude key and Supabase service key live **only** on the server (Netlify env vars). They are never in the browser.

---

## What you'll need (all have free tiers)

1. A **Supabase** account — https://supabase.com
2. A **Netlify** account — https://netlify.com
3. An **Anthropic API key** — https://console.anthropic.com  (Billing → add a small credit; Sonnet 5 is ~$2 / million input tokens right now)
4. A **GitHub** account (easiest deploy path) — https://github.com

Total setup: ~20–30 minutes.

---

## Step 1 — Set up Supabase (5 min)

1. Create a new project. Pick a strong database password (you won't need it again for this).
2. Wait for it to finish provisioning.
3. Left sidebar → **SQL Editor** → **New query**. Paste the entire contents of
   `supabase/schema.sql`, then click **Run**. You should see "Success".
4. Left sidebar → **Project Settings → API**. Copy these three values somewhere safe:
   - **Project URL** (e.g. `https://abcd1234.supabase.co`)
   - **anon public** key
   - **service_role** key ← *secret, server-only*
5. (Recommended for testing) Left sidebar → **Authentication → Providers → Email**:
   turn **off** "Confirm email" so you can sign in immediately without clicking a
   confirmation link. Turn it back on before real launch.

---

## Step 2 — Add your public keys to the frontend (1 min)

Open `public/config.js` and paste your **Project URL** and **anon public** key:

```js
window.GROUNDWORK_CONFIG = {
  SUPABASE_URL: "https://abcd1234.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOi...your anon key...",
};
```

These two are safe to expose — that's what the anon key is for. The **service_role**
key and **Anthropic** key do NOT go here.

---

## Step 3 — Put the code on GitHub (5 min)

1. Create a new **empty** repository on GitHub (no README).
2. From this project folder, in a terminal:

```bash
git init
git add .
git commit -m "Groundwork initial"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/groundwork.git
git push -u origin main
```

`.gitignore` already keeps `node_modules` and `.env` out of the repo.

---

## Step 4 — Deploy on Netlify (5 min)

1. Netlify dashboard → **Add new site → Import an existing project → GitHub** → pick your repo.
2. Build settings: leave the defaults. `netlify.toml` already sets
   publish = `public` and functions = `netlify/functions`. Click **Deploy**.
3. When it's live, go to **Site settings → Environment variables → Add a variable**
   and add these **four** (values from Steps 1 and your Anthropic console):

   | Key | Value |
   |-----|-------|
   | `SUPABASE_URL` | your Project URL |
   | `SUPABASE_ANON_KEY` | your anon public key |
   | `SUPABASE_SERVICE_ROLE_KEY` | your service_role secret key |
   | `ANTHROPIC_API_KEY` | your `sk-ant-...` key |

   (Optional: `CLAUDE_MODEL` = `claude-haiku-4-5-20251001` for cheaper/faster copy.)

4. **Deploys → Trigger deploy → Deploy site** so the function picks up the new variables.

Open your Netlify URL, create an account, paste a real company website + what you
offer, and hit **Read site & write openers**.

---

## Run it locally instead (optional)

```bash
npm install
# put the four secret values in a local .env file (copy from .env.example)
npx netlify dev
```

This serves the site and the function together at http://localhost:8888 with the
`/api/personalize` redirect working.

---

## How it works (so you can extend it)

```
Browser (public/)                Netlify function                 Services
─────────────────                ────────────────                 ────────
app.js  ──login──────────────────────────────────────────────▶  Supabase Auth
app.js  ──POST /api/personalize (JWT + url + offer + tone)──▶  personalize.js
                                    │  verify JWT ───────────▶  Supabase Auth
                                    │  check usage ──────────▶  profiles (service key)
                                    │  fetch + strip HTML ───▶  the prospect's site
                                    │  write openers ────────▶  Claude Messages API
                                    │  save brief ───────────▶  generations (service key)
                                    ◀── result + remaining ──
app.js  renders the brief; history reads generations directly (RLS = own rows only)
```

The grounding is the point: openers are written **only** from the text the function
scraped, and each line reports which page signal it used.

---

## Common issues

- **"Server not configured"** → a Netlify env var is missing or you didn't redeploy after adding them.
- **"Session invalid"** → `SUPABASE_ANON_KEY` in `config.js` and in Netlify must match the same project.
- **"Couldn't read that site"** → some sites block bots or are JS-only. Try their homepage or an about page.
- **Claude 400 error** → check the API key and that `CLAUDE_MODEL` is a valid ID (`claude-sonnet-5`).
- **Signup does nothing** → email confirmation is on; either confirm via email or turn it off (Step 1.5).

---

## Sensible next steps

- Add a paid plan: bump `usage_limit` / `plan` in `profiles` after a Stripe checkout.
- Cache scrapes so re-running the same URL doesn't re-fetch or re-bill.
- Let users save a default "offer" so they don't retype it every time.
- Add a one-page landing route for signed-out visitors before the auth wall.

/* ==================================================================
   Groundwork — /api/personalize
   The only place with secret keys. Flow:
     1. Verify the caller's Supabase session (JWT).
     2. Check they have personalizations left (usage limit).
     3. Fetch + clean the prospect's website (this is the "grounding").
     4. Ask Claude for openers, grounded ONLY in that page.
     5. Increment usage, save the brief, return it.
   ================================================================== */

const { createClient } = require("@supabase/supabase-js");

// ---- env ----
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

const JSON_HEADERS = { "content-type": "application/json" };

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return resp(405, { error: "Method not allowed" });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_API_KEY) {
    return resp(500, { error: "Server not configured. Missing environment variables." });
  }

  // ---- parse body ----
  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return resp(400, { error: "Invalid request body." }); }

  const url = (body.url || "").trim();
  const offer = (body.offer || "").trim();
  const tone = (body.tone || "Direct").trim();

  if (!url || !offer) return resp(400, { error: "Missing url or offer." });
  if (!/^https?:\/\//i.test(url)) return resp(400, { error: "URL must start with http:// or https://" });

  // ---- 1. verify the user ----
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return resp(401, { error: "Not signed in." });

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: userErr } = await anon.auth.getUser(token);
  if (userErr || !userData || !userData.user) {
    return resp(401, { error: "Session invalid — sign in again." });
  }
  const user = userData.user;

  // service client bypasses RLS for usage + inserts
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ---- 2. usage check ----
  const { data: profile, error: profErr } = await admin
    .from("profiles")
    .select("usage_count, usage_limit")
    .eq("id", user.id)
    .single();

  if (profErr || !profile) {
    return resp(500, { error: "Could not load your account. Try again." });
  }
  if (profile.usage_count >= profile.usage_limit) {
    return resp(402, { error: "Out of personalizations.", remaining: 0 });
  }

  // ---- 3. fetch + clean the website ----
  let pageText, pageTitle, pageMeta;
  try {
    const fetched = await fetchSite(url);
    pageText = fetched.text;
    pageTitle = fetched.title;
    pageMeta = fetched.description;
  } catch (e) {
    return resp(422, { error: "Couldn't read that site (" + e.message + "). Try a different page.", remaining: profile.usage_limit - profile.usage_count });
  }
  if (!pageText || pageText.length < 120) {
    return resp(422, { error: "That page had almost no readable text. Try the homepage or an about page.", remaining: profile.usage_limit - profile.usage_count });
  }

  // ---- 4. call Claude ----
  let result;
  try {
    result = await callClaude({ url, offer, tone, pageTitle, pageMeta, pageText });
  } catch (e) {
    return resp(502, { error: "The writer hit a snag: " + e.message, remaining: profile.usage_limit - profile.usage_count });
  }

  // ---- 5. increment usage + save ----
  const newCount = profile.usage_count + 1;
  await admin.from("profiles").update({ usage_count: newCount }).eq("id", user.id);
  await admin.from("generations").insert({
    user_id: user.id,
    prospect_url: url,
    prospect_name: (result.prospect && result.prospect.name) || null,
    offer,
    tone,
    result,
  });

  return resp(200, { result, remaining: Math.max(0, profile.usage_limit - newCount) });
};

/* ------------------------------------------------------------------
   Fetch a URL and reduce it to clean, readable text.
   ------------------------------------------------------------------ */
async function fetchSite(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  let res;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        // present as a normal browser so more sites respond
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) throw new Error("status " + res.status);
  const ctype = res.headers.get("content-type") || "";
  if (!ctype.includes("html")) throw new Error("not an HTML page");

  let html = await res.text();
  if (html.length > 400000) html = html.slice(0, 400000); // guard huge pages

  const title = matchTag(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = matchMeta(html, "description") || matchMeta(html, "og:description");

  const text = htmlToText(html);
  return {
    title: cleanWs(title),
    description: cleanWs(description),
    text: text.slice(0, 7000), // enough context, keeps token cost sane
  };
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|li|h[1-6]|br|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function matchTag(html, re) { const m = html.match(re); return m ? m[1] : ""; }
function matchMeta(html, name) {
  const re = new RegExp('<meta[^>]+(?:name|property)=["\']' + name + '["\'][^>]*content=["\']([^"\']*)["\']', "i");
  const m = html.match(re);
  return m ? m[1] : "";
}
function cleanWs(s) { return (s || "").replace(/\s+/g, " ").trim(); }

/* ------------------------------------------------------------------
   Call Claude via the Messages API (plain fetch, no SDK).
   Note: Sonnet 5 rejects custom temperature / manual thinking — omit them.
   ------------------------------------------------------------------ */
async function callClaude({ url, offer, tone, pageTitle, pageMeta, pageText }) {
  const system = SYSTEM_PROMPT;
  const userContent =
`SENDER'S OFFER (what they sell):
${offer}

REQUESTED TONE: ${tone}

PROSPECT URL: ${url}
PAGE TITLE: ${pageTitle || "(none)"}
PAGE META DESCRIPTION: ${pageMeta || "(none)"}

PROSPECT PAGE CONTENT (extracted text — this is your ONLY source of facts):
"""
${pageText}
"""

Produce the JSON brief now.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1600,
      system,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error("Claude API " + res.status + (errText ? " — " + errText.slice(0, 160) : ""));
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return parseJsonLoose(text);
}

// The model is told to return only JSON; strip fences just in case.
function parseJsonLoose(text) {
  let t = text.trim();
  if (t.startsWith("```")) t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end !== -1) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

const SYSTEM_PROMPT = `You are Groundwork, a senior B2B outreach strategist who writes cold-email opening lines that feel researched and human. You are writing on behalf of the SENDER, to a PROSPECT.

You are given: the sender's offer, a requested tone, and the extracted text of ONE page from the prospect's website. That page text is your ONLY source of facts about the prospect.

HARD RULES:
- Ground every claim in the page text. NEVER invent facts, numbers, clients, funding, awards, locations, or people. If it isn't in the page, don't say it.
- If the page is thin or generic, say so honestly in "notes" and set confidence to "low". Don't paper over a weak page with vague flattery.
- No clichés: never write "I hope this email finds you well", "I came across your website", "I love what you're doing", "big fan", or empty compliments.
- Each opening line must reference a SPECIFIC, verifiable detail from the page, then bridge naturally toward the sender's offer. The bridge should be light — a reason to talk, not a pitch.
- Keep opening lines to 1-2 sentences, conversational, and in the requested tone. Written as the first line(s) of an email, not a whole email.
- Openers must be genuinely different from each other (different angle + different signal where possible), not three rewrites of one idea.
- Subject lines: short (under ~6 words), specific, no clickbait, lowercase-friendly.

Return ONLY a valid JSON object, no prose, no markdown fences, in exactly this shape:
{
  "prospect": {
    "name": "the company or person name if identifiable from the page, else a short descriptor",
    "summary": "one or two plain sentences: what they actually do, from the page",
    "confidence": "high | medium | low"
  },
  "signals": [
    { "label": "SHORT TAG", "detail": "the specific fact from the page this refers to" }
  ],
  "openers": [
    { "angle": "2-4 word label for the angle", "line": "the opening line(s)", "signal_used": "which signal label this line uses" }
  ],
  "subject_lines": ["...", "...", "..."],
  "notes": "caveats worth knowing before sending — e.g. thin page, verify a detail, or empty string if none"
}

Provide 3 to 5 signals and exactly 3 openers. confidence reflects how much real, specific signal the page gave you.`;

/* ---- small response helper ---- */
function resp(status, obj) {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(obj) };
}

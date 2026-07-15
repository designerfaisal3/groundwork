/* ==================================================================
   Groundwork (personal edition for Idievo)
   /api/personalize  —  two actions:
     action: "analyze"  -> read prospect site, suggest fitting services
     action: "compose"  -> write a human cold pitch email for a chosen service
   Secret keys live only here (Netlify env vars). Auth is kept so a
   stranger who finds the URL can't burn your Claude credits. No usage cap.
   ================================================================== */

const { createClient } = require("@supabase/supabase-js");

// ---- env ----
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

const JSON_HEADERS = { "content-type": "application/json" };

/* ==================================================================
   YOUR COMPANY PROFILE  — edit anything here anytime.
   (You wrote your email as foyzul.idievo.com; I assumed the @.)
   ================================================================== */
const IDIEVO = {
  senderName: "Foyzul",
  company: "Idievo",
  oneLiner:
    "a US-registered digital agency that runs CRM, automation, websites, email, social, design, and AI under one roof",
  website: "https://idievo.com/",
  servicesUrl: "https://idievo.com/services",
  bookingUrl: "https://api.idievo.com/widget/bookings/book-a-call-with-idievo",
  contactUrl: "https://idievo.com/contact",
  workUrl: "https://idievo.com/work",
  email: "foyzul@idievo.com",
  phone: "+1 307 310 7690",
  // Real, verifiable trust points — never invent beyond these.
  proof: [
    "Registered US C-Corporation in Wyoming, publicly verifiable",
    "One in-house team — no freelancers, no handoffs, one point of contact",
    "Works across GoHighLevel, HubSpot, WordPress, Shopify, Webflow, Zapier, Klaviyo and more",
    "Offers a free 30-minute strategy call — honest advice, not a hard sell",
  ],
  // The service menu the analyzer chooses from.
  services: [
    { name: "CRM Setup & Management", desc: "GoHighLevel/HubSpot CRM so every lead is captured, tracked, and followed up.", fit: "contact forms, booking, quote requests, leads arriving across several channels with no clear system" },
    { name: "Marketing Automation", desc: "Automated follow-ups, reminders, and workflows so nothing depends on someone remembering.", fit: "appointment-based, high manual follow-up, service business, risk of missed leads" },
    { name: "Email Marketing", desc: "Campaigns and nurture sequences that turn a list into repeat revenue.", fit: "ecommerce, existing audience, newsletter, promotions, abandoned-cart potential" },
    { name: "Website Development", desc: "Fast, modern site builds and redesigns on WordPress, Shopify, Webflow, or Wix.", fit: "dated, slow, or templated site, weak or missing calls to action, poor mobile experience" },
    { name: "Social Media Management", desc: "Done-for-you content and posting that keeps the brand active and consistent.", fit: "inactive or thin social presence, inconsistent posting, no linked social profiles" },
    { name: "Graphic Design & Branding", desc: "Logo, identity, and visual assets that make a business look established.", fit: "weak, dated, or inconsistent branding, DIY logo, mismatched visuals" },
    { name: "AI Agents", desc: "AI chat and voice agents that answer, qualify, and book leads around the clock.", fit: "high inquiry volume, support load, after-hours leads, lots of repetitive questions" },
    { name: "AI Video Production", desc: "AI-generated video for ads, explainers, and social.", fit: "content marketing focus, product demos, heavy social presence, need for video" },
  ],
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return resp(405, { error: "Method not allowed" });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_API_KEY) {
    return resp(500, { error: "Server not configured. Missing environment variables." });
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return resp(400, { error: "Invalid request body." }); }

  const action = body.action || "analyze";

  // ---- verify the user ----
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return resp(401, { error: "Not signed in." });

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: userErr } = await anon.auth.getUser(token);
  if (userErr || !userData || !userData.user) return resp(401, { error: "Session invalid — sign in again." });
  const user = userData.user;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    if (action === "analyze") return await handleAnalyze(body);
    if (action === "compose") return await handleCompose(body, admin, user);
    return resp(400, { error: "Unknown action." });
  } catch (e) {
    return resp(502, { error: (e && e.message) || "Something went wrong." });
  }
};

/* ------------------------------------------------------------------
   ANALYZE: read the prospect site, suggest fitting services.
   ------------------------------------------------------------------ */
async function handleAnalyze(body) {
  const url = (body.url || "").trim();
  if (!url) return resp(400, { error: "Add the prospect's website URL." });
  if (!/^https?:\/\//i.test(url)) return resp(400, { error: "URL must start with http:// or https://" });

  let page;
  try { page = await fetchSite(url); }
  catch (e) { return resp(422, { error: "Couldn't read that site (" + e.message + "). Try a different page." }); }
  if (!page.text || page.text.length < 120) {
    return resp(422, { error: "That page had almost no readable text. Try the homepage or an about page." });
  }

  const serviceMenu = IDIEVO.services
    .map((s, i) => `${i + 1}. ${s.name} — ${s.desc} (typical fit: ${s.fit})`)
    .join("\n");

  const userContent =
`IDIEVO SERVICE MENU (choose ONLY from these):
${serviceMenu}

PROSPECT URL: ${url}
PAGE TITLE: ${page.title || "(none)"}
PAGE META: ${page.description || "(none)"}

PROSPECT PAGE CONTENT (your ONLY source of facts about them):
"""
${page.text}
"""

Produce the JSON analysis now.`;

  const result = await claudeJson(ANALYZE_SYSTEM, userContent);
  return resp(200, { result });
}

/* ------------------------------------------------------------------
   COMPOSE: write the cold pitch email for the chosen service.
   Uses the analysis context passed back from the client (no re-fetch).
   ------------------------------------------------------------------ */
async function handleCompose(body, admin, user) {
  const url = (body.url || "").trim();
  const service = (body.service || "").trim();
  const prospect = body.prospect || {};
  const signals = Array.isArray(body.signals) ? body.signals : [];
  const why = (body.why || "").trim();

  if (!service) return resp(400, { error: "No service selected." });

  const signalText = signals.length
    ? signals.map((s) => `- ${s.label}: ${s.detail}`).join("\n")
    : "(none captured)";

  const companyProfile =
`SENDER / COMPANY (use where natural; never invent beyond this):
- Sender name: ${IDIEVO.senderName}
- Company: ${IDIEVO.company} — ${IDIEVO.oneLiner}
- Website: ${IDIEVO.website}
- Services page: ${IDIEVO.servicesUrl}
- Book a free strategy call: ${IDIEVO.bookingUrl}
- Contact: ${IDIEVO.contactUrl}
- Email: ${IDIEVO.email}
- Phone: ${IDIEVO.phone}
- Real trust points: ${IDIEVO.proof.join("; ")}`;

  const userContent =
`${companyProfile}

SERVICE TO PITCH: ${service}
WHY IT FITS THIS PROSPECT (from analysis): ${why || "(not provided)"}

PROSPECT: ${prospect.name || "the prospect"}
WHAT THEY DO: ${prospect.summary || "(unknown)"}
PROSPECT URL: ${url}

SPECIFIC SIGNALS FOUND ON THEIR SITE (ground the email in these):
${signalText}

Write the cold pitch email now, as JSON.`;

  const email = await claudeJson(COMPOSE_SYSTEM, userContent);

  // save to history (result holds everything so history can re-render the email)
  await admin.from("generations").insert({
    user_id: user.id,
    prospect_url: url,
    prospect_name: prospect.name || null,
    offer: service,
    tone: null,
    result: { mode: "email", prospect, service, why, email },
  });

  return resp(200, { email });
}

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
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
    });
  } finally { clearTimeout(timeout); }

  if (!res.ok) throw new Error("status " + res.status);
  const ctype = res.headers.get("content-type") || "";
  if (!ctype.includes("html")) throw new Error("not an HTML page");

  let html = await res.text();
  if (html.length > 400000) html = html.slice(0, 400000);

  const title = matchTag(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = matchMeta(html, "description") || matchMeta(html, "og:description");
  return { title: cleanWs(title), description: cleanWs(description), text: htmlToText(html).slice(0, 7000) };
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
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
function matchTag(html, re) { const m = html.match(re); return m ? m[1] : ""; }
function matchMeta(html, name) {
  const re = new RegExp('<meta[^>]+(?:name|property)=["\']' + name + '["\'][^>]*content=["\']([^"\']*)["\']', "i");
  const m = html.match(re); return m ? m[1] : "";
}
function cleanWs(s) { return (s || "").replace(/\s+/g, " ").trim(); }

/* ------------------------------------------------------------------
   Anthropic call + robust JSON parse (with one self-repair retry).
   Sonnet 5 rejects custom temperature / manual thinking — omit them.
   ------------------------------------------------------------------ */
async function anthropicText(system, userContent, maxTokens) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: userContent }] }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("Claude API " + res.status + (t ? " — " + t.slice(0, 160) : ""));
  }
  const data = await res.json();
  if (data.stop_reason === "max_tokens") throw new Error("response was too long — try a simpler page");
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

async function claudeJson(system, userContent) {
  const raw = await anthropicText(system, userContent, 4000);
  try { return parseJsonLoose(raw); }
  catch (e) {
    const repaired = await anthropicText(
      "You fix malformed JSON. Output only valid JSON, nothing else.",
      "The text below should be one valid JSON object but is malformed. Return ONLY corrected valid JSON, no fences, keep all content:\n\n" + raw,
      4000
    );
    return parseJsonLoose(repaired);
  }
}

function parseJsonLoose(text) {
  let t = (text || "").trim();
  if (t.startsWith("```")) t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a !== -1 && b !== -1) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

/* ==================================================================
   PROMPTS
   ================================================================== */
const ANALYZE_SYSTEM = `You are the strategist for Idievo, a digital agency. You are handed the extracted text of ONE page from a prospect's website plus Idievo's service menu. Decide, honestly, which Idievo services best fit THIS prospect and why — grounded only in the page.

HARD RULES:
- Use ONLY facts present in the page text. Never invent clients, revenue, tools, team size, or problems.
- Recommend ONLY services from the provided menu, by their exact names.
- Base every recommendation on a specific signal from the page (a missing CTA, an old-looking site, a booking form, an inactive blog, thin branding, lots of manual inquiry, etc.). If the evidence is weak, say so and lower confidence.
- Rank recommendations best-fit first. Give 3 to 4.

OUTPUT FORMAT:
- Output ONE valid JSON object and NOTHING else. No prose, no code fences.
- Inside any string, do NOT use double-quote characters; use single quotes. Keep each string on one line. No trailing commas.

Shape:
{
  "prospect": {
    "name": "company or person name from the page, else a short descriptor",
    "type": "short label, e.g. Local service business, E-commerce brand, SaaS, Agency, Real estate",
    "summary": "one or two plain sentences on what they actually do, from the page",
    "confidence": "high | medium | low"
  },
  "signals": [
    { "label": "SHORT TAG", "detail": "the specific fact from the page" }
  ],
  "recommendations": [
    { "service": "exact service name from the menu", "fit": "high | medium", "why": "one or two sentences tied to a specific signal", "angle": "a short phrase describing the hook to lead with" }
  ]
}

Provide 3 to 5 signals and 3 to 4 recommendations.`;

const COMPOSE_SYSTEM = `You are an elite cold-email copywriter writing ONE first-touch pitch email on behalf of the sender. This email is the prospect's first impression of the company, so it must feel like a sharp, busy human wrote it specifically for them — not a template, not a mass blast.

VOICE AND QUALITY:
- Sound human and specific. Open with a concrete observation about THIS prospect (use the signals), not a greeting cliche.
- Never use: 'I hope this email finds you well', 'I wanted to reach out', 'I came across your website', 'quick question', 'in today's world', 'game-changer', 'leverage', 'synergy', 'unlock', 'elevate', 'seamless', 'robust', 'circle back'.
- No emojis anywhere. No exclamation-mark spam. No ALL-CAPS words. Avoid spammy words like 'free money', 'guarantee', 'act now'.
- Short. Aim for 90-150 words in the body. Short paragraphs (1-2 sentences each). Use contractions. Plain words.
- Connect the prospect's specific situation to the ONE chosen service. Explain the outcome in their terms, not a feature list.
- Use the company's real trust points only if they strengthen the message; do not overclaim or invent metrics or case studies.
- One clear, low-friction call to action (a short reply, or a free strategy call). Do not stack multiple asks.
- Place a relevant link naturally (e.g. the booking link or services page in the CTA). The signature carries website, email, phone.
- Subject line: 2 to 6 words, specific, curiosity or clear value, lowercase-friendly, no clickbait, no spam-trigger words.

OUTPUT FORMAT:
- Output ONE valid JSON object and NOTHING else. No prose, no code fences.
- Inside any string, do NOT use double-quote characters; use single quotes. Keep each string on ONE line. No trailing commas.
- Represent the email as arrays of lines/paragraphs so there are no line breaks inside strings.

Shape:
{
  "subject": "the primary subject line",
  "alt_subjects": ["a second option", "a third option"],
  "body_paragraphs": ["opening hook grounded in a signal", "bridge to the problem/opportunity", "what we do about it, in their terms", "the single call to action with a link where natural"],
  "signoff": ["a natural closing line", "Foyzul", "Idievo", "https://idievo.com/", "foyzul@idievo.com", "+1 307 310 7690"]
}

Keep body_paragraphs between 3 and 5 items. Keep it tight and genuinely persuasive.`;

function resp(status, obj) { return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify(obj) }; }

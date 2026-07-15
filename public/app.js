/* ==================================================================
   Groundwork (personal edition) — frontend logic
   Flow: URL -> analyze -> pick a service -> compose email.
   ================================================================== */
(function () {
  "use strict";

  const cfg = window.GROUNDWORK_CONFIG || {};
  if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("YOUR-PROJECT")) {
    alert("Not configured yet: add your Supabase URL and anon key in public/config.js.");
  }
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  const $ = (id) => document.getElementById(id);

  // auth els
  const authShell = $("authShell"), app = $("app");
  const authTitle = $("authTitle"), authSub = $("authSub");
  const emailEl = $("email"), passEl = $("password");
  const authSubmit = $("authSubmit"), toggleMode = $("toggleMode"), authToggle = $("authToggle");
  const authErr = $("authErr"), authOk = $("authOk");
  let mode = "signin";

  // app els
  const acctPill = $("acctPill"), signOutBtn = $("signOut");
  const urlEl = $("prospectUrl"), analyzeBtn = $("analyzeBtn"), analyzeLabel = $("analyzeLabel");
  const composerErr = $("composerErr"), startOver = $("startOver");
  const emptyState = $("emptyState"), loadingState = $("loadingState"), loadingCaption = $("loadingCaption");
  const analysisState = $("analysisState"), emailState = $("emailState");
  const historyList = $("historyList"), historyCount = $("historyCount");
  const toast = $("toast");

  let currentUser = null;
  let analysis = null;        // last analyze result
  let currentUrl = "";
  let currentEmail = null;    // last composed email
  let currentService = "";

  // ============================================================ AUTH
  function setMode(next) {
    mode = next; clearNotices();
    if (mode === "signin") {
      authTitle.textContent = "Sign in"; authSub.textContent = "Welcome back.";
      authSubmit.textContent = "Sign in"; passEl.setAttribute("autocomplete", "current-password");
      authToggle.innerHTML = 'New here? <button id="toggleMode">Create an account</button>';
    } else {
      authTitle.textContent = "Create account"; authSub.textContent = "Set up your login.";
      authSubmit.textContent = "Create account"; passEl.setAttribute("autocomplete", "new-password");
      authToggle.innerHTML = 'Already have an account? <button id="toggleMode">Sign in</button>';
    }
    $("toggleMode").addEventListener("click", () => setMode(mode === "signin" ? "signup" : "signin"));
  }
  function clearNotices() { authErr.classList.remove("show"); authOk.classList.remove("show"); authErr.textContent = ""; authOk.textContent = ""; }
  function showAuthErr(m) { authErr.textContent = m; authErr.classList.add("show"); authOk.classList.remove("show"); }
  function showAuthOk(m) { authOk.textContent = m; authOk.classList.add("show"); authErr.classList.remove("show"); }
  toggleMode.addEventListener("click", () => setMode("signup"));
  authSubmit.addEventListener("click", handleAuth);
  passEl.addEventListener("keydown", (e) => { if (e.key === "Enter") handleAuth(); });

  async function handleAuth() {
    clearNotices();
    const email = emailEl.value.trim(), password = passEl.value;
    if (!email || !password) return showAuthErr("Enter your email and password.");
    if (password.length < 6) return showAuthErr("Password must be at least 6 characters.");
    authSubmit.disabled = true; authSubmit.textContent = mode === "signin" ? "Signing in\u2026" : "Creating\u2026";
    try {
      if (mode === "signup") {
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        if (data.session) onSignedIn(data.user);
        else { showAuthOk("Check your email to confirm, then sign in."); setMode("signin"); }
      } else {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error; onSignedIn(data.user);
      }
    } catch (err) { showAuthErr(prettyAuthError(err)); }
    finally { authSubmit.disabled = false; authSubmit.textContent = mode === "signin" ? "Sign in" : "Create account"; }
  }
  function prettyAuthError(err) {
    const m = (err && err.message) || "Something went wrong.";
    if (/invalid login/i.test(m)) return "Email or password is incorrect.";
    if (/already registered/i.test(m)) return "That email already has an account — try signing in.";
    return m;
  }
  signOutBtn.addEventListener("click", async () => {
    await sb.auth.signOut(); currentUser = null;
    app.classList.remove("show"); authShell.classList.remove("hide");
  });
  async function onSignedIn(user) {
    currentUser = user; authShell.classList.add("hide"); app.classList.add("show");
    emailEl.value = ""; passEl.value = "";
    acctPill.textContent = user.email || "";
    await loadHistory();
  }
  (async function boot() {
    setMode("signin");
    const { data } = await sb.auth.getSession();
    if (data.session) onSignedIn(data.session.user);
  })();

  // ============================================================ STATES
  function showState(which) {
    emptyState.style.display = which === "empty" ? "block" : "none";
    loadingState.classList.toggle("show", which === "loading");
    analysisState.classList.toggle("show", which === "analysis");
    emailState.classList.toggle("show", which === "email");
    startOver.style.display = which === "empty" ? "none" : "inline";
  }
  let capTimer = null;
  function runCaptions(list) {
    let i = 0; loadingCaption.textContent = list[0];
    clearInterval(capTimer);
    capTimer = setInterval(() => { i = (i + 1) % list.length; loadingCaption.textContent = list[i]; }, 1400);
  }
  function stopCaptions() { clearInterval(capTimer); }

  // ============================================================ ANALYZE
  analyzeBtn.addEventListener("click", analyze);
  urlEl.addEventListener("keydown", (e) => { if (e.key === "Enter") analyze(); });
  startOver.addEventListener("click", () => {
    analysis = null; currentEmail = null; urlEl.value = ""; composerErr.style.display = "none";
    showState("empty");
  });

  async function analyze() {
    composerErr.style.display = "none";
    const url = urlEl.value.trim();
    if (!url) return err("Add the prospect's website URL.");
    if (!/^https?:\/\/.+\..+/.test(url)) return err("That doesn't look like a full URL — include https://");

    currentUrl = url;
    analyzeBtn.disabled = true; analyzeLabel.textContent = "Reading\u2026";
    showState("loading");
    runCaptions(["Fetching the site\u2026", "Reading what they do\u2026", "Pulling out signals\u2026", "Matching services\u2026"]);

    try {
      const data = await callApi({ action: "analyze", url });
      analysis = data.result;
      renderAnalysis(analysis);
      showState("analysis");
    } catch (e) {
      showState("empty"); err(e.message || "Something went wrong.");
    } finally {
      stopCaptions(); analyzeBtn.disabled = false; analyzeLabel.textContent = "Analyze site";
    }
  }

  function renderAnalysis(r) {
    $("aType").textContent = (r.prospect && r.prospect.type) || "Prospect";
    $("aName").textContent = (r.prospect && r.prospect.name) || "This prospect";
    $("aSummary").textContent = (r.prospect && r.prospect.summary) || "";
    const conf = ((r.prospect && r.prospect.confidence) || "medium").toLowerCase();
    const c = $("aConfidence"); c.textContent = conf + " signal";
    c.className = "confidence " + (["high", "medium", "low"].includes(conf) ? conf : "medium");

    const sig = $("aSignals"); sig.innerHTML = "";
    (r.signals || []).forEach((s) => {
      const row = document.createElement("div"); row.className = "signal";
      row.innerHTML = `<span class="s-label">${esc(s.label || "signal")}</span><span class="s-detail">${esc(s.detail || "")}</span>`;
      sig.appendChild(row);
    });
    if (!(r.signals || []).length) sig.innerHTML = `<div class="signal"><span class="s-detail" style="color:var(--muted)">No strong signals — try another page.</span></div>`;

    const recs = $("aRecs"); recs.innerHTML = "";
    (r.recommendations || []).forEach((rec) => {
      const card = document.createElement("button"); card.className = "rec-card"; card.type = "button";
      const fit = (rec.fit || "medium").toLowerCase();
      card.innerHTML = `
        <div class="rec-top">
          <span class="rec-name">${esc(rec.service || "Service")}</span>
          <span class="fit-badge ${fit === "high" ? "high" : "med"}">${esc(fit)} fit</span>
        </div>
        <div class="rec-why">${esc(rec.why || "")}</div>
        <div class="rec-cta">Write the email &rarr;</div>`;
      card.addEventListener("click", () => compose(rec));
      recs.appendChild(card);
    });
    if (!(r.recommendations || []).length) recs.innerHTML = `<p class="history-empty">No clear service match on this page.</p>`;
  }

  // ============================================================ COMPOSE
  async function compose(rec) {
    currentService = rec.service || "";
    showState("loading");
    runCaptions(["Studying the fit\u2026", "Finding the hook\u2026", "Writing the subject\u2026", "Drafting the email\u2026", "Making it sound human\u2026"]);
    try {
      const data = await callApi({
        action: "compose",
        url: currentUrl,
        service: rec.service,
        why: rec.why || "",
        prospect: analysis ? analysis.prospect : {},
        signals: analysis ? analysis.signals : [],
      });
      currentEmail = data.email;
      renderEmail(currentEmail, currentService);
      showState("email");
      loadHistory();
    } catch (e) {
      renderAnalysis(analysis); showState("analysis"); toastMsg(e.message || "Couldn't write the email.");
    } finally { stopCaptions(); }
  }

  function renderEmail(email, service) {
    $("eService").textContent = service || "";
    $("eSubjectText").textContent = email.subject || "";
    const alts = $("eAltSubjects"); alts.innerHTML = "";
    (email.alt_subjects || []).forEach((s) => {
      const row = document.createElement("div"); row.className = "alt-subject";
      row.innerHTML = `<span>${esc(s)}</span><button class="copy-btn" data-copy="${escAttr(s)}">Copy</button>`;
      alts.appendChild(row);
    });

    const body = $("eBody"); body.innerHTML = "";
    (email.body_paragraphs || []).forEach((p) => {
      const el = document.createElement("p"); el.className = "email-p"; el.textContent = p; body.appendChild(el);
    });
    const sign = document.createElement("div"); sign.className = "email-signoff";
    (email.signoff || []).forEach((line) => {
      const l = document.createElement("div"); l.className = "sign-line"; l.textContent = line; sign.appendChild(l);
    });
    body.appendChild(sign);

    // wire copy buttons on alt subjects
    alts.querySelectorAll(".copy-btn").forEach((b) => b.addEventListener("click", () => copyRaw(b.getAttribute("data-copy"), b)));
  }

  function assembleEmail(withSubject) {
    const parts = [];
    if (withSubject && currentEmail.subject) parts.push("Subject: " + currentEmail.subject, "");
    (currentEmail.body_paragraphs || []).forEach((p) => { parts.push(p); parts.push(""); });
    (currentEmail.signoff || []).forEach((l) => parts.push(l));
    return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  $("copySubject").addEventListener("click", (e) => copyRaw(currentEmail.subject, e.currentTarget));
  $("copyEmail").addEventListener("click", (e) => copyRaw(assembleEmail(true), e.currentTarget));
  $("copyBodyOnly").addEventListener("click", (e) => copyRaw(assembleEmail(false), e.currentTarget));
  $("backToRecs").addEventListener("click", () => { renderAnalysis(analysis); showState("analysis"); });

  function copyRaw(text, btn) {
    navigator.clipboard.writeText(text || "").then(() => {
      const orig = btn.textContent; const wasBtn = btn.classList.contains("btn");
      btn.textContent = "Copied"; if (!wasBtn) btn.classList.add("copied");
      toastMsg("Copied to clipboard");
      setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 1400);
    });
  }

  // ============================================================ HISTORY
  async function loadHistory() {
    const { data, error } = await sb.from("generations")
      .select("id, prospect_url, prospect_name, offer, created_at, result")
      .eq("user_id", currentUser.id).order("created_at", { ascending: false }).limit(6);
    if (error || !data || !data.length) {
      historyList.innerHTML = `<p class="history-empty">Nothing yet &mdash; emails you generate will show up here.</p>`;
      historyCount.textContent = ""; return;
    }
    historyCount.textContent = data.length + " shown";
    historyList.innerHTML = "";
    data.forEach((row) => {
      const item = document.createElement("button"); item.className = "history-item";
      const host = safeHost(row.prospect_url);
      item.innerHTML = `<div class="h-url">${esc(row.prospect_name || host)}</div>
        <div class="h-meta">${esc(row.offer || "")} &middot; ${fmtDate(row.created_at)}</div>`;
      item.addEventListener("click", () => {
        if (row.result && row.result.email) {
          currentEmail = row.result.email; currentUrl = row.prospect_url;
          analysis = { prospect: row.result.prospect || {}, signals: (row.result.prospect && []) || [], recommendations: [] };
          renderEmail(row.result.email, row.result.service || row.offer || "");
          showState("email"); window.scrollTo({ top: 0, behavior: "smooth" });
        }
      });
      historyList.appendChild(item);
    });
  }

  // ============================================================ API
  async function callApi(payload) {
    const { data: sess } = await sb.auth.getSession();
    const token = sess.session && sess.session.access_token;
    if (!token) throw new Error("Your session expired — sign in again.");
    const res = await fetch("/api/personalize", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify(payload),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || "Request failed.");
    return out;
  }

  // ============================================================ helpers
  function err(m) { composerErr.textContent = m; composerErr.style.display = "block"; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function escAttr(s) { return esc(s).replace(/\n/g, " "); }
  function safeHost(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u || ""; } }
  function fmtDate(d) { return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
  let toastTimer = null;
  function toastMsg(m) { toast.textContent = m; toast.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("show"), 1600); }
})();

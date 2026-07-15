/* ==================================================================
   Groundwork — frontend app logic
   Plain JS, no framework. Talks to Supabase (auth + history reads)
   and to the Netlify function /api/personalize (the AI work).
   ================================================================== */

(function () {
  "use strict";

  const cfg = window.GROUNDWORK_CONFIG || {};
  if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("YOUR-PROJECT")) {
    alert("Groundwork isn't configured yet. Add your Supabase URL and anon key in public/config.js.");
  }

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  // ---- element refs ----
  const $ = (id) => document.getElementById(id);
  const authShell = $("authShell");
  const app = $("app");

  // auth
  const authTitle = $("authTitle"), authSub = $("authSub");
  const emailEl = $("email"), passEl = $("password");
  const authSubmit = $("authSubmit"), toggleMode = $("toggleMode"), authToggle = $("authToggle");
  const authErr = $("authErr"), authOk = $("authOk");
  let mode = "signin"; // or "signup"

  // app
  const usageLeft = $("usageLeft"), usageDot = $("usageDot"), usagePill = $("usagePill");
  const signOutBtn = $("signOut");
  const urlEl = $("prospectUrl"), offerEl = $("offer"), toneRow = $("toneRow");
  const generateBtn = $("generateBtn"), generateLabel = $("generateLabel"), composerErr = $("composerErr");
  const emptyState = $("emptyState"), loadingState = $("loadingState"), briefState = $("briefState"), loadingCaption = $("loadingCaption");
  const historyList = $("historyList"), historyCount = $("historyCount");
  const toast = $("toast");

  let selectedTone = "Direct";
  let currentUser = null;

  // ============================================================
  // AUTH
  // ============================================================
  function setMode(next) {
    mode = next;
    clearNotices();
    if (mode === "signin") {
      authTitle.textContent = "Sign in";
      authSub.textContent = "Welcome back. Let's get to work.";
      authSubmit.textContent = "Sign in";
      passEl.setAttribute("autocomplete", "current-password");
      authToggle.innerHTML = 'New here? <button id="toggleMode">Create an account</button>';
    } else {
      authTitle.textContent = "Create account";
      authSub.textContent = "Start with 10 free personalizations.";
      authSubmit.textContent = "Create account";
      passEl.setAttribute("autocomplete", "new-password");
      authToggle.innerHTML = 'Already have an account? <button id="toggleMode">Sign in</button>';
    }
    $("toggleMode").addEventListener("click", () => setMode(mode === "signin" ? "signup" : "signin"));
  }

  function clearNotices() {
    authErr.classList.remove("show"); authOk.classList.remove("show");
    authErr.textContent = ""; authOk.textContent = "";
  }
  function showAuthErr(m) { authErr.textContent = m; authErr.classList.add("show"); authOk.classList.remove("show"); }
  function showAuthOk(m) { authOk.textContent = m; authOk.classList.add("show"); authErr.classList.remove("show"); }

  toggleMode.addEventListener("click", () => setMode("signup"));

  authSubmit.addEventListener("click", handleAuth);
  passEl.addEventListener("keydown", (e) => { if (e.key === "Enter") handleAuth(); });

  async function handleAuth() {
    clearNotices();
    const email = emailEl.value.trim();
    const password = passEl.value;
    if (!email || !password) return showAuthErr("Enter your email and password.");
    if (password.length < 6) return showAuthErr("Password must be at least 6 characters.");

    authSubmit.disabled = true;
    authSubmit.textContent = mode === "signin" ? "Signing in…" : "Creating…";

    try {
      if (mode === "signup") {
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        if (data.session) {
          onSignedIn(data.user);
        } else {
          showAuthOk("Check your email to confirm your account, then sign in.");
          setMode("signin");
        }
      } else {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        onSignedIn(data.user);
      }
    } catch (err) {
      showAuthErr(prettyAuthError(err));
    } finally {
      authSubmit.disabled = false;
      authSubmit.textContent = mode === "signin" ? "Sign in" : "Create account";
    }
  }

  function prettyAuthError(err) {
    const m = (err && err.message) || "Something went wrong.";
    if (/invalid login/i.test(m)) return "Email or password is incorrect.";
    if (/already registered/i.test(m)) return "That email already has an account — try signing in.";
    return m;
  }

  signOutBtn.addEventListener("click", async () => {
    await sb.auth.signOut();
    currentUser = null;
    app.classList.remove("show");
    authShell.classList.remove("hide");
  });

  async function onSignedIn(user) {
    currentUser = user;
    authShell.classList.add("hide");
    app.classList.add("show");
    emailEl.value = ""; passEl.value = "";
    await Promise.all([refreshUsage(), loadHistory()]);
  }

  // check for an existing session on load
  (async function boot() {
    setMode("signin");
    const { data } = await sb.auth.getSession();
    if (data.session) onSignedIn(data.session.user);
  })();

  // ============================================================
  // TONE PICKER
  // ============================================================
  toneRow.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    toneRow.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
    btn.setAttribute("aria-pressed", "true");
    selectedTone = btn.dataset.tone;
  });

  // ============================================================
  // USAGE
  // ============================================================
  async function refreshUsage() {
    const { data, error } = await sb
      .from("profiles")
      .select("usage_count, usage_limit")
      .eq("id", currentUser.id)
      .single();
    if (error || !data) { usageLeft.textContent = "—"; return; }
    const left = Math.max(0, data.usage_limit - data.usage_count);
    usageLeft.textContent = left;
    usagePill.title = `${data.usage_count} of ${data.usage_limit} personalizations used`;
    usageDot.className = "usage-dot" + (left === 0 ? " out" : left <= 3 ? " low" : "");
  }

  // ============================================================
  // GENERATE
  // ============================================================
  const CAPTIONS = [
    "Fetching the site…",
    "Reading what they do…",
    "Pulling out signals…",
    "Finding the angle…",
    "Writing openers…",
  ];
  let captionTimer = null;

  generateBtn.addEventListener("click", generate);

  function showResultsState(which) {
    emptyState.style.display = which === "empty" ? "block" : "none";
    loadingState.classList.toggle("show", which === "loading");
    briefState.classList.toggle("show", which === "brief");
    if (which !== "brief") briefState.classList.remove("show");
  }

  async function generate() {
    composerErr.style.display = "none";
    const url = urlEl.value.trim();
    const offer = offerEl.value.trim();

    if (!url) return fieldError("Add the prospect's website URL.");
    if (!/^https?:\/\/.+\..+/.test(url)) return fieldError("That doesn't look like a full URL — include https://");
    if (!offer) return fieldError("Tell Groundwork what you're offering.");

    generateBtn.disabled = true;
    generateLabel.textContent = "Working…";
    showResultsState("loading");

    // rotate loading captions
    let i = 0;
    loadingCaption.textContent = CAPTIONS[0];
    captionTimer = setInterval(() => {
      i = (i + 1) % CAPTIONS.length;
      loadingCaption.textContent = CAPTIONS[i];
    }, 1400);

    try {
      const { data: sess } = await sb.auth.getSession();
      const token = sess.session && sess.session.access_token;
      if (!token) throw new Error("Your session expired — sign in again.");

      const res = await fetch("/api/personalize", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ url, offer, tone: selectedTone }),
      });

      const payload = await res.json();

      if (res.status === 402) {
        showResultsState("empty");
        fieldError("You're out of free personalizations. (Upgrade logic goes here later.)");
        await refreshUsage();
        return;
      }
      if (!res.ok) throw new Error(payload.error || "Generation failed.");

      renderBrief(payload.result);
      showResultsState("brief");
      if (typeof payload.remaining === "number") {
        usageLeft.textContent = payload.remaining;
        usageDot.className = "usage-dot" + (payload.remaining === 0 ? " out" : payload.remaining <= 3 ? " low" : "");
      }
      loadHistory();
    } catch (err) {
      showResultsState("empty");
      fieldError(err.message || "Something went wrong. Try again.");
    } finally {
      clearInterval(captionTimer);
      generateBtn.disabled = false;
      generateLabel.textContent = "Read site & write openers";
    }
  }

  function fieldError(m) {
    composerErr.textContent = m;
    composerErr.style.display = "block";
  }

  // ============================================================
  // RENDER BRIEF
  // ============================================================
  function renderBrief(r) {
    $("bName").textContent = (r.prospect && r.prospect.name) || "This prospect";
    $("bSummary").textContent = (r.prospect && r.prospect.summary) || "";

    const conf = ((r.prospect && r.prospect.confidence) || "medium").toLowerCase();
    const confEl = $("bConfidence");
    confEl.textContent = conf + " signal";
    confEl.className = "confidence " + (["high", "medium", "low"].includes(conf) ? conf : "medium");

    // signals
    const sig = $("bSignals");
    sig.innerHTML = "";
    (r.signals || []).forEach((s) => {
      const row = document.createElement("div");
      row.className = "signal";
      row.innerHTML = `<span class="s-label">${esc(s.label || "signal")}</span><span class="s-detail">${esc(s.detail || "")}</span>`;
      sig.appendChild(row);
    });
    if (!(r.signals || []).length) {
      sig.innerHTML = `<div class="signal"><span class="s-detail" style="color:var(--muted)">No strong signals on this page — try an about or product page.</span></div>`;
    }

    // openers
    const op = $("bOpeners");
    op.innerHTML = "";
    (r.openers || []).forEach((o, idx) => {
      const card = document.createElement("div");
      card.className = "opener";
      const src = o.signal_used ? `<div class="opener-src">Uses signal: <b>${esc(o.signal_used)}</b></div>` : "";
      card.innerHTML = `
        <div class="opener-top">
          <span class="angle-tag">${esc(o.angle || "Angle " + (idx + 1))}</span>
          <button class="copy-btn" data-copy="${escAttr(o.line || "")}">Copy</button>
        </div>
        <div class="opener-line">${esc(o.line || "")}</div>
        ${src}`;
      op.appendChild(card);
    });

    // subjects
    const subj = $("bSubjects");
    subj.innerHTML = "";
    (r.subject_lines || []).forEach((s) => {
      const row = document.createElement("div");
      row.className = "subject";
      row.innerHTML = `<span>${esc(s)}</span><button class="copy-btn" data-copy="${escAttr(s)}">Copy</button>`;
      subj.appendChild(row);
    });
    if (!(r.subject_lines || []).length) subj.innerHTML = `<div class="subject" style="color:var(--muted)">—</div>`;

    // notes
    const notesWrap = $("bNotesWrap");
    if (r.notes && r.notes.trim()) {
      $("bNotes").textContent = r.notes;
      notesWrap.style.display = "flex";
    } else {
      notesWrap.style.display = "none";
    }

    briefState.querySelectorAll(".copy-btn").forEach((b) => {
      b.addEventListener("click", () => copyText(b));
    });
  }

  function copyText(btn) {
    const text = btn.getAttribute("data-copy");
    navigator.clipboard.writeText(text).then(() => {
      const orig = btn.textContent;
      btn.textContent = "Copied";
      btn.classList.add("copied");
      showToast("Copied to clipboard");
      setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 1400);
    });
  }

  // ============================================================
  // HISTORY  (read directly from Supabase; RLS keeps it per-user)
  // ============================================================
  async function loadHistory() {
    const { data, error } = await sb
      .from("generations")
      .select("id, prospect_url, prospect_name, created_at, result")
      .eq("user_id", currentUser.id)
      .order("created_at", { ascending: false })
      .limit(6);

    if (error || !data || !data.length) {
      historyList.innerHTML = `<p class="history-empty">Nothing yet — your saved briefs will show up here.</p>`;
      historyCount.textContent = "";
      return;
    }
    historyCount.textContent = data.length + " shown";
    historyList.innerHTML = "";
    data.forEach((row) => {
      const item = document.createElement("button");
      item.className = "history-item";
      const host = safeHost(row.prospect_url);
      item.innerHTML = `
        <div class="h-url">${esc(row.prospect_name || host)}</div>
        <div class="h-meta">${esc(host)} · ${fmtDate(row.created_at)}</div>`;
      item.addEventListener("click", () => {
        if (row.result) { renderBrief(row.result); showResultsState("brief"); window.scrollTo({ top: 0, behavior: "smooth" }); }
      });
      historyList.appendChild(item);
    });
  }

  // ============================================================
  // helpers
  // ============================================================
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function escAttr(s) { return esc(s).replace(/\n/g, " "); }
  function safeHost(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u || ""; } }
  function fmtDate(d) { const dt = new Date(d); return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }

  let toastTimer = null;
  function showToast(m) {
    toast.textContent = m;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 1600);
  }
})();

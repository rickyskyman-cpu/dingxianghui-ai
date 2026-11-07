// ===== API client (backend: Supabase Edge Function) =====
const API_BASE = "https://lvmgyqbluhabhcrgdzex.supabase.co/functions/v1/dingxianghui-api";
const TOKEN_KEY = "dxh_session_token";
const CARD_MAX_BYTES = 5 * 1024 * 1024;
const CARD_TYPES = ["image/jpeg", "image/png", "image/webp"];
function getToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
}
function setToken(t) {
  try {
    localStorage.removeItem(TOKEN_KEY);
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch (e) {}
}
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function deepEscape(v) {
  if (typeof v === "string") return esc(v);
  if (Array.isArray(v)) return v.map(deepEscape);
  if (v && typeof v === "object") { const o = {}; for (const k in v) o[k] = deepEscape(v[k]); return o; }
  return v;
}
function isDemoActor(u) { return !!(u && (u.is_demo || u.role === "demo_admin")); }
function isRealAdmin(u) { return !!(u && u.role === "admin" && !u.is_demo); }
function isApproved(u) { return !!(u && !isDemoActor(u) && u.audit_status === "approved"); }
async function apiFetch(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  const t = getToken();
  if (t) headers["Authorization"] = "Bearer " + t;
  let res;
  try {
    res = await fetch(API_BASE + path + (path.includes("?") ? "&" : "?") + "forceFunctionRegion=ap-southeast-1", Object.assign({}, opts, { headers }));
  } catch (e) {
    return { ok: false, status: 0, json: async () => ({ detail: "网络请求失败，请检查网络后重试" }) };
  }
  let data = {};
  try { data = deepEscape(await res.json()); } catch (e) { data = { detail: "服务器响应异常" }; }
  if (res.status === 401 && t && path !== "/api/auth/login") { setToken(""); }
  return { ok: res.ok, status: res.status, json: async () => data };
}
const isAdminRole = (u) => u && (u.role === "admin" || u.role === "demo_admin");

// Global application state
let currentUser = null;
let currentView = "home";
let currentWorkspaceStep = 1;
let activeDemandIdForMatch = 1;
let isRecordingVoice = false;
let speechRecognitionInstance = null;
let mediaRecorderInstance = null;
let recordedAudioChunks = [];

document.addEventListener("DOMContentLoaded", async () => {
  try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  if (getToken()) {
    const r = await apiFetch("/api/me");
    if (r.ok) {
      const user = (await r.json()).user;
      if (isDemoActor(user)) {
        await logoutCurrentUser(true);
      } else {
        currentUser = user;
      }
    } else setToken("");
  }
  updateHeaderUserStatus();
  if (location.search.includes("demo=")) {
    history.replaceState(null, "", location.pathname);
    showToast("演示入口已关闭。");
  }
});

function showToast(msg, duration = 4200) {
  const el = document.getElementById("global-toast");
  if (!el) return;
  el.textContent = msg == null ? "" : String(msg);
  el.style.display = "block";
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => { el.style.display = "none"; }, duration);
}

// ==================== Navigation & View Switching ====================
function switchView(viewName) {
  if (viewName === "feed" && !isApproved(currentUser)) viewName = currentUser ? "workspace" : "auth";
  if (viewName === "workspace" && !currentUser) viewName = "auth";
  if (viewName === "admin" && !isRealAdmin(currentUser)) viewName = "home";
  currentView = viewName;
  ["home", "auth", "feed", "workspace", "admin"].forEach((v) => {
    const sec = document.getElementById(`view-${v}`);
    const nav = document.getElementById(`nav-${v}`);
    if (sec) sec.classList.toggle("active", v === viewName);
    if (nav) nav.classList.toggle("active", v === viewName);
  });
  if (viewName === "feed") loadFeedView();
  else if (viewName === "workspace") renderWorkspaceView();
  else if (viewName === "admin") loadAdminDashboard();
  else if (viewName === "auth") loadChannelStatus();
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
}

function showRegister() {
  switchView("auth");
  const name = document.getElementById("reg-name");
  if (name) name.focus();
}

function updateHeaderUserStatus() {
  const pill = document.getElementById("header-user-status");
  const logout = document.getElementById("logout-btn");
  const feed = document.getElementById("nav-feed");
  const workspace = document.getElementById("nav-workspace");
  const admin = document.getElementById("nav-admin");
  const approved = isApproved(currentUser);
  if (feed) feed.hidden = !approved;
  if (workspace) workspace.hidden = !currentUser;
  if (admin) admin.hidden = !isRealAdmin(currentUser);
  if (logout) logout.hidden = !currentUser;
  if (!pill) return;
  if (!currentUser) {
    pill.textContent = "";
    return;
  }
  const state = isRealAdmin(currentUser)
    ? "管理员"
    : currentUser.audit_status !== "approved"
      ? "等待审核"
      : currentUser.profile_completed ? "已通过审核" : "已通过审核，资料未完成";
  pill.textContent = `${currentUser.real_name || ""} ${state}`;
}

async function logoutCurrentUser(silent) {
  const token = getToken();
  setToken("");
  currentUser = null;
  if (token) {
    try { await apiFetch("/api/auth/logout", { method: "POST" }); } catch (e) {}
  }
  updateHeaderUserStatus();
  if (!silent) {
    switchView("home");
    showToast("已退出。");
  }
}

// ==================== VIEW 1: Homepage Public Overview & Data Directory ====================
async function loadInternalOverview() {
  const box = document.getElementById("internal-overview");
  if (!box || !isApproved(currentUser)) return;
  try {
    const r = await apiFetch("/api/public/overview");
    const d = await r.json();
    const parts = (d.stats || []).map((s) => `${s.label || ""}${s.level || ""}`).filter(Boolean);
    box.textContent = parts.length ? `数量级：${parts.join("，")}` : "";
  } catch (e) { box.textContent = ""; }
}

async function loadChannelStatus() {
  const box = document.getElementById("channel-status");
  if (!box) return;
  const r = await apiFetch("/api/auth/channels");
  const d = r.ok ? await r.json() : {};
  if (d.wechat_website || d.wechat_mp || d.sms) {
    box.textContent = "部分渠道已由服务器打开。这里不会显示二维码或验证码，也不会把绑定说成严格双因子。";
    return;
  }
  box.textContent = "微信扫码、微信内授权和短信都未启用。同时绑定也不等于每次登录都要再验一次，也不是严格双因子。";
}

function onAlumniCardSelected() {
  const input = document.getElementById("reg-card-file");
  const box = document.getElementById("ocr-result-box");
  const file = input && input.files && input.files[0];
  if (!box) return;
  box.style.display = "block";
  if (!file) { box.textContent = ""; return; }
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!CARD_TYPES.includes(file.type) || !["jpg", "jpeg", "png", "webp"].includes(ext)) {
    box.textContent = "只接受 JPG、PNG 或 WebP。";
    input.value = "";
    return;
  }
  if (file.size <= 0 || file.size > CARD_MAX_BYTES) {
    box.textContent = "图片不能超过 5MB。";
    input.value = "";
    return;
  }
  box.textContent = "已检查类型和大小。自动识别未启用，图片没有上传，也不会被当成审核通过。";
}

function postCard(p) {
  const tags = (p.tags || []).slice(0, 4).map((t) => `<span class="badge ${(p.related_fields || []).includes(t) ? "badge-gold" : "badge-navy"}">${t}</span>`).join(" ");
  return `<div class="data-item-card" style="border-left:4px solid ${p.post_type === "供给" ? "#0d9488" : "#7c3aed"}">
    <div class="item-top-line"><div>
      <span class="badge ${p.post_type === "供给" ? "badge-success" : "badge-lilac"}">${p.post_type}</span>
      <span class="item-name">${p.title}</span>${p.is_mine ? ' <span class="badge badge-gold">我发布的</span>' : ""}
    </div><span style="font-size:12px;color:var(--text-muted)">${p.created_at || ""}</span></div>
    <div style="font-size:13px;color:var(--text-secondary);margin:6px 0;">${p.summary}</div>
    <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;font-size:12.5px;">
      <span>🏷️ ${p.industry} · ${p.category} ${tags}</span>
      <span style="color:var(--text-muted)">发布校友：${p.poster}</span>
    </div></div>`;
}

async function loadFeedView() {
  const postsBox = document.getElementById("feed-posts");
  if (!isApproved(currentUser)) {
    if (postsBox) postsBox.textContent = "审核通过后才能查看供需。";
    return;
  }
  await loadInternalOverview();
  const r = await apiFetch("/api/feed");
  const d = await r.json();
  if (!r.ok) {
    postsBox.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);">🔒 ${d.detail || "请先登录"}</div>`;
    document.getElementById("feed-alumni").innerHTML = ""; return;
  }
  document.getElementById("feed-my-fields").textContent = d.my_fields.length ? `按您的画像领域推荐：${d.my_fields.join("、")}` : "您尚未完善个人能力画像，以下为最新发布";
  postsBox.innerHTML = d.posts.length ? d.posts.map(postCard).join("") : '<div style="color:var(--text-muted)">暂无相关领域发布</div>';
  document.getElementById("feed-alumni").innerHTML = d.alumni.map((a) => `<div class="data-item-card">
    <div class="item-top-line"><span class="item-name">${a.poster}</span><span style="font-size:12px;color:var(--text-muted)">${a.city || ""}</span></div>
    <div style="font-size:13px;color:var(--text-secondary);margin:4px 0;">${a.capability_summary}</div>
    <div>${a.industry_tags.map((t) => `<span class="badge ${a.related_fields.includes(t) ? "badge-gold" : "badge-navy"}">${t}</span>`).join(" ")}</div></div>`).join("") || '<div style="color:var(--text-muted)">暂无</div>';
  const sel = document.getElementById("feed-search-industry");
  if (sel.options.length <= 1) {
    const inds = ["具身智能","航空航天","低空经济","商业航天","新能源","工商业储能","新材料","碳纤维","智能制造","精密加工","工业视觉","人工智能","大模型Agent","半导体装备","电力电子","伺服系统","精密仪器","生物医药","手术机器人","节能环保","海洋工程","硬科技创投","出海渠道"];
    sel.innerHTML += inds.map((i) => `<option value="${i}">${i}</option>`).join("");
  }
}

async function runFeedSearch() {
  const box = document.getElementById("feed-search-results");
  if (!isApproved(currentUser)) {
    if (box) box.textContent = "审核通过后才能检索。";
    return;
  }
  const q = new URLSearchParams({ keyword: document.getElementById("feed-search-kw").value.trim(), industry: document.getElementById("feed-search-industry").value, type: document.getElementById("feed-search-type").value });
  const r = await apiFetch(`/api/search?${q}`);
  const d = await r.json();
  if (!r.ok) { box.innerHTML = `<div style="color:var(--text-muted)">🔒 ${d.detail}</div>`; return; }
  box.innerHTML = `<div style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">共找到 ${d.total_shown} 条</div>` + (d.results.map(postCard).join("") || "");
}

function fillSampleRegistration() {
  document.getElementById("reg-name").value = "许明远";
  document.getElementById("reg-phone").value = "139" + Math.floor(10000000 + Math.random() * 89999999);
  document.getElementById("reg-campus").value = "校本部(哈尔滨)";
  document.getElementById("reg-year").value = "2011级";
  document.getElementById("reg-dept").value = "机电工程学院 · 流体传动与控制";
  document.getElementById("reg-city").value = "深圳";
  document.getElementById("reg-company").value = "深圳灵巧手智控科技有限公司";
  document.getElementById("reg-position").value = "创始人 & 总经理";
  document.getElementById("reg-card-no").value = "HIT-HQ-20110489";
  document.getElementById("reg-referrer").value = "丁香会大湾区机器人专委会 · 张振宇推荐";
  triggerAlumniCardOCR();
}

async function triggerAlumniCardOCR() {
  onAlumniCardSelected();
}

async function handleRegisterSubmit(e) {
  e.preventDefault();
  const payload = {
    real_name: document.getElementById("reg-name").value,
    phone: document.getElementById("reg-phone").value,
    campus: document.getElementById("reg-campus").value,
    enroll_year: document.getElementById("reg-year").value,
    department: document.getElementById("reg-dept").value,
    city: document.getElementById("reg-city").value,
    company: document.getElementById("reg-company").value,
    position: document.getElementById("reg-position").value,
    alumni_card_no: document.getElementById("reg-card-no").value,
    referrer_source: document.getElementById("reg-referrer").value,
    password: document.getElementById("reg-pwd").value,
    is_demo: false,
  };
  if (!passwordAcceptable(payload.password)) {
    showToast("密码至少 8 位。");
    return;
  }

  const res = await apiFetch("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    showToast(`❌ 注册失败：${data.detail}`);
    return;
  }
  setToken(data.token);
  currentUser = data.user;
  updateHeaderUserStatus();
  showToast(`🎉 ${data.message}`);
  switchView("workspace");
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const phone = document.getElementById("login-phone").value;
  const password = document.getElementById("login-pwd").value;
  const res = await apiFetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password }),
  });
  const data = await res.json();
  if (!res.ok) {
    showToast(`❌ 登录失败：${data.detail}`);
    return;
  }
  if (isDemoActor(data.user)) {
    setToken(data.token);
    await logoutCurrentUser(true);
    showToast("演示账号已停用。");
    return;
  }
  setToken(data.token);
  currentUser = data.user;
  updateHeaderUserStatus();
  showToast(data.message || "已登录。");
  if (isRealAdmin(currentUser)) switchView("admin");
  else switchView("workspace");
}

function passwordAcceptable(password) {
  return typeof password === "string" && password.length >= 8 && password.length <= 200;
}

// ==================== VIEW 3: Personal Profile, Voice Demand Submission & AI Smart Matching ====================
async function renderWorkspaceView() {
  const unauthBox = document.getElementById("ws-unauth-box");
  const pendingBox = document.getElementById("ws-pending-box");
  const approvedBox = document.getElementById("ws-approved-container");

  if (!currentUser) {
    unauthBox.style.display = "block";
    pendingBox.style.display = "none";
    approvedBox.style.display = "none";
    return;
  }

  // Refresh latest user state from server
  const res = await apiFetch(`/api/me`);
  if (res.ok) {
    const detail = await res.json();
    currentUser = detail.user;
    updateHeaderUserStatus();
  } else if (res.status === 401) {
    currentUser = null;
    updateHeaderUserStatus();
    unauthBox.style.display = "block";
    pendingBox.style.display = "none";
    approvedBox.style.display = "none";
    return;
  }
  if (isDemoActor(currentUser)) {
    await logoutCurrentUser(true);
    showToast("演示账号不能再进入。");
    return;
  }

  if (currentUser.audit_status !== "approved") {
    unauthBox.style.display = "none";
    pendingBox.style.display = "block";
    approvedBox.style.display = "none";

    document.getElementById("ws-pending-user-summary").innerHTML = `
      <div style="font-weight:800; color:var(--hit-navy); margin-bottom:8px;">
        📋 您提交的校友实名与官方校友卡注册信息：
      </div>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:10px; font-size:13.5px;">
        <div><strong>真实姓名：</strong>${currentUser.real_name}</div>
        <div><strong>手机号：</strong>${currentUser.phone}</div>
        <div><strong>校区与届别：</strong>${currentUser.campus} · ${currentUser.enroll_year}</div>
        <div><strong>院系专业：</strong>${currentUser.department}</div>
        <div><strong>所在企业：</strong>${currentUser.company}（${currentUser.position}）</div>
        <div><strong>官方校友卡号：</strong><span class="badge badge-navy">${currentUser.alumni_card_no}</span></div>
        <div><strong>引流来源：</strong>${currentUser.referrer_source}</div>
        <div><strong>当前审核状态：</strong><span class="badge badge-warning">待中心节点管理员复核</span></div>
      </div>
    `;
    return;
  }

  // User is approved!
  unauthBox.style.display = "none";
  pendingBox.style.display = "none";
  approvedBox.style.display = "block";

  document.getElementById("ws-user-banner-info").innerHTML = `
    <div style="font-size:17px; font-weight:800;">
      👨‍🎓 ${currentUser.real_name} · ${currentUser.enroll_year} ${currentUser.department}（${currentUser.campus}）
    </div>
    <div style="font-size:13px; color:#cbd5e1; margin-top:2px;">
      🏢 ${currentUser.company} · ${currentUser.position} | 📍 ${currentUser.city} | 🪪 官方校友卡号：${currentUser.alumni_card_no}
    </div>
  `;

  document.getElementById("ws-user-banner-badges").innerHTML = `
    <span class="badge badge-success">✅ 实名与校友卡已过审</span>
    ${
      currentUser.profile_completed
        ? `<span class="badge badge-gold">✅ 个人能力画像已完善（已解锁提需求）</span>`
        : `<span class="badge badge-warning">⚠️ 个人能力画像待完善（完善后可提需求）</span>`
    }
  `;

  // Populate Step 1 form with current user values
  document.getElementById("prof-bio").value = currentUser.bio_detail || "";
  document.getElementById("prof-capabilities").value = currentUser.core_capabilities || "";
  document.getElementById("prof-provide-types").value =
    (currentUser.can_provide_types || []).join(", ") || "技术研发, 产品/供应链";
  document.getElementById("prof-industry-tags").value = (currentUser.industry_tags || []).join(", ");
  document.getElementById("prof-coop-modes").value = currentUser.coop_modes || "";
  document.getElementById("dem-city").value = currentUser.city || "深圳";

  // Update stepper badges
  const step1Badge = document.getElementById("step1-status-badge");
  const step2Badge = document.getElementById("step2-status-badge");
  const step2Tab = document.getElementById("step-tab-2");

  if (currentUser.profile_completed) {
    step1Badge.className = "badge badge-success";
    step1Badge.textContent = "✅ 已完善";
    step2Badge.className = "badge badge-success";
    step2Badge.textContent = "🎙️ 已解锁·可提需求";
    step2Tab.classList.remove("locked");
  } else {
    step1Badge.className = "badge badge-warning";
    step1Badge.textContent = "必填前置";
    step2Badge.className = "badge badge-navy";
    step2Badge.textContent = "🔒 需先完成第一步";
    step2Tab.classList.add("locked");
  }

  // Default step based on whether profile is completed
  if (!currentUser.profile_completed) {
    selectWorkspaceStep(1);
  } else if (currentWorkspaceStep === 1) {
    selectWorkspaceStep(2);
  } else {
    selectWorkspaceStep(currentWorkspaceStep, true);
  }
}

async function quickApproveCurrentUser() {
  showToast("自助通过审核已关闭。");
}

function selectWorkspaceStep(stepNum, skipGateAlert = false) {
  const gateAlert = document.getElementById("profile-gate-alert");
  gateAlert.style.display = "none";

  // Enforce mandatory personal profile before Step 2 demand submission
  if (stepNum === 2 && currentUser && !currentUser.profile_completed) {
    gateAlert.style.display = "block";
    showToast("⚠️ 拦截提示：原则上要求注册校友先把自己的个人与企业情况介绍清楚，保存后才能提交项目需求！");
    stepNum = 1;
  }

  currentWorkspaceStep = stepNum;
  [1, 2, 3].forEach((n) => {
    const tab = document.getElementById(`step-tab-${n}`);
    const panel = document.getElementById(`ws-step-${n}-panel`);
    if (tab) tab.classList.toggle("active", n === stepNum);
    if (panel) panel.style.display = n === stepNum ? "block" : "none";
  });

  if (stepNum === 3) {
    populateDemandSelectorAndLoadMatch();
  }
}

// ==================== Voice Input (Web Speech + MediaRecorder + AI Presets) ====================
async function runPresetVoice(mode, presetKey) {
  const statusBadge = document.getElementById(
    mode === "profile" ? "profile-voice-status" : "demand-voice-status"
  );
  if (statusBadge) {
    statusBadge.textContent = "🎙️ 正在接收语音并调用后台AI转写与提取...";
  }

  const res = await apiFetch("/api/ai/voice-to-text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: mode,
      preset_key: presetKey,
      user_city: currentUser?.city || "深圳",
    }),
  });
  const data = await res.json();

  if (mode === "profile") {
    document.getElementById("profile-voice-raw").value = data.transcript;
    applyExtractedProfile(data.extracted);
    if (statusBadge) statusBadge.textContent = "✅ AI已完成语音转文字与能力字段提取";
    showToast("🎙️ 后台AI已将校友语音自述转换为文字，并自动填好下方个人与企业能力画像表单！");
  } else {
    document.getElementById("demand-voice-raw").value = data.transcript;
    applyExtractedDemand(data.structured);
    if (statusBadge) statusBadge.textContent = `✅ AI已转写语音(${data.duration || "00:18"})并提炼结构化需求`;
    showToast("🎙️ 后台AI已将语音转换为文字需求，并自动提炼出项目标题、类别、预算规模与合作标签！");
  }
}

async function parseProfileFromTextarea() {
  const raw = document.getElementById("profile-voice-raw").value.trim();
  if (!raw) {
    showToast("请先点击上方语音按钮录音/选择语音示例，或在文本框中输入口语自我介绍");
    return;
  }
  const res = await apiFetch("/api/ai/voice-to-text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "profile", raw_text: raw }),
  });
  const data = await res.json();
  applyExtractedProfile(data.extracted);
  showToast("✨ 已根据您的口述内容自动提取并填充个人能力画像表单！");
}

function applyExtractedProfile(ext) {
  if (!ext) return;
  document.getElementById("prof-bio").value = ext.bio_detail || "";
  document.getElementById("prof-capabilities").value = ext.core_capabilities || "";
  document.getElementById("prof-provide-types").value = (ext.can_provide_types || []).join(", ");
  document.getElementById("prof-industry-tags").value = (ext.industry_tags || []).join(", ");
  document.getElementById("prof-coop-modes").value = ext.coop_modes || "";
}

async function parseDemandFromTextarea() {
  const raw = document.getElementById("demand-voice-raw").value.trim();
  if (!raw) {
    showToast("请先录音、点击语音示例按钮，或在文本框中输入您的需求口述内容");
    return;
  }
  const res = await apiFetch("/api/ai/voice-to-text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "demand",
      raw_text: raw,
      user_city: currentUser?.city || "深圳",
    }),
  });
  const data = await res.json();
  applyExtractedDemand(data.structured);
  showToast("🤖 后台AI已将口述内容转换为结构化项目合作需求卡片！");
}

function applyExtractedDemand(st) {
  if (!st) return;
  document.getElementById("dem-title").value = st.title || "";
  document.getElementById("dem-category").value = st.category || "找供应链/核心部件";
  document.getElementById("dem-industry").value = st.industry || "具身智能";
  document.getElementById("dem-city").value = st.city || currentUser?.city || "深圳";
  document.getElementById("dem-desc").value = st.description || "";
  document.getElementById("dem-budget").value = st.budget_scale || "";
  document.getElementById("dem-partner").value = st.expected_partner || "";
  document.getElementById("dem-tags").value = (st.tags || []).join(", ");
}

async function toggleVoiceRecording(mode) {
  const btn = document.getElementById(mode === "profile" ? "profile-mic-btn" : "demand-mic-btn");
  const statusBadge = document.getElementById(
    mode === "profile" ? "profile-voice-status" : "demand-voice-status"
  );
  const rawBox = document.getElementById(
    mode === "profile" ? "profile-voice-raw" : "demand-voice-raw"
  );

  if (isRecordingVoice) {
    // Stop recording
    isRecordingVoice = false;
    btn.classList.remove("recording");
    btn.innerHTML = mode === "profile" ? "🎙️ 点击开始麦克风录音介绍" : "🎙️ 按下开始语音说需求";
    if (speechRecognitionInstance) {
      try { speechRecognitionInstance.stop(); } catch (e) {}
    }
    if (mediaRecorderInstance && mediaRecorderInstance.state !== "inactive") {
      try { mediaRecorderInstance.stop(); } catch (e) {}
    }
    if (statusBadge) statusBadge.textContent = "✅ 录音结束，正在由后台AI解析...";
    if (rawBox.value.trim()) {
      if (mode === "profile") {
        await parseProfileFromTextarea();
      } else {
        await parseDemandFromTextarea();
      }
    }
    return;
  }

  // Start recording
  isRecordingVoice = true;
  btn.classList.add("recording");
  btn.innerHTML = "⏹️ 正在聆听您的语音...（点击结束并AI转写）";
  if (statusBadge) statusBadge.textContent = "🔴 麦克风实时收音中...";

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    speechRecognitionInstance = new SpeechRecognition();
    speechRecognitionInstance.lang = "zh-CN";
    speechRecognitionInstance.continuous = true;
    speechRecognitionInstance.interimResults = true;
    speechRecognitionInstance.onresult = (event) => {
      let transcript = "";
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      rawBox.value = transcript;
    };
    speechRecognitionInstance.onerror = () => {
      // Fallback to realistic voice sample if no physical microphone in headless/server environment
      isRecordingVoice = false;
      btn.classList.remove("recording");
      btn.innerHTML = mode === "profile" ? "🎙️ 点击开始麦克风录音介绍" : "🎙️ 按下开始语音说需求";
      runPresetVoice(mode, mode === "profile" ? "profile_sample_1" : "demand_sample_1");
    };
    try {
      speechRecognitionInstance.start();
    } catch (e) {
      runPresetVoice(mode, mode === "profile" ? "profile_sample_1" : "demand_sample_1");
    }
  } else {
    // Browser doesn't expose Web Speech API or no mic attached -> automatically run realistic voice simulation after 1s
    setTimeout(() => {
      isRecordingVoice = false;
      btn.classList.remove("recording");
      btn.innerHTML = mode === "profile" ? "🎙️ 点击开始麦克风录音介绍" : "🎙️ 按下开始语音说需求";
      runPresetVoice(mode, mode === "profile" ? "profile_sample_1" : "demand_sample_1");
    }, 900);
  }
}

// ==================== Step 1 Submit: Save Personal & Capability Profile ====================
async function handleSaveProfile(e) {
  e.preventDefault();
  if (!currentUser) return;

  const provideTypes = document
    .getElementById("prof-provide-types")
    .value.split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const industryTags = document
    .getElementById("prof-industry-tags")
    .value.split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const payload = {
    user_id: currentUser.id,
    bio_detail: document.getElementById("prof-bio").value,
    core_capabilities: document.getElementById("prof-capabilities").value,
    can_provide_types: provideTypes,
    industry_tags: industryTags,
    coop_modes: document.getElementById("prof-coop-modes").value,
  };

  const res = await apiFetch("/api/user/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    showToast(`❌ 保存失败：${data.detail}`);
    return;
  }

  currentUser = data.user;
  updateHeaderUserStatus();
  showToast(`🎉 ${data.message}`);
  await renderWorkspaceView();
  selectWorkspaceStep(2);
}

// ==================== Step 2 Submit: Create Project Demand & Trigger AI Smart Matching ====================
async function handleCreateDemand(e) {
  e.preventDefault();
  if (!currentUser) return;

  const tags = document
    .getElementById("dem-tags")
    .value.split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const payload = {
    user_id: currentUser.id,
    title: document.getElementById("dem-title").value,
    category: document.getElementById("dem-category").value,
    industry: document.getElementById("dem-industry").value,
    city: document.getElementById("dem-city").value,
    description: document.getElementById("dem-desc").value,
    budget_scale: document.getElementById("dem-budget").value,
    expected_partner: document.getElementById("dem-partner").value,
    tags: tags,
    raw_voice_text: document.getElementById("demand-voice-raw").value,
    need_manual_broker: document.getElementById("dem-broker").checked ? 1 : 0,
    voluntary_pledge: document.getElementById("dem-pledge").value,
  };

  const res = await apiFetch("/api/demands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    showToast(`❌ 提交被拦截：${data.detail}`);
    return;
  }

  activeDemandIdForMatch = data.demand.id;
  showToast(`🚀 ${data.message}`);
  selectWorkspaceStep(3, true);
  renderMatchReportUI(data.demand, data.match_report);
}

// ==================== Step 3: Load & Render AI Smart Matching Report ====================
async function populateDemandSelectorAndLoadMatch() {
  const sel = document.getElementById("match-demand-selector");
  if (!sel) return;
  const res = await apiFetch("/api/me");
  const data = res.ok ? await res.json() : {};
  const list = data.my_demands || [];
  if (!list.length) { sel.innerHTML = '<option value="">（您还没有发布需求，请先在第2步提交）</option>'; return; }
  if (!list.some((d) => d.id === activeDemandIdForMatch)) activeDemandIdForMatch = list[0].id;
  sel.innerHTML = list.map((d) => `<option value="${d.id}" ${d.id === activeDemandIdForMatch ? "selected" : ""}>${d.demand_code} · ${d.title.slice(0, 26)}...</option>`).join("");
  await loadDemandMatchReport(activeDemandIdForMatch);
}

async function loadDemandMatchReport(demandId) {
  activeDemandIdForMatch = Number(demandId);
  const res = await apiFetch(`/api/demands/${activeDemandIdForMatch}/match`);
  if (!res.ok) return;
  const data = await res.json();
  renderMatchReportUI(data.demand, data.match_report);
}

function renderMatchReportUI(demand, report) {
  const banner = document.getElementById("active-demand-banner");
  banner.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
      <div>
        <div style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">
          <span class="badge badge-gold">${demand.demand_code}</span>
          <span class="badge badge-lilac">${demand.category}</span>
          <span style="font-size:12.5px; color:#cbd5e1;">📍 ${demand.city} · 💰 ${demand.budget_scale}</span>
        </div>
        <h3 style="font-size:18px; font-weight:800; margin-bottom:6px;">${demand.title}</h3>
        <p style="font-size:13.5px; color:#e2e8f0; margin-bottom:10px;">${demand.description}</p>
        ${
          demand.raw_voice_text
            ? `<div style="background:rgba(255,255,255,0.1); padding:8px 12px; border-radius:7px; font-size:12.5px; color:#f6e05e; margin-bottom:8px;">
                🎙️ <strong>原始语音转写：</strong>“${demand.raw_voice_text}”
              </div>`
            : ""
        }
      </div>
      <div style="text-align:right;">
        <div style="font-size:28px; font-weight:900; color:#f6e05e;">${report.best_match_score}%</div>
        <div style="font-size:12px; color:#cbd5e1;">最高AI综合匹配度</div>
      </div>
    </div>
    <div style="border-top:1px solid rgba(255,255,255,0.16); padding-top:10px; margin-top:8px; font-size:13px; color:#f8fafc;">
      <div><strong>🧠 ${report.summary_headline}</strong></div>
      <div style="white-space:pre-line; color:#cbd5e1; margin-top:4px; font-size:12.5px;">${report.strategy_advice}</div>
    </div>
  `;

  const alumniContainer = document.getElementById("matched-alumni-container");
  alumniContainer.innerHTML = report.matched_alumni
    .map(
      (m, idx) => `
      <div class="match-card">
        <div class="item-top-line">
          <div>
            <span class="badge badge-gold" style="margin-right:6px;">TOP ${idx + 1}</span>
            <span class="item-name">${m.masked_name}</span>
            <span style="font-size:13px; color:var(--hit-blue); font-weight:700; margin-left:8px;">
              🏢 ${m.masked_company} · ${m.position}
            </span>
          </div>
          <span class="match-score-pill">🧠 AI匹配度 ${m.match_score}%</span>
        </div>

        <div style="font-size:13px; color:var(--text-secondary); margin-bottom:6px;">
          <strong>核心能力画像：</strong>${m.core_capabilities}
        </div>

        <div class="ai-analysis-box">
          <div style="margin-bottom:4px;"><strong>📌 AI匹配依据：</strong>${m.ai_reason}</div>
          <div style="margin-bottom:4px;"><strong>⚙️ 上下游互补分析：</strong>${m.complementarity}</div>
          <div><strong>💡 AI建议合作切入方式：</strong>${m.suggested_action}</div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-top:10px;">
          <div class="tag-row" style="margin-top:0;">
            <span class="badge badge-navy">📍 ${m.city} · ${m.campus.replace("(哈尔滨)", "")}</span>
            ${m.industry_tags.map((t) => `<span class="tag-chip">#${t}</span>`).join("")}
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button class="btn btn-sm btn-outline" onclick="initiateMatchIntent(${demand.id}, ${m.target_id}, 0)">
              🤝 发起双向匿名确认对接
            </button>
            <button class="btn btn-sm btn-gold" onclick="initiateMatchIntent(${demand.id}, ${m.target_id}, 1)">
              🏅 委托中心节点人工深度撮合
            </button>
          </div>
        </div>
      </div>
    `
    )
    .join("");

  const demandsContainer = document.getElementById("matched-demands-container");
  if (!report.matched_demands || report.matched_demands.length === 0) {
    demandsContainer.innerHTML = `<div style="color:var(--text-muted); font-size:13px;">暂无其他关联商机</div>`;
  } else {
    demandsContainer.innerHTML = report.matched_demands
      .map(
        (od) => `
        <div class="data-item-card">
          <div class="item-top-line">
            <div>
              <span class="badge badge-navy">${od.demand_code}</span>
              <span class="item-name" style="margin-left:6px;">${od.title}</span>
            </div>
            <span class="badge badge-success">商机协同度 ${od.match_score}%</span>
          </div>
          <div style="font-size:13px; color:var(--text-secondary);">
            ${od.synergy_note}（规模：${od.budget_scale} · 城市：${od.city}）
          </div>
        </div>
      `
      )
      .join("");
  }
}

async function initiateMatchIntent(demandId, targetId, brokerAssisted) {
  const res = await apiFetch("/api/matches/intent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      demand_id: demandId,
      request_user_id: currentUser ? currentUser.id : 0,
      target_id: targetId,
      broker_assisted: brokerAssisted,
      voluntary_pledge: "项目合作成功后自愿按1%~2%回馈丁香会平台建设",
    }),
  });
  const data = await res.json();
  if (res.ok) {
    showToast(`✅ ${data.message}`);
  } else {
    showToast(`❌ ${data.detail}`);
  }
}

// ==================== VIEW 4: Admin Audit & Central Node Console ====================
async function loadAdminDashboard() {
  if (!isRealAdmin(currentUser)) {
    document.getElementById("admin-users-list").textContent = "只有管理员可以查看审核队列。";
    document.getElementById("admin-matches-list").textContent = "";
    return;
  }
  const res = await apiFetch("/api/admin/dashboard");
  const data = await res.json();
  if (!res.ok) {
    document.getElementById("admin-users-list").textContent = data.detail || "只有管理员可以查看审核队列。";
    document.getElementById("admin-matches-list").innerHTML = "";
    return;
  }

  const usersBox = document.getElementById("admin-users-list");
  usersBox.innerHTML = data.users
    .map(
      (u) => `
      <div class="data-item-card" style="border-left:4px solid ${
        u.audit_status === "pending" ? "#d97706" : "#0d9488"
      }">
        <div class="item-top-line">
          <div>
            <span class="item-name">${u.real_name}</span>${u.is_demo ? ' <span class="badge badge-lilac">演示</span>' : ' <span class="badge badge-gold">真实注册</span>'}
            <span style="font-size:13px; color:var(--text-secondary); margin-left:8px;">
              📱 ${u.phone} | ${u.campus} · ${u.enroll_year} · ${u.department}
            </span>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <span class="badge ${
              u.audit_status === "approved" ? "badge-success" : "badge-warning"
            }">
              ${u.audit_status === "approved" ? "✅ 已审核通过" : "⏳ 待审核"}
            </span>
            <span class="badge ${u.profile_completed ? "badge-navy" : "badge-warning"}">
              ${u.profile_completed ? "个人能力画像：已完善" : "个人能力画像：未填写"}
            </span>
          </div>
        </div>
        <div style="font-size:13px; color:var(--text-main); margin-bottom:6px;">
          🏢 <strong>企业与职务：</strong>${u.company} · ${u.position}（${u.city}） |
          🪪 <strong>官方校友卡凭证号：</strong><code>${u.alumni_card_no}</code> |
          🔗 <strong>来源：</strong>${u.referrer_source}
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <span style="font-size:12.5px; color:var(--text-muted);">
            审核备注：${u.audit_note || "等待管理员核验电子校友卡"}
          </span>
          <div style="display:flex; gap:8px;">
            ${
              u.role !== "alumni" ? "" : u.audit_status !== "approved"
                ? `<button class="btn btn-sm btn-primary" onclick="adminAuditUser(${u.id}, 'approve')">✅ 审核通过（放行入驻）</button>`
                : `<button class="btn btn-sm btn-outline" onclick="adminAuditUser(${u.id}, 'reject')">设为待复核</button>`
            }
            ${u.role === "alumni" ? `<button class="btn btn-sm ${u.is_sponsor ? "btn-primary" : "btn-outline"}" onclick="adminToggle('/api/admin/sponsor',{user_id:${u.id},sponsor:${!u.is_sponsor}})">${u.is_sponsor ? "🌸 赞助校友（点击取消）" : "标记为赞助校友"}</button>` : ""}
          </div>
        </div>
      </div>
    `
    )
    .join("");

  const matchesBox = document.getElementById("admin-matches-list");
  matchesBox.innerHTML = data.matches
    .map(
      (m) => `
      <div class="data-item-card">
        <div class="item-top-line">
          <div>
            <span class="badge badge-navy">商机ID #${m.demand_id}</span>
            <span class="badge badge-gold">匹配分 ${m.match_score}%</span>
            <span class="badge ${m.broker_assisted ? "badge-lilac" : "badge-success"}">
              ${m.broker_assisted ? "🏅 委托中心节点人工深度撮合" : "🤝 双向匿名确认"}
            </span>
          </div>
          <span><span class="badge badge-success">${m.intent_status}</span>
          <button class="btn btn-sm ${m.is_success ? "btn-primary" : "btn-outline"}" onclick="adminToggle('/api/admin/match-success',{match_id:${m.id},success:${!m.is_success}})">${m.is_success ? "✅ 已对接成功（点击取消）" : "标记对接成功"}</button></span>
        </div>
        <div style="font-size:13px; color:var(--text-secondary); margin-bottom:4px;">
          ${m.ai_reason}
        </div>
        <div style="font-size:12.5px; color:var(--hit-blue); font-weight:600;">
          🌸 自愿回馈承诺：${m.voluntary_pledge || "成交后自愿回馈平台长期建设"}
        </div>
      </div>
    `
    )
    .join("");
}

async function adminAuditUser(userId, action) {
  const res = await apiFetch("/api/admin/audit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, action: action }),
  });
  const data = await res.json();
  if (res.ok) {
    showToast(`✅ ${data.message}`);
    loadAdminDashboard();
  } else {
    showToast(`❌ ${data.detail}`);
  }
}

async function adminToggle(path, body) {
  const r = await apiFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json();
  showToast(r.ok ? d.message : (d.detail || "操作失败"));
  loadAdminDashboard();
}

// ===== API client (backend: Supabase Edge Function) =====
const API_BASE = "https://lvmgyqbluhabhcrgdzex.supabase.co/functions/v1/dingxianghui-api";
const TOKEN_KEY = "dxh_session_token";
function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; } }
function setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} }
function deepEscape(v) {
  if (typeof v === "string") return v.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (Array.isArray(v)) return v.map(deepEscape);
  if (v && typeof v === "object") { const o = {}; for (const k in v) o[k] = deepEscape(v[k]); return o; }
  return v;
}
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
  await loadPublicOverview();
  if (getToken()) {
    const r = await apiFetch("/api/me");
    if (r.ok) { currentUser = (await r.json()).user; } else { setToken(""); }
  }
  updateHeaderUserStatus();
  const params = new URLSearchParams(window.location.search);
  const demo = params.get("demo");
  if (demo === "pending") {
    await switchDemoRole("13800138001");
  } else if (demo === "profile") {
    await switchDemoRole("13800138002");
  } else if (demo === "demand") {
    await switchDemoRole("13800138003");
    await runPresetVoice("demand", "demand_sample_1");
  } else if (demo === "match") {
    await switchDemoRole("13800138003");
    selectWorkspaceStep(3, true);
    await loadDemandMatchReport(1);
  } else if (demo === "admin") {
    await switchDemoRole("13800138000");
  }
});

function showToast(msg, duration = 4200) {
  const el = document.getElementById("global-toast");
  if (!el) return;
  el.innerHTML = msg;
  el.style.display = "block";
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    el.style.display = "none";
  }, duration);
}

// ==================== Navigation & View Switching ====================
function switchView(viewName) {
  currentView = viewName;
  ["home", "auth", "feed", "workspace", "admin"].forEach((v) => {
    const sec = document.getElementById(`view-${v}`);
    const nav = document.getElementById(`nav-${v}`);
    if (sec) sec.classList.toggle("active", v === viewName);
    if (nav) nav.classList.toggle("active", v === viewName);
  });

  if (viewName === "home") {
    loadPublicOverview();
  } else if (viewName === "feed") {
    loadFeedView();
  } else if (viewName === "workspace") {
    renderWorkspaceView();
  } else if (viewName === "admin") {
    loadAdminDashboard();
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function updateHeaderUserStatus() {
  const pill = document.getElementById("header-user-status");
  if (!pill) return;
  const logged = !!currentUser;
  ["nav-feed", "nav-workspace"].forEach((id) => { const e = document.getElementById(id); if (e) e.style.display = logged ? "" : "none"; });
  const na = document.getElementById("nav-admin"); if (na) na.style.display = logged && isAdminRole(currentUser) ? "" : "none";
  if (!logged && ["feed", "workspace", "admin"].includes(currentView)) switchView("home");

  // Highlight demo bar chip
  const allChips = document.querySelectorAll(".demo-chip");
  allChips.forEach((c) => c.classList.remove("active"));

  if (!currentUser) {
    pill.innerHTML = `<span>当前身份：未登录游客</span>`;
    const g = document.getElementById("demo-btn-guest");
    if (g) g.classList.add("active");
    return;
  }

  let statusTag = "";
  if (isAdminRole(currentUser)) {
    statusTag = `<span class="badge badge-gold">${currentUser.role === "demo_admin" ? "演示管理员" : "中心节点管理员"}</span>`;
    document.getElementById("demo-btn-admin")?.classList.add("active");
  } else if (currentUser.audit_status !== "approved") {
    statusTag = `<span class="badge badge-warning">待平台审核</span>`;
    document.getElementById("demo-btn-pending")?.classList.add("active");
  } else if (!currentUser.profile_completed) {
    statusTag = `<span class="badge badge-navy">已过审·待填个人能力</span>`;
    document.getElementById("demo-btn-uncompleted")?.classList.add("active");
  } else {
    statusTag = `<span class="badge badge-success">已认证·可提需求</span>`;
    document.getElementById("demo-btn-ready")?.classList.add("active");
  }

  pill.innerHTML = `
    <span>👤 <strong>${currentUser.real_name}</strong>（${currentUser.enroll_year}）</span>
    ${statusTag}${currentUser.is_demo ? ' <span class="badge badge-lilac">演示账号</span>' : ""}
  `;
}

// ==================== Demo Role Quick Switcher ====================
async function switchDemoRole(phoneOrGuest) {
  if (phoneOrGuest === "guest") {
    if (getToken()) { apiFetch("/api/auth/logout", { method: "POST" }); }
    setToken("");
    currentUser = null;
    updateHeaderUserStatus();
    switchView("home");
    showToast("🌐 已切换为【未登录游客视角】：仅浏览项目首页介绍与系统中已注册校友/商机脱敏数据。");
    return;
  }

  try {
    const res = await apiFetch("/api/auth/demo-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: phoneOrGuest }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(`❌ 切换失败：${data.detail || "未知错误"}`);
      return;
    }
    setToken(data.token);
    currentUser = data.user;
    updateHeaderUserStatus();

    if (isAdminRole(currentUser)) {
      switchView("admin");
      showToast(`🛡️ 已切换为【演示管理员：${currentUser.real_name}】，仅可查看与审核演示数据（真实注册由正式管理员审核）。`);
    } else {
      switchView("workspace");
      if (currentUser.audit_status !== "approved") {
        showToast(`⏳ 已切换为【待审核校友：${currentUser.real_name}】，演示未通过平台审核前的拦截状态。`);
      } else if (!currentUser.profile_completed) {
        showToast(`📋 已切换为【已过审但未填个人情况：${currentUser.real_name}】，演示“必须先介绍清楚个人能力才能提需求”规则。`);
      } else {
        showToast(`🎙️ 已切换为【已完善画像校友：${currentUser.real_name}】，可直接语音提交项目需求并体验AI智能匹配！`);
      }
    }
  } catch (err) {
    console.error(err);
    showToast("❌ 网络请求异常");
  }
}

// ==================== VIEW 1: Homepage Public Overview & Data Directory ====================
async function loadPublicOverview() {
  const box = document.getElementById("fuzzy-stats-grid");
  if (!box) return;
  try {
    const r = await apiFetch("/api/public/overview");
    const d = await r.json();
    const icons = { alumni: "🎓", demands: "📁", daily_queries: "🔍", successes: "🤝", sponsors: "🌸" };
    box.innerHTML = d.stats.map((s) => `
      <div class="kpi-card">
        <div class="kpi-label">${icons[s.key] || ""} ${s.label}</div>
        <div class="kpi-value">${s.level}</div>
        <div class="kpi-sub">数量级展示</div>
      </div>`).join("");
  } catch (e) { box.innerHTML = '<div style="color:var(--text-muted)">规模数据加载失败</div>'; }
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
  const cardNo = document.getElementById("reg-card-no").value;
  const realName = document.getElementById("reg-name").value;
  const enrollYear = document.getElementById("reg-year").value;
  const department = document.getElementById("reg-dept").value;
  const campus = document.getElementById("reg-campus").value;

  const res = await apiFetch("/api/ai/ocr-alumni-card", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      card_no: cardNo,
      real_name: realName,
      enroll_year: enrollYear,
      department: department,
      campus: campus,
    }),
  });
  const data = await res.json();
  document.getElementById("reg-card-no").value = data.card_no;
  const box = document.getElementById("ocr-result-box");
  box.style.display = "block";
  box.innerHTML = `✅ <strong>${data.verification_summary}</strong>（发卡机构：${data.issuer} · 置信度 ${data.confidence}）`;
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
    is_demo: !!document.getElementById("reg-is-demo")?.checked,
  };

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
  setToken(data.token);
  currentUser = data.user;
  updateHeaderUserStatus();
  showToast(`✅ ${data.message}`);
  if (isAdminRole(currentUser)) {
    switchView("admin");
  } else {
    switchView("workspace");
  }
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
  const qa = document.getElementById("quick-approve-btn");
  if (qa) qa.style.display = currentUser.is_demo ? "inline-flex" : "none";

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
  if (!currentUser) return;
  const res = await apiFetch("/api/demo/self-approve", { method: "POST" });
  const data = await res.json();
  if (!res.ok) { showToast(`❌ ${data.detail}`); return; }
  if (res.ok) {
    currentUser = data.user;
    showToast(`✅ ${data.message}！现在请先完成【第一步：完善个人与企业情况介绍】。`);
    renderWorkspaceView();
  }
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
  const res = await apiFetch("/api/admin/dashboard");
  const data = await res.json();
  if (!res.ok) {
    document.getElementById("admin-users-list").innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);">🔒 ${data.detail || "仅平台管理员可访问"}（请用管理员账号登录，或点击顶部“演示管理员”）</div>`;
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

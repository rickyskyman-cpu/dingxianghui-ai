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

document.addEventListener("DOMContentLoaded", async () => {
  try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  await consumeWechatCallback();
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
  bindCounters();
  await loadChannelStatus();
  if (location.search.includes("demo=")) {
    history.replaceState(null, "", location.pathname);
    showToast("演示入口已关闭。");
  }
});

function showToast(msg, duration = 4200) {
  const region = document.getElementById("global-toast");
  if (!region) return;
  region.innerHTML = "";
  const toast = document.createElement("div");
  toast.className = "dx-toast dx-toast--info";
  toast.textContent = msg == null ? "" : String(msg);
  region.appendChild(toast);
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => { region.innerHTML = ""; }, duration);
}

function setAlert(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg || "";
  el.hidden = !msg;
  if (msg) {
    el.setAttribute("role", "alert");
    el.setAttribute("aria-live", "assertive");
  }
}

function showAuthMode(mode) {
  const login = document.getElementById("auth-login");
  const register = document.getElementById("auth-register");
  if (login) login.hidden = mode !== "login";
  if (register) register.hidden = mode !== "register";
  const focusId = mode === "register" ? "reg-name" : "login-phone";
  const field = document.getElementById(focusId);
  if (field) field.focus();
}

function bindCounters() {
  document.querySelectorAll("textarea[maxlength], input[maxlength]").forEach((el) => {
    const counter = document.getElementById(el.id + "-count");
    if (!counter) return;
    const max = Number(el.getAttribute("maxlength") || 0);
    const update = () => {
      const n = [...el.value].length;
      counter.textContent = n + " / " + max;
      counter.classList.toggle("dx-counter--over", max && n > max);
    };
    if (!el.dataset.counterBound) {
      el.addEventListener("input", update);
      el.dataset.counterBound = "1";
    }
    update();
  });
}

function badgeClass(status) {
  if (status === "approved") return "dx-badge dx-badge--approved";
  if (status === "rejected") return "dx-badge dx-badge--rejected";
  if (status === "amended") return "dx-badge dx-badge--amended";
  return "dx-badge dx-badge--pending";
}

function badgeLabel(status) {
  return { approved: "已通过", rejected: "已驳回", amended: "已补充", pending: "待审核" }[status] || "待审核";
}
function cellsRow(pairs) {
  return `<tr>${pairs.map(([label, html]) => `<td data-label="${esc(label)}">${html}</td>`).join("")}</tr>`;
}
function toggleCardActions(button) {
  const bar = button && button.closest ? button.closest(".dx-card-actions") : null;
  if (!bar) return;
  const open = bar.classList.toggle("is-open");
  button.setAttribute("aria-expanded", open ? "true" : "false");
  button.textContent = open ? "收起操作" : "更多操作";
}

// ==================== Navigation & View Switching ====================
function switchView(viewName) {
  if (["feed", "cases", "inbox", "assist"].includes(viewName) && !isApproved(currentUser)) viewName = currentUser ? "workspace" : "auth";
  if (viewName === "workspace" && !currentUser) viewName = "auth";
  if (viewName === "admin" && !isRealAdmin(currentUser)) viewName = "home";
  currentView = viewName;
  ["home", "auth", "feed", "workspace", "cases", "inbox", "assist", "admin"].forEach((v) => {
    const sec = document.getElementById(`view-${v}`);
    const nav = document.getElementById(`nav-${v}`);
    if (sec) sec.classList.toggle("active", v === viewName);
    if (nav) nav.classList.toggle("active", v === viewName);
  });
  if (viewName === "feed") loadFeedView();
  else if (viewName === "workspace") renderWorkspaceView();
  else if (viewName === "admin") showAdminTab("queue");
  else if (viewName === "cases") loadCases();
  else if (viewName === "inbox") loadInbox();
  else if (viewName === "assist") loadAssists();
  else if (viewName === "auth") { if (window.__keepAuthMode !== "register") showAuthMode("login"); window.__keepAuthMode = null; loadChannelStatus(); }
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
}

function showRegister() {
  window.__keepAuthMode = "register";
  switchView("auth");
  showAuthMode("register");
}

function updateHeaderUserStatus() {
  const pill = document.getElementById("header-user-status");
  const logout = document.getElementById("logout-btn");
  const auth = document.getElementById("nav-auth");
  const feed = document.getElementById("nav-feed");
  const workspace = document.getElementById("nav-workspace");
  const cases = document.getElementById("nav-cases");
  const inbox = document.getElementById("nav-inbox");
  const admin = document.getElementById("nav-admin");
  const approved = isApproved(currentUser);
  if (auth) auth.hidden = true;
  if (feed) feed.hidden = !approved;
  if (workspace) workspace.hidden = !currentUser;
  if (cases) cases.hidden = !approved;
  if (inbox) inbox.hidden = !approved;
  if (admin) admin.hidden = !isRealAdmin(currentUser);
  if (logout) logout.hidden = !currentUser;
  if (!approved) {
    const badge = document.getElementById("inbox-badge");
    if (badge) badge.hidden = true;
  } else refreshUnread();
  if (!pill) return;
  if (!currentUser) {
    pill.textContent = "";
    return;
  }
  const state = isRealAdmin(currentUser)
    ? "管理员"
    : currentUser.audit_status === "rejected"
      ? "已驳回"
      : currentUser.audit_status !== "approved"
        ? "等待审核"
        : currentUser.profile_completed ? "已通过审核" : "已通过审核，资料未完成";
  pill.innerHTML = `<span class="session__name">${esc(currentUser.real_name || "")}</span><span class="session__state">${esc(state)}</span>`;
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

function phoneOk(value) { return /^1\d{10}$/.test(String(value || "").trim()); }
function setBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  button.setAttribute("aria-busy", busy ? "true" : "false");
  if (label) button.textContent = busy ? "处理中" : label;
}
async function loadChannelStatus() {
  const box = document.getElementById("channel-status");
  const r = await apiFetch("/api/auth/channels");
  const d = r.ok ? await r.json() : {};
  window.__channelStatus = d;
  if (box) box.textContent = d.sms || d.wechat_website ? "已开通的方式见下方。未开通的仍显示暂未开通，不能当作严格双因子。" : "微信扫码和短信验证码都未启用。";
  const smsNote = document.getElementById("sms-login-note");
  const smsForm = document.getElementById("sms-login-form");
  const smsDisabled = document.getElementById("sms-login-disabled");
  if (smsNote && smsForm) {
    smsNote.hidden = !!d.sms;
    smsForm.hidden = !d.sms;
    if (!d.sms) smsNote.textContent = "短信验证码登录：暂未开通";
  }
  if (smsDisabled) smsDisabled.hidden = !!d.sms;
  const wxNote = document.getElementById("wechat-login-note");
  const wxLink = document.getElementById("wechat-login-link");
  const wxDisabled = document.getElementById("wechat-login-disabled");
  if (wxNote && wxLink) {
    wxNote.hidden = !!d.wechat_website;
    wxLink.hidden = !d.wechat_website;
    if (!d.wechat_website) wxNote.textContent = "微信扫码登录：暂未开通";
  }
  if (wxDisabled) wxDisabled.hidden = !!d.wechat_website;
  const send = document.getElementById("sms-send");
  if (send && !send.dataset.bound) {
    send.dataset.bound = "1";
    send.addEventListener("click", sendSmsCode);
  }
  if (d.wechat_website) startWechatLogin();
  if (currentUser) renderWechatBind();
}

function tidyAuthQuery() {
  const params = new URLSearchParams(location.search);
  ["code", "state", "error", "error_description", "wechat"].forEach((key) => params.delete(key));
  const qs = params.toString();
  const next = location.pathname + (qs ? `?${qs}` : "") + (location.hash && !location.hash.includes("dxh_") ? location.hash : "");
  history.replaceState(null, "", next || location.pathname);
}

async function consumeWechatCallback() {
  const params = new URLSearchParams(location.search);
  const hash = new URLSearchParams((location.hash || "").replace(/^#/, "").replace(/&/g, "&"));
  const hashToken = hash.get("dxh_session");
  const wechatFlag = hash.get("dxh_wechat");
  const code = params.get("code");
  const state = params.get("state");
  if (!hashToken && !wechatFlag && !code && !state && !params.get("error")) return;
  const finish = (msg) => { tidyAuthQuery(); if (msg) showToast(msg); };
  if (hashToken) {
    setToken(hashToken);
    finish("微信登录已完成。");
    return;
  }
  if (wechatFlag === "bound") { finish("微信已绑定。"); return; }
  if (wechatFlag === "error" || params.get("error")) { finish("微信登录没有完成。"); return; }
  if (code && state) {
    const res = await apiFetch("/api/auth/wechat/callback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, state }) });
    const data = res.ok ? await res.json() : { detail: (await res.json().catch(() => ({}))).detail };
    tidyAuthQuery();
    if (!res.ok) { showToast(data.detail || "微信登录没有完成。"); return; }
    if (data.token) {
      setToken(data.token);
      currentUser = data.user || currentUser;
      showToast(data.message || "微信登录已完成。");
      return;
    }
    if (data.bound && data.user) {
      currentUser = data.user;
      showToast("微信已绑定。");
    }
    return;
  }
  tidyAuthQuery();
}

function onAlumniCardSelected() {
  const input = document.getElementById("reg-card-file");
  const box = document.getElementById("ocr-result-box");
  const file = input && input.files && input.files[0];
  if (!box) return;
  box.hidden = false;
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
  const tags = (p.tags || []).slice(0, 4).map((t) => `<span class="dx-tag">${esc(t)}</span>`).join(" ");
  if (p.owner_id) rememberContext(`${p.owner_id}:${p.id}`, `关于供需「${p.title || ""}」`);
  return `<article class="dx-match-card">
    <div class="dx-match-card__meta"><span class="dx-tag">${esc(p.post_type)}</span><span class="dx-tag">${esc(p.industry)}</span>${p.lifecycle ? `<span class="dx-tag">${esc(p.lifecycle)}</span>` : ""}${tags}</div>
    <h3>${esc(p.title)}${p.is_mine ? ' <span class="dx-badge dx-badge--amended">我发布的</span>' : ""}</h3>
    <p>${esc(p.summary)}</p>
    <p class="dx-help">${esc(p.category)} ｜ ${esc(p.created_at || "")} ｜ ${esc(p.poster)}</p>
    ${p.is_mine ? "" : contactActions(p.owner_id, p.id)}
  </article>`;
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
    postsBox.innerHTML = `<div class="dx-state">${esc(d.detail || "请先登录")}</div>`;
    document.getElementById("feed-alumni").innerHTML = ""; return;
  }
  document.getElementById("feed-my-fields").textContent = d.my_fields.length ? `按您的画像领域推荐：${d.my_fields.join("、")}` : "您尚未完善个人能力画像，以下为最新发布";
  postsBox.innerHTML = d.posts.length ? d.posts.map(postCard).join("") : '<div class="dx-state"><h2>暂无相关领域发布</h2></div>';
  document.getElementById("feed-alumni").innerHTML = d.alumni.map((a) => {
    if (a.user_id) rememberContext(`${a.user_id}:0`, "来自供需页的校友能力");
    return `<article class="dx-match-card">
    <div class="dx-match-card__meta">${(a.industry_tags||[]).map((t)=>`<span class="dx-tag">${esc(t)}</span>`).join(" ")}${a.openness ? `<span class="dx-tag">${esc(a.openness)}</span>` : ""}</div>
    <h3>${esc(a.poster)}</h3>
    <p>${esc(a.capability_summary)}</p>
    <p class="dx-help">${esc(a.city || "")}${a.campus ? " · " + esc(a.campus) : ""}</p>
    ${contactActions(a.user_id, 0)}
  </article>`;
  }).join("") || '<div class="dx-state">暂无</div>';
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
  const q = new URLSearchParams({
    keyword: document.getElementById("feed-search-kw").value.trim(),
    industry: document.getElementById("feed-search-industry").value,
    type: document.getElementById("feed-search-type").value,
    capability: (document.getElementById("feed-search-capability") || {}).value || "",
    city: (document.getElementById("feed-search-city") || {}).value || "",
    campus: (document.getElementById("feed-search-campus") || {}).value || "",
    openness: (document.getElementById("feed-search-openness") || {}).value || "",
  });
  const r = await apiFetch(`/api/search?${q}`);
  const d = await r.json();
  if (!r.ok) { box.innerHTML = `<div class="dx-state">${esc(d.detail || "检索没有完成")}</div>`; return; }
  const people = (d.alumni || []).map((a) => {
    rememberContext(`${a.id}:0`, "来自校友检索");
    return `<article class="dx-match-card">
      <div class="dx-match-card__meta"><span class="dx-tag">${esc(a.openness || "")}</span>${(a.industry_tags || []).map((t) => `<span class="dx-tag">${esc(t)}</span>`).join("")}</div>
      <h3>${esc(a.masked_name)}</h3>
      <p>${esc(a.capability_summary || a.bio_summary || "")}</p>
      <p class="dx-help">${esc(a.city || "")} · ${esc(a.campus || "")} · ${esc(a.position || "")}</p>
      ${a.seeking ? `<p class="dx-help">在找：${esc(a.seeking)}</p>` : ""}
      ${contactActions(a.id, 0)}
    </article>`;
  }).join("");
  box.innerHTML = `<p class="dx-help" role="status">供需 ${d.total_shown || 0} 条，校友 ${d.alumni_shown || 0} 位</p>`
    + (people ? `<h2>校友</h2>${people}` : "")
    + (d.results.length ? d.results.map(postCard).join("") : '<div class="dx-state"><h2>没有符合条件的供需</h2></div>');
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
  const phoneError = document.getElementById("register-error");
  const confirm = document.getElementById("reg-pwd-confirm");
  const confirmErr = document.getElementById("reg-pwd-confirm-error");
  if (!phoneOk(payload.phone)) {
    setAlert("register-error", "请输入11位中国大陆手机号。");
    document.getElementById("reg-phone").focus();
    return;
  }
  if (!passwordAcceptable(payload.password)) {
    setAlert("register-error", "请将密码设置为8到72位。");
    return;
  }
  if (confirm && confirm.value !== payload.password) {
    if (confirmErr) { confirmErr.hidden = false; confirmErr.textContent = "两次输入的密码不一致。"; }
    confirm.focus();
    return;
  }
  if (confirmErr) { confirmErr.hidden = true; confirmErr.textContent = ""; }
  setAlert("register-error", "");
  const submit = document.getElementById("register-submit");
  setBusy(submit, true, "提交注册申请");
  const res = await apiFetch("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  setBusy(submit, false, "提交注册申请");
  if (!res.ok) {
    setAlert("register-error", data.detail || "注册没有完成。");
    return;
  }
  setToken(data.token);
  currentUser = data.user;
  updateHeaderUserStatus();
  showToast(data.message || "已提交，等待审核。");
  switchView("workspace");
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const phone = document.getElementById("login-phone").value;
  const password = document.getElementById("login-pwd").value;
  const error = document.getElementById("login-error");
  if (!phoneOk(phone)) { setAlert("login-error", "请输入11位中国大陆手机号。"); document.getElementById("login-phone").focus(); return; }
  setAlert("login-error", "");
  const submit = document.getElementById("login-submit");
  setBusy(submit, true, "登录");
  const res = await apiFetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password }),
  });
  const data = await res.json();
  setBusy(submit, false, "登录");
  if (!res.ok) {
    setAlert("login-error", data.detail || "登录没有完成。");
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
  return typeof password === "string" && password.length >= 8 && password.length <= 72;
}

// ==================== VIEW 3: Personal Profile, Voice Demand Submission & AI Smart Matching ====================
async function renderWorkspaceView() {
  const unauthBox = document.getElementById("ws-unauth-box");
  const pendingBox = document.getElementById("ws-pending-box");
  const approvedBox = document.getElementById("ws-approved-container");

  const setWs = (mode) => {
    if (unauthBox) unauthBox.hidden = mode !== "unauth";
    if (pendingBox) pendingBox.hidden = mode !== "pending";
    if (approvedBox) approvedBox.hidden = mode !== "approved";
  };
  if (!currentUser) {
    setWs("unauth");
    return;
  }

  // Refresh latest user state from server
  const res = await apiFetch(`/api/me`);
  let myDemands = [];
  if (res.ok) {
    const detail = await res.json();
    currentUser = detail.user;
    myDemands = detail.my_demands || [];
    updateHeaderUserStatus();
  } else if (res.status === 401) {
    currentUser = null;
    updateHeaderUserStatus();
    setWs("unauth");
    return;
  }
  if (isDemoActor(currentUser)) {
    await logoutCurrentUser(true);
    showToast("演示账号不能再进入。");
    return;
  }
  const changeBox = document.getElementById("password-change-box");
  if (changeBox) changeBox.hidden = !currentUser.must_change_password;
  renderWechatBind();

  if (currentUser.audit_status !== "approved") {
    setWs("pending");
    const rejected = currentUser.audit_status === "rejected";
    const badgeWrap = document.getElementById("ws-pending-badge-wrap");
    const title = document.getElementById("ws-pending-title");
    const copy = document.getElementById("ws-pending-copy");
    if (badgeWrap) badgeWrap.innerHTML = `<span class="${badgeClass(rejected ? "rejected" : "pending")}">${badgeLabel(rejected ? "rejected" : "pending")}</span>`;
    if (title) title.textContent = rejected ? "注册申请已驳回" : "注册申请正在审核";
    if (copy) copy.textContent = rejected ? (currentUser.audit_note || "资料需要补充后再提交。审核完成前只能看到品牌介绍与本页。") : "审核完成前只能看到品牌介绍与本页。通过后即可填写能力档案并查看供需。";
    document.getElementById("ws-pending-user-summary").innerHTML = `<dl>
      <div><dt>真实姓名</dt><dd>${esc(currentUser.real_name)}</dd></div>
      <div><dt>手机号</dt><dd>${esc(currentUser.phone)}</dd></div>
      <div><dt>校区与届别</dt><dd>${esc(currentUser.campus)} · ${esc(currentUser.enroll_year)}</dd></div>
      <div><dt>院系专业</dt><dd>${esc(currentUser.department)}</dd></div>
      <div><dt>所在企业</dt><dd>${esc(currentUser.company)}（${esc(currentUser.position)}）</dd></div>
      <div><dt>校友卡编号</dt><dd>${esc(currentUser.alumni_card_no)}</dd></div>
      <div><dt>引流来源</dt><dd>${esc(currentUser.referrer_source)}</dd></div>
    </dl>`;
    return;
  }

  setWs("approved");

  document.getElementById("ws-user-banner-info").innerHTML = `
    <p><strong>${esc(currentUser.real_name)}</strong> · ${esc(currentUser.enroll_year)} ${esc(currentUser.department)}（${esc(currentUser.campus)}）</p>
    <p class="dx-help">${esc(currentUser.company)} · ${esc(currentUser.position)} ｜ ${esc(currentUser.city)}</p>
  `;

  document.getElementById("ws-user-banner-badges").innerHTML = `
    <span class="dx-badge dx-badge--approved">已通过</span>
    ${currentUser.profile_completed ? '<span class="dx-badge dx-badge--approved">能力档案已完善</span>' : '<span class="dx-badge dx-badge--pending">能力档案待完善</span>'}
  `;

  // Populate Step 1 form with current user values
  document.getElementById("prof-bio").value = currentUser.bio_detail || "";
  document.getElementById("prof-capabilities").value = currentUser.core_capabilities || "";
  document.getElementById("prof-provide-types").value =
    (currentUser.can_provide_types || []).join(", ") || "技术研发, 产品/供应链";
  document.getElementById("prof-industry-tags").value = (currentUser.industry_tags || []).join(", ");
  document.getElementById("prof-coop-modes").value = currentUser.coop_modes || "";
  const openness = document.getElementById("prof-openness");
  if (openness) openness.value = currentUser.openness || "开放对接";
  const assign = (id, value) => { const el = document.getElementById(id); if (el) el.value = value || ""; };
  assign("prof-company", currentUser.company);
  assign("prof-position", currentUser.position);
  assign("prof-city", currentUser.city);
  assign("prof-year", currentUser.enroll_year);
  assign("prof-seeking", currentUser.seeking);
  const campus = document.getElementById("prof-campus");
  if (campus && currentUser.campus) {
    if (![...campus.options].some((option) => option.value === currentUser.campus)) {
      const option = document.createElement("option");
      option.value = currentUser.campus;
      option.textContent = currentUser.campus;
      campus.appendChild(option);
    }
    campus.value = currentUser.campus;
  }
  const meta = document.getElementById("profile-meta");
  const score = currentUser.profile_completeness || {};
  if (meta) {
    const when = score.updated_at ? ` · 最近更新 ${String(score.updated_at).slice(0, 16).replace("T", " ")}` : "";
    meta.textContent = `档案完整度 ${score.percent || 0}%（${score.filled || 0}/${score.total || 0}）${when}`;
  }
  renderMyDemands(myDemands);
  document.getElementById("dem-city").value = currentUser.city || "深圳";

  // Update stepper badges
  const step1Badge = document.getElementById("step1-status-badge");
  const step2Badge = document.getElementById("step2-status-badge");
  const step2Tab = document.getElementById("step-tab-2");

  if (currentUser.profile_completed) {
    if (step1Badge) { step1Badge.className = "dx-badge dx-badge--approved"; step1Badge.textContent = "已完善"; }
    if (step2Badge) { step2Badge.className = "dx-badge dx-badge--approved"; step2Badge.textContent = "已解锁"; }
    if (step2Tab) step2Tab.classList.remove("locked");
  } else {
    if (step1Badge) { step1Badge.className = "dx-badge dx-badge--pending"; step1Badge.textContent = "待完善"; }
    if (step2Badge) { step2Badge.className = "dx-badge"; step2Badge.textContent = "待解锁"; }
    if (step2Tab) step2Tab.classList.add("locked");
  }
  bindCounters();

  // Default step based on whether profile is completed
  if (!currentUser.profile_completed) selectWorkspaceStep(1);
  else selectWorkspaceStep(currentWorkspaceStep || 1, true);
}

async function quickApproveCurrentUser() {
  showToast("自助通过审核已关闭。");
}

function selectWorkspaceStep(stepNum, skipGateAlert = false) {
  const gateAlert = document.getElementById("profile-gate-alert");
  if (gateAlert) gateAlert.hidden = true;

  // Enforce mandatory personal profile before Step 2 demand submission
  if (stepNum === 2 && currentUser && !currentUser.profile_completed) {
    if (gateAlert) gateAlert.hidden = false;
    showToast("⚠️ 拦截提示：原则上要求注册校友先把自己的个人与企业情况介绍清楚，保存后才能提交项目需求！");
    stepNum = 1;
  }

  currentWorkspaceStep = stepNum;
  [1, 2, 3].forEach((n) => {
    const tab = document.getElementById(`step-tab-${n}`);
    const panel = document.getElementById(`ws-step-${n}-panel`);
    if (tab) {
      tab.classList.toggle("dx-stepper__item--current", n === stepNum);
      tab.classList.toggle("dx-stepper__item--done", n < stepNum);
    }
    if (panel) panel.hidden = n !== stepNum;
  });
  if (stepNum === 2) showDemandPane(currentDemandPane || 1);

  if (stepNum === 3) {
    populateDemandSelectorAndLoadMatch();
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

  const wasComplete = !!currentUser.profile_completed;
  const payload = {
    user_id: currentUser.id,
    bio_detail: document.getElementById("prof-bio").value,
    core_capabilities: document.getElementById("prof-capabilities").value,
    can_provide_types: provideTypes,
    industry_tags: industryTags,
    coop_modes: document.getElementById("prof-coop-modes").value,
    openness: (document.getElementById("prof-openness") || {}).value || "开放对接",
    company: (document.getElementById("prof-company") || {}).value || "",
    position: (document.getElementById("prof-position") || {}).value || "",
    city: (document.getElementById("prof-city") || {}).value || "",
    campus: (document.getElementById("prof-campus") || {}).value || "",
    enroll_year: (document.getElementById("prof-year") || {}).value || "",
    seeking: (document.getElementById("prof-seeking") || {}).value || "",
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
  showToast(data.message || "档案已保存");
  await renderWorkspaceView();
  selectWorkspaceStep(wasComplete ? 1 : 2, true);
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
    raw_voice_text: "",
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
  showToast(data.message);
  const success = document.getElementById("demand-success-copy");
  if (success) success.textContent = `${data.message || "需求已提交。"} 匹配来源：${data.match_source || "规则匹配"}。`;
  showDemandPane(4);
  renderMatchReportUI(data.demand, data.match_report, data.match_source);
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
  renderMatchReportUI(data.demand, data.match_report, data.match_source);
}

function renderMatchReportUI(demand, report, matchSource) {
  const banner = document.getElementById("active-demand-banner");
  const empty = document.getElementById("match-empty");
  const rawSource = matchSource || report?.match_source || report?.summary_headline || "";
  const isAi = /deepseek/i.test(String(rawSource));
  const source = isAi ? "deepseek" : "规则匹配";
  const sourceLabel = isAi ? "DeepSeek 匹配" : "规则匹配";
  if (!report || !(report.matched_alumni || []).length) {
    if (banner) banner.hidden = !demand;
    if (empty) empty.hidden = false;
  } else if (empty) empty.hidden = true;
  if (banner && demand) {
    banner.hidden = false;
    banner.innerHTML = `
      <div class="dx-form-card__head">
        <div>
          <p class="dx-help">${esc(demand.demand_code || "")} · ${esc(demand.category || "")} · ${esc(demand.city || "")}</p>
          <h2>${esc(demand.title)}</h2>
        </div>
        <span class="dx-badge ${source === "deepseek" ? "dx-badge--amended" : "dx-badge--approved"}">${esc(sourceLabel)}</span>
      </div>
      <p>${esc(demand.description || "")}</p>
      <p class="dx-help">${esc(report.summary_headline || "")}。${esc(report.strategy_advice || "分数用于排序参考，不是认证。")}${report.model_name ? " 模型：" + esc(report.model_name) + "。" : ""}${report.created_at ? " 生成时间：" + esc(String(report.created_at).slice(0, 16).replace("T", " ")) + "。" : ""}</p>
    `;
  }
  const alumniContainer = document.getElementById("matched-alumni-container");
  const alumni = report?.matched_alumni || [];
  alumniContainer.innerHTML = alumni.map((m, idx) => {
    rememberContext(`${m.target_id}:${demand && demand.id ? demand.id : 0}`, `来自需求「${demand && demand.title ? demand.title : ""}」的匹配`);
    const reasons = [m.ai_reason, m.complementarity, m.suggested_action].filter(Boolean);
    const score = Number(m.match_score) || 0;
    return `<article class="dx-match-card">
      <div class="dx-match-card__body">
        <div class="dx-match-card__meta">
          <span class="dx-tag">${esc(m.city || "")}</span>
          <span class="dx-tag">${esc(m.campus || "")}</span>
          ${(m.industry_tags || []).map((t) => `<span class="dx-tag">${esc(t)}</span>`).join("")}
        </div>
        <h3>${esc(m.masked_name)}</h3>
        <p>${esc(m.core_capabilities || m.masked_company || "")}</p>
        <p class="dx-help">匹配理由</p>
        <ul class="dx-match-reasons">${reasons.map((r) => `<li>${esc(r)}</li>`).join("") || "<li>领域或标签相近</li>"}</ul>
        <div class="dx-action-bar">
          <button class="dx-button dx-button--secondary" type="button" onclick="initiateMatchIntent(${Number(demand.id)}, ${Number(m.target_id)}, 0)">发起双向匿名确认</button>
          <button class="dx-button" type="button" onclick="initiateMatchIntent(${Number(demand.id)}, ${Number(m.target_id)}, 1)">委托中心节点撮合</button>
          <button class="dx-button dx-button--secondary" type="button" onclick="openComposer(${Number(m.target_id)}, ${Number(demand.id)})">发站内信</button>
          <button class="dx-button dx-button--text" type="button" onclick="openAssist(${Number(m.target_id)}, ${Number(demand.id)})">官方协助</button>
        </div>
      </div>
      <div class="dx-match-score">
        <div class="dx-match-score__label">匹配度（${esc(sourceLabel)}）</div>
        <div class="dx-match-score__value">${score}%</div>
        <div class="dx-score-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${score}" aria-label="匹配度 ${score}%">
          <span class="dx-score-bar__fill" style="width:${Math.max(0, Math.min(100, score))}%"></span>
        </div>
      </div>
    </article>`;
  }).join("");
  if (empty) empty.hidden = alumni.length > 0;
  const demandsContainer = document.getElementById("matched-demands-container");
  const ods = report?.matched_demands || [];
  demandsContainer.innerHTML = ods.length ? ods.map((od) => `<article class="dx-match-card">
    <div class="dx-match-card__meta"><span class="dx-tag">${esc(od.demand_code || "")}</span></div>
    <h3>${esc(od.title)}</h3>
    <p class="dx-help">${esc(od.synergy_note || "")} · ${esc(od.budget_scale || "")} · ${esc(od.city || "")}</p>
  </article>`).join("") : '<p class="dx-help">暂无其他关联商机</p>';
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
let adminQueue = [];
function statusOfUser(u) {
  if (u.audit_status === "approved") return "approved";
  if (u.audit_status === "rejected") return "rejected";
  return "pending";
}
function showAdminReview(kind, id) {
  const item = kind === "user" ? adminQueue.find((x) => x._kind === "user" && x.id === id) : adminQueue.find((x) => x._kind === "match" && x.id === id);
  const placeholder = document.getElementById("review-placeholder");
  const body = document.getElementById("review-body");
  const title = document.getElementById("review-title");
  if (!item) return;
  if (placeholder) placeholder.hidden = true;
  if (body) body.hidden = false;
  const badge = document.getElementById("review-badge-wrap");
  if (title) title.textContent = kind === "user" ? "用户审核" : "对接工单";
  if (badge) badge.innerHTML = `<span class="${badgeClass(item._status)}">${badgeLabel(item._status)}</span>`;
  const dl = document.getElementById("review-dl");
  const rows = kind === "user" ? [
    ["姓名", item.real_name], ["手机号", item.phone], ["校区", item.campus], ["届别", item.enroll_year],
    ["院系", item.department], ["企业与职务", `${item.company || ""} · ${item.position || ""}`],
    ["城市", item.city], ["校友卡编号", item.alumni_card_no], ["来源", item.referrer_source],
    ["审核备注", item.audit_note || ""],
  ] : [
    ["商机", `#${item.demand_id}`], ["匹配分", `${item.match_score}%`],
    ["状态", item.intent_status], ["说明", item.ai_reason], ["回馈承诺", item.voluntary_pledge || ""],
  ];
  if (dl) dl.innerHTML = rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("");
  const actions = document.getElementById("review-actions");
  if (!actions) return;
  if (kind === "user" && item.role === "alumni") {
    const pending = item.audit_status !== "approved";
    actions.innerHTML = `
      ${pending ? `<button class="dx-button" type="button" onclick="adminAuditUser(${item.id}, 'approve')">通过</button>
        <button class="dx-button dx-button--secondary" type="button" onclick="adminAuditUser(${item.id}, 'reject')">驳回</button>` : `<button class="dx-button dx-button--secondary" type="button" onclick="adminAuditUser(${item.id}, 'reject')">设为待复核</button>`}
      <button class="dx-button dx-button--text" type="button" onclick="adminResetPassword(${item.id})">重置密码</button>
      <button class="dx-button dx-button--text" type="button" onclick="adminToggle('/api/admin/sponsor',{user_id:${item.id},sponsor:${!item.is_sponsor}})">${item.is_sponsor ? "取消赞助标记" : "标记为赞助校友"}</button>
    `;
  } else if (kind === "match") {
    actions.innerHTML = `<button class="dx-button" type="button" onclick="adminToggle('/api/admin/match-success',{match_id:${item.id},success:${!item.is_success}})">${item.is_success ? "取消已撮合" : "标记已撮合"}</button>`;
  } else actions.innerHTML = "";
  if (window.matchMedia && window.matchMedia("(max-width: 650px)").matches) {
    document.getElementById("admin-review-panel")?.scrollIntoView({ block: "start" });
  }
}
async function loadAdminDashboard() {
  if (!isRealAdmin(currentUser)) {
    document.getElementById("admin-users-list").innerHTML = `<tr><td colspan="7">只有管理员可以查看审核队列。</td></tr>`;
    document.getElementById("admin-matches-list").textContent = "";
    return;
  }
  const res = await apiFetch("/api/admin/dashboard");
  const data = await res.json();
  if (!res.ok) {
    document.getElementById("admin-users-list").innerHTML = `<tr><td colspan="7">${esc(data.detail || "只有管理员可以查看审核队列。")}</td></tr>`;
    document.getElementById("admin-matches-list").innerHTML = "";
    return;
  }
  const users = data.users || [];
  const matches = data.matches || [];
  adminQueue = users.map((u) => ({ ...u, _kind: "user", _status: statusOfUser(u) }));
  const stats = document.getElementById("admin-stats");
  if (stats) {
    const pending = users.filter((u) => statusOfUser(u) === "pending").length;
    const approved = users.filter((u) => statusOfUser(u) === "approved").length;
    const rejected = users.filter((u) => statusOfUser(u) === "rejected").length;
    stats.innerHTML = [
      ["待审核", pending], ["已通过", approved], ["已驳回", rejected], ["对接工单", matches.length],
    ].map(([label, n]) => `<div class="dx-stat-card"><div class="dx-stat-card__value">${n}</div><div class="dx-stat-card__label">${label}</div></div>`).join("");
  }
  document.getElementById("admin-users-list").innerHTML = users.map((u) => cellsRow([
    ["类型", "用户"],
    ["名称 / 标题", esc(u.real_name)],
    ["提交人", esc(u.real_name)],
    ["校区", esc(u.campus)],
    ["提交时间", esc((u.created_at || "").slice(0, 10))],
    ["状态", `<span class="${badgeClass(statusOfUser(u))}">${badgeLabel(statusOfUser(u))}</span>`],
    ["操作", `<button class="dx-button dx-button--text" type="button" onclick="showAdminReview('user', ${u.id})">查看</button>`],
  ])).join("") || `<tr><td colspan="7">暂无记录</td></tr>`;
  adminQueue.push(...matches.map((m) => ({ ...m, _kind: "match", _status: m.is_success ? "approved" : "pending" })));
  document.getElementById("admin-matches-list").innerHTML = matches.length ? `<div class="dx-table-wrap"><table class="dx-table dx-table--compact">
    <thead><tr><th>类型</th><th>名称 / 标题</th><th>提交人</th><th>校区</th><th>提交时间</th><th>状态</th><th>操作</th></tr></thead>
    <tbody>${matches.map((m) => cellsRow([
      ["类型", "对接"],
      ["名称 / 标题", `商机 #${esc(m.demand_id)}`],
      ["提交人", "—"],
      ["校区", "—"],
      ["提交时间", ""],
      ["状态", `<span class="${badgeClass(m.is_success ? "approved" : "pending")}">${m.is_success ? "已通过" : "待审核"}</span>`],
      ["操作", `<button class="dx-button dx-button--text" type="button" onclick="showAdminReview('match', ${m.id})">查看</button>`],
    ])).join("")}</tbody></table></div>` : '<p class="dx-help">暂无对接工单</p>';
}

async function adminAuditUser(userId, action) {
  const note = (document.getElementById("review-reason") || {}).value || "";
  if (action === "reject" && !String(note).trim()) { showToast("请先填写驳回原因。"); return; }
  const res = await apiFetch("/api/admin/audit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, action: action, audit_note: note }),
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

async function sendSmsCode() {
  const phone = document.getElementById("sms-phone").value.trim();
  const error = document.getElementById("sms-phone-error");
  if (!phoneOk(phone)) { setAlert("login-error", "请输入11位中国大陆手机号。"); document.getElementById("login-phone").focus(); return; }
  setAlert("login-error", "");
  const button = document.getElementById("sms-send");
  setBusy(button, true, "获取验证码");
  const res = await apiFetch("/api/auth/sms/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone }) });
  const data = await res.json();
  setBusy(button, false, "获取验证码");
  if (error) error.textContent = data.message || data.detail || "";
}
async function handleSmsLogin(e) {
  e.preventDefault();
  const phone = document.getElementById("sms-phone").value.trim();
  const code = document.getElementById("sms-code").value.trim();
  const error = document.getElementById("sms-phone-error");
  if (!phoneOk(phone) || !/^\d{6}$/.test(code)) { setAlert("sms-phone-error", "请填写手机号和6位验证码。"); return; }
  const button = document.getElementById("sms-submit");
  setBusy(button, true, "用验证码登录");
  const res = await apiFetch("/api/auth/sms/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, code }) });
  const data = await res.json();
  setBusy(button, false, "用验证码登录");
  if (!res.ok) { setAlert("sms-phone-error", data.detail || "验证码不正确或已失效。"); return; }
  setToken(data.token);
  currentUser = data.user;
  updateHeaderUserStatus();
  switchView("workspace");
}
async function startWechatLogin() {
  const res = await apiFetch("/api/auth/wechat/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose: "login" }) });
  const data = await res.json();
  const slot = document.getElementById("wechat-login-link");
  if (!res.ok || !data.url) { if (slot) slot.textContent = "微信扫码登录：暂未开通"; return; }
  if (slot) slot.innerHTML = `<a class="dx-button dx-button--secondary" href="${data.url}">前往微信扫码</a>`;
}
async function renderWechatBind() {
  const box = document.getElementById("wechat-bind-box");
  if (!box || !currentUser || currentUser.audit_status !== "approved") { if (box) box.innerHTML = ""; return; }
  const bound = !!currentUser.wechat_bound;
  const enabled = !!(window.__channelStatus && window.__channelStatus.wechat_website);
  if (!enabled && !bound) {
    box.innerHTML = `<button type="button" class="dx-button dx-button--secondary" id="wechat-bind-action" disabled>微信登录暂未开通</button>`;
    return;
  }
  box.innerHTML = `<button type="button" class="dx-button dx-button--secondary" id="wechat-bind-action">${bound ? "解绑微信" : "绑定微信"}</button>`;
  document.getElementById("wechat-bind-action").onclick = async () => {
    if (bound) {
      if (!confirm("确认解绑当前微信？")) return;
      const res = await apiFetch("/api/auth/wechat/unbind", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) });
      const data = await res.json();
      if (res.ok) { currentUser = data.user; renderWechatBind(); showToast("已解绑微信。"); }
      else showToast(data.detail || "解绑没有完成。");
      return;
    }
    const res = await apiFetch("/api/auth/wechat/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose: "bind" }) });
    const data = await res.json();
    if (res.ok && data.url) location.href = data.url;
    else showToast(data.detail || "微信绑定暂未开通。");
  };
}
async function handleChangePassword(e) {
  e.preventDefault();
  const password = document.getElementById("new-password").value;
  const error = document.getElementById("new-password-error");
  if (!passwordAcceptable(password)) { setAlert("new-password-error", "请将密码设置为8到72位。"); return; }
  setAlert("new-password-error", "");
  const button = document.getElementById("change-password-submit");
  setBusy(button, true, "保存新密码");
  const res = await apiFetch("/api/auth/change-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ new_password: password }) });
  const data = await res.json();
  setBusy(button, false, "保存新密码");
  if (!res.ok) { setAlert("new-password-error", data.detail || "密码没有更新。"); return; }
  currentUser = data.user;
  document.getElementById("password-change-box").hidden = true;
  showToast("密码已更新。");
}
async function handleSettingsPassword(e) {
  e.preventDefault();
  const current = document.getElementById("current-password").value;
  const password = document.getElementById("settings-new-password").value;
  if (!current) { setAlert("settings-password-error", "请输入当前密码。"); return; }
  if (!passwordAcceptable(password)) { setAlert("settings-password-error", "请将密码设置为8到72位。"); return; }
  setAlert("settings-password-error", "");
  const button = document.getElementById("settings-password-submit");
  setBusy(button, true, "更新密码");
  const res = await apiFetch("/api/auth/change-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current_password: current, new_password: password }) });
  const data = await res.json();
  setBusy(button, false, "更新密码");
  if (!res.ok) { setAlert("settings-password-error", data.detail || "密码没有更新。"); return; }
  currentUser = data.user;
  document.getElementById("current-password").value = "";
  document.getElementById("settings-new-password").value = "";
  showToast("密码已更新。");
}
async function adminResetPassword(userId) {
  if (!confirm("确认为该用户生成一次性临时密码？")) return;
  const res = await apiFetch("/api/admin/reset-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId }) });
  const data = await res.json();
  if (!res.ok) { showToast(data.detail || "没有生成临时密码。"); return; }
  showToast("临时密码只显示这一次，请当场交给用户。");
  window.prompt("临时密码（关闭后不再显示）", data.temporary_password);
}


let currentDemandPane = 1;
function showDemandPane(step) {
  currentDemandPane = step;
  [1, 2, 3, 4].forEach((n) => {
    const pane = document.getElementById(`demand-pane-${n}`);
    if (pane) pane.hidden = n !== step;
    const item = document.querySelector(`[data-demand-step="${n}"]`);
    if (item) {
      item.classList.toggle("dx-stepper__item--current", n === step);
      item.classList.toggle("dx-stepper__item--done", n < step);
    }
  });
  const label = document.getElementById("demand-step-label");
  if (label) label.textContent = `第 ${Math.min(step, 4)} 步，共 4 步`;
  const prev = document.getElementById("demand-prev");
  const next = document.getElementById("demand-next");
  const submit = document.getElementById("demand-submit");
  const actions = document.getElementById("demand-actions");
  if (prev) prev.hidden = step === 1 || step === 4;
  if (next) next.hidden = step >= 3;
  if (submit) submit.hidden = step !== 3;
  if (actions) actions.hidden = step === 4;
  if (step === 3) fillDemandPreview();
  if (step === 4) {
    const after = document.getElementById("demand-success-copy");
    if (after && !after.dataset.bound) {
      after.dataset.bound = "1";
    }
  }
}
function fillDemandPreview() {
  const box = document.getElementById("demand-preview");
  if (!box) return;
  const rows = [
    ["类别", "dem-category"], ["行业", "dem-industry"], ["城市", "dem-city"],
    ["标题", "dem-title"], ["描述", "dem-desc"], ["预算或规模", "dem-budget"],
    ["期望合作对象", "dem-partner"], ["标签", "dem-tags"], ["回馈承诺", "dem-pledge"],
  ];
  box.innerHTML = "<dl>" + rows.map(([label, id]) => {
    const el = document.getElementById(id);
    return `<div><dt>${label}</dt><dd>${esc(el ? el.value : "")}</dd></div>`;
  }).join("") + `<div><dt>人工撮合</dt><dd>${document.getElementById("dem-broker")?.checked ? "是" : "否"}</dd></div></dl>`;
}
function demandPaneValid(step) {
  if (step === 1) return ["dem-category", "dem-industry", "dem-city"].every((id) => (document.getElementById(id)?.value || "").trim());
  if (step === 2) {
    const title = (document.getElementById("dem-title")?.value || "").trim();
    const desc = (document.getElementById("dem-desc")?.value || "").trim();
    return title.length >= 4 && desc.length >= 10;
  }
  return true;
}
function stepDemand(delta) {
  const next = currentDemandPane + delta;
  if (delta > 0 && !demandPaneValid(currentDemandPane)) {
    showToast(currentDemandPane === 2 ? "请填写不少于4字的标题和不少于10字的描述。" : "请先完整选择类型、行业和城市。");
    return;
  }
  if (next >= 1 && next <= 3) showDemandPane(next);
}

const composeState = { to: 0, demandId: 0, context: "" };
const contexts = {};
let editingDemandId = 0;
let activeConversationId = 0;

function rememberContext(key, text) { contexts[key] = text || ""; }
function contactActions(userId, demandId) {
  const id = Number(userId);
  if (!id) return "";
  return `<div class="dx-action-bar">
    <button class="dx-button dx-button--secondary" type="button" onclick="openComposer(${id}, ${Number(demandId) || 0})">发站内信</button>
    <button class="dx-button dx-button--text" type="button" onclick="openAssist(${id}, ${Number(demandId) || 0})">官方协助</button>
  </div>`;
}
function openComposer(userId, demandId) {
  composeState.to = Number(userId);
  composeState.demandId = Number(demandId) || 0;
  composeState.context = contexts[`${composeState.to}:${composeState.demandId}`] || contexts[`${composeState.to}:0`] || "";
  const note = document.getElementById("compose-context");
  if (note) note.textContent = composeState.context || "留言只发送给对方账号，不会公开手机号。";
  const body = document.getElementById("compose-body");
  if (body) body.value = "";
  const dialog = document.getElementById("compose-dialog");
  if (dialog && dialog.showModal) dialog.showModal();
}
async function sendCompose(e) {
  e.preventDefault();
  const button = document.getElementById("compose-submit");
  setBusy(button, true, "发送");
  const res = await apiFetch("/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to_user_id: composeState.to, demand_id: composeState.demandId || undefined, context: composeState.context, body: document.getElementById("compose-body").value }),
  });
  const data = await res.json();
  setBusy(button, false, "发送");
  if (!res.ok) { showToast(data.detail || "没有发送"); return; }
  document.getElementById("compose-dialog").close();
  showToast("站内信已发送");
  refreshUnread();
  if (currentView === "inbox") loadInbox();
}
async function refreshUnread() {
  if (!isApproved(currentUser)) return;
  const res = await apiFetch("/api/inbox/unread");
  if (!res.ok) return;
  const data = await res.json();
  const badge = document.getElementById("inbox-badge");
  if (!badge) return;
  const total = Number(data.total) || 0;
  badge.hidden = total <= 0;
  badge.textContent = total > 99 ? "99+" : String(total);
}
function renderMyDemands(list) {
  const box = document.getElementById("my-demands-list");
  if (!box) return;
  window.__myDemands = list || [];
  if (!list.length) {
    box.innerHTML = '<div class="dx-state"><h2>还没有发布供需</h2><p class="dx-muted">完善档案后可以在下面发布，之后随时回来修改。</p></div>';
    return;
  }
  box.innerHTML = list.map((d) => `<article class="dx-match-card">
    <div class="dx-match-card__meta"><span class="dx-tag">${esc(d.lifecycle || "进行中")}</span><span class="dx-tag">${esc(d.industry || "")}</span></div>
    <h3>${esc(d.title)}</h3>
    <p>${esc(d.description || "")}</p>
    <p class="dx-help">${esc(d.demand_code || "")} · 更新 ${esc(String(d.updated_at || d.created_at || "").slice(0, 16).replace("T", " "))}</p>
    <div class="dx-action-bar dx-card-actions">
      <button class="dx-button dx-button--secondary" type="button" onclick="openDemandEditor(${Number(d.id)})">编辑</button>
      <button class="dx-button dx-button--text dx-card-actions__extra" type="button" onclick="setDemandState(${Number(d.id)}, '进行中')">进行中</button>
      <button class="dx-button dx-button--text dx-card-actions__extra" type="button" onclick="setDemandState(${Number(d.id)}, '暂停')">暂停</button>
      <button class="dx-button dx-button--text dx-card-actions__extra" type="button" onclick="setDemandState(${Number(d.id)}, '已对接完成')">已对接完成</button>
      <button class="dx-button dx-button--text dx-card-actions__extra" type="button" onclick="setDemandState(${Number(d.id)}, '已关闭')">已关闭</button>
      <button class="dx-button dx-button--text dx-card-actions__extra" type="button" onclick="refreshDemand(${Number(d.id)})">刷新动态</button>
      <button class="dx-button dx-button--text dx-card-actions__extra" type="button" onclick="archiveDemand(${Number(d.id)})">归档</button>
      <button class="dx-more-toggle" type="button" aria-expanded="false" onclick="toggleCardActions(this)">更多操作</button>
    </div>
  </article>`).join("");
}
function openDemandEditor(id) {
  const row = (window.__myDemands || []).find((item) => item.id === id);
  if (!row) return;
  editingDemandId = id;
  document.getElementById("edit-title").value = row.title || "";
  document.getElementById("edit-desc").value = row.description || "";
  document.getElementById("edit-category").value = row.category || "";
  document.getElementById("edit-industry").value = row.industry || "";
  document.getElementById("edit-city").value = row.city || "";
  document.getElementById("edit-tags").value = (row.tags || []).join(", ");
  document.getElementById("demand-edit-dialog").showModal();
}
async function saveDemandEdit(e) {
  e.preventDefault();
  const tags = document.getElementById("edit-tags").value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
  const res = await apiFetch(`/api/demands/${editingDemandId}/update`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: document.getElementById("edit-title").value,
      description: document.getElementById("edit-desc").value,
      category: document.getElementById("edit-category").value,
      industry: document.getElementById("edit-industry").value,
      city: document.getElementById("edit-city").value,
      tags,
    }),
  });
  const data = await res.json();
  if (!res.ok) { showToast(data.detail || "没有保存"); return; }
  document.getElementById("demand-edit-dialog").close();
  showToast("供需已更新");
  renderWorkspaceView();
}
async function setDemandState(id, lifecycle) {
  const res = await apiFetch(`/api/demands/${id}/status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lifecycle }) });
  const data = await res.json();
  showToast(res.ok ? data.message : (data.detail || "没有更新"));
  if (res.ok) renderWorkspaceView();
}
async function refreshDemand(id) {
  const res = await apiFetch(`/api/demands/${id}/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const data = await res.json();
  showToast(res.ok ? data.message : (data.detail || "没有刷新"));
  if (res.ok) renderWorkspaceView();
}
async function archiveDemand(id) {
  if (!confirm("归档后这条供需不再公开，确定继续？")) return;
  const res = await apiFetch(`/api/demands/${id}/archive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const data = await res.json();
  showToast(res.ok ? data.message : (data.detail || "没有归档"));
  if (res.ok) renderWorkspaceView();
}
function openAssist(userId, demandId) {
  switchView("assist");
  const target = document.getElementById("assist-target");
  const demand = document.getElementById("assist-demand");
  const note = document.getElementById("assist-context");
  if (target && userId) target.value = String(userId);
  if (demand && demandId) demand.value = String(demandId);
  if (note) note.textContent = contexts[`${Number(userId) || 0}:${Number(demandId) || 0}`] || "";
}
async function handleAssistSubmit(e) {
  e.preventDefault();
  setAlert("assist-error", "");
  const button = document.getElementById("assist-submit");
  setBusy(button, true, "提交协助申请");
  const res = await apiFetch("/api/assists", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target_user_id: Number(document.getElementById("assist-target").value) || undefined,
      demand_id: Number(document.getElementById("assist-demand").value) || undefined,
      appeal: document.getElementById("assist-appeal").value,
      help_needed: document.getElementById("assist-help").value,
      contact_time: document.getElementById("assist-time").value,
      urgency: document.getElementById("assist-urgency").value,
      note: document.getElementById("assist-note").value,
    }),
  });
  const data = await res.json();
  setBusy(button, false, "提交协助申请");
  if (!res.ok) { setAlert("assist-error", data.detail || "没有提交"); return; }
  showToast(data.message || "已提交");
  document.getElementById("assist-form").reset();
  loadAssists();
}
async function loadAssists() {
  const box = document.getElementById("assist-list");
  if (!box || !isApproved(currentUser)) return;
  const res = await apiFetch("/api/assists");
  const data = await res.json();
  if (!res.ok) { box.innerHTML = `<div class="dx-state">${esc(data.detail || "暂时无法读取申请")}</div>`; return; }
  const rows = data.assists || [];
  box.innerHTML = rows.length ? rows.map((item) => `<article class="dx-match-card">
    <div class="dx-match-card__meta"><span class="dx-tag">${esc(item.status)}</span><span class="dx-tag">${esc(item.urgency || "")}</span></div>
    <h3>申请 #${esc(item.id)}</h3>
    <p>${esc(item.appeal)}</p>
    <p class="dx-help">${item.target ? esc(item.target.masked_name) : "未指定对象"}${item.demand ? " · " + esc(item.demand.title) : ""}</p>
    ${(item.updates || []).map((update) => `<p class="dx-help">${esc(update.created_at || "").slice(0, 16)} · ${esc(update.body)}</p>`).join("")}
    ${item.status === "待受理" ? `<button class="dx-button dx-button--text" type="button" onclick="cancelAssist(${Number(item.id)})">取消申请</button>` : ""}
    ${item.status !== "已促成" && item.status !== "已关闭" ? `<form class="dx-field" onsubmit="supplementAssist(event, ${Number(item.id)})"><label for="assist-more-${item.id}">补充说明</label><input id="assist-more-${item.id}" class="dx-input" maxlength="500"><button class="dx-button dx-button--secondary" type="submit">提交补充</button></form>` : ""}
    ${item.target ? contactActions(item.target.id, item.demand && item.demand.id) : ""}
  </article>`).join("") : '<div class="dx-state"><h2>还没有协助申请</h2></div>';
}
async function supplementAssist(e, id) {
  e.preventDefault();
  const input = document.getElementById(`assist-more-${id}`);
  const res = await apiFetch(`/api/assists/${id}/supplement`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: input ? input.value : "" }) });
  const data = await res.json();
  showToast(res.ok ? "已补充" : (data.detail || "没有提交"));
  if (res.ok) loadAssists();
}
async function cancelAssist(id) {
  const res = await apiFetch(`/api/assists/${id}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const data = await res.json();
  showToast(res.ok ? data.message : (data.detail || "没有取消"));
  if (res.ok) loadAssists();
}
function showInboxTab(name) {
  const mail = document.getElementById("inbox-mail");
  const official = document.getElementById("inbox-official");
  if (mail) mail.hidden = name !== "mail";
  if (official) official.hidden = name !== "official";
  const mailTab = document.getElementById("inbox-tab-mail");
  const officialTab = document.getElementById("inbox-tab-official");
  if (mailTab) mailTab.setAttribute("aria-selected", name === "mail" ? "true" : "false");
  if (officialTab) officialTab.setAttribute("aria-selected", name === "official" ? "true" : "false");
  if (name === "official") loadNotices();
}
function showInboxList() {
  const pane = document.getElementById("inbox-pane");
  if (pane) pane.classList.remove("is-reading");
}
async function loadInbox(keepThread) {
  if (!keepThread) showInboxTab("mail");
  const box = document.getElementById("inbox-list");
  if (!box) return;
  const res = await apiFetch("/api/messages");
  const data = await res.json();
  if (!res.ok) { box.innerHTML = `<div class="dx-state">${esc(data.detail || "请先登录")}</div>`; return; }
  const rows = data.conversations || [];
  box.innerHTML = rows.length ? rows.map((item) => {
    const current = Number(item.id) === Number(activeConversationId);
    const when = String(item.last_message_at || "").replace("T", " ").slice(5, 16);
    const preview = item.last_preview || item.context_summary || "";
    return `<button class="dx-thread-item ${current ? "is-current" : ""}" type="button" onclick="openThread(${Number(item.id)})">
      <span class="dx-thread-item__top"><strong>${esc(item.peer && item.peer.masked_name || "校友")}</strong><span class="dx-thread-item__meta">${item.unread ? `<span class="nav-count">${esc(item.unread)}</span>` : ""}${when ? `<time>${esc(when)}</time>` : ""}</span></span>
      <span class="dx-thread-item__preview">${esc(preview)}</span>
    </button>`;
  }).join("") : '<div class="dx-state"><h2>还没有留言</h2></div>';
  refreshUnread();
}
async function openThread(id) {
  activeConversationId = Number(id);
  const pane = document.getElementById("inbox-pane");
  if (pane) pane.classList.add("is-reading");
  const res = await apiFetch(`/api/messages/${activeConversationId}`);
  const data = await res.json();
  const box = document.getElementById("inbox-thread");
  if (!res.ok) {
    if (pane) pane.classList.remove("is-reading");
    if (box) box.innerHTML = `<div class="dx-state">${esc(data.detail || "不能打开该会话")}</div>`;
    return;
  }
  const conv = data.conversation || {};
  const peerId = Number(conv.peer && conv.peer.id) || 0;
  const demandId = Number(conv.demand && conv.demand.id) || 0;
  if (box) box.innerHTML = `<button class="dx-button dx-button--text dx-thread-back" type="button" onclick="showInboxList()">返回列表</button>
    <h2>${esc(conv.peer && conv.peer.masked_name || "会话")}</h2>
    <p class="dx-help">${esc(conv.context_summary || "")}${conv.demand ? " · " + esc(conv.demand.title) : ""}</p>
    <div class="dx-thread-log">${(data.messages || []).map((item) => `<div class="dx-bubble ${item.mine ? "is-mine" : "is-theirs"}"><strong>${item.mine ? "我" : "对方"}</strong><p>${esc(item.body)}</p>${item.context_summary ? `<p class="dx-help">${esc(item.context_summary)}</p>` : ""}</div>`).join("")}</div>
    <form class="dx-reply" onsubmit="replyThread(event, ${peerId}, ${demandId})">
      <div class="dx-field"><label for="thread-reply">回复</label><textarea id="thread-reply" class="dx-textarea" maxlength="800" required></textarea></div>
      <div class="dx-reply-actions">
        <button class="dx-button" type="submit">发送回复</button>
        <button class="dx-button dx-button--text" type="button" onclick="openAssist(${peerId}, ${demandId})">就此申请官方协助</button>
      </div>
    </form>`;
  loadInbox(true);
  refreshUnread();
}
async function replyThread(e, peerId, demandId) {
  e.preventDefault();
  const res = await apiFetch("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to_user_id: peerId, demand_id: demandId || undefined, body: document.getElementById("thread-reply").value }) });
  const data = await res.json();
  if (!res.ok) { showToast(data.detail || "没有发送"); return; }
  openThread(activeConversationId);
}
async function loadNotices() {
  const box = document.getElementById("notice-list");
  if (!box) return;
  const res = await apiFetch("/api/notices");
  const data = await res.json();
  if (!res.ok) { box.innerHTML = `<div class="dx-state">${esc(data.detail || "暂时无法读取")}</div>`; return; }
  const items = data.items || [];
  box.innerHTML = items.length ? items.map((item) => `<article class="dx-match-card">
    <div class="dx-match-card__meta"><span class="dx-tag">${esc(item.category || "")}</span>${item.read ? "" : '<span class="dx-badge dx-badge--pending">未读</span>'}</div>
    <h3>${esc(item.title)}</h3>
    <p>${esc(item.body)}</p>
    <p class="dx-help">${esc(String(item.created_at || "").slice(0, 16).replace("T", " "))}</p>
    ${item.read ? "" : `<button class="dx-button dx-button--text" type="button" onclick="markNoticeRead('${item.kind}', ${Number(item.id)})">标为已读</button>`}
  </article>`).join("") : '<div class="dx-state"><h2>没有官方消息</h2></div>';
}
async function markNoticeRead(kind, id) {
  const res = await apiFetch(`/api/notices/${kind}/${id}/read`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (res.ok) { loadNotices(); refreshUnread(); }
}
async function markAllNoticesRead() {
  const res = await apiFetch("/api/notices/read-all", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (res.ok) { loadNotices(); refreshUnread(); showToast("已全部标为已读"); }
}
async function loadCases() {
  const box = document.getElementById("case-list");
  if (!box) return;
  const q = new URLSearchParams({
    keyword: (document.getElementById("case-keyword") || {}).value || "",
    field: (document.getElementById("case-field") || {}).value || "",
  });
  const res = await apiFetch(`/api/cases?${q}`);
  const data = await res.json();
  if (!res.ok) { box.innerHTML = `<div class="dx-state">${esc(data.detail || "审核通过后可以查看案例")}</div>`; return; }
  const rows = data.cases || [];
  box.innerHTML = rows.length ? rows.map((item) => `<article class="dx-match-card">
    <div class="dx-match-card__meta">${item.featured ? '<span class="dx-badge dx-badge--approved">精选</span>' : ""}<span class="dx-tag">${esc(item.domain_tags || "")}</span></div>
    <h3>${esc(item.title)}</h3>
    <p>${esc(item.background || "")}</p>
    <p>${esc(item.highlight || "")}</p>
    <p>${esc(item.outcome || "")}</p>
    <p class="dx-help">${esc(item.display_names || "")}${item.facilitated_on ? " · " + esc(item.facilitated_on) : ""}</p>
  </article>`).join("") : '<div class="dx-state"><h2>没有已发布的案例</h2><p class="dx-muted">可以调整关键词或领域后再看。</p></div>';
}
function showAdminTab(name) {
  ["queue", "matches", "assists", "cases", "broadcast"].forEach((id) => {
    const section = document.getElementById(id === "queue" ? "admin-queue" : `admin-${id}`);
    if (section) section.hidden = id !== name;
    const link = document.querySelector(`[data-admin-tab="${id}"]`);
    if (link) {
      if (id === name) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  });
  if (name === "queue" || name === "matches") loadAdminDashboard();
  if (name === "assists") loadAdminAssists();
  if (name === "cases") loadAdminCases();
  if (name === "broadcast") loadAdminBroadcasts();
}
async function loadAdminAssists() {
  const q = new URLSearchParams({
    keyword: (document.getElementById("admin-assist-keyword") || {}).value || "",
    status: (document.getElementById("admin-assist-status") || {}).value || "",
  });
  const res = await apiFetch(`/api/admin/assists?${q}`);
  const data = await res.json();
  const box = document.getElementById("admin-assist-list");
  if (!box) return;
  if (!res.ok) { box.textContent = data.detail || "只有管理员可以查看"; return; }
  box.innerHTML = (data.assists || []).map((item) => `<article class="dx-match-card">
    <h3>#${esc(item.id)} ${esc(item.requester_name)} → ${esc(item.target_name || "未指定")}</h3>
    <p>${esc(item.appeal)}</p>
    <p class="dx-help">${esc(item.status)} · ${esc(item.urgency || "")}</p>
    <button class="dx-button dx-button--text" type="button" onclick="openAdminAssist(${Number(item.id)})">查看</button>
  </article>`).join("") || '<p class="dx-help">没有符合条件的申请</p>';
}
async function openAdminAssist(id) {
  const res = await apiFetch(`/api/admin/assists/${id}`);
  const data = await res.json();
  const box = document.getElementById("admin-assist-detail");
  if (!box) return;
  if (!res.ok) { box.textContent = data.detail || "没有打开"; return; }
  const item = data.assist;
  const requester = item.requester || {};
  const target = item.target_contact || {};
  box.innerHTML = `<article class="dx-form-card">
    <h3>申请 #${esc(item.id)} · ${esc(item.status)}</h3>
    <div class="dx-preview"><dl>
      <div><dt>申请人</dt><dd>${esc(requester.real_name || "")} · ${esc(requester.phone || "")}</dd></div>
      <div><dt>目标校友</dt><dd>${esc(target.real_name || "未指定")} · ${esc(target.phone || "")}</dd></div>
      <div><dt>诉求</dt><dd>${esc(item.appeal || "")}</dd></div>
      <div><dt>希望协助</dt><dd>${esc(item.help_needed || "")}</dd></div>
      <div><dt>联系时间</dt><dd>${esc(item.contact_time || "")}</dd></div>
      <div><dt>内部备忘</dt><dd>${esc(item.internal_memo || "")}</dd></div>
    </dl></div>
    ${(item.updates || []).map((update) => `<p class="dx-help">${esc(update.body)}</p>`).join("")}
    <div class="dx-field"><label for="assist-admin-status">处理状态</label>
      <select id="assist-admin-status" class="dx-select">${["待受理", "评估中", "对接中", "已促成", "已关闭"].map((status) => `<option ${status === item.status ? "selected" : ""}>${status}</option>`).join("")}</select>
    </div>
    <div class="dx-field"><label for="assist-admin-progress">对申请人可见的进展</label><textarea id="assist-admin-progress" class="dx-textarea"></textarea></div>
    <div class="dx-field"><label for="assist-admin-memo">仅管理员可见的备忘</label><textarea id="assist-admin-memo" class="dx-textarea">${esc(item.internal_memo || "")}</textarea></div>
    <div class="dx-action-bar">
      <button class="dx-button" type="button" onclick="saveAdminAssist(${Number(item.id)})">保存进展</button>
      <button class="dx-button dx-button--secondary" type="button" onclick="assistToCase(${Number(item.id)})">转为成功案例草稿</button>
    </div>
  </article>`;
}
async function saveAdminAssist(id) {
  const res = await apiFetch(`/api/admin/assists/${id}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: document.getElementById("assist-admin-status").value,
      progress: document.getElementById("assist-admin-progress").value,
      internal_memo: document.getElementById("assist-admin-memo").value,
    }),
  });
  const data = await res.json();
  showToast(res.ok ? data.message : (data.detail || "没有保存"));
  if (res.ok) { loadAdminAssists(); openAdminAssist(id); }
}
async function assistToCase(id) {
  const res = await apiFetch(`/api/admin/assists/${id}/to-case`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const data = await res.json();
  if (!res.ok) { showToast(data.detail || "没有生成草稿"); return; }
  showAdminTab("cases");
  fillCaseForm(data.case || {});
  showToast(data.message || "已生成草稿");
}
function resetCaseForm() {
  const form = document.getElementById("admin-case-form");
  if (form) form.reset();
  const id = document.getElementById("case-id");
  if (id) id.value = "";
}
function fillCaseForm(item) {
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value == null ? "" : String(value); };
  set("case-id", item.id || "");
  set("case-title", item.title);
  set("case-domain", item.domain_tags);
  set("case-when", item.facilitated_on);
  set("case-names", item.display_names);
  set("case-background", item.background);
  set("case-highlight", item.highlight);
  set("case-outcome", item.outcome);
  set("case-status", item.status || "draft");
  set("case-featured", item.featured ? "1" : "0");
  set("case-assist-id", item.assist_id || "");
  set("case-demand-id", item.demand_id || "");
}
async function saveAdminCase(e) {
  e.preventDefault();
  const id = (document.getElementById("case-id").value || "").trim();
  const payload = {
    title: document.getElementById("case-title").value,
    domain_tags: document.getElementById("case-domain").value,
    facilitated_on: document.getElementById("case-when").value,
    display_names: document.getElementById("case-names").value,
    background: document.getElementById("case-background").value,
    highlight: document.getElementById("case-highlight").value,
    outcome: document.getElementById("case-outcome").value,
    status: document.getElementById("case-status").value,
    featured: document.getElementById("case-featured").value === "1",
    assist_id: Number(document.getElementById("case-assist-id").value) || null,
    demand_id: Number(document.getElementById("case-demand-id").value) || null,
  };
  const res = await apiFetch(id ? `/api/admin/cases/${id}` : "/api/admin/cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await res.json();
  if (!res.ok) { showToast(data.detail || "没有保存"); return; }
  if (data.case) fillCaseForm(data.case);
  showToast(data.message || "已保存");
  loadAdminCases();
}
async function loadAdminCases() {
  const q = new URLSearchParams({
    keyword: (document.getElementById("admin-case-keyword") || {}).value || "",
    field: (document.getElementById("admin-case-field") || {}).value || "",
    status: (document.getElementById("admin-case-status") || {}).value || "",
    featured: (document.getElementById("admin-case-featured") || {}).value || "",
  });
  const res = await apiFetch(`/api/admin/cases?${q}`);
  const data = await res.json();
  const box = document.getElementById("admin-case-list");
  if (!box) return;
  if (!res.ok) { box.textContent = data.detail || "只有管理员可以查看"; return; }
  const label = { draft: "草稿", published: "已发布", archived: "已下架" };
  box.innerHTML = (data.cases || []).map((item) => `<article class="dx-match-card">
    <h3>${esc(item.title)}</h3>
    <p class="dx-help">${esc(label[item.status] || item.status)}${item.featured ? " · 精选" : ""} · ${esc(item.domain_tags || "")}</p>
    <div class="dx-action-bar dx-card-actions">
      <button class="dx-button dx-button--text" type="button" onclick="editAdminCase(${Number(item.id)})">编辑</button>
      <button class="dx-button dx-button--text dx-card-actions__extra" type="button" onclick="setCaseStatus(${Number(item.id)}, 'published', ${item.featured ? "true" : "false"})">发布</button>
      <button class="dx-button dx-button--text dx-card-actions__extra" type="button" onclick="setCaseStatus(${Number(item.id)}, 'archived', ${item.featured ? "true" : "false"})">下架</button>
      <button class="dx-button dx-button--text dx-card-actions__extra" type="button" onclick="setCaseStatus(${Number(item.id)}, '${item.status}', ${item.featured ? "false" : "true"})">${item.featured ? "取消精选" : "设为精选"}</button>
      <button class="dx-button dx-button--text dx-card-actions__extra" type="button" onclick="deleteAdminCase(${Number(item.id)})">删除</button>
      <button class="dx-more-toggle" type="button" aria-expanded="false" onclick="toggleCardActions(this)">更多操作</button>
    </div>
  </article>`).join("") || '<p class="dx-help">没有案例</p>';
}
async function editAdminCase(id) {
  const res = await apiFetch(`/api/admin/cases?keyword=`);
  const data = await res.json();
  const item = (data.cases || []).find((row) => row.id === id);
  if (item) {
    fillCaseForm(item);
    if (window.matchMedia && window.matchMedia("(max-width: 650px)").matches) {
      document.getElementById("admin-case-form")?.scrollIntoView({ block: "start" });
    }
  }
}
async function setCaseStatus(id, status, featured) {
  const res = await apiFetch(`/api/admin/cases/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, featured }) });
  const data = await res.json();
  showToast(res.ok ? data.message : (data.detail || "没有更新"));
  if (res.ok) loadAdminCases();
}
async function deleteAdminCase(id) {
  if (!confirm("删除后不能恢复，确定继续？")) return;
  const res = await apiFetch(`/api/admin/cases/${id}/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const data = await res.json();
  showToast(res.ok ? data.message : (data.detail || "没有删除"));
  if (res.ok) loadAdminCases();
}
async function loadCaseSources() {
  const q = new URLSearchParams({ keyword: (document.getElementById("admin-source-keyword") || {}).value || "" });
  const res = await apiFetch(`/api/admin/case-sources?${q}`);
  const data = await res.json();
  const box = document.getElementById("admin-source-list");
  if (!box) return;
  if (!res.ok) { box.textContent = data.detail || "只有管理员可以检索"; return; }
  const assists = (data.assists || []).map((item) => `<li>对接 #${esc(item.id)} ${esc(item.requester_name)} / ${esc(item.target_name)}：${esc(item.appeal)}</li>`).join("");
  const demands = (data.demands || []).map((item) => `<li>供需 #${esc(item.id)} ${esc(item.title)}</li>`).join("");
  const alumni = (data.alumni || []).map((item) => `<li>校友 #${esc(item.id)} ${esc(item.real_name)} ${esc(item.phone || "")}</li>`).join("");
  box.innerHTML = `<div class="dx-form-card"><h3>已促成对接</h3><ul>${assists || "<li>无</li>"}</ul><h3>供需</h3><ul>${demands || "<li>无</li>"}</ul><h3>校友</h3><ul>${alumni || "<li>无</li>"}</ul></div>`;
}
async function sendBroadcast(e) {
  e.preventDefault();
  const button = document.getElementById("broadcast-submit");
  setBusy(button, true, "发送公告");
  const res = await apiFetch("/api/admin/announcements", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: document.getElementById("broadcast-title").value,
      body: document.getElementById("broadcast-body").value,
      category: document.getElementById("broadcast-category").value,
      audience: document.getElementById("broadcast-audience").value,
      campus: document.getElementById("broadcast-campus").value,
    }),
  });
  const data = await res.json();
  setBusy(button, false, "发送公告");
  if (!res.ok) { showToast(data.detail || "没有发送"); return; }
  showToast(data.message || "已发送");
  document.getElementById("broadcast-form").reset();
  loadAdminBroadcasts();
}
async function loadAdminBroadcasts() {
  const res = await apiFetch("/api/admin/announcements");
  const data = await res.json();
  const box = document.getElementById("admin-broadcast-list");
  if (!box) return;
  if (!res.ok) { box.textContent = data.detail || "只有管理员可以查看"; return; }
  const audience = { all_registered: "全部注册会员", approved: "仅已审核通过", campus: "按校区" };
  box.innerHTML = (data.announcements || []).map((item) => `<article class="dx-match-card">
    <h3>${esc(item.title)}${item.revoked_at ? ' <span class="dx-badge dx-badge--rejected">已撤回</span>' : ""}</h3>
    <p>${esc(item.body)}</p>
    <p class="dx-help">${esc(item.category)} · ${esc(audience[item.audience] || item.audience)}${item.campus ? " · " + esc(item.campus) : ""} · 覆盖 ${esc(item.covered_count)} · 已读 ${esc(item.read_count)} · ${esc(String(item.created_at || "").slice(0, 16).replace("T", " "))}</p>
    ${item.revoked_at ? "" : `<button class="dx-button dx-button--text" type="button" onclick="revokeBroadcast(${Number(item.id)})">撤回</button>`}
  </article>`).join("") || '<p class="dx-help">还没有公告</p>';
}
async function revokeBroadcast(id) {
  const res = await apiFetch(`/api/admin/announcements/${id}/revoke`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const data = await res.json();
  showToast(res.ok ? data.message : (data.detail || "没有撤回"));
  if (res.ok) loadAdminBroadcasts();
}


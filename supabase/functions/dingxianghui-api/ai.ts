import DATA from "./data.ts";
// deno-lint-ignore no-explicit-any
type Any = any;
export const PRESETS: Record<string, Any> = DATA.presets;
const KW: Record<string, string[]> = DATA.kw;
const PAIRS: [Set<string>, Set<string>][] = DATA.pairs.map((p: string[][]) => [new Set(p[0]), new Set(p[1])]);
const ENGINE = "HIT-DingXiangHui-Voice-NLP-v2.6";

export function extractTags(text: string): string[] {
  const found: string[] = [];
  const low = text.toLowerCase();
  for (const [tag, kws] of Object.entries(KW)) {
    if (kws.some((k) => low.includes(k.toLowerCase())) && !found.includes(tag)) found.push(tag);
  }
  return (found.length ? found : ["智能制造", "人工智能"]).slice(0, 5);
}

export function parseProfile(raw: string, preset = ""): Any {
  if (preset && PRESETS[preset]) {
    const s = PRESETS[preset];
    return { transcript: s.transcript, extracted: s.extracted, ai_engine: ENGINE };
  }
  const text = raw.trim();
  const tags = extractTags(text);
  const pt: string[] = [];
  const has = (ks: string[]) => ks.some((k) => text.includes(k));
  if (has(["研发", "算法", "设计", "技术", "专利", "仿真"])) pt.push("技术研发");
  if (has(["产线", "生产", "制造", "加工", "供货", "车间", "量产", "样品"])) pt.push("产品/供应链");
  if (has(["渠道", "海外", "客户", "市场", "销售", "代理"])) pt.push("市场渠道");
  if (has(["投资", "基金", "融资", "资本"])) pt.push("资金/投融资");
  if (has(["置换", "易货", "富余产能"])) pt.push("产能共享/易货");
  if (!pt.length) pt.push("技术研发", "产品/供应链");
  const bio = text.length >= 30 ? text
    : `${text}。作为哈工大创业校友，团队长期深耕${tags.join("、")}领域，具备扎实的工程化落地与产学研转化经验，期待与丁香会校友开展深度业务协同。`;
  return {
    transcript: text,
    extracted: {
      bio_detail: bio,
      core_capabilities: `核心专注${tags.join("、")}方向研发与产业化交付，可提供${pt.join("、")}支持`,
      can_provide_types: pt, industry_tags: tags,
      coop_modes: "上下游供应链配套、联合技术攻关、市场渠道互换及项目共建",
    },
    ai_engine: ENGINE,
  };
}

export function parseDemand(raw: string, preset = "", userCity = "深圳"): Any {
  if (preset && PRESETS[preset]) {
    const s = PRESETS[preset];
    return { transcript: s.transcript, duration: s.duration || "00:19", structured: s.structured, ai_engine: ENGINE };
  }
  const text = raw.trim();
  const tags = extractTags(text);
  const primary = tags[0] || "智能制造";
  const has = (ks: string[]) => ks.some((k) => text.includes(k));
  let category = "找供应链/核心部件";
  if (has(["融资", "投资", "基金", "资金", "A轮", "天使"])) category = "找资金/投融资";
  else if (has(["渠道", "客户", "出海", "落地场景", "试用", "销售", "市场"])) category = "找客户/市场渠道";
  else if (has(["置换", "易货", "富余产能"])) category = "产能共享/以货易货";
  else if (has(["联合研发", "攻关", "算法", "仿真", "检测方案"])) category = "找技术/联合研发";
  const bm = text.match(/(\d+[\d.\-~至到]*万元?)/);
  const budget = bm ? `预计合作规模 ${bm[1]}` : "预算规模 100万 - 300万元（具体面议）";
  let city = userCity;
  for (const c of ["深圳", "哈尔滨", "北京", "上海", "苏州", "杭州", "成都", "威海", "青岛", "宁波"]) {
    if (text.includes(c)) { city = c; break; }
  }
  const short = text.replace(/^(喂|你好|大家好|丁香会[^，。]*)[，。,\s]*/, "");
  let title = short.slice(0, 28).replace(/[，。,. ]+$/, "");
  title = title.length < 10 ? `${primary}项目寻求${tags.slice(0, 2).join("/")}方向校友深度合作` : `【${primary}】${title}`;
  return {
    transcript: text, duration: "00:16",
    structured: {
      title, category, industry: primary, city,
      description: text.length > 25 ? text : `${text}。希望在丁香会平台内匹配具备相关工程落地经验与合规资质的哈工大校友企业，建立长期互信合作。`,
      budget_scale: budget,
      expected_partner: `具备${tags.join("、")}领域核心技术、量产能力或市场资源的哈工大校友企业`,
      tags,
    },
    ai_engine: ENGINE,
  };
}

export function ocrCard(cardNo: string, name: string, year: string, dept: string, campus: string): Any {
  const yd = ((year || "2012").replace(/\D/g, "").slice(0, 4)) || "2012";
  const cc = (campus || "").includes("深圳") ? "SZ" : ((campus || "").includes("威海") ? "WH" : "HQ");
  const no = cardNo && cardNo.trim().length >= 6 ? cardNo.trim() : `HIT-${cc}-${yd}0618`;
  return {
    recognized: true, card_no: no, holder_name: name || "待核验校友", campus: campus || "校本部(哈尔滨)",
    enroll_year: year || "2012级", department: dept || "航天学院", issuer: "哈尔滨工业大学校友总会电子校友卡中心",
    confidence: "99.2%（模拟识别）",
    verification_summary: `AI视觉初筛（演示模拟）：已读取校友卡号 ${no}，等待平台中心节点管理员人工复核。`,
  };
}

export function maskCompany(company: string, city: string): string {
  if (!company) return `${city}某校友硬科技企业`;
  const a = [...company];
  if (a.length <= 6) return a.slice(0, 2).join("") + "**" + a.slice(-2).join("");
  return a.slice(0, 2).join("") + "**" + a.slice(4).join("");
}
export function maskPerson(name: string): string {
  if (!name) return "校友*";
  const a = [...name];
  return a[0] + "*" + (a.length > 2 ? "*" : "");
}
const J = (s: Any) => { try { return Array.isArray(s) ? s : JSON.parse(s || "[]"); } catch { return []; } };
const dept0 = (d: string) => (d || "").split("·")[0].trim();
const inter = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x));

export function runMatching(demand: Any, users: Any[], demands: Any[]): Any {
  const dTags = new Set<string>(J(demand.tags));
  const dInd = demand.industry || "", dCat = demand.category || "", dCity = demand.city || "";
  const dText = `${demand.title || ""} ${demand.description || ""} ${demand.expected_partner || ""}`;
  const dUid = demand.user_id || 0;
  extractTags(dText).forEach((t) => dTags.add(t));
  if (dInd) dTags.add(dInd);
  const alumni: Any[] = [];
  for (const u of users) {
    if (u.id === dUid || u.audit_status !== "approved" || !u.profile_completed || u.role !== "alumni") continue;
    const uTags = new Set<string>(J(u.industry_tags));
    const uProv = new Set<string>(J(u.can_provide_types));
    const blob = `${u.bio_detail || ""} ${u.core_capabilities || ""} ${u.coop_modes || ""} ${u.department || ""}`;
    const overlap = inter(dTags, uTags);
    let score = 52 + overlap.length * 12;
    for (const [a, b] of PAIRS) {
      if ((inter(dTags, a).length && inter(uTags, b).length) || (inter(dTags, b).length && inter(uTags, a).length)) { score += 14; break; }
    }
    if (dCat.includes("供应链") && uProv.has("产品/供应链")) score += 10;
    else if (dCat.includes("技术") && uProv.has("技术研发")) score += 10;
    else if (dCat.includes("渠道") && (uProv.has("市场渠道") || uProv.has("出海落地"))) score += 10;
    else if (dCat.includes("资金") && uProv.has("资金/投融资")) score += 12;
    else if (dCat.includes("易货") && uProv.has("产能共享/易货")) score += 12;
    let hits = 0;
    for (const t of dTags) if ((KW[t] || [t]).some((k) => blob.includes(k))) hits++;
    score += Math.min(12, hits * 4);
    if (dCity && u.city === dCity) score += 4;
    score = Math.max(72, Math.min(98, score));
    const n0 = [...(u.real_name || "校")][0];
    const shared = (overlap.length ? overlap : [...uTags]).slice(0, 3).join("、");
    const mc = maskCompany(u.company, u.city);
    alumni.push({
      target_type: "alumni", target_id: u.id,
      masked_name: `${n0}* · ${u.enroll_year} ${dept0(u.department)}`,
      city: u.city, campus: u.campus, masked_company: mc, position: u.position,
      core_capabilities: u.core_capabilities, industry_tags: [...uTags], can_provide_types: [...uProv],
      match_score: score, is_demo: !!u.is_demo,
      ai_reason: `${n0}*校友（${u.enroll_year}${dept0(u.department)} · ${u.city}）所属企业【${mc}】核心能力为“${u.core_capabilities}”，与您项目所需的【${shared}】形成高契合度上下游能力互补。`,
      complementarity: `需求方寻找【${dCat}】，供给方具备【${[...uProv].slice(0, 2).join(" / ")}】认证能力；关键技术/产业标签重合：${shared}。`,
      suggested_action: "建议先发起双向匿名对接意向，交换脱敏技术指标或商务需求清单；如涉及大额采购或定制研发，可勾选【委托丁香会中心节点人工撮合】协助签署居间与保密协议。",
    });
  }
  alumni.sort((a, b) => b.match_score - a.match_score);
  const top = alumni.slice(0, 4);
  const md: Any[] = [];
  for (const od of demands) {
    if (od.id === demand.id || od.user_id === dUid) continue;
    const odTags = new Set<string>(J(od.tags));
    const ov = inter(dTags, odTags);
    if (!ov.length && od.industry !== dInd) continue;
    md.push({
      demand_id: od.id, demand_code: od.demand_code, title: od.title, category: od.category, industry: od.industry,
      city: od.city, budget_scale: od.budget_scale, tags: [...odTags],
      match_score: Math.min(96, 76 + ov.length * 9 + (od.category !== dCat ? 6 : 2)),
      synergy_note: `该商机与您的项目在【${(ov.length ? ov : [dInd]).slice(0, 2).join("、")}】领域高度关联，可联合采购、共享渠道或协同交付。`,
    });
  }
  md.sort((a, b) => b.match_score - a.match_score);
  const topD = md.slice(0, 3);
  const best = top.length ? top[0].match_score : 88;
  return {
    best_match_score: best,
    summary_headline: `AI全库扫描完成：从 ${users.length} 位已认证校友与 ${demands.length} 条商机池中，为您精准锁定 ${top.length} 位高匹配度校友及 ${topD.length} 条协同商机（最高匹配度 ${best}%）。`,
    strategy_advice: `1. 优先对接首位匹配度 ${best}% 的 ${top.length ? top[0].masked_name : "同领域校友"}，双方在【${dInd}】产业链直接互补；\n2. 丁香会采用“先双向确认意向、再解锁实名微信/拉三方群”机制，保护校友商业隐私；\n3. 若项目涉及金额较大或需要校友背书，建议启用【中心节点人工深度撮合】，项目合作成功后可按意愿自愿回馈平台长期建设。`,
    matched_alumni: top, matched_demands: topD,
  };
}

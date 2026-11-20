// 화면과 상태. 계산은 scenario.js / sensitivity.js / classify.js가 한다.
import { compare, paramValues, quantitiesFromArea, paperMode, schedule, STREAMS, STREAM_LABEL, SEPARATED, SITES, LABOR_METHODS, EQUIPMENT, equipmentMode, selExtra, CONCRETE_CASES, DEFAULT_CONCRETE_CASE, streamTons, unbenefitedFinishLabor } from "./scenario.js";
import { VALIDATION_SCHEMA, MIN_CASES, SCOPES, PERIOD_UNITS, BENCHMARKS, validationCases, comparableCases, calibrateStructure, benchmark } from "./calibration.js";
import { variables, tornado, breakEven, simulate, histogram } from "./sensitivity.js";
import { classify, quantitiesFromElements, supplement, checkAgainstUnits, elementResults, toCsv, groupKey, CATEGORY_LABEL, isOpenSteelFrame } from "./classify.js";
import { stackedBars, tornadoChart, histChart, legend, mil, num } from "./charts.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const json = async (f) => (await fetch(`assets/data/${f}`)).json();
const [rates, paper, validationDoc] = await Promise.all([json("rates.json"), json("paper2023_case.json"), json("plan-validation.json")]);
const sampleCases = validationCases(validationDoc);
const defaults = paramValues(rates);

const TABS = [["model", "모델"], ["rates", "단가"], ["compare", "비교"], ["validation", "검증·보정"], ["export", "내보내기"]];
const STREAM_COLOR = { masonry: "#aa7259", concrete: "#9c9084", metal: "#4a6fa5", wood: "#b0783c", resin: "#c05a9a", glass: "#58b8d8", tile: "#9180a6", panel: "#ad9c5a", board: "#d9b23a", mixed: "#6f747d", copper: "#c8642a", aluminum: "#b8c4d0", excluded: "#d6d3ce" };
const METHOD_COLOR = { 분별: "#1baf7a", 압쇄: "#9c9084" };

const saved = (() => { try { return JSON.parse(localStorage.getItem("rc.state")) || {}; } catch { return {}; } })();
const oldDefaults = { crew_size: 20, window_frame_pd_per_m2: 0.0229, indirect_per_day: 500000, crew_standing: 3, crew_per_excavator: 1 };
const loadedParams = Object.fromEntries(Object.entries(saved.p || {}).filter(([k, v]) => (
  Object.hasOwn(defaults, k) && Number.isFinite(v) && !rates.params[k].locked
  && (saved.rateRevision >= 2 || oldDefaults[k] !== v)
)));
const caseMap = new Map(sampleCases.map((row) => [row.id, row]));
const localCases = new Map();
try {
  const local = JSON.parse(localStorage.getItem("rc.validation") || "null");
  if (local) for (const row of validationCases(local)) {
    const oldSample = local.revision !== 2 && caseMap.has(row.id)
      && (!row.verified || row.source === "논현동 124-1 해체계획서 p.9·19·40·118");
    if (!oldSample) localCases.set(row.id, row);
  }
} catch { /* 손상된 브라우저 데이터는 기본 목록으로 복구한다. */ }
const allCases = () => [...new Map([...caseMap, ...localCases]).values()];
const caseFields = ["height", "equipment", "scope", "structure", "scaffold", "equipmentCrewPeriod", "craneDays", "parallelGain", "overlap", "mixedMineral", "mixedCombustible",
  "cleanCrush", "cleanSel", "cleanPrice", "cableCrush", "cableSel", "cablePrice", "fittingCrush", "fittingSel", "fittingPrice", "carpenterShare", "boardM2", "tileM2", "pvcM2", "alM2", "generalFinishPd", "panelTons", "concreteCase", "groundFloors"];
const state = {
  tab: "model", source: null, fileName: "", model: null, elements: [], overrides: {},
  area: saved.area || 2400, floors: saved.floors || 5, usage: saved.usage || "공동주택", supplement: false,
  site: saved.site in SITES ? saved.site : "normal", labor: saved.labor in LABOR_METHODS ? saved.labor : "paper",
  equipment: "auto", scope: "unknown", structure: "rc", scaffold: "yes", equipmentCrewPeriod: "structure",
  ...Object.fromEntries(caseFields.filter((key) => saved[key] != null).map((key) => [key, saved[key]])),
  p: { ...defaults, ...loadedParams }, seed: 1, colorMode: "stream", busy: "", error: "",
  cases: allCases(), caseMessage: "", calibrationType: "plan", useCalibration: false,
};
let viewer = null, sim = null;
const save = () => {
  const settings = ["area", "floors", "usage", "site", "labor", ...caseFields];
  const values = Object.fromEntries(settings.map((key) => [key, state[key]]));
  const p = Object.fromEntries(Object.entries(state.p).filter(([key, value]) => value !== defaults[key]));
  try {
    if (state.source === "ifc" && state.fileKey) {
      const project = Object.fromEntries([...settings,"overrides","supplement","seed","caseId","useCalibration","calibrationType"].map(k => [k,state[k]]));
      project.supplementSelected = true;
      if (state.plan) project.planApplied = true;
      localStorage.setItem(state.fileKey, JSON.stringify(project));
    }
    localStorage.setItem("rc.state", JSON.stringify({ ...values, p, rateRevision: 3 })); }
  catch { /* 저장 불가여도 계산은 된다 */ }
};
const opts = (options, value) => Object.entries(options).map(([key, label]) =>
  `<option value="${key}" ${value === key ? "selected" : ""}>${label}</option>`).join("");
const numeric = (key, label, { max = "", placeholder = "미입력" } = {}) =>
  `<label class="field">${label}<input class="input" type="number" min="0" ${max === "" ? "" : `max="${max}"`} step="any" placeholder="${placeholder}" data-set="${key}" value="${state[key] ?? ""}"></label>`;
function projectInputs() {
  return {
    area_m2: state.area, floors: state.floors, site: state.site, labor: state.labor, equipment: state.equipment,
    scope: state.scope, structure: state.structure, height: state.height, scaffold: state.scaffold === "yes", equipmentCrewPeriod: state.equipmentCrewPeriod,
    craneDays: state.craneDays, groundFloors: state.groundFloors, parallelGain: (state.parallelGain ?? 0) / 100, overlap: (state.overlap ?? 0) / 100,
    mixedMineral: (state.mixedMineral ?? 0) / 100, mixedCombustible: (state.mixedCombustible ?? 0) / 100,
    cleanCrush: state.cleanCrush, cleanSel: state.cleanSel, cleanPrice: state.cleanPrice, cableCrush: state.cableCrush, cableSel: state.cableSel, cablePrice: state.cablePrice, fittingCrush: state.fittingCrush, fittingSel: state.fittingSel, fittingPrice: state.fittingPrice, carpenterShare: state.carpenterShare,
    generalFinishPd: state.generalFinishPd, concreteCase: state.concreteCase ?? DEFAULT_CONCRETE_CASE, caseId: state.caseId || state.plan?.source?.validation_id,
  };
}

function derive() {
  if (!state.source) return null;
  let classified = [], q, openSteelFrame = false;
  if (state.source === "ifc") {
    const included = state.scope === "above" ? state.elements.filter(e => !e.basement && e.category !== "footing") : state.elements;
    classified = included.map((e) => classify(e, rates, state.overrides));
    const raw = quantitiesFromElements(classified, state.area);
    openSteelFrame = isOpenSteelFrame(classified);
    q = state.supplement && !openSteelFrame ? supplement(raw, state.usage, rates) : { ...raw, added: {} };
    q.raw = raw;
    q.supplemented = state.supplement && !openSteelFrame;
  } else q = { ...quantitiesFromArea(state.area, state.usage, rates), added: {} };
  Object.assign(q, projectInputs());
  const manualAreas = { board: state.boardM2, tile: state.tileM2, pvc: state.pvcM2, aluminum: state.alM2 };
  if (state.plan?.rebar_kg_per_m3?.value && state.p.rebar_kg_per_m3 === defaults.rebar_kg_per_m3) q.rebarKgPerM3 = state.plan.rebar_kg_per_m3.value;
  q.finishAreas = { ...q.finishAreas, ...Object.fromEntries(Object.entries(manualAreas).filter(([, value]) => value != null)) };
  q.panelWeightMissing = classified.some((el) => el.parts.some((part) => part.stream === "panel")) && state.panelTons == null;
  q.t.panel = state.panelTons ?? q.t.panel;
  if (state.useCalibration) {
    const cal = calibrateStructure(state.cases, q, state.p, state.calibrationType);
    if (cal.ready) q.structureFactor = cal.factor;
  }
  return { classified, q, openSteelFrame, cmp: openSteelFrame ? null : compare(q, state.p) };
}

/* ---------------- 모델 ---------------- */
// 해체계획서 데이터(JSON) → 구조체 IFC를 만들어 그대로 읽어 들인다
async function loadPlan(plan, name) {
  try {
    if (plan.schema !== "reclaim-plan/1") throw new Error('schema가 "reclaim-plan/1"이 아닙니다');
    const { planToIfc, planConditions } = await import("./plan.js");
    const b = plan.building || {};
    if (rates.wasteUnits[b.wasteUnit]) state.usage = b.wasteUnit;
    const conditions = planConditions(plan, { sites: SITES, equipments: EQUIPMENT });
    await loadIfc(new TextEncoder().encode(planToIfc(plan)).buffer, `${name} → 자동 생성 구조체 모델`, b.demolition_area_m2 || b.area_m2, plan, conditions);
  } catch (e) {
    state.error = `계획서 데이터를 읽지 못했습니다: ${e.message}`; render();
  }
}

let loadVersion = 0;
async function loadIfc(buffer, name, area, plan = null, conditions = null) {
  const version = ++loadVersion;
  state.busy = "IFC를 읽는 중입니다…"; state.error = ""; render();
  try {
    const { parseIfc } = await import("./ifc.js");
    const model = await parseIfc(buffer);
    if (!model.elements.some(e => e.category !== "other" && e.volume > 0)) throw new Error("비용 산정에 사용할 건축 부재 물량을 찾지 못했습니다.");
    const b = plan?.building;
    const hash = await crypto.subtle.digest("SHA-256", buffer);
    if (version !== loadVersion) return;
    const fileKey = "rc.ifc." + Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2,"0")).join("") + (plan ? JSON.stringify(plan.building) : "");
    let previous;
    try { previous = JSON.parse(localStorage.getItem(fileKey)); } catch {}
    if (previous && !previous.supplementSelected) previous.supplement = false;
    Object.assign(state, { fileKey, plan, source: "ifc", model, elements: model.elements, fileName: name, overrides: {}, caseId: "",
      ...Object.fromEntries(caseFields.map((key) => [key, undefined])),
      area: area || Math.round(model.gross.area),
      floors: b?.floors_above || model.aboveFloors || model.floors });
    Object.assign(state, { height: b?.height_m, usage: b?.wasteUnit in rates.wasteUnits ? b.wasteUnit : model.usage || "공동주택",
      labor: "quantity", equipment: "auto", scope: "unknown", structure: "rc", scaffold: "yes", site: "normal",
      equipmentCrewPeriod: "structure", supplement: false, seed: 1, useCalibration: false, calibrationType: "plan" }, previous,
      // 계획서의 현장·장비 조건은, 이 기능 이전에 저장된 값(기본값 "보통")보다 우선한다. 이후 사용자가 고친 값은 유지한다.
      conditions && !previous?.planApplied ? conditions.values : {});
    state.planNotes = conditions?.notes ?? [];
    state.tab = "compare"; state.colorMode = "method";
  } catch (e) {
    if (version !== loadVersion) return;
    state.tab = "model";
    state.error = `IFC를 읽지 못했습니다: ${e.message}`;
  }
  state.busy = ""; sim = null; save(); render();
}

function modelTab(d) {
  const input = `
    <section class="card">
      <h2>1. 물량 입력</h2>
      <div class="drop" id="drop">
        <p><strong>Revit에서 내보낸 IFC 파일</strong>을 여기에 끌어 놓거나 고르세요. (Revit: 파일 › 내보내기 › IFC)</p>
        <div class="row no-print">
          <label class="btn btn-primary">IFC 파일 고르기<input type="file" id="file" accept=".ifc" hidden></label>
          <button class="btn btn-outline" data-act="sample">예시 모델 불러오기</button>
          <button class="btn btn-outline" data-act="area">IFC 없이 면적만으로 계산</button>
        </div>
        <p style="margin-top:8px"><strong>Revit 모델이 없으면</strong> 해체계획서의 구조도면을 옮긴 데이터(JSON)로 구조체 모델을 자동 생성합니다.</p>
        <div class="row no-print">
          <label class="btn btn-outline">계획서 데이터(JSON) 고르기<input type="file" id="planfile" accept=".json" hidden></label>
          <button class="btn btn-outline" data-act="plan-sample">계획서 예시 (가상 건물)</button>
        </div>
        ${state.busy ? `<p class="badge badge-info">${esc(state.busy)}</p>` : ""}
        ${state.error ? `<p class="badge badge-danger">${esc(state.error)}</p>` : ""}
        ${state.source ? `<p class="caption muted">현재: ${state.source === "ifc" ? `IFC · ${esc(state.fileName)} · 부재 ${num(state.elements.length)}개 · ${state.model.floors}개 층` : "면적 × 표준품셈 원단위 (간이 계산)"}</p>` : ""}
      </div>
      <div class="form-grid" style="margin-top:16px">
        <div class="field"><label>해체 대상 면적 (㎡)</label><input class="input" type="number" min="1" step="any" data-set="area" value="${state.area}"></div>
        <div class="field"><label>지상 층수 (공기 계산용)</label><input class="input" type="number" min="1" step="1" data-set="floors" value="${state.floors}"></div>
        <div class="field"><label>용도·구조 (원단위 기준)</label><select class="select" data-set="usage">${Object.keys(rates.wasteUnits).map((u) => `<option ${u === state.usage ? "selected" : ""}>${u}</option>`).join("")}</select></div>
        <div class="field"><label>대지 조건 (장비 구성)</label><select class="select" data-set="site">${Object.entries(SITES).map(([k, v]) => `<option value="${k}" ${k === state.site ? "selected" : ""}>${v}</option>`).join("")}</select></div>
        <div class="field"><label>분별 추가 품 계산</label><select class="select" data-set="labor">${Object.entries(LABOR_METHODS).map(([k, v]) => `<option value="${k}" ${k === state.labor ? "selected" : ""}>${v}</option>`).join("")}</select></div>
        ${state.source === "ifc" ? `<div class="field"><label>모델에 없는 내장재</label><label class="row"><input type="checkbox" data-set="supplement" ${d?.openSteelFrame ? "disabled" : state.supplement ? "checked" : ""}> ${d?.openSteelFrame ? "개방형 철골 · 보충 생략" : "원단위로 보충한다"}</label></div>` : ""}
      </div>
      <details id="site-details" style="margin-top:14px"><summary>현장 조건·자재 면적 입력</summary>
        <p>기본 집계 대상은 파일의 전체 건축 부재입니다. 지상부를 선택하면 기초와 층 이름에서 식별된 지하 부재를 제외합니다. 부분 철거는 대상 부재만 내보낸 IFC를 사용하세요.</p>
        <div class="form-grid" style="margin-top:12px">
          ${numeric("height", "건물 높이 (m)")}
          <label class="field">구조체 <select class="select" data-set="structure">${opts({ rc: "철근콘크리트", other: "기타·복합 구조" }, state.structure)}</select></label>
          <label class="field">해체 범위 <select class="select" data-set="scope">${opts(SCOPES, state.scope)}</select></label>
          <label class="field">장비 운용 방식 <select class="select" data-set="equipment">${opts(EQUIPMENT, state.equipment)}</select></label>
          <label class="field">가설 비계 <select class="select" data-set="scaffold">${opts({ yes: "비계공 투입", no: "비계공 0명" }, state.scaffold)}</select></label>
          <label class="field">굴착기 연동 살수·신호 배치 기간 <select class="select" data-set="equipmentCrewPeriod">${opts({ structure: "구조체 작업일 (팀 기본값)", all: "전체 작업일" }, state.equipmentCrewPeriod)}</select></label>
          ${numeric("craneDays", "탑재 해체 크레인 사용 일수")}
          ${numeric("groundFloors", "탑재 방식 · 지상 장비로 해체하는 하부 층수", { placeholder: `기본 ${state.p.mounted_ground_floors}개 층` })}
          ${numeric("parallelGain", "추가 굴착기 1대당 병렬 효율 (%)", { max: 100, placeholder: "기본 0%" })}
          ${numeric("overlap", "분별 추가 작업의 타 공정 병행률 (%)", { max: 100, placeholder: "기본 0%" })}
          ${numeric("mixedMineral", "혼합·기타 중 확인된 건설폐재류 (%)", { max: 100 })}
          ${numeric("mixedCombustible", "혼합·기타 중 확인된 가연물 (%)", { max: 100 })}
          <p>별도 반입 콘크리트에만 처리장 견적을 적용합니다. 나머지 폐콘크리트에만 공법별 배분을 적용합니다. 조적은 건설폐재류 단가를 적용합니다.</p>
          ${numeric("cleanCrush","압쇄 · 별도 반입 콘크리트 (%)",{max:100})}
          ${numeric("cleanSel","분별 · 별도 반입 콘크리트 (%)",{max:100})}
          ${numeric("cleanPrice","동일 반입 조건 처리장 견적 (원/t)")}
          <p>국민권익위원회의 고재처리 자료와 나라장터 철거 시방서에 따라 현장에서 확인한 매각 가능 물량을 입력합니다. 추가 고재는 기존 금속 물량에서 빠진 품목만 입력하세요. 피복 포함 전선은 피복 상태의 인수 견적을 사용합니다.</p>
          ${[["cable","폐전선"],["fitting","철거 배관·설비"]].map(([key,label]) => numeric(key+"Crush",label+" · 압쇄 매각 (t)") + numeric(key+"Sel",label+" · 분별 매각 (t)") + numeric(key+"Price",label+" · 순매입 견적 (원/t)")).join("")}
          ${numeric("panelTons", "폐샌드위치패널 확인 중량 (t)")}
          ${state.labor === "quantity" ? [
            numeric("boardM2", "보드 면적 (㎡)", { placeholder: "IFC 또는 면적비" }),
            numeric("tileM2", "타일 면적 (㎡)", { placeholder: "IFC 또는 면적비" }),
            numeric("pvcM2", "PVC 창틀 면적 (㎡)", { placeholder: "IFC 또는 면적비" }),
            numeric("alM2", "알루미늄 창틀 면적 (㎡)", { placeholder: "IFC 또는 면적비" }),
            numeric("carpenterShare","추가 공수 중 목공 (%)",{max:100}),
            numeric("generalFinishPd", "동일 범위의 일반해체 공수 (인·일)", { placeholder: "기본: 내부 철거 공수 차감" }),
          ].join("") : ""}
        </div>
        <p class="caption muted" style="margin-top:8px">비율 합계에서 남는 혼합·기타 물량은 성상 미확인으로 계산합니다. 높이는 비교 기록에 쓰입니다. 장비 방식은 현장 조건에 맞춰 지정하세요. 작업량 방식의 공란 면적은 식별된 IFC 물량 또는 면적비를 사용합니다.</p>
      </details>
      ${state.formError ? `<p class="badge badge-danger">${esc(state.formError)}</p>` : ""}
      ${state.source === "ifc" ? `<p class="caption muted" style="margin-top:8px">연면적과 층수는 모델에서 읽어 넣어 두었습니다. 연면적은 ${state.model?.gross?.basis === "slab" ? "바닥 슬래브 면적의 합" : "모델에 바닥 슬래브가 없어 외곽 크기 × 층수로 잡은 값(실제보다 클 수 있음)"}, 층수는 층 이름에서 식별한 지하·옥상 레벨을 제외해 추정합니다. 실제 값과 다르면 고치세요.${state.model?.lengthScale && state.model.lengthScale !== 1 ? ` 이 파일의 길이 단위는 ${state.model.lengthScale === 0.001 ? "mm" : `${state.model.lengthScale} m`}이며 m로 바꿔 계산했습니다.` : ""}</p>` : ""}
      ${state.planNotes?.length ? `<p class="caption muted">계획서에서 가져온 현장 조건: ${esc(state.planNotes.join(" · "))}. 실제와 다르면 현장 조건·자재 면적 입력에서 고치세요.</p>` : ""}
    </section>`;
  if (!d) return input;

  const { q, classified } = d;
  const total = STREAMS.reduce((s, k) => s + q.t[k], 0);
  // 비교 계산과 같은 기준: 콘크리트 톤수에서 추정 철근을 빼서 철근·강재 행에 넣는다
  const { t: shown, rebar } = streamTons(q, state.p);
  const units = rates.wasteUnits[state.usage];
  const check = state.source === "ifc" && !d.openSteelFrame ? checkAgainstUnits(q.raw, state.usage, rates) : [];
  const off = check.filter((c) => c.ratio < 0.5 || c.ratio > 2);
  const streamRows = STREAMS.filter((s) => shown[s] > 0).map((s) => {
    const added = q.added[s] || 0, u = units[s];
    const label = s === "metal" && rebar > 0 ? `${STREAM_LABEL[s]} <span class="muted">(철근 추정 ${num(rebar, 1)}t 포함)</span>` : s === "concrete" && rebar > 0 ? `${STREAM_LABEL[s]} <span class="muted">(철근 제외)</span>` : STREAM_LABEL[s];
    return `<tr><td><i class="dot" style="background:${STREAM_COLOR[s]}"></i> ${label}</td>
      <td class="r">${num(shown[s] - added, 1)}</td><td class="r">${added ? num(added, 1) : "–"}</td><td class="r">${num(shown[s], 1)}</td>
      <td class="r">${num(shown[s] / q.area_m2, 4)}</td><td class="r">${u != null ? num(u, 4) : s === "masonry" ? "별도 원단위 없음" : "–"}</td>
      <td>${SEPARATED.has(s) ? '<span class="badge badge-success">분별 대상</span>' : ""}</td></tr>`;
  }).join("");

  let groups = "";
  if (state.source === "ifc") {
    const g = new Map();
    for (const el of classified) {
      const k = groupKey(el), x = g.get(k) || { el, n: 0, tons: 0, guessed: false };
      x.n++; x.tons += el.tons; x.guessed ||= el.guessed;
      g.set(k, x);
    }
    groups = `<section class="card"><h2>부재 그룹별 성상</h2>
      <p class="lead" style="margin-bottom:12px">재료 이름으로 성상을 자동 분류했습니다. 틀린 곳은 직접 고치세요. <span class="badge badge-warning">추정</span>은 재료 이름으로 알 수 없어 부재 종류로 정한 것입니다.</p>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>부재</th><th>재료 (IFC)</th><th class="r">개수</th><th class="r">톤</th><th>성상</th></tr></thead><tbody>
      ${[...g].sort((a, b) => b[1].tons - a[1].tons).map(([k, x]) => `<tr><td>${CATEGORY_LABEL[x.el.category]}</td><td>${esc(x.el.layers.map((l) => l.name).join(" + ") || "(재료 없음)")} ${x.guessed ? '<span class="badge badge-warning">추정</span>' : ""}</td>
        <td class="r">${num(x.n)}</td><td class="r">${num(x.tons, 2)}</td>
        <td><select class="select sm" data-override="${esc(k)}"><option value="">자동 (${x.el.parts.length > 1 && !state.overrides[k] ? "층별" : STREAM_LABEL[x.el.stream]})</option>${[...STREAMS, "excluded"].map((s) => `<option value="${s}" ${state.overrides[k] === s ? "selected" : ""}>${STREAM_LABEL[s]}</option>`).join("")}</select></td></tr>`).join("")}
      </tbody></table></div></section>`;
  }

  return `${input}
    <section class="kpis">
      <div class="card kpi"><div class="v">${num(total)} t</div><div class="l">예상 폐기물·자재 총량</div></div>
      <div class="card kpi"><div class="v">${num(total / q.area_m2, 3)}</div><div class="l">t/㎡ (원단위 합계 ${num(Object.values(units).reduce((a, b) => a + b, 0), 3)})</div></div>
      <div class="card kpi"><div class="v">${num(q.concrete_m3)} ㎥</div><div class="l">구조체 콘크리트 부피</div></div>
      <div class="card kpi"><div class="v">${num(STREAMS.filter((s) => SEPARATED.has(s)).reduce((s, k) => s + q.t[k], 0), 1)} t</div><div class="l">분별 대상 물량</div></div>
    </section>
    ${off.length ? `<div class="disclaimer"><div><strong>원단위 검산:</strong> ${off.map((c) => `${STREAM_LABEL[c.stream]} ${num(c.ratio * 100)}%`).join(", ")} — 모델 물량이 표준품셈 원단위와 2배 이상 차이 납니다. 모델에 해당 자재가 빠졌거나 분류가 틀렸을 수 있습니다.${state.supplement ? " 목재·합성수지·혼합폐기물의 부족분은 원단위로 채웠습니다." : ""}</div></div>` : ""}
    ${(() => { const ex = classified.filter((e) => e.stream === "excluded"); return ex.length ? `<p class="caption muted">기타 객체 ${num(ex.length)}개(가구·가전·위생기구·조경 등, 모델 값 ${num(ex.reduce((a, e) => a + e.tons, 0))} t)는 건물 부재가 아니고 부피를 믿기 어려워 물량에서 뺐습니다. 넣으려면 아래 부재 그룹 표에서 성상을 고르세요.</p>` : ""; })()}
    ${planCard(q)}
    ${state.source === "ifc" ? `<section class="card"><h2>3D 모델</h2>${viewerBox()}</section>` : ""}
    <section class="card"><h2>성상별 물량</h2>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>성상</th><th class="r">${state.source === "ifc" ? "모델 (t)" : "원단위 (t)"}</th><th class="r">보충 (t)</th><th class="r">합계 (t)</th><th class="r">t/㎡</th><th class="r">표준품셈 원단위</th><th></th></tr></thead>
      <tbody>${streamRows}</tbody><tfoot><tr><td>합계</td><td></td><td></td><td class="r">${num(total, 1)}</td><td class="r">${num(total / q.area_m2, 4)}</td><td></td><td></td></tr></tfoot></table></div>
      ${q.rebarFromConcrete ? `<p class="caption muted" style="margin-top:8px">철근은 모델에 없어 콘크리트 1㎥당 ${num(q.rebarKgPerM3 ?? state.p.rebar_kg_per_m3)}kg으로 추정해 고철 수익에 넣습니다 (약 ${num((q.concrete_m3 * (q.rebarKgPerM3 ?? state.p.rebar_kg_per_m3)) / 1000, 1)} t). 콘크리트 톤수는 철근콘크리트 단위질량 2.4t/㎥로 계산했으므로, 같은 무게를 폐콘크리트에서 빼고 처리비를 계산합니다.${q.masonry_m3 > 0 ? ` 조적 ${num(q.masonry_m3, 1)}㎥도 압쇄 장비 시간과 구조체 공기에 넣습니다.` : ""}</p>` : ""}
    </section>
    ${groups}`;
}

// 계획서에서 만든 모델이면 계획서 내용과 검산 결과를 보여준다
function planCard(q) {
  const plan = state.plan;
  if (!plan || state.source !== "ifc") return "";
  const b = plan.building, d = plan.demolition || {}, model = (q.raw || q).t.concrete, want = plan.check?.waste_concrete_t;
  const assumed = Object.entries(plan.sections).filter(([, s]) => s.assumed).map(([k]) => k);
  return `<section class="card"><h2>해체계획서에서 읽은 정보</h2>
    <div class="table-wrap"><table class="tbl"><tbody>
      <tr><th>건물</th><td>${esc(b.name)} · ${esc(b.usage)} · ${esc(b.structure)} · ${b.built}년 · 지하 ${b.floors_below} / 지상 ${b.floors_above}층</td></tr>
      <tr><th>면적</th><td>연면적 ${num(b.area_m2, 1)}㎡ · 해체 연면적 ${num(b.demolition_area_m2, 2)}㎡</td></tr>
      <tr><th>해체</th><td>${esc(d.scope || "–")} · ${esc(d.method || "–")}${d.period ? ` · ${d.period.join(" ~ ")}` : ""}</td></tr>
      <tr><th>재료</th><td>콘크리트 ${plan.materials.concrete_fck_MPa}MPa · 철근 ${plan.materials.rebar_fy_MPa}MPa · 철근량 ${num(plan.rebar_kg_per_m3?.value || 0)}kg/㎥ (${esc(plan.rebar_kg_per_m3?.note || "")})</td></tr>
      <tr><th>유해물질</th><td>석면 ${plan.hazards?.asbestos ? "검출" : "불검출"}</td></tr>
      <tr><th>부재</th><td class="mono">${Object.entries(plan.sections).map(([k, s]) => `${k} ${s.t ? "T" + s.t : s.b + "×" + s.h}`).join(" · ")}</td></tr>
    </tbody></table></div>
    ${want ? `<p style="margin-top:12px"><strong>검산:</strong> 생성한 모델의 콘크리트 ${num(model)}t ÷ 계획서 폐콘크리트 약 ${num(want)}t = <strong>${num((model / want) * 100)}%</strong>. 물량 비교에는 부재 포함 범위와 산출 기준의 차이가 있을 수 있습니다.</p>` : ""}
    <p class="caption muted" style="margin-top:8px">구조체(기둥·보·벽·슬래브)와 바닥 마감 몰탈만 들어 있습니다. 내장재·창호·설비는 계획서에 없어 원단위로 보충합니다.${assumed.length ? ` 치수를 가정한 부재: ${assumed.join(", ")}.` : ""} ${esc(plan.source?.note || "")}</p>
  </section>`;
}

function viewerBox() {
  const items = state.colorMode === "stream" ? STREAMS.map((s) => [STREAM_LABEL[s], STREAM_COLOR[s]]) : [["분별해체 대상", METHOD_COLOR.분별], ["구조체와 함께 압쇄 (반투명)", METHOD_COLOR.압쇄]];
  return `<div class="viewer" id="viewer"><div class="modes no-print">
      <button class="btn btn-sm ${state.colorMode === "stream" ? "btn-secondary" : "btn-outline"}" data-color="stream">성상별</button>
      <button class="btn btn-sm ${state.colorMode === "method" ? "btn-secondary" : "btn-outline"}" data-color="method">분별 / 압쇄</button>
    </div><div class="pick" id="pick">부재를 누르면 정보가 나옵니다. 끌어서 돌리고, 휠로 확대합니다.</div></div>${legend(items)}`;
}

async function mountViewer(d) {
  viewer?.dispose(); viewer = null;
  const box = $("#viewer");
  if (!box || !state.model) return;
  const byId = new Map(d.classified.map((e) => [e.expressID, e]));
  const color = (id) => { const e = byId.get(id); if (!e) return null; if (state.colorMode === "stream") return STREAM_COLOR[e.stream]; return SEPARATED.has(e.stream) ? METHOD_COLOR.분별 : [METHOD_COLOR.압쇄, 0.06]; }; // 압쇄 대상은 비쳐 보이게 해서 안쪽 내장재가 드러난다
  const { createViewer } = await import("./viewer3d.js");
  viewer = createViewer(box, state.model, color, (id) => {
    const e = byId.get(id);
    $("#pick").innerHTML = e ? `<strong>${CATEGORY_LABEL[e.category]}</strong> ${esc(e.name)} · ${e.floor}층 · ${num(e.tons, 3)} t · ${STREAM_LABEL[e.stream]} · ${SEPARATED.has(e.stream) ? "분별" : "압쇄"}<br><span class="muted">${esc(e.layers.map((l) => l.name).join(" + ") || "재료 없음")} · Revit ID ${esc(e.tag || "–")}</span>` : "부재를 누르면 정보가 나옵니다.";
  });
}

/* ---------------- 단가 ---------------- */
function ratesTab() {
  const r = paperMode(paper), ok = r.delta === paper.expected.delta;
  let last = "", rows = "";
  for (const [k, v] of Object.entries(rates.params)) {
    if (v.group !== last) { rows += `<tr class="grp"><td colspan="5">${v.group}</td></tr>`; last = v.group; }
    const changed = state.p[k] !== v.value;
    const shown = v.optional && state.p[k] < 0 ? "" : state.p[k];
    rows += `<tr><td>${esc(v.label)} ${v.assumed ? '<span class="badge badge-warning">가정</span>' : ""} ${changed ? '<span class="badge badge-info">수정됨</span>' : ""}</td>
      <td class="r"><input class="input sm" type="number" step="any" data-p="${k}" value="${shown}" ${v.locked ? "disabled" : ""} ${v.optional ? 'placeholder="미확인"' : ""}></td><td>${v.unit}</td>
      <td class="muted">${v.min != null ? `${num(v.min, v.min < 1 ? 5 : v.min < 10 ? 2 : 0)} ~ ${num(v.max, v.min < 1 ? 5 : v.min < 10 ? 2 : 0)}${v.sample === false ? " (대안 비교용)" : ""}` : "–"}</td>
      <td class="muted">${esc(rates.sources[v.source] || "출처 없음 (잠정값)")}${v.date ? ` · ${v.date}` : ""}${v.ref ? `<br><small>${esc(v.ref)}</small>` : ""}</td></tr>`;
  }
  return `<section class="card"><div class="row" style="justify-content:space-between"><h2>단가·품·회수율</h2><button class="btn btn-outline btn-sm no-print" data-act="reset">기본값으로 되돌리기</button></div>
      <p class="lead" style="margin-bottom:12px">값을 고치면 비교 결과가 바로 다시 계산됩니다. 확률 분석은 계산 범위가 있는 항목을 변화시킵니다. 대안 비교용 값과 서로 다른 조건의 공고 단가는 별도로 비교합니다.</p>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>항목</th><th class="r">값</th><th>단위</th><th>범위 (최소 ~ 최대)</th><th>출처 · 기준</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>
    <section class="card"><h2>엔진 검증: 기준 논문 재현 <span class="badge ${ok ? "badge-success" : "badge-danger"}">${ok ? "일치" : "불일치"}</span></h2>
      <p class="lead" style="margin-bottom:12px">${esc(rates.sources.paper)}의 5층 공동주택 2,400㎡ 사례를 같은 식으로 계산한 결과입니다 (단위: 천원).</p>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>항목</th><th class="r">일반 해체</th><th class="r">분별 해체</th><th class="r">논문 값</th></tr></thead><tbody>
        <tr><td>시공비</td><td class="r">${num(r.construction[0])}</td><td class="r">${num(r.construction[1])}</td><td class="r">${paper.expected.construction.map((x) => num(x)).join(" / ")}</td></tr>
        <tr><td>폐기물 처리비</td><td class="r">${num(r.disposal[0])}</td><td class="r">${num(r.disposal[1])}</td><td class="r">${paper.expected.disposal.map((x) => num(x)).join(" / ")}</td></tr>
        <tr><td>재활용 수익</td><td class="r">–</td><td class="r">${num(r.revenue)}</td><td class="r">${num(paper.expected.revenue)}</td></tr>
        </tbody><tfoot><tr><td>Δ (분별 − 일반)</td><td></td><td class="r">${num(r.delta)}</td><td class="r">${num(paper.expected.delta)}</td></tr></tfoot></table></div>
      <p class="caption muted" style="margin-top:8px">논문은 재활용 수익을 제품 판매가(합판 4,000원/장, 그래뉼 850천원/t)로 잡았습니다. 이 프로그램의 비교는 폐자재 매각가를 기본으로 씁니다.</p>
    </section>`;
}

/* ---------------- 비교 ---------------- */
function openSteelNotice(d) {
  return `<section class="card"><h2>개방형 철골 모델 · 경제성 산정 보류</h2>
    <p>${esc(state.fileName)} · IFC 집계 고철 ${num(d.q.t.metal, 2)}t · 콘크리트 ${num(d.q.t.concrete, 2)}t</p>
    <p>벽·바닥·지붕이 없는 철골 모델로 감지했습니다. 건축물 원단위 보충을 생략했습니다. 철골 절단·인양·반출의 공법별 작업량과 견적이 있어야 순비용을 비교할 수 있습니다.</p>
    <button class="btn btn-outline" data-tab="model">IFC 물량 보기</button></section>`;
}

function compareTab(d) {
  if (!d) return empty();
  if (d.openSteelFrame) return openSteelNotice(d);
  const { q, cmp } = d, { crush, selective, delta } = cmp, p = state.p;
  const vars = variables(rates);
  sim ||= simulate(q, p, vars, { n: 5000, seed: state.seed });
  const better = delta < 0 ? "전면 분별해체" : "일괄 압쇄";
  const issues = [...new Set([...crush.issues, ...selective.issues])];
  const finishLabor = unbenefitedFinishLabor(q, p);
  const equality = delta === 0;
  const gradeOptions = Object.fromEntries(Object.entries(CONCRETE_CASES).map(([key, input]) => [key, input.label]));
  const gradeRows = Object.entries(CONCRETE_CASES).map(([key, input]) => {
    const result = key === q.concreteCase ? cmp : compare({ ...q, concreteCase: key }, p);
    return `<tr><td>${input.label}${key === q.concreteCase ? " (적용 중)" : ""}</td><td>${input.shares.map(x => Math.round(x * 100)).join(" / ")}</td><td class="r">${mil(result.crush.total, 2)}</td><td class="r">${mil(result.selective.total, 2)}</td><td class="r">${mil(result.delta, 2)}</td></tr>`;
  }).join("");
  const rawComparison = q.supplemented ? compare({ ...q, t: { ...q.t, wood: q.raw.t.wood, resin: q.raw.t.resin, mixed: q.raw.t.mixed } }, p) : null;
  const work = selExtra(q, p);
  const indirect = rates.params.indirect_per_day;
  const crewOnWholeJob = q.equipmentCrewPeriod === "all";
  const alternatePrices = [
    ["폐목재 유상 처리 사례 (운반·선별·VAT 포함)", { net_wood: -80000 }],
    ["폐합성수지 유상 처리 사례 (소각, 운반 별도)", { net_resin: -220000 }],
    ["폐합성수지 매각 사례 (소형가전 파쇄물)", { net_resin: 258000 }],
  ];
  const resinSwitch = breakEven(q, p, "net_resin", -1000000, 5000000);
  const paperAlt = q.labor === "paper" ? compare(q, { ...p, sel_extra_laborer: 0.325 }) : null;
  const mixLabel = { mineral: "건설폐재류", glass: "유리·타일", board: "보드", unknown: "미확인", none: "해당 없음" };
  const torn = tornado(q, p, vars).filter((t) => t.span > 1).slice(0, 10);

  const be = vars.map((v) => {
    const x = breakEven(q, p, v.key, v.min, v.max); // 범위 밖에서만 뒤집히는 변수는 뺀다
    if (x == null) return "";
    const up = compare(q, { ...p, [v.key]: x + Math.max(1e-9, (v.max - v.min) * 1e-6) }).delta < 0;
    const f = (n) => num(n, v.unit === "비율" ? 2 : v.unit === "인·일/㎡" ? 5 : 0);
    return `<li><strong>${esc(v.label)}</strong>: <strong>${f(x)} ${v.unit === "비율" ? "" : v.unit}</strong> ${up ? "이상" : "이하"}이면 분별해체가 유리 <span class="muted">(현재 ${f(p[v.key])}, 범위 ${f(v.min)} ~ ${f(v.max)})</span></li>`;
  }).filter(Boolean).join("");

  // 내역: 두 안의 같은 항목을 한 줄에
  const ORDER = ["인건비", "장비비", "처리비", "간접비", "매각수익"];
  const keys = [...new Set([...crush.rows, ...selective.rows].map((r) => `${r.group}|${r.item}`))]
    .sort((a, b) => ORDER.indexOf(a.split("|")[0]) - ORDER.indexOf(b.split("|")[0]));
  const find = (s, k) => s.rows.find((r) => `${r.group}|${r.item}` === k);
  let last = "", detail = "";
  for (const k of keys) {
    const a = find(crush, k), b = find(selective, k), r = a || b;
    if (r.group !== last) { detail += `<tr class="grp"><td colspan="7">${r.group}</td></tr>`; last = r.group; }
    const cell = (x) => x ? `<td class="r">${num(x.qty, x.qty < 100 ? 1 : 0)} ${x.unit}</td><td class="r">${mil(x.amount, 2)}</td>` : `<td class="r">–</td><td class="r">–</td>`;
    detail += `<tr><td>${esc(r.item)}</td><td class="r">${a && b && a.price !== b.price ? `${num(a.price)} / ${num(b.price)}` : num(r.price)}</td>${cell(a)}${cell(b)}<td class="r">${mil((b?.amount || 0) - (a?.amount || 0), 2)}</td></tr>`;
  }

  return `<section class="card">
      ${state.source === "ifc" ? `<p>${esc(state.fileName)} · 산정 면적 ${num(q.area_m2,2)}㎡ · ${num(q.floors)}층 · 집계 ${num(d.classified.length)}개 부재</p><p class="caption muted">범위 ${q.scope === "above" ? "식별된 지하·기초 제외" : "입력 모델 전체"} · 원단위 ${esc(state.usage)}${state.supplement ? " 적용" : " 보충 꺼짐"} · 용도·현장 조건 미확인 시 기본 가정을 사용합니다. <button class="btn" data-tab="model">입력 근거 확인</button></p>` : ""}
      <p class="verdict">포함 항목 기준 추정 · ${equality ? "두 공법의 순비용이 같습니다." : `<strong>${better}</strong>의 순비용이 ${mil(Math.abs(delta))}백만원 낮습니다.`}</p>
      ${finishLabor ? `<div class="disclaimer"><div><strong>보드·타일 철거 비용의 효과가 계산에 없습니다.</strong> 분별안에 보드·타일 철거 비용 ${mil(finishLabor.cost, 1)}백만원(인건비와 늘어난 공기의 간접비·상시 인원)이 들어가지만, 떼어 낸 보드·타일을 따로 처리하는 효과(보드 분리율·별도 처리 견적)와 폐콘크리트 성상 개선은 현재 0입니다.${finishLabor.sharePoints != null ? ` 이 비용을 콘크리트 성상 개선만으로 상쇄하려면 폐콘크리트의 ${num(finishLabor.sharePoints, 0)}%p를 건설폐재류에서 순수 폐콘크리트로 옮겨야 합니다.` : ""} 단가 탭의 보드 분리율·처리 견적, 아래의 폐콘크리트 배분, 현장 조건의 별도 반입 견적으로 효과를 넣을 수 있습니다.</div></div>` : ""}
      ${issues.length ? `<ul class="caption muted">${issues.map((issue) => `<li>${esc(issue)}</li>`).join("")}</ul>` : ""}
      <p class="caption muted">5,000회 비교의 ${num(sim.pSelective * 100, 1)}%에서 분별 순비용이 더 낮았습니다. 이 비율은 입력한 탐색 범위와 삼각분포에 따른 값입니다.</p>
    </section>
    <section class="kpis">
      <div class="card kpi"><div class="v">${mil(crush.total)}</div><div class="l">일괄 압쇄 순비용 (백만원)</div><div class="s">공기 ${num(crush.days)}일</div></div>
      <div class="card kpi"><div class="v">${mil(selective.total)}</div><div class="l">전면 분별해체 순비용 (백만원)</div><div class="s">공기 ${num(selective.days)}일 (+${num(cmp.deltaDays, 1)}일)</div></div>
      <div class="card kpi"><div class="v">${delta > 0 ? "+" : delta < 0 ? "−" : ""}${mil(Math.abs(delta))}</div><div class="l">Δ = 분별 − 압쇄 (백만원)</div><div class="s">음수면 분별이 유리</div></div>
      <div class="card kpi"><div class="v">${num(sim.pSelective * 100, 1)}%</div><div class="l">분별 순비용이 낮은 시행 비율</div><div class="s">${num(sim.n)}회 시뮬레이션</div></div>
    </section>
    <section class="card"><h2>비용 구성</h2><p>분별 추가 매각수익 ${mil(selective.revenue-crush.revenue,2)}백만원 · 처리비 절감 ${mil(crush.disposal-selective.disposal,2)}백만원 · 추가 인건비 ${mil(selective.labor-crush.labor,2)}백만원</p>${stackedBars([{ ...crush, name: "일괄 압쇄" }, { ...selective, name: "전면 분별" }])}</section>
    <section class="card"><h2>산정 가정 비교</h2>
      <label class="field">분별 후 폐콘크리트 배분 <select class="select" data-set="concreteCase">${opts(gradeOptions, q.concreteCase)}</select></label>
      <p class="caption muted">압쇄 66 / 26 / 8%는 설계내역 참고값입니다. 배분 순서는 순수 / 가연물 제거 / 가연물 5% 이하입니다. 조적은 건설폐재류 단가를 적용합니다.</p>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>조건</th><th>분별 배분 (%)</th><th class="r">압쇄 (백만원)</th><th class="r">분별 (백만원)</th><th class="r">Δ (백만원)</th></tr></thead><tbody>${gradeRows}</tbody></table></div>
      ${rawComparison ? `<p>보충을 끈 경우 압쇄 ${mil(rawComparison.crush.total, 2)}백만원 · 분별 ${mil(rawComparison.selective.total, 2)}백만원입니다. 현재 결과에는 원단위 보충량 ${num(Object.values(q.added).reduce((sum, value) => sum + value, 0), 1)}t을 포함합니다.</p>` : ""}
    </section>
    <section class="card"><h2>견적 내역</h2>
      <p class="caption muted">포함 항목 기준 추정 순비용입니다. 현장 수집·운반비와 부가세는 별도입니다.</p>
      ${delta > 0 ? `<p>현재 물량과 공기를 유지하면 분별안에서 추가 순수익 또는 비용 절감 ${num(delta)}원이 더 발생할 때 두 공법의 순비용이 같아집니다.</p>` : ""}
      <div class="table-wrap"><table class="tbl"><thead><tr><th>항목</th><th class="r">단가 (원, 다르면 압쇄 / 분별)</th><th class="r">압쇄 수량</th><th class="r">압쇄 (백만원)</th><th class="r">분별 수량</th><th class="r">분별 (백만원)</th><th class="r">차이</th></tr></thead>
      <tbody>${detail}</tbody><tfoot><tr><td>순비용 (비용 − 매각수익)</td><td></td><td></td><td class="r">${mil(crush.total, 2)}</td><td></td><td class="r">${mil(selective.total, 2)}</td><td class="r">${mil(delta, 2)}</td></tr></tfoot></table></div>
      <ul class="caption muted">${[["압쇄", crush], ["분별", selective]].map(([label, { mixed, unsoldMetal }]) =>
        `<li>${label} 혼합잔재 ${num(mixed.tons, 2)}t · 확인된 가연물 ${num(mixed.share * 100, 1)}% · 주성상 ${mixLabel[mixed.main]} · ${esc(mixed.rule)} ${num(mixed.fee)}원/t${mixed.needsQuote ? " (잠정)" : ""} · 미매각 금속 ${num(unsoldMetal, 2)}t</li>`).join("")}</ul>
      <details style="margin-top:8px"><summary>일당 간접비 ${num(p.indirect_per_day)}원 · 가정 (탐색 범위 ${num(indirect.min)}~${num(indirect.max)}원)</summary><p class="caption muted">${esc(indirect.ref)} 간접비는 각 공법의 작업일에 곱합니다.</p></details>
      <p class="caption muted">협회 중간처리단가에 현장 수집·운반비와 VAT는 포함되지 않습니다. 폐목재·폐합성수지의 순단가는 양수면 매각수익, 음수면 처리비입니다.</p>
    </section>
    <section class="card"><h2>공기와 투입 인원</h2>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>공종</th><th>일수 계산식</th><th class="r">작업조 (명)</th><th class="r">압쇄 일수</th><th class="r">압쇄 공수</th><th class="r">분별 일수</th><th class="r">분별 공수</th></tr></thead><tbody>
        ${[["setup", "가설 설치 (비계·방진막)", `${num(p.sched_setup_base, 1)} + 연면적 ÷ 1,000 × ${num(p.sched_setup_per_1000m2, 1)}`],
           ["interior", "내부 철거", `연면적 ÷ 1,000 × ${num(p.sched_interior_per_1000m2, 1)} (최소 ${num(p.sched_interior_min, 1)}일)`],
           ["structure", "구조체 해체", `면적식 ${num(crush.schedule.areaDays, 1)}일${q.structureFactor ? ` × 보정계수 ${num(q.structureFactor, 3)}` : ""}, 장비 생산성 기준 ${num(crush.schedule.volumeDays, 1)}일 중 큰 값`],
           ["finish", "마무리 (정리·비계 해체)", `${num(p.sched_finish_base, 1)} + 연면적 ÷ 1,000 × ${num(p.sched_finish_per_1000m2, 1)}`]]
          .map(([k, label, f]) => `<tr><td>${label}</td><td class="muted">${f}</td><td class="r">${k === "structure" ? "–" : num(crush.crews[k])}</td><td class="r">${num(crush.schedule[k], 1)}</td><td class="r">${k === "structure" ? "–" : num(crush.crews[k] * crush.schedule[k])}</td><td class="r">${num(selective.schedule[k], 1)}</td><td class="r">${k === "structure" ? "–" : num(selective.crews[k] * selective.schedule[k])}</td></tr>`).join("")}
        <tr><td>분별 추가 작업</td><td class="muted">${work.method === "quantity" ? `자재별 분별 총공수 ${num(work.gross, 2)} − 일반해체 공수 ${num(work.baseline, 2)}${q.generalFinishPd == null ? " (내부 철거 공수, 잠정)" : ""} 인·일` : `연면적 × (목공 ${num(p.sel_extra_carpenter, 3)} + 보통인부 ${num(p.sel_extra_laborer, 3)} 인·일/㎡)`} ÷ 작업조 ${num(p.crew_size)}명</td><td class="r">${num(p.crew_size)}</td><td class="r">–</td><td class="r">–</td><td class="r">${num(selective.schedule.selective, 1)}</td><td class="r">${num(work.persons, 1)}</td></tr>
        <tr><td>상시 작업유도·감시</td><td class="muted">전체 작업일</td><td class="r">${num(crush.crews.standing)}</td><td class="r">${num(crush.days, 1)}</td><td class="r">${num(crush.crews.standing * crush.days)}</td><td class="r">${num(selective.days, 1)}</td><td class="r">${num(selective.crews.standing * selective.days)}</td></tr>
        <tr><td>굴착기 연동 살수·신호</td><td class="muted">${crewOnWholeJob ? "전체 작업일" : "구조체 작업일"} · 굴착기 ${num(crush.crews.excavators)}대 × ${num(p.crew_per_excavator)}명/대</td><td class="r">${num(crush.crews.structure)}</td><td class="r">${num(crush.equipmentCrewDays, 1)}</td><td class="r">${num(crush.crews.structure * crush.equipmentCrewDays)}</td><td class="r">${num(selective.equipmentCrewDays, 1)}</td><td class="r">${num(selective.crews.structure * selective.equipmentCrewDays)}</td></tr>
      </tbody><tfoot><tr><td>공기 (작업일) · 총공수 (인·일)</td><td></td><td></td><td class="r">${num(crush.days, 1)}</td><td class="r">${num(persons(crush))}</td><td class="r">${num(selective.days, 1)}</td><td class="r">${num(persons(selective))}</td></tr></tfoot></table></div>
      <p>구조체 공정일수는 두 공법 모두 <strong>${num(crush.schedule.structure, 1)}일</strong>입니다. 굴착기 가동시간은 두 공법 모두 <strong>${num(crush.excavatorHours, 1)} 장비·시간</strong>입니다 (콘크리트 부피 ÷ 일일 해체량 × 하루 작업시간).</p>
      <p class="caption muted">배치 인원은 천마산 p.38, 정선 p.65, 노량진 p.104의 계획을 참고했습니다. 구조체 기간에만 굴착기 연동 인원을 배치하고 관리자를 직접노무에서 제외하는 것은 팀 가정입니다. 천마산은 살수와 작업유도를 각각 전체 21일로 계획했습니다. 모델의 현장 조건에서 전체 작업일 배치도 비교할 수 있습니다.</p>
      <p class="caption muted" style="margin-top:8px">장비 방식은 ${EQUIPMENT[equipmentMode(q)]}입니다. 분별 추가 작업 ${num(selective.schedule.selective, 1)}일 중 병행률 ${num(q.overlap * 100, 1)}%를 반영해 전체 공기가 ${num(selective.schedule.extension, 1)}일 늘어납니다. 보드·타일 외 선별 공수는 확인된 별도 항목이 없습니다.</p>
      ${paperAlt ? `<p class="caption muted">표 3·4 기재를 달리 해석해 보통인부 추가 품을 0.325로 두면, Δ는 ${mil(paperAlt.delta, 2)}백만원, 공기 차이는 ${num(paperAlt.deltaDays, 1)}일입니다. 이 해석의 출처 확인이 필요합니다.</p>` : ""}
    </section>
    <div class="grid-2">
      <section class="card"><h2>손익분기</h2>${be ? `<ul style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:8px">${be}</ul>` : `<p class="muted">범위 안에서 결과를 뒤집는 변수가 없습니다.</p>`}
        <p class="caption muted" style="margin-top:12px">폐합성수지 순단가 손익분기 ${resinSwitch == null ? "탐색 구간 내 없음" : `${num(resinSwitch)}원/t`} (다른 입력 고정, −100만~500만원/t 탐색).<br>다른 값은 그대로 두고 한 변수만 바꿨을 때 두 안의 비용이 같아지는 지점입니다. 조사 범위 안에서 결과를 뒤집을 수 있는 변수만 보여줍니다.</p>
        <details style="margin-top:8px"><summary>폐목재·수지 사례별 Δ</summary>
          <p class="caption muted">배출원과 비용 포함 범위가 다른 공고 사례입니다.</p>
          <ul>${alternatePrices.map(([label, changes]) => `<li>${label} · ${num(Object.values(changes)[0])}원/t → Δ ${mil(compare(q, { ...p, ...changes }).delta, 2)}백만원</li>`).join("")}</ul>
        </details></section>
      <section class="card"><h2>몬테카를로 결과</h2>${histChart(histogram(sim.sorted))}
        <div class="row" style="margin-top:12px;justify-content:space-between"><span class="num">P10 ${mil(sim.p10)} · P50 ${mil(sim.p50)} · P90 ${mil(sim.p90)} 백만원</span>
        <label class="row no-print caption muted">seed <input class="input sm" style="width:80px" type="number" min="1" data-set="seed" value="${state.seed}"></label></div>
        <p class="caption muted" style="margin-top:8px">범위가 있는 단가 ${vars.length}개를 삼각분포로 뽑아 Δ를 ${num(sim.n)}번 계산했습니다. seed가 같으면 결과가 같습니다.</p></section>
    </div>
    <section class="card"><h2>민감도 (토네이도)</h2>${tornadoChart(torn, delta)}</section>
    ${state.source === "ifc" ? `<section class="card"><h2>3D: 분별 대상과 압쇄 대상</h2>${viewerBox()}</section>` : ""}`;
}

const persons = (s) => s.rows.filter((r) => r.group === "인건비").reduce((a, r) => a + r.qty, 0);

const empty = () => `<section class="card"><p>먼저 <strong>모델</strong> 단계에서 IFC를 올리거나 면적을 넣어 주세요.</p><p style="margin-top:12px"><button class="btn btn-primary" data-tab="model">모델 단계로</button></p></section>`;

function validationTab(d) {
  const q = d?.q ?? projectInputs();
  const comparable = comparableCases(state.cases, q, state.calibrationType);
  const cal = calibrateStructure(state.cases, q, state.p, state.calibrationType);
  const available = (v, decimal = 1) => v == null ? "–" : num(v, decimal);
  const range = (row) => row.total_days_max == null ? available(row.total_days) : `${num(row.total_days)}~${num(row.total_days_max)}`;
  const error = (v, base) => v == null || !base ? "–" : `${v >= base ? "+" : ""}${num(100 * (v - base) / base, 1)}%`;
  const fields = Object.entries(BENCHMARKS).map(([key, [label, unit]]) => {
    const b = benchmark(comparable, key);
    const digits = unit === "인·일/㎡" ? 5 : unit === "원/일" ? 0 : 2;
    return `<tr><td>${label}</td><td>${unit}</td><td class="r">${b?.count ?? 0}</td><td class="r">${b ? num(b.median, digits) : "–"}</td><td class="r">${b ? `${num(b.min, digits)}~${num(b.max, digits)}` : "–"}</td></tr>`;
  }).join("");
  const cases = state.cases.map((row) => {
    const actual = row.total_days_max == null ? error(row.prior_days, row.total_days)
      : `${error(row.prior_days, row.total_days_max)} ~ ${error(row.prior_days, row.total_days)}`;
    const modelComparable = row.structure === "rc" && ["above", "full"].includes(row.scope)
      && ["large", "small", "mounted"].includes(row.equipment) && row.area_m2 > 0 && row.floors > 0;
    const current = modelComparable ? schedule(row, state.p, "crush") : null;
    const period = row.period_length == null ? "–" : `${num(row.period_length)}${PERIOD_UNITS[row.period_unit]}${row.period_max ? " 이내" : ""}`;
    const mismatch = current && row.total_days && row.total_days_max == null ? error(current.total, row.total_days) : "";
    const total = current && available(current.total);
    return `<tr><td><strong>${esc(row.name)}</strong><br><small>${esc(row.source)} · ${row.verified ? "원문 대조" : "조원 기록"} · ${row.type === "plan" ? "계획" : "실적"}${row.note ? `<br>${esc(row.note)}` : ""}</small></td>
      <td>${row.structure === "rc" ? "RC" : "기타"} · ${row.area_m2 == null ? "면적 미확인" : `${num(row.area_m2, 2)}㎡`} · ${row.floors == null ? "층수 미확인" : `${row.floors}층`} · ${SCOPES[row.scope]}</td>
      <td class="r">${period}</td><td class="r">${range(row)} / ${available(row.structure_days)}</td>
      <td class="r">${available(row.prior_days)}${actual === "–" ? "" : ` (${actual})`}</td>
      <td class="r">${total ? `${total}${row.concrete_m3 == null ? " (면적식)" : ""}${mismatch ? ` · ${mismatch}` : ""}` : "–"}</td>
      <td class="r">${available(row.prior_crew)} / ${available(row.crew_mean)}</td>
      <td class="r">${available(row.prior_concrete_t, 0)} / ${available(row.concrete_t, 0)}${row.concrete_t && row.prior_concrete_t != null ? ` (${error(row.prior_concrete_t, row.concrete_t)})` : ""}</td></tr>`;
  }).join("");
  return `<section class="card">
      <div class="row no-print">
        <label class="btn btn-primary">검증자료 JSON 가져오기<input type="file" id="validation-file" accept=".json,application/json" hidden></label>
        <button class="btn btn-outline" data-act="validation-export">표본 목록 JSON 내려받기</button>
      </div>
      ${state.caseMessage ? `<p role="status">${esc(state.caseMessage)}</p>` : ""}
      <p class="caption muted">계획서 PDF의 공정표와 물량표를 확인한 후 숫자와 쪽수를 JSON에 입력하세요. 달력일, 주·개월 일정과 작업일은 단위를 구분합니다. 계획값과 완료 현장의 실적은 따로 비교합니다. 파일 입력은 이 브라우저에 저장됩니다.</p>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>현장 · 출처</th><th>대상</th><th>계획서 기간</th><th>전체 / 구조체 작업일</th><th>기존 사이트 (공기 오차)</th><th>현재 압쇄 모델 (일)</th><th>기존 사이트 / 자료 인원 (명)</th><th>기존 사이트 / 자료 폐콘크리트 (t)</th></tr></thead><tbody>${cases}</tbody></table></div>
    </section>
    <section class="card">
      <h2>유사 현장으로 구조체 공기 보정</h2>
      <div class="form-grid">
        <label class="field">참조 자료 <select class="select" data-set="calibrationType">${opts({ plan: "예정공정표", actual: "완료 현장 실적" }, state.calibrationType)}</select></label>
        <label class="field">보정 표본에서 제외할 현장 <select class="select" data-set="caseId">
          <option value="">새 현장</option>${state.cases.map((row) => `<option value="${esc(row.id)}" ${q.caseId === row.id ? "selected" : ""}>${esc(row.name)}</option>`).join("")}
        </select></label>
      </div>
      <p class="caption muted">원문을 대조한 RC 현장 중 해체 범위와 장비 방식이 같고, 면적은 대상의 0.5~2배, 층수는 ±2층인 사례를 씁니다. 구조체 작업일과 부피가 있는 사례 ${MIN_CASES}건 이상에서 한 건씩 빼고 예측해 평균 절대오차를 확인합니다.</p>
      <p>현재 조건 ${num(q.area_m2)}㎡ · 지상 ${q.floors}층 · ${SCOPES[q.scope]} · ${EQUIPMENT[equipmentMode(q)]}<br>유사 사례 ${comparable.length}건 · 구조체 공기 보정용 ${cal.count}건</p>
      ${cal.count >= MIN_CASES ? `<p>평균 절대오차 · 기존 ${num(cal.baseMae, 2)}일 / 교차검증 ${num(cal.cvMae, 2)}일 · 보정계수 ${num(cal.factor, 3)}</p>` : "<p>보정에 필요한 구조체 작업일·부피 자료가 부족합니다.</p>"}
      <button class="btn btn-outline no-print" data-act="calibration-toggle" ${!cal.ready && !state.useCalibration ? "disabled" : ""}>${state.useCalibration ? "보정 해제" : "현재 비교에 보정 적용"}</button>
      ${state.useCalibration && cal.ready ? '<p role="status">현재 비교 계산에 보정계수를 적용합니다.</p>' : ""}
      ${cal.count >= MIN_CASES && !cal.ready ? "<p>교차검증 오차가 감소하지 않아 기존 공기식을 사용합니다.</p>" : ""}
    </section>
    <section class="card"><h2>공수·작업조·장비·간접비 참고값</h2>
      <p class="caption muted">유사 현장에서 확인된 항목만 중앙값과 관측 범위를 표시합니다. 같은 작업 범위와 단위인지 확인한 뒤 단가 탭에 반영할 수 있습니다.</p>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>항목</th><th>단위</th><th class="r">표본 수</th><th class="r">중앙값</th><th class="r">관측 범위</th></tr></thead><tbody>${fields}</tbody></table></div>
    </section>`;
}

/* ---------------- 내보내기 ---------------- */
function summary(d) {
  const { crush, selective, delta, deltaDays } = d.cmp;
  sim ||= simulate(d.q, state.p, variables(rates), { n: 5000, seed: state.seed });
  return { source: state.source === "ifc" ? state.fileName : "area", area_m2: state.area, usage: state.usage, site: state.site, labor_method: state.labor,
    input_quantities: streamTons(d.q, state.p).t, rebar_estimated_t: streamTons(d.q, state.p).rebar, project_inputs: projectInputs(), finish_areas_m2: d.q.finishAreas, applied_rates: state.p,
    crush_total_won: Math.round(crush.total), selective_total_won: Math.round(selective.total), delta_won: Math.round(delta),
    indirect_per_day_won: state.p.indirect_per_day, equipment_crew_period: d.q.equipmentCrewPeriod,
    crush_days: +crush.days.toFixed(1), selective_days: +selective.days.toFixed(1), delta_days: +deltaDays.toFixed(1),
    p_selective_cheaper: +sim.pSelective.toFixed(4), seed: state.seed, estimate: true,
    input_issues: [...new Set([...crush.issues, ...selective.issues])],
    structure_calibration_factor: d.q.structureFactor ?? null, recommended: delta === 0 ? "tie" : delta < 0 ? "selective" : "crush" };
}

function exportTab(d) {
  if (!d) return empty();
  if (d.openSteelFrame) return openSteelNotice(d);
  const res = elementResults(d.classified, state.p, d.cmp.selective.mixed.fee, d.q);
  return `<section class="card"><h2>결과 내보내기</h2>
      <div class="row no-print">
        ${state.source === "ifc" ? `<button class="btn btn-primary" data-act="csv">부재별 결과 CSV</button>` : ""}
        <button class="btn btn-outline" data-act="json">요약 JSON</button>
        <button class="btn btn-outline" data-act="print">보고서 인쇄 · PDF</button>
      </div>
      <pre class="mono" style="margin-top:16px;white-space:pre-wrap">${esc(JSON.stringify(summary(d), null, 2))}</pre>
    </section>
    ${state.source === "ifc" ? `<section class="card"><h2>Revit에 결과 넣기</h2>
      <ol style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px">
        <li><strong>부재별 결과 CSV</strong>와 <strong>요약 JSON</strong>을 내려받습니다.</li>
        <li>Revit에서 원본 모델을 열고, 저장소의 <span class="mono">revit/ReClaim_SharedParams.txt</span>를 공유 매개변수 파일로 지정합니다.</li>
        <li>pyRevit으로 <span class="mono">revit/write_results.py</span>를 실행해 CSV를 고릅니다. 부재마다 <span class="mono">RC_Waste, RC_Method, RC_Tons, RC_DisposalCost, RC_Revenue</span>가 기록됩니다.</li>
        <li>.rvt로 저장합니다. <span class="mono">RC_Method</span>로 필터를 만들면 분별 대상만 색으로 볼 수 있습니다.</li>
      </ol>
      <h2 style="margin-top:20px">부재별 결과 미리보기 <span class="caption muted">(${num(res.length)}개 중 12개, 전면 분별 기준)</span></h2>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Revit ID</th><th>부재</th><th>층</th><th>성상</th><th>방법</th><th class="r">톤</th><th class="r">처리비 (원)</th><th class="r">매각수익 (원)</th></tr></thead><tbody>
      ${[...res].sort((a, b) => b.revenue - a.revenue).slice(0, 12).map((r) => `<tr><td class="mono">${esc(r.tag || r.globalId)}</td><td>${CATEGORY_LABEL[r.category]}</td><td>${r.floor}</td><td>${STREAM_LABEL[r.stream]}</td><td>${r.method}</td><td class="r">${num(r.tons, 3)}</td><td class="r">${num(r.disposal)}</td><td class="r">${num(r.revenue)}</td></tr>`).join("")}
      </tbody></table></div></section>` : ""}
    <div class="disclaimer"><div>이 결과는 견적 검토를 돕는 1차 비교 자료입니다. "가정"으로 표시된 단가는 출처가 없는 잠정값이므로 실제 견적·반출 기록으로 보정해야 합니다.</div></div>`;
}

function download(name, text, type) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------------- 그리기와 이벤트 ---------------- */
const HEAD = {
  model: ["모델과 물량", "Revit에서 내보낸 IFC에서 부재·재료별 물량을 뽑고, 폐기물 성상으로 분류합니다."],
  rates: ["단가", "노임, 품, 처리비, 매각가, 회수율입니다. 모든 값에 출처와 기준 연도를 표시합니다."],
  compare: ["공법 비교", "일괄 압쇄와 전면 분별해체의 인건비·장비비·처리비·매각수익·간접비를 비교합니다."],
  validation: ["해체계획서 검증·보정", "계획 공기와 사이트 계산을 비교하고, 유사한 현장 자료로 구조체 공기를 보정합니다."],
  export: ["내보내기", "부재별 결과를 CSV로 내보내 Revit 모델에 기록합니다."],
};

function render() {
  const d = derive();
  $("#tabs").innerHTML = TABS.map(([k, l], i) => `<button data-tab="${k}" ${k === state.tab ? 'aria-current="step"' : ""}><span>${i + 1}</span>${l}</button>`).join("");
  const wasOpen = $("#site-details")?.open;
  const body = { validation: validationTab, model: modelTab, rates: ratesTab, compare: compareTab, export: exportTab }[state.tab](d);
  $("#content").innerHTML = `<div><h1>${HEAD[state.tab][0]}</h1><p class="lead">${HEAD[state.tab][1]}</p></div>${body}`;
  if (wasOpen && $("#site-details")) $("#site-details").open = true;
  if (d) mountViewer(d);
}

document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-tab],[data-act],[data-color]");
  if (!t) return;
  if (t.dataset.tab) { state.tab = t.dataset.tab; if (state.tab === "compare") state.colorMode = "method"; window.scrollTo(0, 0); return render(); }
  if (t.dataset.color) { state.colorMode = t.dataset.color; return render(); }
  const act = t.dataset.act, d = derive();
  if (act === "sample") return loadIfc(await (await fetch("assets/data/sample.ifc")).arrayBuffer(), "sample.ifc (예시 5층 공동주택)", 2400);
  if (act === "plan-sample") return loadPlan(await json("plans/example.json"), "계획서 예시");
  if (act === "area") { Object.assign(state, { source: "area", plan: null, model: null, elements: [], error: "" }); sim = null; return render(); }
  if (act === "validation-export") return download("reclaim-validation.json", JSON.stringify({ schema: VALIDATION_SCHEMA, cases: state.cases }, null, 2), "application/json");
  if (act === "calibration-toggle") {
    state.useCalibration = !state.useCalibration;
    sim = null; return render();
  }
  if (act === "reset") { state.p = { ...defaults }; sim = null; save(); return render(); }
  if (["csv", "json"].includes(act) && !d?.cmp) return;
  if (act === "csv") return download("reclaim_elements.csv", "﻿" + toCsv(elementResults(d.classified, state.p, d.cmp.selective.mixed.fee, d.q)), "text/csv");
  if (act === "json") return download("reclaim_summary.json", JSON.stringify(summary(d), null, 2), "application/json");
  if (act === "print") return window.print();
});

document.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.id === "file" && t.files[0]) return loadIfc(await t.files[0].arrayBuffer(), t.files[0].name);
  if (t.id === "planfile" && t.files[0]) {
    try { return loadPlan(JSON.parse(await t.files[0].text()), t.files[0].name); }
    catch (e) { state.error = `JSON을 읽지 못했습니다: ${e.message}`; return render(); }
  }
  if (t.id === "validation-file" && t.files[0]) {
    try {
      const imported = validationCases(JSON.parse(await t.files[0].text()));
      for (const row of imported) localCases.set(row.id, row);
      state.cases = allCases();
      try {
        localStorage.setItem("rc.validation", JSON.stringify({ schema: VALIDATION_SCHEMA, revision: 2, cases: [...localCases.values()] }));
        state.caseMessage = `${imported.length}건을 반영했습니다. 같은 ID는 새 자료로 갱신했습니다.`;
      } catch { state.caseMessage = "현재 세션에 반영했습니다. 유지하려면 검증자료 JSON을 내려받으세요."; }
    } catch (err) { state.caseMessage = err.message; }
    sim = null; return render();
  }
  state.formError = "";
  if (t.dataset.p) {
    const key = t.dataset.p, meta = rates.params[key], v = Number(t.value);
    const signed = key === "net_wood" || key === "net_resin";
    const nonzero = /per_day$|per_1000m2$/.test(key) && !key.startsWith("sched_") && key !== "indirect_per_day" && key !== "crane_per_day"
      || ["crew_size", "area_per_excavator", "hours_per_day", "crush_m3_per_day_small", "sched_struct_m2_per_day"].includes(key);
    if (meta.optional && !t.value) state.p[key] = -1;
    else if (!meta.locked && t.value && Number.isFinite(v) && (signed || v >= 0) && (!nonzero || v > 0) && (meta.unit !== "비율" || v <= 1)) state.p[key] = v;
    else return render();
  }
  else if (t.dataset.set === "supplement") state.supplement = t.checked;
  else if (t.dataset.set === "caseId") state.caseId = t.value;
  else if (t.dataset.set === "calibrationType") state.calibrationType = t.value;
  else if (t.dataset.set === "scope" && state.model) {
    state.scope = t.value;
    state.area = Math.round((state.scope === "above" ? state.model.aboveArea : state.model.gross.area) * 100) / 100;
  }
  else if (["concreteCase", "usage", "site", "labor", "equipment", "scope", "structure", "scaffold", "equipmentCrewPeriod"].includes(t.dataset.set)) state[t.dataset.set] = t.value;
  else if (caseFields.includes(t.dataset.set)) {
    const key = t.dataset.set, v = t.value === "" ? undefined : Number(t.value);
    const limit = t.max ? Number(t.max) : Infinity;
    if (v != null && (!Number.isFinite(v) || v < 0 || v > limit)) state.formError = "입력 범위를 확인하세요.";
    else if (key.startsWith("mixed") && (v ?? 0) + (state[key === "mixedMineral" ? "mixedCombustible" : "mixedMineral"] ?? 0) > 100) {
      state.formError = "혼합·기타 중 건설폐재류와 가연물의 합은 100% 이하여야 합니다.";
    } else state[key] = v;
  }
  else if (t.dataset.set) { const v = Number(t.value); if (v > 0 && Number.isFinite(v)) state[t.dataset.set] = t.dataset.set === "floors" ? Math.max(1, Math.round(v)) : v; }
  else if (t.dataset.override != null) { if (t.value) state.overrides[t.dataset.override] = t.value; else delete state.overrides[t.dataset.override]; }
  else return;
  sim = null; save(); render();
});

document.addEventListener("dragover", (e) => { if ($("#drop")) { e.preventDefault(); $("#drop").classList.add("over"); } });
document.addEventListener("dragleave", () => $("#drop")?.classList.remove("over"));
document.addEventListener("drop", async (e) => {
  if (!$("#drop")) return;
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) loadIfc(await f.arrayBuffer(), f.name);
});

const tip = $("#tip");
document.addEventListener("mousemove", (e) => {
  const t = e.target.closest?.("[data-tip]");
  if (!t) { tip.hidden = true; return; }
  tip.textContent = t.dataset.tip;
  tip.hidden = false;
  tip.style.left = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8) + "px";
  tip.style.top = e.clientY + 16 + "px";
});

render();

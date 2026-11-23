// 일괄 압쇄 vs 전면 분별해체 비용 엔진. DOM을 쓰지 않는 순수 함수만 둔다.
// 물량 q = { area_m2, floors(지상 층수), concrete_m3, rebarFromConcrete, t: { concrete, metal, wood, resin, glass, board, mixed, copper, aluminum },
//          site(대지 조건: SITES의 키), labor(분별 추가 품 계산: "paper" | "quantity") }
// 단가 p = { 키: 숫자 } (rates.json의 params에서 value만 뽑은 것)
import { estimateTransport } from "./transport.js?v=nonhyeon-compare-20261123";

export const STREAMS = ["concrete", "masonry", "metal", "wood", "resin", "glass", "tile", "board", "panel", "mixed", "copper", "aluminum"];
export const STREAM_LABEL = {
  concrete: "폐콘크리트", masonry: "폐벽돌·조적", metal: "철근·강재", wood: "폐목재", resin: "폐합성수지", glass: "폐유리", tile: "폐타일·도자기",
  board: "폐보드", panel: "폐샌드위치패널", mixed: "혼합·기타", copper: "구리", aluminum: "알루미늄",
  excluded: "제외 (집계 안 함)",
};
// 물량에 넣지 않는 부재 (IFC의 기타 객체: 가구·설비·조경 등). STREAMS에는 들어가지 않는다.
export const EXCLUDED = "excluded";
// 분별해체에서 따로 떼어 내는 성상 (나머지는 구조체와 함께 압쇄)
export const SEPARATED = new Set(["wood", "resin", "glass", "board", "copper", "aluminum"]);

// 대지 조건은 자동 장비 가정에 쓰고, 장비·양중 방식은 현장별로 지정할 수 있다.
export const SITES = { wide: "넉넉함", normal: "보통", tight: "협소·도심", restricted: "진입 제한" };
export const EQUIPMENT = { auto: "대지 조건으로 추정", mixed: "소형·대형 지상 굴착기 각 1대", large: "대형 지상 장비", small: "소형 지상 장비", mounted: "탑재 장비 + 크레인" };
export const equipmentMode = (q) => q.equipment && q.equipment !== "auto"
  ? q.equipment : q.site === "tight" || q.site === "restricted" ? (q.fixedComparison ? "small" : "mounted") : "large";
export const smallSite = (q) => equipmentMode(q) !== "large";
export const separation = (p) => ({
  wood: p.rec_sel, resin: p.rec_sel_resin ?? p.rec_sel,
  glass: p.rec_sel_glass ?? 0, board: p.rec_sel_board ?? 0,
});
// 분별 추가 품 계산 방식 (6.3의 3)
export const LABOR_METHODS = { paper: "논문 표 3·4의 차이 품 (현장 적용 가정)", quantity: "자재별 작업량과 일반해체 공수 차감" };

// 압쇄기로 허무는 구조체 부피(㎥): 콘크리트 + 조적
export const crushVolume = (q) => (q.concrete_m3 || 0) + (q.masonry_m3 || 0);

export function concreteCut(q, mode) {
  const input = q.concreteCut?.[mode] ?? {};
  const volume = input.volume ?? 0;
  const cost = input.cost ?? 0;
  const days = input.days ?? 0;
  const active = volume > 0 || cost > 0 || days > 0;
  const ready = !active || (volume > 0 && volume <= (q.concrete_m3 ?? 0) && days > 0);
  return { volume, cost, days, active, ready, quoteMissing: active && input.cost == null };
}

function remainingCrushShare(q, mode) {
  const cut = concreteCut(q, mode);
  return cut.active && cut.ready ? 1 - cut.volume / crushVolume(q) : 1;
}

// 구조체 해체 구간: 장비별 부피·하루 해체량·일수.
// 탑재 방식은 크레인으로 올린 장비가 위층을 허물고, 지상 장비가 닿는 하부 층은 대형 장비가 허문다
// (논현동 124-1 계획서 p.9·40·66·69: 탑재 R35Z 지붕~3층, 지상 DX-320 2~1층). 부피는 층수 비율로 나눈다.
export function crushSegments(q, p, method = "crush") {
  const share = remainingCrushShare(q, method);
  const volume = crushVolume(q) * share, mode = equipmentMode(q);
  if (mode === "mixed") return [
    { key: "small", label: "소형 지상 굴착기", days: q.smallHours * share / p.hours_per_day, price: q.smallPrice },
    { key: "large", label: "대형 지상 굴착기", days: q.largeHours * share / p.hours_per_day, price: q.largePrice },
  ];
  if (mode === "large") return [{ key: "large", label: "굴착기+압쇄기", volume, production: p.crush_m3_per_day, days: volume / p.crush_m3_per_day }];
  if (mode === "small") return [{ key: "small", label: "소형 굴착기+압쇄기", volume, production: p.crush_m3_per_day_small, days: volume / p.crush_m3_per_day_small }];
  const floors = Math.max(1, q.floors || 1);
  const ground = Math.min(floors, Math.max(0, q.groundFloors ?? p.mounted_ground_floors ?? 0));
  const lower = volume * ground / floors, upper = volume - lower;
  const production = q.mountedProduction ?? (q.fixedComparison
    ? ((q.mountedBucket != null ? q.mountedBucket > 0.3 : q.mountedLarge) ? p.crush_m3_per_day : p.crush_m3_per_day_small)
    : p.crush_m3_per_day_small);
  return [
    { key: "mounted", label: "굴착기+압쇄기 (탑재 구간)", volume: upper, production, days: upper / production },
    { key: "ground", label: `굴착기+압쇄기 (지상 장비 구간, 하부 ${ground}개 층)`, volume: lower, production: p.crush_m3_per_day, days: lower / p.crush_m3_per_day },
  ].filter((segment) => segment.volume > 0 || segment.key === "mounted");
}

export function officeSalvage(q, p) {
  const pipeInstalled = q.pipeInstalled != null;
  const cableInstalled = q.cableInstalled != null;
  if (!q.officeRecovery && !pipeInstalled && !cableInstalled) return null;
  const pipeKg = pipeInstalled ? q.pipeInstalled * 1000 : q.officeRecovery ? q.area_m2 * p.office_pipe_kg_per_m2 : 0;
  const cableKg = cableInstalled ? q.cableInstalled * 1000 : q.officeRecovery ? q.area_m2 * p.office_cable_kg_per_m2 : 0;
  const recovery = (exposed, embedded) => exposed * p.office_exposed_recovery + (1 - exposed) * embedded;
  const pipeRate = recovery(p.office_pipe_exposed, p.office_pipe_embedded_recovery);
  const cableCrushRate = recovery(p.office_cable_exposed, p.office_cable_embedded_crush);
  const cableSelectiveRate = recovery(p.office_cable_exposed, p.office_cable_embedded_selective);
  const estimateCableCrush = cableKg > 0 && (q.cableCrush ?? q.cableCommon) == null;
  const estimateCableSelective = cableKg > 0 && (q.cableSel ?? q.cableCommon) == null;
  return {
    pipeKg, cableKg, pipeRate, cableCrushRate, cableSelectiveRate,
    pipeInstalled, cableInstalled,
    estimatePipe: pipeKg > 0 && q.copperPipeSold == null && (pipeInstalled || !((q.t?.copper ?? 0) - (q.separateCopperTons ?? 0) > 1e-9)),
    estimateCable: estimateCableCrush || estimateCableSelective, estimateCableCrush, estimateCableSelective,
  };
}

export const paramValues = (rates) => Object.fromEntries(Object.entries(rates.params).map(([k, v]) => [k, v.value]));

const tons = (q) => Object.fromEntries(STREAMS.map((s) => [s, Number(q.t?.[s]) || 0]));

// IFC 콘크리트 톤수는 철근콘크리트 단위질량(2.4t/㎥, KDS 기준 24kN/㎥)으로 계산했으므로 철근 무게가 이미 들어 있다.
// 철근을 콘크리트 부피에서 따로 추정해 고철로 셀 때는 같은 무게를 폐콘크리트에서 빼야 이중 계상이 없다.
export const rebarTons = (q, kgPerM3) => ((q.rebarConcrete_m3 ?? q.concrete_m3 ?? 0) * (q.rebarKgPerM3 ?? kgPerM3)) / 1000;

// 물량 q의 성상별 톤수 (철근 분리 반영). 콘크리트에서 뺀 철근은 metal에 더한다.
// 모델에 철근을 그렸으면(q.rebarModeledTons) 그 무게는 이미 metal에 있으므로, 추정량 중 모자란 만큼만 더한다.
// 콘크리트 톤수에서는 철근 전체(추정량과 모델량 중 큰 값)를 뺀다 — 콘크리트 형상 부피는 철근을 빼지 않은 값이다.
export function streamTons(q, p) {
  const t = tons(q);
  if (q.copperPipeSold != null || q.pipeInstalled != null) {
    t.copper = Math.max(t.copper, (q.separateCopperTons ?? 0) + Math.max(q.copperPipeSold ?? 0, q.pipeInstalled ?? 0));
  }
  if (!q.rebarFromConcrete) return { t, rebar: 0, rebarAdded: 0 };
  const modeled = q.rebarModeledTons || 0;
  const rebar = Math.min(Math.max(rebarTons(q, p.rebar_kg_per_m3), modeled), t.concrete);
  const rebarAdded = Math.max(0, rebar - modeled);
  return { t: { ...t, concrete: t.concrete - rebar, metal: t.metal + rebarAdded }, rebar, rebarAdded };
}

// 폐콘크리트 성상 배분(순수 / 건설폐재류 / 가연물 5% 이하). 분별안이 더 깨끗하다는 배분은 출처가 없는 가정이므로
// 기본값은 두 공법에 같은 배분을 쓰고, 분별안 가정은 사용자가 고르거나 처리장 견적(cleanSel·cleanPrice)으로 넣는다.
export const DEFAULT_CONCRETE_CASE = "building";
export const CONCRETE_CASES = {
  building: { label: "건축 폐재류 · 양 공법 동일", shares: [0, 1, 0] },
  "building-sorted": { label: "건축 폐재류 · 공법별 선별 가정", shares: [0.80, 0.18, 0.02] },
  same: { label: "기존 성상 시나리오 · 양 공법 동일 (현장 확인 필요)", shares: [0.66, 0.26, 0.08], legacy: true },
  standard: { label: "기존 분별 중간 시나리오 (현장 확인 필요)", shares: [0.71, 0.26, 0.03], legacy: true },
  good: { label: "기존 분별 양호 시나리오 (현장 확인 필요)", shares: [0.80, 0.18, 0.02], legacy: true },
};

// Benchmark is the 04 apartment IFC under the phase-2 finish takeoff.
const REFERENCE_FINISH_RATIO = 57.21156 / 7968.550875802546;

export function concreteGradeLink(q, p) {
  if (!q.finishTakeoff) return { status: "no-takeoff" };
  if (!(q.t.concrete > 0)) return { status: "no-concrete" };
  if (Object.values(q.finishTakeoff).some(item => item.unverified)) return { status: "missing-finish" };
  const removed = selective => {
    const split = finishSeparations(q, q.t, p, selective);
    const routes = finishMaterialRoutes(q, q.t, selective, split);
    return Object.values(routes).reduce((total, route) => total + route.separate + route.preRemovalMixed, 0);
  };
  const extraTons = Math.max(0, removed(true) - removed(false));
  const ratio = extraTons / q.t.concrete;
  return { status: "linked", extraTons, ratio, factor: Math.min(1, ratio / REFERENCE_FINISH_RATIO) };
}

export function concreteGrades(p, selective, concreteCase = DEFAULT_CONCRETE_CASE, q) {
  // Building waste does not implicitly qualify for the civil-works pure-concrete tariff.
  // Explicit historic scenarios remain reproducible and are flagged by compare().
  const baseline = concreteCase === "building" ? CONCRETE_CASES.building.shares : CONCRETE_CASES.same.shares;
  const link = selective && concreteCase === "linked" && q ? concreteGradeLink(q, p) : null;
  const shares = link
    ? baseline.map((share, i) => share + (CONCRETE_CASES.good.shares[i] - share) * (link.factor ?? 0))
    : (selective ? CONCRETE_CASES[concreteCase]?.shares ?? baseline : baseline);
  const buildingSorted = concreteCase === "building-sorted";
  return [
    { name: buildingSorted ? "별도 선별한 건축 폐콘크리트" : "순수 폐콘크리트", share: shares[0], fee: buildingSorted ? p.fee_concrete : p.fee_pure_concrete },
    { name: "건설폐재류 (가연물 제거)", share: shares[1], fee: p.fee_concrete },
    { name: "건설폐재류 (가연물 5% 이하)", share: shares[2], fee: p.fee_mixed_mineral },
  ];
}

export function steelDismantling(q) {
  const active = q.steelWork || q.structure === "steel";
  const complete = q.cutCommon != null || (q.cutCrush != null && q.cutSel != null);
  return {
    excluded: Boolean(active && !complete),
    crush: active && complete ? q.cutCrush ?? q.cutCommon : 0,
    selective: active && complete ? q.cutSel ?? q.cutCommon : 0,
  };
}

export function selectiveEquipmentHoursPerDay(p) {
  return p.selective_equipment_hours_per_day ?? 0;
}

export function equipmentNormStatus(q, p) {
  const mode = equipmentMode(q), missing = [], assumptions = [];
  const add = (code, item, reason) => missing.push({ code, item, reason });
  const residual = Math.max(remainingCrushShare(q, "crush"), remainingCrushShare(q, "selective"));
  if (!(crushVolume(q) > 0 && residual > 0)) return { complete: true, missing, assumptions, supportRequired: false };
  if (!q.methodConfirmed && q.structure && q.structure !== "rc") add("structure-method", "구조체 해체 공법", "RC 생산성의 다른 구조 적용은 현장 공법·견적으로 확인해야 합니다.");
  if (!q.methodConfirmed && !["above", "full"].includes(q.scope)) add("demolition-scope", "해체 범위", "지상·지하·기초 포함 범위를 확인하세요.");
  const basement = q.basementOnly || q.basementIncluded || q.basementFloors > 0;
  if (!q.methodConfirmed && basement) add("basement-method", "지하·기초 작업", "지하·기초의 양중·작업공간·지보 등은 별도 공정과 견적이 필요합니다.");
  if (!q.methodConfirmed && q.scope === "full" && q.basementIncluded == null && !q.basementOnly && q.basementFloors == null) add("basement-scope", "지하 포함 여부", "전체 모델이라는 입력만으로 지하층의 유무를 확정하지 않습니다. 지하 포함 여부와 기초 작업범위를 확인하세요.");
  if (["large", "small", "mixed"].includes(mode) && !q.methodConfirmed) {
    if (!(q.height > 0) && !q.basementOnly) add("equipment-height", "장비 작업높이", "지상 압쇄의 실제 높이와 작업 도달조건을 확인하세요. 표준 RC 압쇄 기준은 높이 10m 이하입니다.");
    else if (q.height > 10) add("equipment-height", "높이 10m 초과 공법", "지상 RC 압쇄 표준 생산성을 그대로 적용할 수 없습니다. 탑재·양중·절단 등 공법을 확인하세요.");
  }
  if (mode === "small" || mode === "mounted") {
    assumptions.push("소형·탑재 생산성은 단일 예정계획서의 비교 가정이며 현장 실적이 아닙니다.");
    if (mode === "mounted" && !q.methodConfirmed) add("mounted-method", "탑재 해체 공법", "탑재 위치·장비하중·층별 물량·양중·보강을 반영한 현장 공법과 작업일수를 확인하세요.");
    if (mode === "mounted" && q.craneDays == null) add("crane-days", "탑재·양중 크레인", "크레인 사용일수가 없어 공정일수로 잠정 계산했습니다.");
  }
  const supportRequired = mode === "large" || mode === "mounted" && crushSegments(q, p).some(s => s.key === "ground" && s.volume > 0);
  if (supportRequired && !q.equipmentPackageConfirmed && !(p.support_excavator_per_h >= 0)) {
    add("support-equipment", "RC 압쇄 보조 굴착기", "45~50㎥/일 기준은 압쇄기 장착 1.0㎥ 굴착기와 보조 0.6㎥ 굴착기 각 1대입니다. 보조 장비 단가 또는 포함 견적을 확인하세요.");
  }
  if (supportRequired && !q.equipmentCrewConfirmed) add("equipment-crew", "RC 압쇄 작업조", "표준 RC 압쇄의 특별인부 2명·보통인부 1명과 현장 살수·신호 배치의 중복 및 포함범위를 확인하세요.");
  return { complete: !missing.length, missing, assumptions, supportRequired };
}

function recoveryQuote(q, mode) {
  return q[mode === "selective" ? "recoveryCostSel" : "recoveryCostCrush"] ?? q.recoveryCostCommon;
}

export function costScenario(q, p, mode) {
  const sel = mode === "selective";
  const allInInput = sel ? q.disposalAllInSel : q.disposalAllInCrush;
  const allInQuote = Number.isFinite(allInInput) && allInInput >= 0 ? allInInput : null;
  // IFC 모델에는 철근이 없으므로 콘크리트 부피에서 추정하고, 그만큼 폐콘크리트 톤수에서 뺀다
  const { t, rebar } = streamTons(q, p);
  const metal = t.metal;
  let rows = [];
  const add = (group, item, qty, unit, price, sign = 1) => {
    const amount = sign * qty * price;
    rows.push({ group, item, qty, unit, price, amount });
    return amount;
  };

  const extra = sel ? selExtra(q, p) : null;
  const issues = [];
  const unpricedCosts = [];
  const unpricedDisposal = q.panelWeightMissing ? [{ item: "폐샌드위치패널 중량 미확인", tons: null }] : [];
  if (q.panelWeightMissing && allInQuote == null) issues.push("폐샌드위치패널이 감지되었습니다. 별도 처리비에 반영할 중량을 입력하세요.");
  if (q.structure === "other") issues.push("기타·복합 구조에 RC 공기와 장비식을 적용한 비교값입니다.");
  // 1. 인건비 — 공종별 일수 × 작업조 × 노임 (두 안 공통). 일수는 schedule()의 공기 규칙을 쓴다.
  const sched = schedule(q, p, mode), days = sched.total, crew = crews(q, p);
  const cut = concreteCut(q, mode);
  const crushShare = remainingCrushShare(q, mode);
  const segments = crushSegments(q, p, mode);
  const equipmentCrewDays = crushShare === 0 ? 0 : q.equipmentCrewPeriod === "all" ? days - sched.cutting
    : segments.reduce((sum, segment) => sum + segment.days, 0) / crew.excavators;
  let labor = add("인건비", "상시 작업유도·감시", crew.standing * days, "인·일", p.wage_laborer)
    + add("인건비", "가설 설치 비계공", crew.setup * sched.setup, "인·일", p.wage_scaffold ?? p.wage_carpenter)
    + add("인건비", "내부 철거 인부", crew.interior * sched.interior, "인·일", p.wage_laborer)
    + add("인건비", "굴착기 연동 살수·신호", crew.structure * equipmentCrewDays, "인·일", p.wage_laborer)
    + add("인건비", "마무리 인부", crew.finish * sched.finish, "인·일", p.wage_laborer);
  if (extra) {
    for (const r of extra.rows) labor += add("인건비", r.item, r.qty, "인·일", r.wage === "carpenter" ? p.wage_carpenter : p.wage_laborer);
    issues.push(...extra.issues);
  }

  let equipment = 0, excavatorHours = 0;
  for (const segment of segments) {
    const hours = segment.days * p.hours_per_day;
    excavatorHours += hours;
    equipment += add("장비비", segment.label, hours, "h", segment.price ?? p.excavator_per_h);
    if (["large", "ground"].includes(segment.key) && !q.equipmentPackageConfirmed && p.support_excavator_per_h >= 0) {
      equipment += add("장비비", "RC 압쇄 보조 굴착기 0.6㎥ (운전원 포함)", hours, "h", p.support_excavator_per_h);
    }
  }
  const norm = equipmentNormStatus(q, p);
  unpricedCosts.push(...norm.missing);
  issues.push(...norm.assumptions);
  if (equipmentMode(q) === "mounted") {
    // 크레인은 소형 장비를 올리고 내리는 탑재 구간에만 쓴다. 지상 장비 구간까지 세지 않는다.
    // 구조체 공기 중 탑재 구간이 차지하는 비율만큼 (구간 일수 비율)
    const segmentDays = segments.reduce((sum, segment) => sum + segment.days, 0);
    const mountedShare = segmentDays > 0 ? (segments.find((segment) => segment.key === "mounted")?.days ?? 0) / segmentDays : 1;
    const craneDays = q.craneDays == null ? sched.crushing * mountedShare : q.craneDays * crushShare;
    equipment += add("장비비", "이동식 크레인 (장비 탑재·양중)", craneDays, "일", p.crane_per_day);
    if (q.craneDays == null) issues.push(`크레인 사용 일수가 없어 탑재 구간 공정 ${craneDays.toFixed(1)}일을 적용했습니다.`);
  }

  if (sel && q.selectiveEquipmentQuote != null) {
    equipment += add("장비비", "분별 선철거·선별 추가 장비 (견적)", 1, "식", q.selectiveEquipmentQuote);
  } else if (sel && sched.selective > 0) {
    const hours = sched.selective * selectiveEquipmentHoursPerDay(p);
    equipment += add("장비비", "분별 선철거·선별 소형 장비 (추정)", hours, "h", p.selective_equipment_per_h ?? 0);
  }
  if (cut.active && cut.ready && !cut.quoteMissing) equipment += add("장비비", "콘크리트 절단·인양 도급비 (장비·인력 포함)", 1, "식", cut.cost);

  if (q.steelWork || q.structure === "steel") {
    const steel = steelDismantling(q);
    if (!steel.excluded) equipment += add("장비비", "철골 절단·인양 도급비 (인력 포함)", 1, "식", sel ? steel.selective : steel.crush);
  }
  const rates = separation(p);
  const split = Object.fromEntries(Object.entries(rates).map(([key, rate]) => [key, sel ? t[key] * rate : 0]));
  split.board = t.board * (sel ? (q.boardSel ?? (p.rec_sel_board ?? 0) * 100) : (q.boardCrush ?? 0)) / 100;
  split.tile = t.tile * ((sel ? q.tileSel : q.tileCrush) ?? 0) / 100;
  const pvcFrame = q.pvcFrameTons ?? 0;
  const alFrame = q.alFrameTons ?? 0;
  const pvcRecoveredRate = ((sel ? q.pvcSel : q.pvcCrush) ?? 0) / 100;
  const windowGlass = q.windowMode ? q.windowGlassTons ?? 0 : 0;
  if (q.windowMode) split.glass = sel ? Math.max(0, t.glass - windowGlass) * rates.glass : 0;
  const alRecovered = alFrame * ((sel ? q.alSel : q.alCrush) ?? (q.windowMode ? 100 : 0)) / 100;
  const pvcRecovered = q.windowMode
    ? (q.pvcPrice == null ? 0 : pvcFrame * ((sel ? q.pvcSel : q.pvcCrush) ?? 100) / 100)
    : pvcFrame * pvcRecoveredRate;
  split.resin = (sel ? Math.max(0, t.resin - pvcFrame) * rates.resin : 0) + pvcRecovered;
  if (q.finishTakeoff) Object.assign(split, finishSeparations(q, t, p, sel));
  const finishRoutes = finishMaterialRoutes(q, t, sel, split);
  const mixedQuote = q[sel ? "mixedFeeSel" : "mixedFeeCrush"];
  const mix = mixedWaste({
    ...t, glass: t.glass - windowGlass,
    board: t.board - (finishRoutes?.board.concreteCarryover ?? 0),
    tile: t.tile - (finishRoutes?.tile.concreteCarryover ?? 0),
  }, split, p, q);
  if (mixedQuote != null && mixedQuote >= 0) Object.assign(mix, { fee: mixedQuote, needsQuote: false, quoted: true, rule: "현장 혼합잔재 반입 견적" });
  const specified = t.concrete * (sel ? q.cleanSel ?? 0 : q.cleanCrush ?? 0) / 100;
  const quoted = q.cleanPrice == null ? 0 : specified;
  if (allInQuote == null && specified && !quoted) issues.push("콘크리트 별도 반입 견적이 없어 공법별 성상 비율을 적용했습니다.");
  let disposal = add("처리비", "혼합건설폐기물", mix.tons, "t", mix.fee);
  if (allInQuote == null && (q.concreteCase ?? DEFAULT_CONCRETE_CASE) === "building" && (t.concrete - quoted > 1e-9 || t.masonry > 1e-9) && !q.concreteIntakeConfirmed) {
    unpricedCosts.push({ code: "building-intake-condition", item: "건축 폐재류 반입조건", reason: "49,571원/t는 건설폐재류의 가연물 제거 반입조건을 전제로 한 공표 참고값입니다. 현장 성상과 처리장 인수조건을 확인하거나 해당 물량의 반입견적을 입력하세요." });
  }
  const finishCarryover = (finishRoutes?.board.concreteCarryover ?? 0) + (finishRoutes?.tile.concreteCarryover ?? 0);
  if (finishCarryover) disposal += add("처리비", "폐콘크리트 동반 반입 · 마감재", finishCarryover, "t", p.fee_concrete);
  if (windowGlass) {
    const glassMixedQuote = mixedQuote ?? (p.fee_mixed_quote >= 0 ? p.fee_mixed_quote : null);
    disposal += add("처리비", "혼합 반출 창호 유리", windowGlass, "t", glassMixedQuote ?? p.fee_mixed_unverified);
    if (allInQuote == null && glassMixedQuote == null) unpricedCosts.push({ code: "window-glass-quote", item: "창호 유리 혼합 반입", reason: "공법별 혼합 처리 견적이 없어 비교용 단가를 적용했습니다." });
  }
  for (const grade of concreteGrades(p, sel, q.concreteCase, q)) {
    disposal += add("처리비", grade.name, (t.concrete - quoted) * grade.share, "t", grade.fee);
  }
  if (t.masonry > 0) disposal += add("처리비", "폐벽돌·조적 (건설폐재류)", t.masonry, "t", p.fee_concrete);
  if (quoted) disposal += add("처리비","별도 반입 콘크리트 (현장 견적)",quoted,"t",q.cleanPrice);
  if (t.panel > 0) {
    if (p.fee_panel >= 0) disposal += add("처리비", STREAM_LABEL.panel, t.panel, "t", p.fee_panel);
    else unpricedDisposal.push({ item: STREAM_LABEL.panel, tons: t.panel });
  }
  if (allInQuote == null && mix.needsQuote) {
    issues.push("혼합잔재에 프로젝트 기본 처리단가를 적용했습니다. 공표 반입조건을 충족하는 현장 견적이 아닙니다.");
    unpricedCosts.push({ code: "mixed-disposal-quote", item: "혼합잔재 반입 견적", reason: mix.rule + ": 가연물 5% 이하 공표 단가의 적용조건을 벗어나거나 성상이 미확인입니다. 현재 금액은 비교용 가정입니다." });
  }

  const nf = sel ? p.rec_nonferrous_sel : p.rec_nonferrous_crush;
  const copperRate = (sel ? p.rec_copper_sel : p.rec_copper_crush) ?? nf;
  const office = officeSalvage(q, p);
  // A pipe tally replaces pipe/unspecified IFC copper; separately identified sheets stay in the inventory.
  const distinctOnly = q.copperPipeSold != null || q.pipeInstalled != null || office?.estimatePipe === true;
  const rawModelCopper = q.copperModeledTons ?? q.t?.copper ?? 0;
  const eligible = q.fixedComparison ? (q.salvageCopperTons ?? 0) : rawModelCopper;
  const modeledBasis = Math.max(0, Math.min(rawModelCopper, eligible, distinctOnly ? q.separateCopperTons ?? 0 : Infinity));
  const modeledCopper = modeledBasis * copperRate;
  const measuredPipe = q.copperPipeSold ?? 0;
  const estimatedPipeSold = office?.estimatePipe ? office.pipeKg * office.pipeRate : 0;
  const copperSales = { modeled: modeledCopper, measuredPipe, estimatedPipe: estimatedPipeSold / 1000,
    modeledBasis, modelRate: copperRate, distinctOnly };
  const copperSold = modeledCopper + measuredPipe + copperSales.estimatedPipe;
  const scrapRecovery = sel ? p.rec_scrap_sel : p.rec_scrap_crush;
  const structuralSteel = Math.min(Math.max(0, metal - rebar), q.structuralSteelTons ?? 0);
  const commonRecovery = p.rec_structural_steel ?? p.rec_scrap_sel;
  const sold = { metal: (metal - structuralSteel) * scrapRecovery + structuralSteel * commonRecovery, copper: copperSold, aluminum: Math.max(0, t.aluminum - alFrame) * nf + alRecovered };
  let revenue = -add("매각수익", "고철", sold.metal, "t", p.price_scrap, -1)
    - add("매각수익", "확인된 동관", measuredPipe * 1000, "kg", p.price_copper_pipe, -1)
    - add("매각수익", "구리", modeledCopper, "t", p.price_copper, -1)
    - add("매각수익", "알루미늄", sold.aluminum - alRecovered, "t", p.price_aluminum, -1);
  if (alRecovered) revenue -= add("매각수익", "알루미늄 창틀", alRecovered * 1000, "kg", q.alPrice ?? p.price_aluminum / 1000, -1);
  if (pvcRecovered) {
    if (q.pvcPrice > 0) revenue -= add("매각수익", "PVC 창틀", pvcRecovered * 1000, "kg", q.pvcPrice, -1);
    else disposal += add("처리비", q.pvcPrice === 0 ? "PVC 창틀 무상 인수" : "PVC 창틀 처리", pvcRecovered * 1000, "kg", -q.pvcPrice);
  }
  const cableSold = q[sel ? "cableSel" : "cableCrush"] ?? q.cableCommon ?? 0;
  const cablePrice = q.cablePrice ?? (q.fixedComparison || office ? p.price_waste_cable * 1000 : undefined);
  const estimateCable = sel ? office?.estimateCableSelective : office?.estimateCableCrush;
  const estimatedCableSold = estimateCable ? office.cableKg * (sel ? office.cableSelectiveRate : office.cableCrushRate) : 0;
  const recoveryCost = recoveryQuote(q, mode);
  const recoveryConfirmed = recoveryCost != null && recoveryCost >= 0;
  const potentialRevenue = {
    pipe: estimatedPipeSold * p.price_copper_pipe,
    cable: estimatedCableSold * (cablePrice ?? 0) / 1000,
    included: estimatedPipeSold > 0 || estimatedCableSold > 0, recoveryCostKnown: recoveryConfirmed, unbooked: 0,
    pipeKg: estimatedPipeSold, cableKg: estimatedCableSold,
  };
  potentialRevenue.total = potentialRevenue.pipe + potentialRevenue.cable;
  if (potentialRevenue.included && !recoveryConfirmed) {
    unpricedCosts.push({ code: "recovery-work", item: "설비 회수·선별 공정", reason: "설치량과 회수율로 추정한 매각수익을 반영했습니다. 인발·회수·선별 작업비를 확인하세요." });
    issues.push("설비 추정 매각대금을 반영했습니다. 회수 작업비 견적이 비어 있어 포함 항목의 소계로 표시합니다.");
  }
  if (recoveryConfirmed) equipment += add("장비비", "설비 회수·선별 도급비 (인력 포함)", 1, "식", recoveryCost);
  revenue -= add("매각수익", office?.pipeInstalled ? "동관 (현장 설치량 추정)" : "동관 (사무소 추정)", estimatedPipeSold, "kg", p.price_copper_pipe, -1);
  if (estimateCable) revenue -= add("매각수익", office.cableInstalled ? "피복 전선 (현장 설치량 추정)" : "피복 전선 (사무소 추정)", estimatedCableSold, "kg", cablePrice / 1000, -1);
  if (cableSold && cablePrice == null) issues.push("별도 계근 폐전선 인수 견적이 없어 수익에서 제외했습니다.");
  if (cablePrice != null) revenue -= add("매각수익", "별도 계근 폐전선", cableSold, "t", cablePrice, -1);
  const embeddedRebar = rebar * (1 - scrapRecovery);
  if (embeddedRebar > 0) disposal += add("처리비", "폐콘크리트 동반 반입 · 미회수 철근", embeddedRebar, "t", p.fee_concrete);
  const unsoldSteel = Math.max(0, metal - rebar - structuralSteel) * (1 - scrapRecovery) + structuralSteel * (1 - commonRecovery);
  const unsoldAl = Math.max(0, t.aluminum - sold.aluminum);
  const pipeInInventory = Math.max(0, t.copper - (q.separateCopperTons ?? 0));
  const unsoldCopper = Math.max(0, t.copper - modeledCopper - Math.min(measuredPipe + copperSales.estimatedPipe, pipeInInventory));
  const unsoldMetal = unsoldSteel + unsoldCopper + unsoldAl;
  if (unsoldMetal > 0) {
    const metalFee = q.metalFee ?? (q.fixedComparison ? mixedQuote ?? p.fee_mixed_unverified : p.fee_unsold_metal);
    if (metalFee >= 0) disposal += add("처리비", q.fixedComparison ? "혼합 반출 미회수 기타 금속" : "미매각 금속", unsoldMetal, "t", metalFee);
    else {
      const components = [
        ["별도 철강재", unsoldSteel],
        ["구리", unsoldCopper],
        ["알루미늄", unsoldAl]
      ].filter(([, weight]) => weight > 0);
      unpricedDisposal.push({ item: "미매각 금속", tons: unsoldMetal, components });
    }
  }

  for (const [key, net] of [["wood", q.woodNetPrice ?? p.net_wood], ["resin", q.resinNetPrice ?? p.net_resin]]) {
    const weight = key === "resin" ? split.resin - pvcRecovered : split[key];
    if (weight > 0 && (allInQuote == null || net >= 0) && q[key === "wood" ? "woodNetPrice" : "resinNetPrice"] == null && !q.separatedPricesConfirmed) {
      unpricedCosts.push({ code: `separated-${key}-price`, item: `분리 ${STREAM_LABEL[key]} 인수조건`, reason: "프로젝트 참고 순단가를 적용했습니다. 현장 매각/처리 견적을 입력하세요. 0원은 무상 인수가 확인된 경우입니다." });
    }
    if (net >= 0) revenue -= add("매각수익", STREAM_LABEL[key], weight, "t", net, -1);
    else disposal += add("처리비", `분리 ${STREAM_LABEL[key]}`, weight, "t", -net);
  }
  for (const [key, quote] of [["glass", p.fee_glass_separate], ["board", q.boardFee ?? p.fee_board_separate], ["tile", q.tileFee ?? -1]]) {
    const weight = split[key];
    if (!(weight > 0)) continue;
    if (quote >= 0) disposal += add("처리비", `분리 ${STREAM_LABEL[key]}`, weight, "t", quote);
    else unpricedDisposal.push({ item: `분리 ${STREAM_LABEL[key]}`, tons: weight });
  }

  const transportQuote = allInQuote == null ? (sel ? q.transportSel : q.transportCrush) : null;
  // Transport follows the actual disposal/salvage routes, including unpriced disposal stocks.
  const routes = rows.filter(row => ["처리비", "매각수익"].includes(row.group) && row.qty > 0 && ["t", "kg"].includes(row.unit)).map(row => ({
    key: `${row.group}/${row.item}`, label: row.item, stream: row.item,
    tons: row.unit === "kg" ? row.qty / 1000 : row.qty,
    destination: row.group === "매각수익" ? "salvage" : "disposal",
    kind: /가연물 5% 이하|혼합/.test(row.item) ? "mixed" : /콘크리트|폐벽돌|조적|건설폐재류/.test(row.item) ? "mineral" : "separated",
  }));
  for (const item of unpricedDisposal) if (item.tons > 0) routes.push({ key: `처리비/${item.item}`, label: item.item, stream: item.item, tons: item.tons, destination: "disposal", kind: "separated" });
  const routeQuotes = q.routeQuotes?.[mode];
  if (routeQuotes) for (const route of routes) {
    if (Object.hasOwn(routeQuotes, route.key)) route.quote = routeQuotes[route.key];
  }
  const transportResult = estimateTransport({ ...(q.transport ?? {}), routes, quote: transportQuote, includedInDisposalQuote: allInQuote != null });
  const disposalComponents = { processing: null, collection: null, allInQuote };
  if (allInQuote != null) {
    rows = rows.filter(row => row.group !== "처리비");
    unpricedDisposal.length = 0;
    disposal = add("처리비", "현장 처리·상차·운반 일괄 견적", 1, "식", allInQuote);
  } else {
    disposalComponents.processing = disposal;
    disposalComponents.collection = transportResult.total;
    if (transportResult.total > 0) {
      disposal += add("처리비", transportResult.status === "quote" ? "처리비에 포함한 수집·운반 견적" : "처리비에 포함한 수집·운반 (경로별 산정)", 1, "식", transportResult.total);
    }
  }
  issues.push(...transportResult.issues);
  unpricedCosts.push(...transportResult.unpriced.map(item => ({ code: "transport-route", item: item.label ?? item.item ?? "운반 경로", reason: item.reason ?? "현장 운반견적을 확인하세요." })));
  const transportConditions = transportResult.rows.filter(row => row.kind !== "quote" && row.kind !== "pickup").flatMap(row => [
    row.distanceAssumed && "실거리", !row.receiver && "수용처", row.isProxy && "분리자재 대리차량·적재비중",
    row.referenceLoads < 1 && "소량 최소배차비", row.extrapolated && "원거리 추가조건",
  ].filter(Boolean));
  if (transportConditions.length && !(q.transportConditionsConfirmed || q.transport?.conditionsConfirmed)) {
    unpricedCosts.push({ code: "transport-estimate-conditions", item: "운반 현장조건", reason: `${[...new Set(transportConditions)].join("·")} 미확인: 공표 톤당 참고단가 계산을 유지했습니다. 현장 운반 총견적 또는 해당 반출조건을 확인하세요.` });
  }

  // 5. 간접비
  const indirect = add("간접비", "현장 간접비", days, "일", p.indirect_per_day);

  return { mode, labor, equipment, disposal, disposalComponents, transport: 0, transportQuote, transportResult, potentialRevenue, recoveryCost, copperSales, revenue, indirect, days, unpricedDisposal, unpricedCosts, equipmentNorm: norm, equipmentCrewDays, excavatorHours, schedule: sched, crews: crew, mixed: mix, finishRoutes, split, sold, embeddedRebar, concreteIntake: t.concrete + embeddedRebar + finishCarryover, unsoldMetal, issues, total: labor + equipment + disposal + indirect - revenue, rows: rows.filter((r) => r.qty > 0) };
}

function finishSeparations(q, t, p, selective) {
  const boardRate = selective ? q.boardSel ?? (p.rec_sel_board ?? 0) * 100 : q.boardCrush ?? 0;
  const tileRate = (selective ? q.tileSel : q.tileCrush) ?? 0;
  const fraction = rate => Math.max(0, Math.min(1, rate / 100));
  return {
    board: (q.boardFee ?? p.fee_board_separate) >= 0 ? t.board * fraction(boardRate) : 0,
    tile: (q.tileFee ?? -1) >= 0 ? t.tile * fraction(tileRate) : 0,
  };
}

// Unknown pre-removal residue is priced as mixed until concrete co-loading is confirmed.
export function finishMaterialRoutes(q, t, selective, separated) {
  if (!q.finishTakeoff) return null;
  const mixRate = q.finishDemolitionMixedShare ?? 1;
  const routes = {};
  for (const key of ["board", "tile"]) {
    const total = t[key];
    const separate = separated[key];
    const removed = Math.max(separate, total * (selective ? 1 : q.finishBaseline[key]));
    const remaining = Math.max(0, total - removed);
    const demolitionMixed = remaining * mixRate;
    routes[key] = {
      total, separate, preRemovalMixed: removed - separate,
      demolitionMixed, concreteCarryover: remaining - demolitionMixed,
    };
  }
  return routes;
}

// 두 공법의 잔재에 같은 판정 규칙을 적용한다. 혼합·기타의 미확인 성상은 견적 대상으로 둔다.
export function mixedWaste(t, split, p, q = {}) {
  const wood = t.wood - split.wood, resin = t.resin - split.resin;
  const glass = t.glass - split.glass, tile = (t.tile ?? 0) - (split.tile ?? 0), board = t.board - split.board;
  const mineral = t.mixed * (q.mixedMineral ?? 0);
  const otherCombustible = t.mixed * (q.mixedCombustible ?? 0);
  const unknown = Math.max(0, t.mixed - mineral - otherCombustible);
  const combustible = wood + resin + otherCombustible;
  const tons = t.mixed + glass + tile + board + wood + resin;
  const share = tons > 0 ? combustible / tons : 0;
  const composition = [["mineral", mineral], ["glass", glass + tile], ["board", board]].sort((a, b) => b[1] - a[1]);
  const [main, mainTons] = composition[0];
  const unclassified = unknown > 1e-9 || mainTons === 0 || Math.abs(composition[1][1] - mainTons) < 1e-9;
  const over = share > p.mixed_combustible_limit + 1e-12;
  if (!tons) return { tons, share, main: "none", fee: 0, rule: "잔재 없음" };
  if (over || unclassified) {
    const quote = p.fee_mixed_quote;
    const rule = over ? "가연물 한도 초과" : "주성상 확인 필요";
    return { tons, share, main: unclassified ? "unknown" : main, unknown, fee: quote >= 0 ? quote : p.fee_mixed_unverified, rule, needsQuote: !(quote >= 0) };
  }
  const fees = {
    mineral: combustible > 0 ? [p.fee_mixed_mineral, "건설폐재류+가연물"] : [p.fee_concrete, "건설폐재류"],
    glass: [p.fee_mixed_inert, "불연성 중심 혼합잔재"],
    board: [p.fee_board_mixed, "보드·판넬 중심 혼합잔재"],
  };
  const [fee, rule] = fees[main];
  return { tons, share, main, unknown, fee, rule };
}

// 일반해체 내부 철거 공수 중 분별 작업과 겹치는 부분 (인·일) = 내부 철거 작업조 × 면적 비례 일수.
// 공정표의 최소 일수(sched_interior_min)는 작은 건물에도 하루를 잡는 일정 하한이지 실제 철거 작업량이 아니므로 빼지 않는다.
// (최소 1일치를 빼면 64㎡ 건물에서 6인·일이 빠져 분별 추가 공수가 항상 0이 된다.)
export function generalInteriorPd(q, p) {
  return p.crew_interior * p.sched_interior_per_1000m2 * q.area_m2 / 1000;
}

export const PRESS_FINISH_BASELINE = { board: 0.6, tile: 1 };

function boardTilePd(q, p, shares = { board: 1, tile: 1 }) {
  return shares.board * (q.finishAreas?.board ?? q.area_m2 * p.int_board_ratio) / p.int_board_m2_per_day
    + shares.tile * (q.finishAreas?.tile ?? q.area_m2 * p.int_tile_ratio) / p.int_tile_m2_per_day;
}

function sharedFinishPd(q, p) {
  if (q.finishBaseline) return boardTilePd(q, p, q.finishBaseline);
  return boardTilePd(q, p) * (q.sharedFinish ?? 0) / 100;
}

function windowPd(q, p) {
  const areas = q.finishAreas ?? {};
  const knownArea = (areas.pvc ?? 0) + (areas.aluminum ?? 0);
  const totalArea = q.windowArea ?? ((areas.pvc != null || areas.aluminum != null) ? knownArea : q.area_m2 * p.window_ratio);
  const framePd = (areas.pvc ?? 0) * p.window_pvc_pd_per_m2 + (areas.aluminum ?? 0) * p.window_al_pd_per_m2
    + Math.max(0, totalArea - knownArea) * p.window_frame_pd_per_m2;
  const glassPd = q.windowMode ? totalArea * (q.glassPdPerM2 ?? p.window_frame_pd_per_m2) : 0;
  return framePd + glassPd;
}

function commonFinishPd(q, p) {
  const windowWork = q.windowMode === "both" ? windowPd(q, p) : 0;
  return Math.max(sharedFinishPd(q, p) + windowWork, q.generalFinishPd ?? generalInteriorPd(q, p));
}

export function selExtra(q, p) {
  const A = q.area_m2;
  if (Number.isFinite(q.selectiveExtraPd) && q.selectiveExtraPd >= 0) {
    const persons = q.selectiveExtraPd;
    const carpenter = persons * Math.min(100, Math.max(0, q.carpenterShare ?? 0)) / 100;
    return { method: "field", persons, rows: [
      { item: "현장 입력 분별 추가 보통인부", qty: persons - carpenter, wage: "laborer" },
      { item: "현장 입력 분별 추가 목공", qty: carpenter, wage: "carpenter" },
    ], issues: [] };
  }
  // Only extend the selective operation. A labor comparison cannot establish the
  // mass of omitted materials or modify labor already booked in the base schedule.
  const referenceFallback = q.selectiveLaborReference === "park-2023" && q.labor === "quantity"
    && q.finishQuantityMode === "auto" && q.generalFinishPd == null
    && q.finishTakeoff?.board?.unverified === true && q.finishTakeoff?.tile?.unverified === true;
  if (q.labor !== "quantity" || referenceFallback) {
    const baseCarpenter = A * p.sel_extra_carpenter;
    const baseLaborer = A * p.sel_extra_laborer;
    const total = baseCarpenter + baseLaborer;
    const commonWindow = q.windowMode === "both" ? Math.min(total, windowPd(q, p)) : 0;
    const remaining = total > 0 ? (total - commonWindow) / total : 0;
    const rows = [
      { item: "분별 추가 목공", qty: baseCarpenter * remaining, wage: "carpenter" },
      { item: "분별 추가 보통인부", qty: baseLaborer * remaining, wage: "laborer" },
    ];
    const issues = ["표 3·4 차이 품의 현장 적용 및 천장 모르타르·바닥 타일 기재 의도는 확인이 필요합니다."];
    if (referenceFallback) issues.push("보드·타일 조사 물량이 없어 박지선 외(2023)의 5층 공동주택 2,400㎡ 비교 사례에서 산정한 추가 노무량을 해체 대상 면적에 적용했습니다. 현장 공수 입력으로 대체할 수 있습니다.");
    return { method: "paper", referenceFallback, commonWindow, rows, persons: rows[0].qty + rows[1].qty, issues };
  }

  const areas = q.finishAreas ?? {};
  const hasFrameAreas = areas.pvc != null || areas.aluminum != null;
  const gross = boardTilePd(q, p) + windowPd(q, p);
  // 자재별 공수는 보드·타일·창틀을 "떼어 내는 총공수"다. 일반해체(두 안 공통)의 내부 철거 인부도 같은 범위를
  // 철거하므로, 그대로 더하면 분별안에서 같은 작업을 두 번 센다. 입력값이 없으면 두 안에 이미 들어간
  // 내부 철거 공수를 같은 범위의 일반해체 공수로 보고 뺀다 (0을 입력하면 차감하지 않는다).
  const interiorPd = generalInteriorPd(q, p);
  const baseline = commonFinishPd(q, p);
  const persons = Math.max(0, gross - baseline);
  const issues = [];
  // 창틀은 PVC·알루미늄 중 하나라도 확인되면 나머지를 0으로 보므로 추정이 아니다
  const estimated = [areas.board == null && "보드", areas.tile == null && "타일", !hasFrameAreas && "창틀"].filter(Boolean);
  if (estimated.length) issues.push(`${estimated.join("·")} 면적을 연면적 비율로 추정했습니다.`);
  if (q.generalFinishPd == null && !q.finishBaseline) issues.push(`같은 범위의 일반해체 공수가 없어 두 안 공통 내부 철거 공수 중 면적 비례분 ${interiorPd.toFixed(1)}인·일을 잠정 차감했습니다. 일반해체에서 보드·타일·창틀을 철거하지 않으면 0을 입력하세요.`);
  if (baseline > gross) issues.push("적용한 일반해체 공수가 분별 총공수보다 커서 추가 공수를 0으로 계산했습니다.");
  const carpenter = persons * (q.carpenterShare ?? 0) / 100;
  if (q.carpenterShare == null) issues.push("프로젝트 기본값인 보통인부 100%를 적용했습니다.");
  return { method: "quantity", interiorPd, rows: [
    { item: "분별 추가: 내장재·창틀 보통인부", qty: persons-carpenter, wage: "laborer" },
    { item: "분별 추가: 내장재·창틀 목공", qty: carpenter, wage: "carpenter" }],
    gross, baseline, persons, issues };
}

// 공기(작업일). 압쇄안은 해체계획서 4건의 예정공정표에서 뽑은 규칙:
//   가설 + 내부 철거 + 구조체 해체 + 마무리 (폐기물 반출은 구조체 해체와 겹쳐서 공기를 늘리지 않는다)
// 분별안은 계획서 자료가 없어서, 압쇄안 공기에 "분별로 늘어나는 인원 ÷ 작업조"를 더한다.
export function schedule(q, p, mode) {
  const k = q.area_m2 / 1000, floors = Math.max(0, q.floors ?? 1);
  const setup = p.sched_setup_base + p.sched_setup_per_1000m2 * k;
  const commonPd = q.labor === "quantity"
    ? (q.windowMode ? commonFinishPd(q, p) : sharedFinishPd(q, p))
    : q.windowMode === "both" ? Math.max(generalInteriorPd(q, p), windowPd(q, p)) : 0;
  const interior = Math.max(p.sched_interior_min, p.sched_interior_per_1000m2 * k, commonPd / Math.max(1, p.crew_interior));
  const m2PerDay = p.sched_struct_m2_per_day;
  const parallel = excavators(q, p) > 1 ? (q.parallelGain ?? 0) : 0;
  const capacity = 1 + (excavators(q, p) - 1) * parallel;
  const cut = concreteCut(q, mode);
  const crushShare = remainingCrushShare(q, mode);
  const cutting = cut.ready ? cut.days : 0;
  const areaDays = (p.sched_struct_base + p.sched_struct_per_floor * floors + q.area_m2 / (m2PerDay * capacity)) * crushShare;
  const volumeDays = crushSegments(q, p, mode).reduce((sum, segment) => sum + segment.days, 0) / capacity;
  const crushing = equipmentMode(q) === "mixed"
    ? (q.smallHours + q.largeHours - (q.concurrentHours ?? 0)) * crushShare / p.hours_per_day
    : Math.max(volumeDays, areaDays * (q.structureFactor ?? 1));
  const structure = crushing + cutting;
  const finish = p.sched_finish_base + p.sched_finish_per_1000m2 * k;
  const selective = mode === "selective" ? selExtra(q, p).persons / p.crew_size : 0;
  const extension = selective * (1 - (q.overlap ?? 0));
  const recovery = Math.max(0, q[mode === "selective" ? "recoveryDaysSel" : "recoveryDaysCrush"] ?? q.recoveryDaysCommon ?? 0);
  return { setup, interior, structure, crushing, cutting, areaDays, volumeDays, finish, selective, extension, recovery, total: setup + interior + structure + finish + extension + recovery };
}

// 굴착기 대수: 대지가 넉넉할 때만 큰 건물에 장비를 더 넣는다 (계획서: 965㎡ 1대, 4,515㎡ 학교 2대).
// 보통·협소·진입 제한 대지는 1대 (민서, 11/14 회의록)
export const excavators = (q, p) => equipmentMode(q) === "mixed" ? 2 : (q.site === "wide" && !smallSite(q) ? Math.max(1, Math.ceil(q.area_m2 / p.area_per_excavator)) : 1);

// 공종별 하루 작업조 인원. 살수공과 구조체 보조 인부는 굴착기 대수에 비례한다.
export function crews(q, p) {
  const n = excavators(q, p);
  return { excavators: n, standing: p.crew_standing, setup: q.scaffold === false ? 0 : p.crew_setup, interior: p.crew_interior, structure: p.crew_per_excavator * n, finish: p.crew_finish };
}

// 보드·타일 철거 공수의 비용과 효과가 짝이 맞는지 확인한다. 기본값에서는 떼어 낸 보드·타일을 따로 처리하지 않고
// (분리율 0, 별도 견적 없음) 콘크리트 성상 배분도 두 공법 동일이라, 철거 비용만 들어가고 효과는 0으로 잡힌다.
// 반환: 그 비용(인건비 + 늘어난 공기의 간접비·상시 인원)과, 같은 금액을 콘크리트 성상 개선으로 상쇄하려면
// 건설폐재류에서 순수 폐콘크리트로 옮겨야 하는 비율(%p). 해당 없으면 null.
export function unbenefitedFinishLabor(q, p) {
  if (q.labor !== "quantity") return null;
  const boardSeparated = (q.boardSel ?? (p.rec_sel_board ?? 0) * 100) > (q.boardCrush ?? 0) && q.t?.board > 0 && (q.boardFee ?? p.fee_board_separate) >= 0;
  const tileSeparated = (q.tileSel ?? 0) > (q.tileCrush ?? 0) && q.t?.tile > 0 && q.tileFee >= 0;
  const concreteBenefit = (q.concreteCase === "linked"
    ? concreteGradeLink(q, p).factor > 0
    : !["same", "building"].includes(q.concreteCase ?? DEFAULT_CONCRETE_CASE)) || (q.cleanSel ?? 0) > 0 && q.cleanPrice != null;
  if (boardSeparated || tileSeparated || concreteBenefit) return null;
  const without = { ...q, finishAreas: { ...q.finishAreas, board: 0, tile: 0 } };
  const cost = compare(q, p).delta - compare(without, p).delta;
  if (!(cost > 1)) return null;
  const concrete = streamTons(q, p).t.concrete;
  const saving = q.cleanPrice != null ? p.fee_concrete - q.cleanPrice
    : q.concreteCase === "same" ? p.fee_concrete - p.fee_pure_concrete : 0;
  const sharePoints = concrete > 0 && saving > 0 ? (cost / (concrete * saving)) * 100 : null;
  return { cost, sharePoints };
}

export function compare(q, p) {
  const crush = costScenario(q, p, "crush"), selective = costScenario(q, p, "selective");
  const unpricedCuts = ["crush", "selective"].filter(mode => concreteCut(q, mode).quoteMissing);
  const partialTransport = (crush.transportQuote == null && crush.disposalComponents.allInQuote == null) !== (selective.transportQuote == null && selective.disposalComponents.allInQuote == null);
  const hasUnpricedDisposal = crush.unpricedDisposal.length > 0 || selective.unpricedDisposal.length > 0;
  const missing = [...crush.unpricedCosts, ...selective.unpricedCosts];
  for (const [mode, result] of [["crush", crush], ["selective", selective]]) {
    for (const item of result.unpricedDisposal) missing.push({ code: "disposal-quote", item: item.item, mode, reason: item.tons == null ? "확인 중량과 처리견적이 필요합니다." : `${item.tons.toFixed(3)}t 처리견적이 합계에서 빠졌습니다.` });
  }
  if (steelDismantling(q).excluded) missing.push({ code: "steel-dismantling", item: "철골 절단·인양", reason: "양 공법의 절단·인양 도급비가 확인되지 않았습니다." });
  for (const mode of unpricedCuts) missing.push({ code: "concrete-cut", item: "콘크리트 절단·인양", mode, reason: "작업량·공기는 반영했으나 도급비가 합계에서 빠졌습니다." });
  const usesGradeRates = (q.t?.concrete ?? 0) > 0 && [crush, selective].some(result =>
    result.disposalComponents.allInQuote == null && (q.cleanPrice == null || (result.mode === "crush" ? q.cleanCrush : q.cleanSel) !== 100));
  if (q.concreteCase && q.concreteCase !== "building" && usesGradeRates && !q.concreteGradesConfirmed) missing.push({ code: "concrete-grades", item: "콘크리트 반입 성상", reason: q.concreteCase === "building-sorted"
    ? "압쇄 66/26/8%, 분별 80/18/2%는 프로젝트의 건축 폐재류 분리 가정입니다. 처리장 계근표·성상검사 또는 현장 일괄 견적으로 확인하세요."
    : "기존 66/26/8 등 성상비율과 순수 콘크리트 단가는 비교 가정입니다. 현장 반입조건·견적을 확인하세요." });
  const unknownVolume = q.unresolvedMaterialVolume_m3 ?? 0;
  if (unknownVolume > 1e-9) missing.push({ code: "quantity-material", item: "미확인 재료 물량", reason: `${unknownVolume.toFixed(3)}㎥의 재료·밀도·실체적이 미확인입니다.` });
  const finishes = Object.entries(q.finishTakeoff ?? {});
  const unfinished = finishes.filter(([, item]) => item.unverified).map(([key]) => STREAM_LABEL[key]);
  const areaAssumed = finishes.filter(([, item]) => ["area-finish-assumption", "area-supplement-assumption"].includes(item.source)).map(([key]) => STREAM_LABEL[key]);
  if (unfinished.length) missing.push({ code: "finish-missing", item: unfinished.join("·"), reason: "분별 작업량을 확정하려면 조사 면적이나 중량이 필요합니다. 현장에 없는 것으로 확인한 품목은 0을 입력하세요." });
  if (areaAssumed.length) missing.push({ code: "finish-assumption", item: areaAssumed.join("·"), reason: "연면적 비율로 보충한 가정 물량입니다. 조사한 면적이나 중량으로 비교를 갱신하세요." });
  const uniqueMissing = [...new Map(missing.map(item => [[item.code, item.item, item.mode ?? ""].join("|"), item])).values()];
  const assumptions = [...new Set([
    ...crush.transportResult.assumptions, ...selective.transportResult.assumptions,
    ...crush.equipmentNorm.assumptions, ...selective.equipmentNorm.assumptions,
    "철근량·회수율·공수·일당 간접비는 현장 실측으로 교체할 비교 가정입니다.",
    "전체 도급범위의 가설재·보강·법정경비·일반관리비·이윤·VAT 포함 여부는 별도 확인 대상입니다.",
  ])];
  const delta = selective.total - crush.total;
  const completeness = { complete: !uniqueMissing.length, eligibleForRecommendation: !uniqueMissing.length, missing: uniqueMissing, assumptions, basis: uniqueMissing.length ? "포함 항목 기준" : "확인한 범위와 가정 기준" };
  return { crush, selective, partialTransport, hasUnpricedDisposal, unpricedCuts, delta,
    deltaDays: selective.schedule.extension + (selective.schedule.structure - crush.schedule.structure) + (selective.schedule.recovery - crush.schedule.recovery), completeness,
    recommended: completeness.eligibleForRecommendation ? delta === 0 ? "tie" : delta < 0 ? "selective" : "crush" : null };
}

// 면적 × 표준품셈 원단위로 물량을 추정 (IFC가 없을 때, 또는 모델 검산용)
export function quantitiesFromArea(area_m2, usage, rates) {
  const u = rates.wasteUnits[usage];
  const t = Object.fromEntries(STREAMS.map((k) => [k, (u[k] || 0) * area_m2]));
  return { area_m2, floors: 1, concrete_m3: t.concrete / rates.density.concrete, rebarFromConcrete: false, t, basis: "원단위" };
}

// 논문(박지선 외 2023) 계산을 그대로 따라 한다. 단위: 천원. 반올림 위치도 논문과 같다.
export function paperMode(c) {
  const A = c.area_m2, k = (won) => Math.round(won / 1000);
  const construction = ["general", "selective"].map((m) =>
    k(Math.round(A * c.productivity_per_m2[m].carpenter) * c.wage.carpenter) + k(Math.round(A * c.productivity_per_m2[m].laborer) * c.wage.laborer));
  const w = c.waste_t_per_m2, d = c.disposal_won_per_t;
  const common = k(A * w.concrete * d.concrete) + k(A * w.wood * d.wood) + k(A * w.resin * d.resin);
  const disposal = [common + k(A * w.mixed * d.mixed_general), common + k(A * w.mixed * d.mixed_selective)];
  const [sx, sy, sz] = c.revenue.wood.sheet_m;
  const sheets = Math.floor(Math.round(A * w.wood) / (sx * sy * sz * c.revenue.wood.density));
  const revenue = k(sheets * c.revenue.wood.won_per_sheet) + k(Math.round(A * w.resin) * c.revenue.resin.won_per_t);
  const delta = construction[1] - construction[0] - (disposal[0] - disposal[1]) - revenue;
  return { construction, disposal, revenue, sheets, delta };
}

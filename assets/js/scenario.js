// 일괄 압쇄 vs 전면 분별해체 비용 엔진. DOM을 쓰지 않는 순수 함수만 둔다.
// 물량 q = { area_m2, floors(지상 층수), concrete_m3, rebarFromConcrete, t: { concrete, metal, wood, resin, glass, board, mixed, copper, aluminum },
//          site(대지 조건: SITES의 키), labor(분별 추가 품 계산: "paper" | "quantity") }
// 단가 p = { 키: 숫자 } (rates.json의 params에서 value만 뽑은 것)

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
export const EQUIPMENT = { auto: "대지 조건으로 추정", large: "대형 지상 장비", small: "소형 지상 장비", mounted: "소형 탑재 장비 + 크레인" };
export const equipmentMode = (q) => q.equipment && q.equipment !== "auto"
  ? q.equipment : q.site === "tight" || q.site === "restricted" ? "mounted" : "large";
export const smallSite = (q) => equipmentMode(q) !== "large";
export const separation = (p) => ({
  wood: p.rec_sel, resin: p.rec_sel_resin ?? p.rec_sel,
  glass: p.rec_sel_glass ?? 0, board: p.rec_sel_board ?? 0,
});
// 분별 추가 품 계산 방식 (6.3의 3)
export const LABOR_METHODS = { paper: "논문 표 3·4의 차이 품 (현장 적용 가정)", quantity: "자재별 작업량과 일반해체 공수 차감" };

export const paramValues = (rates) => Object.fromEntries(Object.entries(rates.params).map(([k, v]) => [k, v.value]));

const tons = (q) => Object.fromEntries(STREAMS.map((s) => [s, Number(q.t?.[s]) || 0]));

export const CONCRETE_CASES = {
  same: { label: "양 공법 동일", shares: [0.66, 0.26, 0.08] },
  standard: { label: "분별 기본 가정", shares: [0.71, 0.26, 0.03] },
  good: { label: "분별 선별 양호 가정", shares: [0.80, 0.18, 0.02] },
};

export function concreteGrades(p, selective, concreteCase = "good") {
  const scenario = selective ? CONCRETE_CASES[concreteCase] ?? CONCRETE_CASES.good : CONCRETE_CASES.same;
  const shares = scenario.shares;
  return [
    { name: "순수 폐콘크리트", share: shares[0], fee: p.fee_pure_concrete },
    { name: "건설폐재류 (가연물 제거)", share: shares[1], fee: p.fee_concrete },
    { name: "건설폐재류 (가연물 5% 이하)", share: shares[2], fee: p.fee_mixed_mineral },
  ];
}

export function costScenario(q, p, mode) {
  const sel = mode === "selective";
  const t = tons(q);
  // IFC 모델에는 철근이 없으므로 콘크리트 부피에서 추정한다
  const metal = t.metal + (q.rebarFromConcrete ? (q.concrete_m3 * (q.rebarKgPerM3 ?? p.rebar_kg_per_m3)) / 1000 : 0);
  const rows = [];
  const add = (group, item, qty, unit, price, sign = 1) => {
    const amount = sign * qty * price;
    rows.push({ group, item, qty, unit, price, amount });
    return amount;
  };

  const extra = sel ? selExtra(q, p) : null;
  const issues = [];
  if (q.panelWeightMissing) issues.push("폐샌드위치패널이 감지되었습니다. 별도 처리비에 반영할 중량을 입력하세요.");
  if (q.structure === "other") issues.push("기타·복합 구조에 RC 공기와 장비식을 적용한 비교값입니다.");
  // 1. 인건비 — 공종별 일수 × 작업조 × 노임 (두 안 공통). 일수는 schedule()의 공기 규칙을 쓴다.
  const sched = schedule(q, p, mode), days = sched.total, crew = crews(q, p);
  const equipmentCrewDays = q.equipmentCrewPeriod === "all" ? days : sched.structure;
  let labor = add("인건비", "상시 작업유도·감시", crew.standing * days, "인·일", p.wage_laborer)
    + add("인건비", "가설 설치 비계공", crew.setup * sched.setup, "인·일", p.wage_carpenter)
    + add("인건비", "내부 철거 인부", crew.interior * sched.interior, "인·일", p.wage_laborer)
    + add("인건비", "굴착기 연동 살수·신호", crew.structure * equipmentCrewDays, "인·일", p.wage_laborer)
    + add("인건비", "마무리 인부", crew.finish * sched.finish, "인·일", p.wage_laborer);
  if (extra) {
    for (const r of extra.rows) labor += add("인건비", r.item, r.qty, "인·일", r.wage === "carpenter" ? p.wage_carpenter : p.wage_laborer);
    issues.push(...extra.issues);
  }

  const small = smallSite(q);
  const production = small ? p.crush_m3_per_day_small : p.crush_m3_per_day;
  const excavatorHours = ((q.concrete_m3 || 0) / production) * p.hours_per_day;
  let equipment = add("장비비", small ? "소형 굴착기+압쇄기" : "굴착기+압쇄기", excavatorHours, "h", p.excavator_per_h);
  if (equipmentMode(q) === "mounted") {
    const craneDays = q.craneDays ?? sched.structure;
    equipment += add("장비비", "이동식 크레인 (장비 탑재·양중)", craneDays, "일", p.crane_per_day);
    if (q.craneDays == null) issues.push("크레인 사용 일수가 없어 구조체 공정 전체를 적용했습니다.");
  }

  const rates = separation(p);
  const split = Object.fromEntries(Object.entries(rates).map(([key, rate]) => [key, sel ? t[key] * rate : 0]));
  const mix = mixedWaste(t, split, p, q);
  const specified = t.concrete * (sel ? q.cleanSel ?? 0 : q.cleanCrush ?? 0) / 100;
  const quoted = q.cleanPrice == null ? 0 : specified;
  if (specified && !quoted) issues.push("콘크리트 별도 반입 견적이 없어 공법별 성상 비율을 적용했습니다.");
  let disposal = add("처리비", "혼합건설폐기물", mix.tons, "t", mix.fee);
  for (const grade of concreteGrades(p, sel, q.concreteCase)) {
    disposal += add("처리비", grade.name, (t.concrete - quoted) * grade.share, "t", grade.fee);
  }
  if (t.masonry > 0) disposal += add("처리비", "폐벽돌·조적 (건설폐재류)", t.masonry, "t", p.fee_concrete);
  if (quoted) disposal += add("처리비","별도 반입 콘크리트 (현장 견적)",quoted,"t",q.cleanPrice);
  if (t.panel > 0) {
    if (p.fee_panel >= 0) disposal += add("처리비", STREAM_LABEL.panel, t.panel, "t", p.fee_panel);
    else issues.push("폐샌드위치패널 처리비는 별도 견적이 없어 합계에서 빠져 있습니다.");
  }
  if (mix.needsQuote) issues.push("혼합잔재는 별도 견적 조건입니다. 견적 입력 전에는 비교용 잠정단가를 적용합니다.");

  const nf = sel ? p.rec_nonferrous_sel : p.rec_nonferrous_crush;
  const copperRate = (sel ? p.rec_copper_sel : p.rec_copper_crush) ?? nf;
  const sold = { metal: metal * (sel ? p.rec_scrap_sel : p.rec_scrap_crush), copper: t.copper * copperRate, aluminum: t.aluminum * nf };
  let revenue = -add("매각수익", "고철", sold.metal, "t", p.price_scrap, -1)
    - add("매각수익", "구리", sold.copper, "t", p.price_copper, -1)
    - add("매각수익", "알루미늄", sold.aluminum, "t", p.price_aluminum, -1);
  for (const [key,label] of [["cable","별도 계근 폐전선"],["fitting","별도 계근 배관·설비"]]) {
    const weight = q[key + (sel ? "Sel" : "Crush")];
    if (!weight) continue;
    if (q[key+"Price"] == null) issues.push(label + " 인수 견적이 없어 수익에서 제외했습니다.");
    else revenue -= add("매각수익",label,weight,"t",q[key+"Price"],-1);
  }
  const unsoldMetal = Math.max(0, metal + t.copper + t.aluminum - sold.metal - sold.copper - sold.aluminum);
  if (unsoldMetal > 0) {
    if (p.fee_unsold_metal >= 0) disposal += add("처리비", "미매각 금속", unsoldMetal, "t", p.fee_unsold_metal);
    else issues.push("미매각 금속의 처리비는 견적이 없어 합계에서 빠져 있습니다.");
  }

  for (const [key, net] of [["wood", p.net_wood], ["resin", p.net_resin]]) {
    if (net >= 0) revenue -= add("매각수익", STREAM_LABEL[key], split[key], "t", net, -1);
    else disposal += add("처리비", `분리 ${STREAM_LABEL[key]}`, split[key], "t", -net);
  }
  for (const [key, quote] of [["glass", p.fee_glass_separate], ["board", p.fee_board_separate]]) {
    if (!split[key]) continue;
    if (quote >= 0) disposal += add("처리비", `분리 ${STREAM_LABEL[key]}`, split[key], "t", quote);
    else issues.push(`분리 ${STREAM_LABEL[key]} ${split[key].toFixed(2)}t의 처리비는 견적이 없어 합계에서 빠져 있습니다.`);
  }

  // 5. 간접비
  const indirect = add("간접비", "현장 간접비", days, "일", p.indirect_per_day);

  return { mode, labor, equipment, disposal, revenue, indirect, days, equipmentCrewDays, excavatorHours, schedule: sched, crews: crew, mixed: mix, split, sold, unsoldMetal, issues, total: labor + equipment + disposal + indirect - revenue, rows: rows.filter((r) => r.qty > 0) };
}

// 두 공법의 잔재에 같은 판정 규칙을 적용한다. 혼합·기타의 미확인 성상은 견적 대상으로 둔다.
export function mixedWaste(t, split, p, q = {}) {
  const wood = t.wood - split.wood, resin = t.resin - split.resin;
  const glass = t.glass - split.glass, tile = t.tile ?? 0, board = t.board - split.board;
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

export function selExtra(q, p) {
  const A = q.area_m2;
  if (q.labor !== "quantity") {
    const rows = [
      { item: "분별 추가 목공", qty: A * p.sel_extra_carpenter, wage: "carpenter" },
      { item: "분별 추가 보통인부", qty: A * p.sel_extra_laborer, wage: "laborer" },
    ];
    return { method: "paper", rows, persons: rows[0].qty + rows[1].qty,
      issues: ["표 3·4 차이 품의 현장 적용 및 천장 모르타르·바닥 타일 기재 의도는 확인이 필요합니다."] };
  }

  const areas = q.finishAreas ?? {};
  const frameArea = A * p.window_ratio;
  const hasFrameAreas = areas.pvc != null || areas.aluminum != null;
  const gross = (areas.board ?? A * p.int_board_ratio) / p.int_board_m2_per_day
    + (areas.tile ?? A * p.int_tile_ratio) / p.int_tile_m2_per_day
    + (hasFrameAreas ? (areas.pvc ?? 0) * p.window_pvc_pd_per_m2 + (areas.aluminum ?? 0) * p.window_al_pd_per_m2
      : frameArea * p.window_frame_pd_per_m2);
  const baseline = q.generalFinishPd;
  const persons = Math.max(0, gross - (baseline ?? 0));
  const issues = [];
  if (areas.board == null || areas.tile == null || areas.pvc == null || areas.aluminum == null) issues.push("일부 내장재 면적을 연면적 비율로 추정했습니다.");
  if (baseline == null) issues.push("같은 범위의 일반해체 공수가 없어 자재별 분별 총공수를 잠정 적용했습니다.");
  if (baseline > gross) issues.push("입력한 일반해체 공수가 분별 총공수보다 큽니다. 추가 공수는 0으로 계산했습니다.");
  const carpenter = persons * (q.carpenterShare ?? 0) / 100;
  if (q.carpenterShare == null) issues.push("목공 투입 비율 미확인. 작업량 방식은 보통인부 단가로 잠정 산정합니다.");
  return { method: "quantity", rows: [
    { item: "분별 추가: 내장재·창틀 보통인부", qty: persons-carpenter, wage: "laborer" },
    { item: "분별 추가: 내장재·창틀 목공", qty: carpenter, wage: "carpenter" }],
    gross, baseline, persons, issues };
}

// 공기(작업일). 압쇄안은 해체계획서 4건의 예정공정표에서 뽑은 규칙:
//   가설 + 내부 철거 + 구조체 해체 + 마무리 (폐기물 반출은 구조체 해체와 겹쳐서 공기를 늘리지 않는다)
// 분별안은 계획서 자료가 없어서, 압쇄안 공기에 "분별로 늘어나는 인원 ÷ 작업조"를 더한다.
export function schedule(q, p, mode) {
  const k = q.area_m2 / 1000, floors = q.floors || 1;
  const setup = p.sched_setup_base + p.sched_setup_per_1000m2 * k;
  const interior = Math.max(p.sched_interior_min, p.sched_interior_per_1000m2 * k);
  const production = smallSite(q) ? p.crush_m3_per_day_small : p.crush_m3_per_day;
  const m2PerDay = p.sched_struct_m2_per_day;
  const parallel = excavators(q, p) > 1 ? (q.parallelGain ?? 0) : 0;
  const capacity = 1 + (excavators(q, p) - 1) * parallel;
  const areaDays = p.sched_struct_base + p.sched_struct_per_floor * floors + q.area_m2 / (m2PerDay * capacity);
  const volumeDays = (q.concrete_m3 || 0) / (production * capacity);
  const structure = Math.max(volumeDays, areaDays * (q.structureFactor ?? 1));
  const finish = p.sched_finish_base + p.sched_finish_per_1000m2 * k;
  const selective = mode === "selective" ? selExtra(q, p).persons / p.crew_size : 0;
  const extension = selective * (1 - (q.overlap ?? 0));
  return { setup, interior, structure, areaDays, volumeDays, finish, selective, extension, total: setup + interior + structure + finish + extension };
}

// 굴착기 대수: 대지가 넉넉할 때만 큰 건물에 장비를 더 넣는다 (계획서: 965㎡ 1대, 4,515㎡ 학교 2대).
// 보통·협소·진입 제한 대지는 1대 (민서, 11/14 회의록)
export const excavators = (q, p) => (q.site === "wide" && !smallSite(q) ? Math.max(1, Math.ceil(q.area_m2 / p.area_per_excavator)) : 1);

// 공종별 하루 작업조 인원. 살수공과 구조체 보조 인부는 굴착기 대수에 비례한다.
export function crews(q, p) {
  const n = excavators(q, p);
  return { excavators: n, standing: p.crew_standing, setup: q.scaffold === false ? 0 : p.crew_setup, interior: p.crew_interior, structure: p.crew_per_excavator * n, finish: p.crew_finish };
}

export function compare(q, p) {
  const crush = costScenario(q, p, "crush"), selective = costScenario(q, p, "selective");
  return { crush, selective, delta: selective.total - crush.total, deltaDays: selective.schedule.extension };
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

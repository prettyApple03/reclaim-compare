import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { paperMode, compare, costScenario, mixedWaste, paramValues, quantitiesFromArea, schedule, excavators, crews, selExtra } from "../assets/js/scenario.js";
import { breakEven, simulate, tornado, triangular, variables, mulberry32 } from "../assets/js/sensitivity.js";

const load = (f) => JSON.parse(readFileSync(new URL(`../assets/data/${f}`, import.meta.url)));
const paper = load("paper2023_case.json"), rates = load("rates.json");
const p = paramValues(rates), q = quantitiesFromArea(2400, "공동주택", rates), vars = variables(rates);

test("논문 사례 재현: 표 5·8·9와 Δ = −34,727천원", () => {
  const r = paperMode(paper);
  assert.deepEqual(r.construction, paper.expected.construction);
  assert.deepEqual(r.disposal, paper.expected.disposal);
  assert.equal(r.sheets, 2469);
  assert.equal(r.revenue, paper.expected.revenue);
  assert.equal(r.delta, paper.expected.delta);
});

test("논문 사례: 재활용 수익이 0이면 분별이 28,699천원 더 비싸다", () => {
  const c = structuredClone(paper);
  c.revenue.wood.won_per_sheet = 0; c.revenue.resin.won_per_t = 0;
  assert.equal(paperMode(c).delta, 28699);
});

test("분별 추가 품 = 논문 표 3·4의 분별 − 일반 차이", () => {
  const diff = (i) => +rates.laborItems.reduce((s, x) => s + x.selective[i] - x.crush[i], 0).toFixed(3);
  assert.deepEqual([diff(0), diff(1)], [0.09, 0.025]);
  assert.deepEqual([p.sel_extra_carpenter, p.sel_extra_laborer], [0.09, 0.025]);
  // 논문 사례 규모(2,400㎡)에서 논문의 시공비 증가 67,522천원과 같다
  const paperWages = { ...p, wage_carpenter: paper.wage.carpenter, wage_laborer: paper.wage.laborer };
  const rows = costScenario({ ...q, floors: 5 }, paperWages, "selective").rows.filter((r) => r.item.startsWith("분별 추가"));
  assert.equal(Math.round(rows.reduce((a, r) => a + r.qty, 0)), 276);
  assert.ok(Math.abs(rows.reduce((a, r) => a + r.amount, 0) / 1000 - 67522) < 1);
});

test("상시 유도·감시와 굴착기 연동 인원은 투입일수에 맞게 따로 계산한다", () => {
  const wide = { ...q, area_m2: 4514.84, floors: 4, site: "wide" };
  assert.equal(excavators({ area_m2: 965.04, site: "wide" }, p), 1);
  assert.equal(excavators(wide, p), 2);
  assert.equal(crews(wide, p).standing, 1);
  assert.equal(crews(wide, p).structure, 4);
  const base = costScenario(wide, p, "selective");
  const whole = costScenario({ ...wide, equipmentCrewPeriod: "all" }, p, "selective");
  const qty = (s, item) => s.rows.find((r) => r.item === item).qty;
  assert.equal(qty(base, "상시 작업유도·감시"), base.days);
  assert.equal(qty(base, "굴착기 연동 살수·신호"), base.schedule.structure * 4);
  assert.equal(qty(whole, "굴착기 연동 살수·신호"), whole.days * 4);
  assert.equal(whole.days, base.days);
  assert.equal(whole.indirect, base.indirect);
  assert.ok(whole.labor > base.labor);
  for (const site of ["normal", "tight", "restricted", undefined]) assert.equal(excavators({ ...wide, site }, p), 1);
});

test("일당 간접비 70만원과 50~90만원 탐색 범위가 계산에 들어간다", () => {
  assert.equal(p.indirect_per_day, 700000);
  assert.equal(rates.params.indirect_per_day.assumed, true);
  const v = vars.find((v) => v.key === "indirect_per_day");
  assert.deepEqual([v.min, v.max], [500000, 900000]);
  const r = compare(q, p);
  assert.equal(r.selective.indirect, r.selective.days * p.indirect_per_day);
  const [effect] = tornado(q, p, [v]);
  assert.ok(Math.abs(effect.span - r.deltaDays * 400000) < 1e-6);
  assert.notEqual(simulate(q, p, [v], { n: 50 }).p10, simulate(q, p, [v], { n: 50 }).p90);
});

test("총액 = 내역 행의 합, 구조체 비용은 두 안이 같다", () => {
  const { crush, selective } = compare(q, p);
  for (const s of [crush, selective]) {
    assert.ok(Math.abs(s.rows.reduce((a, r) => a + r.amount, 0) - s.total) < 1);
    assert.ok(s.total > 0 && s.days > 0);
  }
  assert.equal(crush.equipment, selective.equipment);
  assert.ok(selective.labor > crush.labor && selective.disposal < crush.disposal && selective.days > crush.days);
});

test("혼합폐기물 처리비가 오르면 분별 쪽으로 기운다", () => {
  const base = compare(q, p).delta;
  assert.ok(compare(q, { ...p, fee_mixed_unverified: p.fee_mixed_unverified * 3 }).delta < base);
});

test("손익분기: 찾은 값에서 Δ ≈ 0", () => {
  const x = breakEven(q, p, "net_resin", -5e5, 5e6);
  assert.ok(x != null);
  assert.ok(Math.abs(compare(q, { ...p, net_resin: x }).delta) < 1);
  assert.equal(breakEven(q, p, "hours_per_day", 1, 24), null); // 두 안에 공통이라 부호가 바뀌지 않는다
});

test("몬테카를로: 같은 seed면 같은 결과, 분위수 순서", () => {
  const a = simulate(q, p, vars, { n: 500, seed: 7 }), b = simulate(q, p, vars, { n: 500, seed: 7 });
  assert.equal(a.pSelective, b.pSelective);
  assert.equal(a.p50, b.p50);
  assert.ok(a.p10 <= a.p50 && a.p50 <= a.p90);
  assert.notEqual(simulate(q, p, vars, { n: 500, seed: 8 }).p50, a.p50);
});

test("삼각분포는 범위 안, 토네이도는 영향 큰 순", () => {
  const rnd = mulberry32(3);
  for (let i = 0; i < 1000; i++) { const x = triangular(rnd(), 2, 2, 5); assert.ok(x >= 2 && x <= 5); }
  const t = tornado(q, p, vars);
  assert.ok(t.length === vars.length && t[0].span >= t.at(-1).span);
});

test("철근 추정: IFC 물량이면 콘크리트 부피에서 고철 수익이 나온다", () => {
  const ifcQ = { area_m2: 100, concrete_m3: 50, rebarFromConcrete: true, t: { concrete: 120 } };
  const row = costScenario(ifcQ, p, "crush").rows.find((r) => r.item === "고철");
  assert.ok(Math.abs(row.qty - 50 * 0.1 * p.rec_scrap_crush) < 1e-9);
});

test("출처가 확인된 탑재 현장의 면적식에 소형 장비율을 중복 적용하지 않는다", () => {
  const cases = load("plan-validation.json").cases;
  for (const [id, expectedTotal, expectedStructure] of [
    ["nonhyeon-124-1", 16.8, 11.3], ["noryangjin-67-8", 9.1, 5.0],
  ]) {
    const row = cases.find((row) => row.id === id);
    const s = schedule(row, p, "crush");
    assert.equal(+s.total.toFixed(1), expectedTotal);
    assert.equal(+s.structure.toFixed(1), expectedStructure);
    assert.equal(s.structure, s.areaDays);
    assert.equal(s.selective, 0);
  }
});

test("분별 공기: 작업조와 병행률로 전체 연장을 계산한다", () => {
  const q4 = { ...q, floors: 5 }, c = schedule(q4, p, "crush"), s = schedule(q4, p, "selective");
  const extra = 2400 * (0.09 + 0.025) / p.crew_size;
  assert.ok(Math.abs(s.total - c.total - extra) < 1e-9 && extra === 46);
  assert.ok(Math.abs(compare(q4, p).crush.days - c.total) < 1e-9);
  assert.equal(compare({ ...q4, overlap: 0.5 }, p).deltaDays, 23);
  assert.equal(compare({ ...q4, overlap: 1 }, p).deltaDays, 0);
});

test("분리 목재·수지는 순단가 하나: +면 매각수익, −면 처리비 (둘이 함께 들어가지 않는다)", () => {
  const qq = { ...q, floors: 5 };
  for (const [net, group] of [[-230000, "처리비"], [150000, "매각수익"]]) {
    const s = costScenario(qq, { ...p, net_resin: net }, "selective");
    const rows = s.rows.filter((r) => r.item.endsWith("폐합성수지"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].group, group);
    assert.ok(Math.abs(Math.abs(rows[0].amount) - Math.abs(net) * qq.t.resin * p.rec_sel_resin) < 1);
  }
  assert.ok(!costScenario(qq, p, "crush").rows.some((r) => r.item.endsWith("폐합성수지")));
});

test("가연물 한도와 성상 기준을 두 공법에 동일하게 적용한다", () => {
  const t = { glass: 0, board: 0, mixed: 95, wood: 5, resin: 0 };
  const split = { wood: 0, resin: 0, glass: 0, board: 0 };
  const m = (waste, params = p, composition = { mixedMineral: 1 }) => mixedWaste(waste, split, params, composition);
  assert.equal(m(t).share, 0.05);
  assert.equal(m(t).fee, p.fee_mixed_mineral);
  assert.equal(m({ ...t, wood: 0 }).fee, p.fee_concrete);
  assert.equal(m({ ...t, wood: 5.1 }).needsQuote, true);
  assert.equal(m({ ...t, wood: 5.1 }, { ...p, fee_mixed_quote: 130000 }).fee, 130000);
  assert.equal(m(t, p, {}).main, "unknown");
  assert.equal(m({ ...t, glass: 200 }).fee, p.fee_mixed_inert);
  assert.equal(m({ ...t, board: 200 }).fee, p.fee_board_mixed);
  assert.equal(m({ ...t, mixed: 0, wood: 20, board: 100 }).needsQuote, true);
});

test("분별 후 혼합잔재·별도 처리·매각·미매각 물량이 원래 물량과 같다", () => {
  const t = { concrete: 50, metal: 10, copper: 2, aluminum: 3, glass: 20, tile: 12, board: 5, mixed: 30, wood: 2, resin: 4 };
  const out = compare({ ...q, t, mixedMineral: 1 }, { ...p, rec_sel_glass: 0.6, rec_sel_board: 1, fee_glass_separate: 70000, fee_board_separate: 0 });
  for (const s of [out.crush, out.selective]) {
    const tally = s.mixed.tons + t.concrete + s.unsoldMetal + Object.values(s.sold).reduce((a, b) => a + b, 0)
      + Object.values(s.split).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(tally - Object.values(t).reduce((a, b) => a + b, 0)) < 1e-9);
  }
  assert.equal(out.selective.rows.find((row) => row.item === "분리 폐유리").qty, 12);
});

test("비주거 RC 면적 모드: 1,000㎡의 폐금속 추정량은 73t", () => {
  assert.equal(quantitiesFromArea(1000, "비주거 RC", rates).t.metal, 73);
});

test("대지 협소·진입 제한: 소형 장비로 장비 시간이 늘고 크레인이 붙으며 구조체 공기가 길어진다", () => {
  const base = { ...q, floors: 5 };
  for (const site of ["tight", "restricted"]) {
    const n = costScenario({ ...base, site: "normal" }, p, "crush"), t = costScenario({ ...base, site }, p, "crush");
    const excavatorRow = (s) => s.rows.find((r) => r.group === "장비비" && r.unit === "h");
    const h = (s) => excavatorRow(s).qty;
    assert.equal(excavatorRow(n).price, p.excavator_per_h);
    assert.equal(excavatorRow(t).price, p.excavator_per_h);
    assert.equal(t.excavatorHours, h(t));
    assert.ok(Math.abs(h(t) / h(n) - p.crush_m3_per_day / p.crush_m3_per_day_small) < 1e-9);
    const crane = t.rows.find((r) => r.item.startsWith("이동식 크레인"));
    assert.ok(crane && Math.abs(crane.qty - t.schedule.structure) < 1e-9);
    assert.ok(!n.rows.some((r) => r.item.startsWith("이동식 크레인")));
    assert.ok(t.schedule.structure > n.schedule.structure && t.equipment > n.equipment);
  }
  // 두 안에 똑같이 들어가므로 대지 조건만으로는 Δ가 거의 변하지 않는다 (간접비·상시 인원 일수만 같이 늘어난다)
  assert.equal(compare({ ...base, site: "tight" }, p).deltaDays, compare({ ...base, site: "normal" }, p).deltaDays);
});

test("분별 작업량의 단위와 일반해체 공수 차감을 확인한다", () => {
  const qq = { ...q, floors: 5, labor: "quantity", finishAreas: { board: 30, tile: 10, pvc: 10, aluminum: 10 }, generalFinishPd: 1.5 };
  const result = selExtra(qq, p);
  const expected = 2 + 10 * (p.window_pvc_pd_per_m2 + p.window_al_pd_per_m2) - 1.5;
  assert.ok(Math.abs(result.persons - expected) < 1e-9);
  const s = costScenario(qq, p, "selective");
  assert.ok(Math.abs(s.schedule.selective - expected / p.crew_size) < 1e-9);
  assert.equal(s.rows.find((row) => row.item.startsWith("분별 추가")).unit, "인·일");
  assert.equal(selExtra({ ...qq, generalFinishPd: 3 }, p).persons, 0);
  assert.ok(selExtra({ ...qq, generalFinishPd: undefined }, p).issues.some((issue) => issue.includes("잠정")));
});

test("대형 병렬 장비의 공기와 소형 지상 장비의 크레인 독립 지정", () => {
  const wide = { ...q, area_m2: 4500, floors: 4, site: "wide" };
  const parallel = compare({ ...wide, parallelGain: 0.8 }, p).crush;
  const serial = compare(wide, p).crush;
  assert.ok(parallel.schedule.structure < serial.schedule.structure);
  assert.equal(parallel.excavatorHours, serial.excavatorHours);
  const ground = compare({ ...wide, equipment: "small" }, p).crush;
  assert.equal(ground.crews.excavators, 1);
  assert.ok(!ground.rows.some((row) => row.item.includes("크레인")));
  const mounted = compare({ ...wide, equipment: "mounted", craneDays: 1 }, p).crush;
  assert.equal(mounted.rows.find((row) => row.item.includes("크레인")).qty, 1);
});

test("콘크리트 견적은 해당 물량만 대체하고 별도 매각분은 공법별로 한 번 차감한다", () => {
  const qg = { ...q, concreteCase: "good" };
  const base = compare(qg, p);
  const result = compare({ ...qg, cleanSel: 25, cleanPrice: 30000,
    cableCrush: 1, cableSel: 2, cablePrice: 100000 }, p);
  assert.equal(result.selective.revenue - base.selective.revenue, 200000);
  assert.equal(result.crush.revenue - base.crush.revenue, 100000);
  assert.ok(Math.abs(base.selective.disposal - result.selective.disposal
    - q.t.concrete * 0.25 * (35290.8 - 30000)) < 0.01);
  assert.equal(compare({ ...qg, cleanSel: 25 }, p).delta, base.delta);
});

test("목공 비율을 바꾸면 총공수는 같고 직종별 차액만 인건비에 반영된다", () => {
  const input = { ...q, labor: "quantity", generalFinishPd: 1 };
  const initial = costScenario(input, p, "selective");
  const split = costScenario({ ...input, carpenterShare: 50 }, p, "selective");
  const persons = selExtra(input, p).persons;
  assert.equal(initial.days, split.days);
  assert.ok(Math.abs(split.labor - initial.labor - persons / 2 * (p.wage_carpenter - p.wage_laborer)) < 0.01);
});

test("조적에는 별도 처리 단가를 적용하고 콘크리트에만 성상 가정을 적용한다", () => {
  const input = { ...q, t: { concrete: 100, masonry: 20 } };
  const same = compare({ ...input, concreteCase: "same" }, p);
  const good = compare({ ...input, concreteCase: "good" }, p);
  assert.equal(same.crush.disposal, same.selective.disposal);
  assert.equal(good.crush.disposal, same.crush.disposal);
  assert.equal(good.selective.rows.find(row => row.item.startsWith("폐벽돌")).amount, 20 * p.fee_concrete);
  assert.equal(good.selective.rows.find(row => row.item === "순수 폐콘크리트").qty, 80);
});

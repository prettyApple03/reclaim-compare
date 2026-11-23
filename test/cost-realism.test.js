import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compare, concreteGrades, costScenario, equipmentNormStatus, paramValues, rebarTons, schedule } from "../assets/js/scenario.js";
import { simulate, variables, breakEven } from "../assets/js/sensitivity.js";

const rates = JSON.parse(readFileSync(new URL("../assets/data/rates.json", import.meta.url)));
const p = paramValues(rates);
const base = { area_m2: 100, floors: 1, height: 6, structure: "rc", scope: "above", equipment: "large", site: "normal",
  labor: "quantity", finishAreas: { board: 0, tile: 0, pvc: 0, aluminum: 0 }, windowArea: 0,
  windowMode: "both", finishBaseline: { board: 0.6, tile: 1 }, concrete_m3: 100, t: { concrete: 240 },
  equipmentPackageConfirmed: true, equipmentCrewConfirmed: true, concreteIntakeConfirmed: true, transportCrush: 0, transportSel: 0 };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

test("한 반출 경로의 운반 총견적은 해당 공법과 경로에서만 추정액을 대체한다", () => {
  const inputs = { ...base, transportCrush: undefined, transportSel: undefined };
  const before = compare(inputs, p);
  const route = before.crush.transportResult.rows.find(row => row.kind === "mineral");
  const quoted = compare({ ...inputs, routeQuotes: { crush: { [route.key]: 0 } } }, p);
  near(quoted.crush.transport, before.crush.transport - route.amount);
  near(quoted.selective.transport, before.selective.transport);
  const override = compare({ ...inputs, routeQuotes: { crush: { [route.key]: 0 } }, transportCrush: 250000 }, p);
  near(override.crush.transport, 250000);
});

test("건축 기본은 양 공법 같은 건설폐재류 단가이며 순수 토목단가 이득이 없다", () => {
  for (const mode of [false, true]) assert.deepEqual(concreteGrades(p, mode).map(row => row.share), [0, 1, 0]);
  const c = compare(base, p);
  near(c.crush.disposal, 240 * p.fee_concrete);
  near(c.delta, 0);
  assert.equal(c.completeness.complete, true);
  assert.equal(c.recommended, "tie");
  const explicit = compare({ ...base, concreteCase: "good" }, p);
  assert.equal(explicit.recommended, null);
  assert.ok(explicit.completeness.missing.some(row => row.code === "concrete-grades"));
});

test("확인한 별도 반입견적만 해당 콘크리트 물량의 단가를 대체한다", () => {
  const c = compare({ ...base, cleanCrush: 0, cleanSel: 25, cleanPrice: 30000 }, p);
  near(c.selective.disposal, 240 * (0.75 * p.fee_concrete + 0.25 * 30000));
  near(c.crush.disposal, 240 * p.fee_concrete);
});

test("압쇄 표준편성의 보조장비와 작업조 누락을 알리고 견적을 실제 비용에 반영한다", () => {
  const q = { ...base, equipmentPackageConfirmed: false, equipmentCrewConfirmed: false };
  const r = costScenario(q, p, "crush");
  assert.ok(r.unpricedCosts.some(row => row.code === "support-equipment"));
  assert.ok(r.unpricedCosts.some(row => row.code === "equipment-crew"));
  const priced = costScenario(q, { ...p, support_excavator_per_h: 100000 }, "crush");
  near(priced.equipment - r.equipment, r.excavatorHours * 100000);
  assert.equal(priced.unpricedCosts.some(row => row.code === "support-equipment"), false);
  assert.ok(equipmentNormStatus({ ...base, height: 20 }, p).missing.some(row => row.code === "equipment-height"));
  assert.ok(equipmentNormStatus({ ...base, basementOnly: true }, p).missing.some(row => row.code === "basement-method"));
  assert.equal(equipmentNormStatus({ ...base, height: 20, methodConfirmed: true }, p).complete, true);
  near(schedule({ ...base, floors: 1 }, p, "crush").areaDays - schedule({ ...base, floors: 0 }, p, "crush").areaDays, p.sched_struct_per_floor);
});

test("비RC 콘크리트에는 추정 철근을 만들지 않는다", () => {
  assert.equal(rebarTons({ concrete_m3: 100, rebarConcrete_m3: 0 }, 100), 0);
  assert.equal(rebarTons({ concrete_m3: 100, rebarConcrete_m3: 20 }, 100), 2);
  assert.equal(rebarTons({ concrete_m3: 100 }, 100), 10); // Legacy explicit quantity API remains supported.
});

test("선택한 설비 추정 매출은 한 번 반영하고 견적이 없으면 회수비를 확인 대상으로 남긴다", () => {
  const q = { ...base, area_m2: 1000, officeRecovery: true, fixedComparison: true };
  const c = compare(q, p);
  for (const result of [c.selective, c.crush]) {
    near(result.revenue, result.potentialRevenue.total);
    near(result.revenue, -result.rows.filter(row => row.group === "매각수익").reduce((sum, row) => sum + row.amount, 0));
    assert.equal(result.potentialRevenue.included, true);
    assert.equal(result.potentialRevenue.recoveryCostKnown, false);
    near(result.potentialRevenue.unbooked, 0);
  }
  near(c.selective.potentialRevenue.total - c.crush.potentialRevenue.total, 781200);
  assert.equal(c.recommended, null);
  assert.ok(c.completeness.missing.some(row => row.code === "recovery-work"));
  const priced = compare({ ...q, recoveryCostCommon: 1500000, recoveryDaysCommon: 2 }, p);
  near(priced.selective.equipment - c.selective.equipment, 1500000);
  near(priced.selective.revenue, c.selective.potentialRevenue.total);
  near(priced.selective.days - c.selective.days, 2);
  const free = compare({ ...q, recoveryCostCommon: 0 }, p);
  assert.equal(free.selective.potentialRevenue.recoveryCostKnown, true);
  assert.ok(!free.completeness.missing.some(row => row.code === "recovery-work"));
});

test("현장 설치량 추정에서 한 공법의 별도 계근값·0원이 다른 공법 수익을 지우지 않는다", () => {
  const q = { ...base, fixedComparison: true, pipeInstalled: 0.5, cableInstalled: 1, cableCrush: 0, cablePrice: 100000 };
  const c = compare(q, p);
  near(c.crush.potentialRevenue.pipeKg, 347.5);
  near(c.crush.potentialRevenue.cableKg, 0);
  near(c.selective.potentialRevenue.cableKg, 875);
  near(c.selective.revenue - c.crush.revenue, 87500);
  const confirmed = compare({ ...q, copperPipeSold: 0, cableSel: 0.25 }, p);
  near(confirmed.selective.revenue, 25000);
  near(confirmed.selective.potentialRevenue.total, 0);
});

test("자동 창호 모드도 현장 확인 공법별 회수율을 존중한다", () => {
  const q = { ...base, t: { aluminum: 1, resin: 1 }, alFrameTons: 1, pvcFrameTons: 1, pvcPrice: 0,
    alCrush: 40, alSel: 80, pvcCrush: 50, pvcSel: 100 };
  const c = compare(q, p);
  near(c.crush.sold.aluminum, 0.4);
  near(c.selective.sold.aluminum, 0.8);
  near(c.crush.split.resin, 0.5);
  near(c.selective.split.resin, 1);
});

test("운반비는 기본 공식표로 추정하고 한쪽 견적만 있어도 독립 적용한다", () => {
  const q = { ...base, transportCrush: undefined, transportSel: undefined };
  const c = compare(q, p);
  assert.ok(c.crush.transport > 0);
  assert.equal(c.crush.transportResult.benchmark, true);
  const partial = compare({ ...q, transportCrush: 123456 }, p);
  near(partial.crush.transport, 123456);
  near(partial.selective.transport, c.selective.transport);
});

test("미확인 성상·재료·필수견적은 포함항목 금액을 유지하며 확정 추천을 막는다", () => {
  const c = compare({ ...base, t: { concrete: 240, mixed: 10 }, unresolvedMaterialVolume_m3: 3 }, p);
  assert.ok(Number.isFinite(c.delta));
  assert.equal(c.recommended, null);
  assert.ok(c.completeness.missing.some(row => row.code === "quantity-material"));
  assert.ok(c.completeness.missing.some(row => row.code === "mixed-disposal-quote"));
});

test("현장 혼합견적과 분리 목재·수지 순견적은0원도 명시적 확인값으로 적용한다", () => {
  const q = { ...base, t: { concrete: 240, mixed: 2, wood: 4, resin: 3 }, mixedFeeCrush: 100000, mixedFeeSel: 0,
    woodNetPrice: 0, resinNetPrice: -200000 };
  const c = compare(q, p);
  assert.equal(c.crush.mixed.fee, 100000);
  assert.equal(c.selective.mixed.fee, 0);
  assert.equal(c.selective.rows.find(row => row.item === "분리 폐합성수지").price, 200000);
  assert.equal(c.selective.rows.find(row => row.item === "폐목재").amount, -0);
  assert.equal(c.completeness.missing.some(row => /mixed-disposal-quote|separated-wood-price|separated-resin-price/.test(row.code)), false);
});

test("시행비율에는 조건부·독립분포·누락범위 설명이 붙는다", () => {
  const result = simulate(base, p, variables(rates), { n: 20, seed: 1 });
  assert.equal(result.interpretation, "conditional-included-costs");
  assert.equal(result.distribution, "independent-triangular");
  assert.equal(result.completeBasis, true);
  assert.ok(result.limitations.length >= 3);
  assert.throws(() => simulate(base, p, [], { n: 0 }), /시행 횟수/);
});

test("고층 소형지상도 공법확인이 필요하고 지하없는 전체모델은 지하로 오인하지 않는다", () => {
  const tall = { ...base, equipment: "small", height: 20 };
  assert.ok(equipmentNormStatus(tall, p).missing.some(row => row.code === "equipment-height"));
  assert.equal(equipmentNormStatus({ ...tall, methodConfirmed: true }, p).complete, true);
  const full = { ...base, scope: "full", basementIncluded: false };
  assert.equal(equipmentNormStatus(full, p).missing.some(row => row.code.startsWith("basement")), false);
  assert.ok(equipmentNormStatus({ ...full, basementIncluded: true }, p).missing.some(row => row.code === "basement-method"));
  assert.equal(equipmentNormStatus({ ...full, basementIncluded: true, methodConfirmed: true }, p).complete, true);
});

test("공표 운반 추정의 소량·대리단가와 건축 반입조건은 확인 또는 견적으로 해소한다", () => {
  const q = { ...base, concreteIntakeConfirmed: false, transportCrush: undefined, transportSel: undefined };
  const pending = compare(q, p);
  assert.ok(pending.completeness.missing.some(row => row.code === "building-intake-condition"));
  assert.ok(pending.completeness.missing.some(row => row.code === "transport-estimate-conditions"));
  const checked = compare({ ...q, concreteIntakeConfirmed: true, transportConditionsConfirmed: true }, p);
  assert.equal(checked.completeness.complete, true);
  const quoted = compare({ ...q, cleanCrush: 100, cleanSel: 100, cleanPrice: 49000, transportCrush: 1000000, transportSel: 1000000 }, p);
  assert.equal(quoted.completeness.complete, true);
  const small = compare({ ...base, t: { concrete: 1 }, transportCrush: undefined, transportSel: undefined }, p);
  assert.match(small.completeness.missing.find(row => row.code === "transport-estimate-conditions").reason, /소량 최소배차비/);
  const proxy = compare({ ...base, t: { resin: 1 }, resinNetPrice: -100000, mixedFeeCrush: 200000, mixedFeeSel: 200000, transportCrush: undefined, transportSel: undefined }, p);
  assert.match(proxy.completeness.missing.find(row => row.code === "transport-estimate-conditions").reason, /대리차량/);
});

test("비용이 전구간 같거나 부호가 바뀌지 않으면 손익분기를 만들지 않는다", () => {
  near(compare(base, p).delta, 0);
  assert.equal(breakEven(base, p, "net_resin", -1000000, 5000000), null);
  assert.equal(breakEven(base, p, "hours_per_day", 1, 24), null);
  assert.equal(breakEven(base, p, "net_resin", 1, 1), null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compare, paramValues } from "../assets/js/scenario.js";
import { salvageLedger } from "../assets/js/salvage.js";
import { classify, elementResults, quantitiesFromElements, reconcileElementResults } from "../assets/js/classify.js";

const rates = JSON.parse(readFileSync(new URL("../assets/data/rates.json", import.meta.url), "utf8"));
const p = paramValues(rates);
const q = { area_m2: 100, floors: 1, site: "normal", rebarFromConcrete: true, concrete_m3: 20, rebarConcrete_m3: 10,
  unverifiedRebarConcrete_m3: 10, rebarModeledTons: 0.2, structuralSteelTons: 2, fixedComparison: true,
  t: { concrete: 48, metal: 3.2, aluminum: 0.4, wood: 0.5 }, copperPipeSold: 0.01, cableCommon: 0.02 };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ≠ ${expected}`);

test("두 공법의 품목별 매각액이 순비용에서 차감한 총액과 일치한다", () => {
  const c = compare(q,p);
  for (const mode of ["crush", "selective"]) {
    const ledger = salvageLedger(q,p,c[mode]);
    near(ledger.items.reduce((sum, row) => sum + row.amount, 0), c[mode].revenue);
    for (const row of ledger.items) near(row.quantity * row.unitPrice, row.amount);
    near(ledger.total_won, c[mode].revenue);
    assert.ok(ledger.items.find(i => i.item === "철근").amount > 0);
    assert.ok(ledger.items.find(i => i.item === "구조용 철골").amount > 0);
    assert.ok(ledger.items.find(i => i.item === "확인된 동관").amount > 0);
  }
});

test("배근 미확인 조건부 매각액은 모델링한 철근과 중복되지 않고 확인 시 한 번만 이동한다", () => {
  const sparse = { ...q, rebarModeledTons: 1.5 };
  const verified = { ...sparse, rebarConcrete_m3: 20, rebarConcreteConfirmed: true };
  const before = salvageLedger(sparse, p, compare(sparse,p).selective);
  const after = salvageLedger(verified, p, compare(verified,p).selective);
  near(before.pending_rebar.installed_t, 0.5);
  near(after.total_won - before.total_won, before.pending_rebar.gross_won);
  assert.equal(after.pending_rebar, null);
});

test("논현동 지상 골조의 매각액이 공법별 회수량·부재별 산출과 일치한다", () => {
  // Aggregate takeoff from the 557-element above-ground IFC, without embedding the project file.
  const volume = 362.16646858243564, wood = 0.465725;
  const input = { area_m2: 965.04, floors: 4, concrete_m3: volume, rebarConcrete_m3: volume,
    rebarKgPerM3: 100, rebarFromConcrete: true, fixedComparison: true, woodNetPrice: 1000,
    t: { concrete: volume * 2.4, wood } };
  const elements = [
    { category: "slab", stream: "concrete", tons: input.t.concrete, parts: [{ cls: "concrete", stream: "concrete", tons: input.t.concrete, m3: volume, reinforced: true }] },
    { category: "covering", stream: "wood", tons: wood, parts: [{ stream: "wood", tons: wood }] },
  ];
  const local = { ...p, rec_scrap_crush: 0.92, rec_scrap_sel: 0.95, price_scrap: 360000, rec_sel: 0.8 };
  const comparison = compare(input, local);
  for (const [mode, expectedRebarTons, expectedGross] of [["crush", 33.31931510958408, 11994953], ["selective", 34.405814515331386, 12386466]]) {
    const result = comparison[mode];
    const ledger = salvageLedger(input, local, result);
    near(ledger.items.find(row => row.item === "철근").quantity, expectedRebarTons);
    assert.equal(Math.round(ledger.total_won), expectedGross);
    near(elementResults(elements, local, result.mixed.fee, input, mode, result).reduce((total, row) => total + row.revenue, 0), result.revenue);
    near(result.embeddedRebar + expectedRebarTons, volume * 0.1);
  }
  const zero = { ...local, rec_scrap_sel: 0 };
  assert.equal(compare(input, zero).selective.sold.metal, 0);
});

test("현장 중간처리 총견적을 개별 부재에 배정하지 않는다", () => {
  const wood = { category: "covering", stream: "wood", tons: 1, parts: [{ stream: "wood", tons: 1 }] };
  const input = { woodNetPrice: 1000, t: { wood: 1 } };
  for (const quote of [0, 50000]) {
    const result = { disposal: quote, disposalComponents: { quote }, revenue: p.rec_sel * 1000 };
    const [row] = elementResults([wood], p, p.fee_mixed_unverified, input, "selective", result);
    assert.equal(row.disposal, 0);
    assert.ok(row.revenue > 0);
    const frameCorrection = { category: "adjustment", method: "창틀 수동 보정", tons: 0.1, disposal: 500, revenue: 0 };
    const exported = reconcileElementResults([row, frameCorrection], 1.1, result);
    assert.deepEqual(exported.map(r => r.disposal), [0, 0, quote]);
    assert.equal(exported[2].method, "현장 중간처리 총견적");
    assert.equal(exported[0].revenue, result.revenue);
  }
});

test("재질이 없는 창틀을 추정 반출하되 인수 확인 전 매각하지 않는다", () => {
  const opening = { category: "window", area: 3, volume: 0.1 };
  const unknown = classify({ ...opening, name: "Facade glazing", layers: [{ name: "섀시" }] }, rates);
  const actual = classify({ ...opening, name: "일반 창틀", layers: [{ name: "Aluminum" }] }, rates);
  const pvc = classify({ ...opening, name: "PVC 시스템 창호_소방관진입창", layers: [{ name: "섀시" }, { name: "유리" }] }, rates);
  assert.equal(unknown.parts[1].assumedFrame, true);
  assert.equal(actual.parts[1].assumedFrame, false);
  assert.equal(pvc.parts[1].assumedFrame, false);
  assert.equal(pvc.parts[1].stream, "resin");
  const input = { ...quantitiesFromElements([unknown, actual, pvc], 100), windowMode: "both", floors: 1,
    alFrameTons: 0.06, alFrameUnverifiedTons: 0.03, pvcFrameTons: 0.03, windowGlassTons: 0.27, alSel: 50 };
  const result = compare(input, p);
  near(result.crush.sold.aluminum, 0.03);
  near(result.selective.sold.aluminum, 0.03);
  assert.deepEqual(salvageLedger(input, p, result.crush).pending_sales.map(item => item.item), ["PVC 창틀", "재질 미확인 창틀"]);
  assert.equal(salvageLedger(input, p, result.selective).pending_sales.length, 1);
  assert.equal(salvageLedger({ ...input, pvcPrice: 0 }, p, result.selective).pending_sales.length, 0);
  for (const mode of ["crush", "selective"]) {
    const rows = elementResults([unknown, actual, pvc], p, undefined, input, mode, result[mode]);
    near(rows.reduce((sum,row) => sum + row.revenue, 0), result[mode].revenue);
    assert.equal(rows[0].revenue, mode === "crush" ? 0 : 0.015 * p.price_aluminum);
  }
});

test("비내력 복합 슬래브의 콘크리트와 기초의 철근 후보를 구분한다", () => {
  const concrete = { name: "콘크리트", thickness: 0.052 };
  const slab = classify({ name: "Level 1 floor", volume: 27.27, category: "slab", loadBearing: false,
    layers: [{ name: "타일", thickness: 0.008 }, concrete, { name: "단열재", thickness: 0.34 }] }, rates);
  const wall = classify({ name: "Foundation - 300m Concrete", volume: 4.5883, category: "wall", loadBearing: true,
    layers: [{ name: "콘크리트, 현장치기", thickness: 0.3 }] }, rates);
  const tagged = classify({ name: "계단", volume: 1, category: "stair", loadBearing: false,
    layers: [{ name: "철근콘크리트", thickness: 0.15 }] }, rates);
  const input = quantitiesFromElements([slab, wall, tagged], 218.11);
  near(input.rebarConcrete_m3, 1);
  near(input.unverifiedRebarConcrete_m3, 4.5883);
});

// IFC 물량·비용 정확도 보정 (2026-11-20): 성상 오분류, 철근 이중 계상, 집합 부재 이중 계상, 조적 압쇄 부피,
// 분별 공수와 일반해체 공수의 중복, 콘크리트 성상 배분의 기본값
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classify, materialClass, quantitiesFromElements, elementResults, checkAgainstUnits } from "../assets/js/classify.js";
import { dropAggregateParents } from "../assets/js/ifc.js";
import { compare, costScenario, paramValues, quantitiesFromArea, selExtra, generalInteriorPd, streamTons, concreteGrades } from "../assets/js/scenario.js";

const rates = JSON.parse(readFileSync(new URL("../assets/data/rates.json", import.meta.url)));
const p = paramValues(rates);
const el = (category, layers, volume = 1, area = 10, extra = {}) => ({ expressID: 1, globalId: "G", tag: "1", category, floor: 1, volume, area, layers, ...extra });
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test("유리섬유·광물섬유 단열재는 폐유리(2.5t/㎥)가 아니라 단열재로 분류한다", () => {
  for (const name of ["Glass Wool", "Fiberglass Batt", "그라스울 50K", "유리섬유 보온재", "유리면", "Mineral Wool", "암면"]) {
    assert.equal(materialClass(name), "insulation", name);
  }
  assert.equal(materialClass("Glass"), "glass");
  assert.equal(materialClass("복층유리"), "glass");
  const wall = classify(el("wall", [{ name: "Concrete", thickness: 0.2 }, { name: "Glass Wool", thickness: 0.1 }], 3), rates);
  near(wall.parts[1].tons, 1 * rates.density.insulation); // 1㎥ × 0.03, 2.5t 아님
});

test("재료 없는 커튼월 유리 패널은 이름으로 폐유리, 재료 없는 강재 보는 수량표 중량으로 강재", () => {
  const panel = classify(el("plate", [], 0.02, 1.5, { name: "System Panel: Glazed" }), rates);
  assert.equal(panel.stream, "glass");
  near(panel.tons, 0.02 * rates.density.glass);
  assert.equal(panel.guessed, true);

  const beam = classify(el("beam", [], 0.05, 0, { weightTons: 0.3925 }), rates); // 0.3925 / 0.05 = 7.85 t/㎥
  assert.equal(beam.stream, "metal");
  near(beam.tons, 0.3925);
  // 중량이 콘크리트 밀도면 기존처럼 부재 종류 기본값(콘크리트)
  assert.equal(classify(el("beam", [], 0.05, 0, { weightTons: 0.12 }), rates).stream, "concrete");
});

test("철근콘크리트 2.4t/㎥ 안의 철근은 폐콘크리트에서 빼고 고철로 센다 (총중량 보존)", () => {
  const q = { area_m2: 100, concrete_m3: 50, rebarFromConcrete: true, t: { concrete: 120, metal: 3 } };
  const { t, rebar } = streamTons(q, p);
  near(rebar, 50 * p.rebar_kg_per_m3 / 1000);
  near(t.concrete, 120 - rebar);
  near(t.metal, 3 + rebar);
  near(t.concrete + t.metal, 123);
  for (const mode of ["crush", "selective"]) {
    const s = costScenario(q, p, mode);
    const concreteRows = s.rows.filter((r) => r.group === "처리비" && concreteGrades(p, mode === "selective").some((g) => g.name === r.item));
    near(concreteRows.reduce((a, r) => a + r.qty, 0), 120 - rebar);
  }
  // 원단위(면적) 물량은 철근을 따로 더하지 않으므로 그대로
  const area = quantitiesFromArea(1000, "공동주택", rates);
  assert.equal(streamTons(area, p).t.concrete, area.t.concrete);
  // 검산표도 같은 기준
  const check = checkAgainstUnits({ ...q, area_m2: 100 }, "공동주택", rates);
  near(check.find((c) => c.stream === "concrete").model, (120 - rebar) / 100);
});

test("부재별 결과(CSV)의 처리비·수익 합계가 엔진의 철근 분리와 같은 기준", () => {
  const classified = [classify(el("slab", [{ name: "Concrete", thickness: 0 }], 10), rates)];
  const res = elementResults(classified, p, p.fee_mixed_unverified, { concreteCase: "same" })[0];
  const rebar = 10 * p.rebar_kg_per_m3 / 1000;
  const fee = concreteGrades(p, true, "same").reduce((s, g) => s + g.share * g.fee, 0);
  near(res.disposal, (24 - rebar) * fee, 1e-6);
  near(res.revenue, rebar * p.rec_scrap_sel * p.price_scrap, 1e-6);
});

test("조적벽 부피도 압쇄 장비 시간·구조체 공기에 들어간다 (철근 추정에는 안 들어간다)", () => {
  const classified = [
    classify(el("wall", [{ name: "Concrete", thickness: 0 }], 10), rates),
    classify(el("wall", [{ name: "Brick", thickness: 0 }], 4), rates),
  ];
  const q = { ...quantitiesFromElements(classified, 100), floors: 1 };
  near(q.concrete_m3, 10);
  near(q.masonry_m3, 4);
  const withMasonry = costScenario(q, p, "crush");
  const without = costScenario({ ...q, masonry_m3: 0 }, p, "crush");
  near(withMasonry.excavatorHours, 14 / p.crush_m3_per_day * p.hours_per_day);
  assert.ok(withMasonry.excavatorHours > without.excavatorHours);
  near(streamTons(q, p).rebar, 10 * p.rebar_kg_per_m3 / 1000);
});

test("집합 부재: 하위 부재에 형상이 있으면 부모(커튼월·계단·지붕)를 빼서 이중 계상을 막는다", () => {
  const acc = new Map([[1, "curtain wall"], [2, "panel"], [3, "mullion"], [10, "stair"], [20, "roof"]]);
  const parts = new Map([[1, [2, 3]], [10, [11, 12]], [20, [21]], [21, [22]]]);
  dropAggregateParents(acc, parts);
  assert.deepEqual([...acc.keys()], [2, 3, 10, 20]); // 계단·지붕은 하위 형상이 없어 부모를 남긴다
  const partial = new Map([[20, "roof"], [22, "roof slab"]]);
  assert.deepEqual([...dropAggregateParents(partial, new Map([[20, [22, 23]]])).keys()], [20, 22]);
  const deep = new Map([[20, "roof"], [22, "roof slab"]]);
  assert.deepEqual([...dropAggregateParents(deep, parts).keys()], [22]); // 손자에 형상이 있어도 뺀다
});

test("작업량 방식: 일반해체 공수 미입력이면 두 안 공통 내부 철거 공수를 빼서 중복을 막는다", () => {
  const q = { ...quantitiesFromArea(2400, "공동주택", rates), floors: 5, labor: "quantity" };
  const interior = generalInteriorPd(q, p);
  near(interior, p.crew_interior * Math.max(p.sched_interior_min, p.sched_interior_per_1000m2 * 2.4));
  const auto = selExtra(q, p), none = selExtra({ ...q, generalFinishPd: 0 }, p), given = selExtra({ ...q, generalFinishPd: 5 }, p);
  near(auto.persons, auto.gross - interior);
  near(none.persons, none.gross);
  near(given.persons, given.gross - 5);
  assert.ok(auto.issues.some((i) => i.includes("잠정") && i.includes("0을 입력")));
  // 내부 철거 인부 행은 두 안에 그대로 있다 (분별안만 빼는 것이 아니다)
  const item = (s) => s.rows.find((r) => r.item === "내부 철거 인부").qty;
  const cmp = compare(q, p);
  near(item(cmp.crush), item(cmp.selective));
  near(item(cmp.crush), interior);
});

test("콘크리트 성상 배분의 기본값은 두 공법 동일: 근거 없이 분별안에 유리하게 기울지 않는다", () => {
  const q = { ...quantitiesFromArea(2400, "공동주택", rates), floors: 5 };
  const cmp = compare(q, p);
  const concrete = (s) => s.rows.filter((r) => concreteGrades(p, false).some((g) => g.name === r.item)).reduce((a, r) => a + r.amount, 0);
  near(concrete(cmp.crush), concrete(cmp.selective), 1e-6);
  assert.ok(compare({ ...q, concreteCase: "good" }, p).delta < cmp.delta); // 사용자가 고르면 반영된다
});

test("섬유 유리 배팅과 유리·프레임 합성 창호를 별도로 분류한다", () => {
  assert.equal(materialClass("섬유 유리 배팅"), "insulation");
  assert.equal(materialClass("폴리염화비닐, 리지드"), "resin");
  const window = classify(el("plate", [{ name: "창호(알루미늄+유리)", category: "Glazing", thickness: 0 }], 0.8, 9), rates);
  assert.equal(window.guessed, true);
  assert.deepEqual(window.parts.map(part => part.stream), ["glass", "aluminum"]);
  near(window.parts[0].tons, 9 * rates.perArea.window_glass);
  near(window.parts[1].tons, 9 * rates.perArea.window_frame);
  const solidGlass = classify(el("plate", [{ name: "복층유리", thickness: 0 }], 0.02, 1), rates);
  near(solidGlass.tons, 0.02 * rates.density.glass);
});

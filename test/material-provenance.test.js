import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classify, classifyElements, quantitiesFromElements, materialClass, connectFinishTakeoff, groupKey, elementResults } from "../assets/js/classify.js";
import { paramValues, streamTons, costScenario, compare, selExtra, PRESS_FINISH_BASELINE } from "../assets/js/scenario.js";

const rates = JSON.parse(readFileSync(new URL("../assets/data/rates.json", import.meta.url)));
const params = paramValues(rates);
const el = (name, layers, category = "wall", extra = {}) => ({ expressID: 1, globalId: "G", tag: "1", floor: 1, category, name, volume: 1, area: 10, layers, ...extra });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("개인 IFC의 목재·방습막·타일 이름은 콘크리트 기본값으로 바뀌지 않는다", () => {
  for (const name of ["떡갈나무 바닥", "벚나무", "구조, 판재 장선/서까래 층"]) assert.equal(materialClass(name), "wood");
  assert.equal(materialClass("습기 차단"), "resin");
  assert.equal(materialClass("타일, 석재 및 세라믹 혼합"), "tile");
  const wall = classify(el("Wall", [{ name: "벚나무", thickness: 0.01 }, { name: "기본 벽", thickness: 0.09 }]), rates);
  near(wall.parts[0].tons, 0.1 * rates.density.wood);
  near(wall.parts[1].tons, 0);
  assert.equal(wall.parts[1].cls, "unknown");
  assert.equal(wall.parts[1].m3, 0.9);
  assert.equal(wall.parts[1].unresolved, true);
  assert.ok(wall.quantityIssues.some(text => text.includes("기본 벽")));
});

test("목구조 공동층은 솔리드 목재 대신 실재적 비율을 확인한다", () => {
  const layers = [{ name: "섬유 유리 배팅", thickness: 140 }, { name: "목재 - 벚나무", thickness: 140 }];
  const original = el("Wood framed wall", layers, "wall", { lengthScale: 0.001 });
  const unresolved = classify(original, rates);
  assert.equal(unresolved.parts[1].tons, 0);
  assert.equal(unresolved.parts[1].framingEnvelope_m3, 0.5);
  assert.ok(unresolved.parts[1].unresolved);
  const confirmed = classify({ ...original, framingFraction: 0.15 }, rates);
  near(confirmed.parts[1].tons, 0.5 * 0.15 * rates.density.wood);
  assert.equal(confirmed.parts[1].framingFraction, 0.15);
  assert.equal(confirmed.parts[1].unresolved, false);
});

test("가전 proxy는 표면재 이름과 무관하게 건축재 질량에서 제외한다", () => {
  for (const [name, material] of [["냉장고:W912*D952*H1779", "금속 - 크롬"], ["보일러:535 x 910", "Steel"], ["세척기", "흰색 유리"]]) {
    const result = classify(el(name, [{ name: material }], "other"), rates);
    assert.equal(result.stream, "excluded");
    assert.equal(result.tons, 0);
    assert.ok(result.excludedReason.includes("별도 반출"));
  }
  assert.equal(classify(el("구조체 proxy", [{ name: "Reinforced Concrete" }], "other"), rates).stream, "concrete");
});

test("광물단열재는 합성수지 회수대상으로 합치지 않고 미확정 부피를 추적한다", () => {
  const result = classify(el("Insulated wall", [{ name: "Glass Wool" }]), rates);
  const q = quantitiesFromElements([result], 100);
  assert.equal(q.t.resin, 0);
  assert.equal(q.t.mixed, 0);
  assert.equal(q.unresolvedMaterialVolume_m3, 1);
  assert.equal(q.unresolvedParts[0].layer, "Glass Wool");
  assert.ok(q.quantityIssues.length);
  const known = classify(el("Insulated wall", [{ name: "Glass Wool" }]), { ...rates, density: { ...rates.density, mineralInsulation: 0.05 } });
  near(known.tons, 0.05);
  assert.equal(known.stream, "mixed");
});

test("proxy·마감재 압쇄물량은 포함하되 모르타르에서 철근을 매각하지 않는다", () => {
  const classified = [classify(el("기초", [{ name: "Reinforced Concrete" }], "other"), rates), classify(el("Mortar finish", [{ name: "Mortar" }], "covering"), rates)];
  const q = quantitiesFromElements(classified, 100);
  near(q.concrete_m3, 2);
  near(q.rebarConcrete_m3, 1);
  near(streamTons(q, params).rebar, params.rebar_kg_per_m3 / 1000);
});

test("IFC 보충 OFF에서는 없는 보드·타일을 만들지 않고 확인한 타일층 면적만 쓴다", () => {
  const raw = quantitiesFromElements([classify(el("타일벽", [{ name: "타일, 석재 및 세라믹 혼합", thickness: 0.01 }]), rates)], 100);
  const q = { ...raw, t: { ...raw.t }, supplemented: false };
  connectFinishTakeoff(q, raw, rates, params);
  assert.equal(q.t.board, 0);
  assert.equal(q.finishTakeoff.board.unverified, true);
  assert.equal(q.finishTakeoff.board.source, "not-modeled");
  near(q.finishAreas.tile, 100);
  near(q.t.tile, rates.density.tile);
  const supplemented = { ...raw, t: { ...raw.t }, supplemented: true };
  connectFinishTakeoff(supplemented, raw, rates, params);
  assert.ok(supplemented.t.board > 0);
  assert.equal(supplemented.finishTakeoff.board.source, "area-supplement-assumption");
});

test("구조 전용 IFC의 마감재 추정은 공법별 공수를 만들고 물량 출처와 판정 보류를 유지한다", () => {
  const raw = quantitiesFromElements([classify(el("RC벽", [{ name: "철근콘크리트", thickness: 0 }]), rates)], 1000);
  const q = { ...raw, labor: "quantity", finishBaseline: PRESS_FINISH_BASELINE,
    windowMode: "both", windowArea: 0, estimateMissingFinishes: true };
  connectFinishTakeoff(q, raw, rates, params);
  assert.equal(q.finishTakeoff.board.source, "area-finish-assumption");
  near(q.t.board, 1000 * params.int_board_ratio * rates.density.board * rates.finishThickness.board);
  near(selExtra(q, params).persons, (1 - PRESS_FINISH_BASELINE.board) * q.finishAreas.board / params.int_board_m2_per_day);
  const estimate = compare(q, params);
  assert.ok(estimate.selective.total > estimate.crush.total);
  const withoutEstimate = compare({ ...q, t: raw.t }, params);
  assert.equal(estimate.crush.revenue, withoutEstimate.crush.revenue);
  assert.equal(estimate.selective.revenue, withoutEstimate.selective.revenue);
  assert.ok(estimate.completeness.missing.some(issue => issue.code === "finish-assumption"));
  assert.equal(estimate.recommended, null);

  const excluded = { ...q, finishAreas: raw.finishAreas, finishAreaExclusions: { board: 700, floor: 250 } };
  connectFinishTakeoff(excluded, raw, rates, params);
  near(excluded.finishAreas.board, 1000 * params.int_board_ratio - 700);
  near(excluded.finishAreas.tile, 750 * params.int_tile_ratio);

  const measured = { ...q, finishAreas: { board: 120 }, boardWeight: 0, tileWeight: 2 };
  connectFinishTakeoff(measured, raw, rates, params);
  assert.equal(measured.finishAreas.board, 0);
  assert.equal(measured.t.board, 0);
  assert.equal(measured.t.tile, 2);
  assert.ok(!compare(measured, params).completeness.missing.some(issue => issue.code.startsWith("finish-")));

  const modelOnly = { ...q, finishAreas: raw.finishAreas, finishQuantityMode: "ifc", supplemented: true };
  connectFinishTakeoff(modelOnly, raw, rates, params);
  assert.equal(modelOnly.t.board, 0);
  assert.equal(modelOnly.t.tile, 0);
  assert.ok(compare(modelOnly, params).completeness.missing.some(issue => issue.code === "finish-missing"));
});

test("확인한 RC 구조 기본값은 무재료 단일 부재에만 적용하고 복합 미확정 층을 덮지 않는다", () => {
  const wall = el("재료 없음", [], "wall");
  const before = classify(wall, rates);
  const after = classify(wall, rates, {}, "aluminum", { verifiedStructuralConcrete: true });
  assert.equal(before.tons, 0);
  near(after.tons, rates.density.concrete);
  assert.equal(after.parts[0].reinforced, true);
  assert.equal(after.parts[0].massBasis, "verified-rc-structure-assumption");
  const composite = classify(el("복합벽", [{ name: "기본 벽", thickness: 0.1 }, { name: "Gypsum Board", thickness: 0.01 }]), rates, {}, "aluminum", { verifiedStructuralConcrete: true });
  assert.ok(composite.parts[0].unresolved);
  const mortar = classify(el("Topping", [{ name: "Mortar" }], "slab"), rates, {}, "aluminum", { verifiedStructuralConcrete: true });
  assert.equal(mortar.parts[0].reinforced, false);
});

test("동일 그룹 층의 실측 kg은 한번만 배분하고 유효밀도는 원부피 기준으로 적용한다", () => {
  const a = el("같은 벽", [{ name: "기본 벽", thickness: 0.1 }]);
  const b = { ...a, expressID: 2, volume: 3 };
  const key = groupKey(a);
  const options = { layerOverrides: { [key]: { "기본 벽": { massKg: 400, material: "wood" } } } };
  const rows = classifyElements([a, b], rates, {}, "aluminum", options);
  near(rows[0].tons, 0.1);
  near(rows[1].tons, 0.3);
  assert.equal(rows[0].parts[0].geometryVolume_m3, 1);
  near(rows[1].parts[0].geometryVolume_m3, 3);
  assert.equal(quantitiesFromElements(rows, 100).unresolvedMaterialVolume_m3, 0);
  assert.equal(rows[0].quantityIssues.length, 0);
  const densityRows = classifyElements([a, b], rates, {}, "aluminum", { layerOverrides: { [key]: { "기본 벽": { densityKgPerM3: 60, material: "wood" } } } });
  near(densityRows.reduce((sum, row) => sum + row.tons, 0), 4 * 60 / 1000);
});

test("구성비 없는 복합 재료는 첫 재료의 솔리드 밀도로 전체 부피를 계산하지 않는다", () => {
  const member = el("복합 패널", [{ name: "Steel" }, { name: "Glass" }], "plate", { weightTons: 0.12 });
  const result = classify(member, rates);
  assert.equal(result.stream, "mixed");
  near(result.tons, 0.12);
  assert.equal(result.parts[0].massBasis, "ifc-weight");
  assert.ok(result.quantityIssues.some(text => text.includes("성상 미확인")));
  const noWeight = classify({ ...member, weightTons: undefined }, rates);
  near(noWeight.tons, 0);
  assert.equal(noWeight.unresolvedParts[0].reason, "두께·구성비 없는 복합 재료");
});

test("CRC 시멘트보드에 석고보드 밀도를 전용하지 않는다", () => {
  const wall = el("CRC wall", [{ name: "CRC보드", thickness: 0.01 }]);
  const result = classify(wall, rates);
  assert.equal(result.parts[0].cls, "cementBoard");
  assert.equal(result.parts[0].tons, 0);
  assert.ok(result.parts[0].unresolved);
  const q = quantitiesFromElements([result], 100);
  connectFinishTakeoff(q, { ...q }, rates, params);
  assert.equal(q.t.board, 0);
  const known = classifyElements([wall], rates, {}, "aluminum", { layerOverrides: { [groupKey(wall)]: { "CRC보드": { densityKgPerM3: 1400 } } } });
  const confirmed = quantitiesFromElements(known, 100);
  near(confirmed.t.board, 1.4);
  near(confirmed.finishAreas.board, 100);
});

test("현장 순단가·공법별 혼합견적과 창틀 회수율은 부재표와 전체 내역에 똑같이 반영한다", () => {
  const classified = [
    classify(el("Plywood", [{ name: "Plywood" }], "covering"), rates),
    classify(el("PVC finish", [{ name: "PVC" }], "covering"), rates),
    classify(el("Al window", [{ name: "Aluminum" }], "window", { area: 10 }), rates),
  ];
  const q = { ...quantitiesFromElements(classified, 100), floors: 1, labor: "quantity", fixedComparison: true,
    windowMode: "both", windowGlassTons: 10 * rates.perArea.window_glass, alFrameTons: 10 * rates.perArea.window_frame,
    pvcFrameTons: 0, woodNetPrice: -12000, resinNetPrice: 3000, mixedFeeCrush: 100000, mixedFeeSel: 90000,
    alCrush: 20, alSel: 80,
  };
  for (const mode of ["crush", "selective"]) {
    const scenario = costScenario(q, params, mode);
    const rows = elementResults(classified, params, scenario.mixed.fee, q, mode, scenario);
    near(rows.reduce((sum, row) => sum + row.disposal, 0), scenario.disposalComponents.processing);
    near(rows.reduce((sum, row) => sum + row.revenue, 0), scenario.revenue);
  }
});

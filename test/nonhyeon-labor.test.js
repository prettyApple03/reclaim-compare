import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compare, selExtra, paramValues } from "../assets/js/scenario.js";

const p = paramValues(JSON.parse(readFileSync(new URL("../assets/data/rates.json", import.meta.url))));
const missing = { area: 0, tons: 0, unverified: true, source: "not-modeled" };
const q = {
  area_m2: 965.04, floors: 4, scope: "above", site: "tight", equipment: "mounted",
  concrete_m3: 360, t: { concrete: 864 }, labor: "quantity", windowMode: "both",
  windowArea: 187.56816, finishAreas: { board: 0, tile: 0 }, finishBaseline: { board: 0.6, tile: 1 },
  finishTakeoff: { board: missing, tile: missing }, finishQuantityMode: "auto",
  estimateMissingFinishLabor: true,
};
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

test("일반 건축물의 누락 마감재는 분별 추가 공수만 추정하고 압쇄 공정과 반출 물량을 유지한다", () => {
  const original = compare({ ...q, estimateMissingFinishLabor: false }, p);
  const work = selExtra(q, p);
  const result = compare(q, p);
  near(work.gross, 2 * q.windowArea * p.window_frame_pd_per_m2);
  near(work.finishLaborEstimate.board.area, q.area_m2 * p.int_board_ratio);
  near(work.finishLaborEstimate.tile.persons, 0);
  near(work.estimatedFinishPd, q.area_m2 * p.int_board_ratio * (1 - q.finishBaseline.board) / p.int_board_m2_per_day);
  near(work.persons, work.estimatedFinishPd);
  near(result.crush.schedule.total, original.crush.schedule.total);
  near(result.crush.labor, original.crush.labor);
  near(result.selective.schedule.extension, work.persons / p.crew_size);
  near(result.selective.equipment - result.crush.equipment,
    work.persons / p.crew_size * p.selective_equipment_hours_per_day * p.selective_equipment_per_h);
  near(result.selective.disposal, original.selective.disposal);
  near(result.selective.revenue, original.selective.revenue);
});

test("공수 추정은 미조사 품목에만 적용하고 IFC 전용, 현장 공수 및 0 물량을 존중한다", () => {
  for (const input of [
    { ...q, finishQuantityMode: "ifc" },
    { ...q, generalFinishPd: 0 },
  ]) {
    near(selExtra(input, p).estimatedFinishPd, 0);
  }
  const boardZero = { ...q, finishTakeoff: { ...q.finishTakeoff, board: { area: 0, tons: 0, unverified: false } } };
  assert.equal(selExtra(boardZero, p).finishLaborEstimate.board, undefined);
  near(selExtra(boardZero, p).estimatedFinishPd, 0);
  const tileSurvey = { ...q, finishAreas: { ...q.finishAreas, tile: 100 },
    finishTakeoff: { ...q.finishTakeoff, tile: { area: 100, tons: 2, unverified: false } } };
  assert.equal(selExtra(tileSurvey, p).finishLaborEstimate.tile, undefined);
  near(selExtra(tileSurvey, p).estimatedFinishPd, selExtra(q, p).estimatedFinishPd);
  const hazard = { ...q, finishAreaExclusions: { board: 500 }, finishBaseline: { board: 0.6, tile: 0.8 } };
  near(selExtra(hazard, p).finishLaborEstimate.board.area, q.area_m2 * p.int_board_ratio - 500);
  near(selExtra(hazard, p).finishLaborEstimate.tile.persons, q.area_m2 * p.int_tile_ratio * 0.2 / p.int_tile_m2_per_day);
  const aboveScope = { ...q, finishLaborArea: q.area_m2 * 0.75 };
  near(selExtra(aboveScope, p).estimatedFinishPd, selExtra(q, p).estimatedFinishPd * 0.75);
  near(selExtra(aboveScope, p).gross, selExtra(q, p).gross);
  assert.equal(selExtra({ ...q, labor: "paper" }, p).method, "paper");
});

test("현장 추가 공수는 0까지 인건비·공기·장비에 한 번 적용하고 장비 실견적이 가정액을 대체한다", () => {
  const field = { ...q, selectiveExtraPd: 12, carpenterShare: 25, overlap: 0.5, selectiveEquipmentQuote: 150000 };
  const result = compare(field, p);
  const work = selExtra(field, p);
  assert.equal(work.method, "field");
  assert.deepEqual(work.rows.map(row => row.qty), [9, 3]);
  near(result.selective.schedule.selective, 12 / p.crew_size);
  near(result.deltaDays, 12 / p.crew_size / 2);
  near(result.selective.labor - result.crush.labor,
    9 * p.wage_laborer + 3 * p.wage_carpenter + result.deltaDays * p.crew_standing * p.wage_laborer);
  near(result.selective.equipment - result.crush.equipment, 150000);
  near(result.selective.indirect - result.crush.indirect, result.deltaDays * p.indirect_per_day);
  const zero = compare({ ...q, selectiveExtraPd: 0 }, p);
  for (const key of ["labor", "equipment", "indirect"]) near(zero.selective[key], zero.crush[key]);
  near(zero.deltaDays, 0);
});

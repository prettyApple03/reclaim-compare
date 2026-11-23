import test from "node:test";
import assert from "node:assert/strict";
import { concreteCutCandidates, normalizeConcreteCutPlan } from "../assets/js/concrete-cut.js";

const wall = { expressID: 42, globalId: "wall-id", name: "Core wall", category: "wall", floor: 3,
  bounds: { min: [0, 0, 0], max: [4.1, 3.18, 0.2] }, volume: 4.1 * 3.18 * 0.2 };
const concreteWall = { ...wall, parts: [{ stream: "concrete", m3: wall.volume, tons: wall.volume * 2.4 }] };
const line = { id: "line", candidateId: "wall-id", label: "West interface", tool: "wire", method: "both",
  measure: "line", length: 3.18, thickness: 0.2 };

test("IFC 절단 후보는 층명과 참고 단면을 제공하며 강재를 제외한다", () => {
  const cap = { ...concreteWall, expressID: 18, globalId: "cap", name: "Floor slab", category: "slab", floor: 1,
    basementCap: true, volume: 2, parts: [{ stream: "concrete", m3: 2, tons: 4.8 }] };
  const steel = { ...wall, expressID: 20, globalId: "steel", parts: [{ stream: "metal", m3: wall.volume }] };
  const candidates = concreteCutCandidates([concreteWall, steel, cap], {
    basementFloors: 1, storeys: [{ floor: 3, name: "2F" }],
  }, "above");
  assert.deepEqual(candidates.map(({ id, reasonCode }) => [id, reasonCode]), [["cap", "basementBoundary"], ["wall-id", "core"]]);
  assert.deepEqual([candidates[1].storey, candidates[1].thickness, candidates[1].basis], ["2F", 0.2, "bounds"]);
});

test("IFC 재료 층은 metre로 환산하고 회전된 벽의 외접 폭은 두께로 제공하지 않는다", () => {
  const layered = { ...concreteWall, layers: [{ thickness: 200 }] };
  const rotated = { ...concreteWall, bounds: { min: [0, 0, 0], max: [3, 3.18, 3] } };
  assert.equal(concreteCutCandidates([layered], { lengthScale: 0.001 }, "partial")[0].thickness, 0.2);
  assert.equal(concreteCutCandidates([rotated], { lengthScale: 0.001 }, "partial")[0].thickness, null);
});

test("공통 절단면과 개별 면적을 합산하고 중복 및 현재 범위 밖 부재를 제외한다", () => {
  const candidate = { id: "wall-id" };
  const plan = normalizeConcreteCutPlan([
    line, { ...line, id: "duplicate", method: "crush", label: "west  interface" },
    { ...line, id: "additional", method: "selective", label: "East interface", measure: "section", width: 0.5, depth: 0.4, count: 2 },
    { ...line, id: "outside", label: "Outside", candidateId: "not-in-scope" },
    { ...line, id: "manual", candidateId: "", label: "Manual area", method: "crush", measure: "area", area: 1.2 },
    { ...line, id: "invalid", label: "Invalid count", count: 0.5 },
  ], [candidate]);
  assert.deepEqual(plan.rows.map(row => row.id), ["line", "additional", "manual"]);
  assert.ok(Math.abs(plan.areas.crush - 1.836) < 1e-12);
  assert.ok(Math.abs(plan.areas.selective - 1.036) < 1e-12);
  assert.equal(plan.issues.length, 3);
  assert.equal(plan.rows[0].candidate, candidate);
});

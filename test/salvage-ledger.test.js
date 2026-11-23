import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compare, paramValues } from "../assets/js/scenario.js";
import { salvageLedger } from "../assets/js/salvage.js";

const p = paramValues(JSON.parse(readFileSync(new URL("../assets/data/rates.json", import.meta.url), "utf8")));
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

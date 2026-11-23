// 손익분기, 토네이도(민감도), 몬테카를로. Δ = 분별 총비용 − 압쇄 총비용 (음수면 분별이 유리)
import { compare } from "./scenario.js?v=nonhyeon-compare-20261123";

export const delta = (q, p) => compare(q, p).delta;

// 범위(min·max)가 있는 단가만 불확실 변수로 쓴다
export const variables = (rates) =>
  Object.entries(rates.params).filter(([, v]) => v.sample !== false && v.min != null && v.max != null && v.max > v.min)
    .map(([key, v]) => ({ key, label: v.label, unit: v.unit, min: v.min, max: v.max }));

export function tornado(q, p, vars) {
  return vars.map((v) => {
    const lo = delta(q, { ...p, [v.key]: v.min }), hi = delta(q, { ...p, [v.key]: v.max });
    return { ...v, lo, hi, span: Math.abs(hi - lo) };
  }).sort((a, b) => b.span - a.span);
}

// 변수 하나만 바꿔 Δ = 0이 되는 값. [lo, hi] 안에서 부호가 바뀌지 않으면 null
export function breakEven(q, p, key, lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return null;
  const f = (x) => delta(q, { ...p, [key]: x });
  let a = lo, b = hi, fa = f(a);
  const fb = f(b);
  // A flat tie is not a break-even threshold. Require a meaningful strict sign
  // change inside the explored interval, rather than reporting every lower bound.
  if (!Number.isFinite(fa) || !Number.isFinite(fb) || Math.abs(fa) < 1 || Math.abs(fb) < 1 || fa * fb >= 0) return null;
  for (let i = 0; i < 60; i++) {
    const m = (a + b) / 2, fm = f(m);
    if (fa * fm <= 0) b = m; else { a = m; fa = fm; }
  }
  const root = (a + b) / 2;
  return Math.abs(f(root)) < 1 ? root : null; // 구간 분류가 바뀌는 불연속점은 비용이 같은 지점이 아니다.
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 삼각분포 역함수: u∈[0,1), 최소 a, 최빈 c, 최대 b
export function triangular(u, a, c, b) {
  const f = (c - a) / (b - a);
  return u < f ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c));
}

export function simulate(q, p, vars, { n = 5000, seed = 1 } = {}) {
  if (!Number.isInteger(n) || n < 1) throw new Error("시행 횟수는 1 이상의 정수여야 합니다.");
  const basis = compare(q, p);
  const rnd = mulberry32(seed);
  const deltas = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = { ...p };
    for (const v of vars) s[v.key] = triangular(rnd(), v.min, Math.min(v.max, Math.max(v.min, p[v.key])), v.max);
    deltas[i] = delta(q, s);
  }
  const sorted = Float64Array.from(deltas).sort();
  const pct = (x) => sorted[Math.min(n - 1, Math.floor(x * n))];
  let wins = 0, sum = 0;
  for (const d of deltas) { if (d < 0) wins++; sum += d; }
  return { n, seed, pSelective: wins / n, mean: sum / n, p10: pct(0.1), p50: pct(0.5), p90: pct(0.9), min: sorted[0], max: sorted[n - 1], sorted,
    interpretation: "conditional-included-costs", distribution: "independent-triangular", variableCount: vars.length,
    completeBasis: basis.completeness.complete,
    missingBasis: basis.completeness.missing,
    limitations: [
      "설정한 변수 범위 안의 포함 항목 비교이며 실제 현장 경제성의 확률이 아닙니다.",
      "변수는 독립 삼각분포로 샘플링합니다. 가격·생산성·작업조·회수율 사이의 상관은 실증자료가 없어 반영하지 않았습니다.",
      "물량 분류오류, 미확인 재료, 공법 적합성, 누락 견적, 고정 성상 시나리오는 이 시행 비율에 포함되지 않습니다.",
    ],
  };
}

export function histogram(sorted, bins = 30) {
  const lo = sorted[0], hi = sorted[sorted.length - 1], w = (hi - lo) / bins || 1;
  const counts = new Array(bins).fill(0);
  for (const d of sorted) counts[Math.min(bins - 1, Math.floor((d - lo) / w))]++;
  return counts.map((count, i) => ({ x0: lo + i * w, x1: lo + (i + 1) * w, count }));
}

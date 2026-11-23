// 2026 published collection/haul benchmarks. Monetary values are KRW/t, VAT excluded.
// This module prices already-routed masses; it never adds raw IFC quantities a second time.
export const TRANSPORT_SOURCE = Object.freeze({
  title: "2026 건설폐기물 수집·운반비 · 한국건설자원수집운반협회",
  effectiveDate: "2026-01-01",
  url: "https://data.cmpi.or.kr/program/board/%5B2026%EB%85%84%5D%20%EA%B1%B4%EC%84%A4%ED%8F%90%EA%B8%B0%EB%AC%BC%20%EC%88%98%EC%A7%91%C2%B7%EC%9A%B4%EB%B0%98%EB%B9%84.pdf",
  distanceBasis: "편도 km · 단가에 왕복 비용 포함",
  excluded: ["중간처리비", "최종처리비", "반입료", "부가가치세", "추가 수집·운반 조건"],
});
export const TRANSPORT_GUIDELINE = "https://www.law.go.kr/admRulLsInfoP.do?admRulId=35894&efYd=0";
export const TRANSPORT_DISTANCES = Object.freeze([30, 35, 40, 50, 60]);
export const TRANSPORT_METHOD = Object.freeze({
  defaultDistanceKm: 30,
  defaultDistanceLabel: "수용처·거리 미확인 시 30km 참고조건",
  distanceRule: "편도 30km 이하는 30km 단가, 30~60km 사이는 직선보간, 60km 초과는 공표표 주8의 50~60km 기울기로 가산",
  loadingRule: "상차 포함이 기본 · 다른 공사/처리 견적에 상차가 포함되면 상차비 제외",
  quoteRule: "공법별 현장 수집·운반 총견적 우선 · 0원도 유효 · 처리/매각 견적에 운반이 이미 포함된 경로는 재가산하지 않음",
  separateRule: "분리 자재 전용 조건 미확인 시 혼합 암롤 대리단가로 계산하거나 별도견적 대상으로 보류",
  salvageRule: "매각물은 매입자 수거 포함 확인 또는 별도 운반 견적 필요",
  payloadRule: "참고 적재량=min(차량 중량한도, 적재함×공표 적재비중) · 톤당 단가에 배차수를 다시 곱하지 않음",
});

const vehicle = (label, kind, nominalTons, boxM3, referenceDensity, loading, haul) => Object.freeze({
  label, kind, nominalTons, boxM3, referenceDensity, loading, haul: Object.freeze(haul),
});
export const TRANSPORT_RATES = Object.freeze({
  dump24: vehicle("24t 덤프", "mineral", 24, 15.03, 1.6, 3890, [16450, 18380, 20240, 24050, 27800]),
  dump15: vehicle("15t 덤프", "mineral", 15, 9.39, 1.6, 3890, [19700, 22170, 24710, 29810, 34740]),
  dump4_5: vehicle("4.5t 덤프", "mineral", 4.5, 2.82, 1.6, 3890, [37430, 42760, 48150, 59400, 70680]),
  dump2_5: vehicle("2.5t 덤프", "mineral", 2.5, 1.57, 1.6, 3900, [61280, 70750, 79570, 97570, 116350]),
  armroll24: vehicle("24t 암롤", "mixed", 24, 30, 0.63, 6420, [61880, 65710, 69790, 78590, 86620]),
  armroll16: vehicle("16t 암롤", "mixed", 16, 20, 0.63, 6420, [74930, 80360, 87170, 98590, 111400]),
});

const present = value => value !== undefined && value !== null && value !== "";
const nonnegative = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const labelFor = route => route.label || route.stream || route.key || "미분류 반출물";

// Distance below 30 km uses the published floor. Beyond 60 km, note 8 explicitly
// prescribes the last 50-60 km slope; this is reported as a prescribed extrapolation.
export function transportRate(truckKey, distanceKm, { loadingIncluded = false } = {}) {
  const truck = TRANSPORT_RATES[truckKey];
  if (!truck) return { valid: false, reason: "지원하지 않는 차량", truck: truckKey };
  if (!nonnegative(distanceKm)) return { valid: false, reason: "운반거리 입력 오류", truck: truckKey };
  const appliedDistanceKm = Math.max(30, distanceKm);
  const extrapolated = appliedDistanceKm > TRANSPORT_DISTANCES.at(-1);
  const upper = extrapolated ? TRANSPORT_DISTANCES.length - 1 : TRANSPORT_DISTANCES.findIndex(distance => distance >= appliedDistanceKm);
  const lower = Math.max(0, upper - 1);
  const span = TRANSPORT_DISTANCES[upper] - TRANSPORT_DISTANCES[lower];
  const share = span ? (appliedDistanceKm - TRANSPORT_DISTANCES[lower]) / span : 0;
  const haul = truck.haul[lower] + (truck.haul[upper] - truck.haul[lower]) * share;
  const loading = loadingIncluded ? 0 : truck.loading;
  return {
    valid: true, truck: truckKey, label: truck.label, kind: truck.kind, distanceKm,
    appliedDistanceKm, haul, loading, total: haul + loading,
    interpolated: !extrapolated && !TRANSPORT_DISTANCES.includes(appliedDistanceKm), extrapolated,
    referencePayloadTons: Math.min(truck.nominalTons, truck.boxM3 * truck.referenceDensity),
    publishedDistanceRange: { minKm: 30, maxKm: 60, minRate: truck.haul[0] + loading, maxRate: truck.haul.at(-1) + loading },
  };
}

/**
 * routes must be disjoint outbound loads after recycling/finish routing, not raw totals.
 * { key, label, stream, tons, kind:'mineral'|'mixed'|'separated',
 *   destination:'disposal'|'salvage', receiver?, distanceKm?, truck?, quote?, pickupIncluded? }
 * quote is a whole-scenario, VAT-exclusive site collection/haul quote, including zero.
 * separatedHandling:'benchmark' uses an explicitly labelled mixed-vehicle proxy; 'quote'
 * leaves those routes unpriced. Sold materials require pickup confirmation or a quote.
 * complete means every supplied route is priced/accounted for, not validated on site.
 */
export function estimateTransport(options = {}) {
  const {
    routes = [], quote, distanceKm, mineralDistanceKm, mixedDistanceKm, separatedDistanceKm,
    mineralTruck = "dump24", mixedTruck = "armroll24", loadingIncluded = false,
    separatedHandling = "benchmark", salvageHandling = "unknown",
  } = options;
  const rows = [], issues = [], unpriced = [], assumptions = [];
  let total = 0, routeTons = 0, benchmark = false, publishedRangeMin = 0, publishedRangeMax = 0;
  const result = (status, complete) => ({
    total, status, complete, rows, issues: [...new Set(issues)], unpriced,
    assumptions: [...new Set(assumptions)], sources: [TRANSPORT_SOURCE], benchmark, routeTons,
    // Distance-knot sensitivity only; this is not a confidence interval or a quote range.
    publishedDistanceSensitivity: { at30Km: publishedRangeMin, at60Km: publishedRangeMax },
  });
  if (options.includedInDisposalQuote) {
    routeTons = routes.reduce((sum, route) => sum + (nonnegative(route.tons) ? route.tons : 0), 0);
    assumptions.push("현장 일괄 견적은 매각대금 차감 전 금액이며 폐기물 처리와 현장이 부담하는 모든 상차·운반을 포함합니다.");
    return result("bundled", true);
  }
  if (present(quote)) {
    if (!nonnegative(quote)) {
      unpriced.push({ key: "quote", item: "운반 견적", tons: null, reason: "0원 이상인 유한 금액을 입력하세요." });
      return result("unknown", false);
    }
    total = quote;
    routeTons = routes.reduce((sum, route) => sum + (nonnegative(route.tons) ? route.tons : 0), 0);
    rows.push({ key: "scenario-quote", label: "현장 수집·운반 견적", kind: "quote", qty: 1, unit: "식", rate: quote, amount: quote });
    assumptions.push("현장 운반 견적이 해당 공법의 모든 반출 경로를 포함하며 VAT는 별도라는 입력 조건");
    return result("quote", true);
  }
  const keys = new Set();
  for (const [index, raw] of routes.entries()) {
    const route = { ...raw }, key = route.key || `route-${index}`, label = labelFor(route);
    if (keys.has(key)) {
      unpriced.push({ key, item: label, tons: route.tons, reason: "중복 반출 경로 ID · 이중 계산 방지를 위해 합산 제외" });
      continue;
    }
    keys.add(key);
    if (!nonnegative(route.tons)) {
      unpriced.push({ key, item: label, tons: null, reason: "반출 중량 미확인 또는 입력 오류" });
      continue;
    }
    if (route.tons === 0) continue;
    routeTons += route.tons;
    const base = { key, label, stream: route.stream, tons: route.tons, receiver: route.receiver ?? null, destination: route.destination || "disposal" };
    if (present(route.quote)) {
      if (!nonnegative(route.quote)) unpriced.push({ key, item: label, tons: route.tons, reason: "경로별 운반 견적 입력 오류" });
      else {
        rows.push({ ...base, kind: "quote", amount: route.quote, qty: 1, unit: "식", rate: route.quote });
        total += route.quote;
      }
      continue;
    }
    if (route.pickupIncluded === true || (base.destination === "salvage" && salvageHandling === "buyer-pickup")) {
      rows.push({ ...base, kind: "pickup", amount: 0, rate: 0, qty: route.tons, unit: "t" });
      assumptions.push(`${label}: 매입자 수거 또는 기존 계약에 운반 포함 · 현장 별도 부담 0원 조건`);
      continue;
    }
    if (base.destination === "salvage") {
      unpriced.push({ key, item: label, tons: route.tons, reason: "매입자 수거 포함 여부 또는 별도 운반 견적 필요" });
      continue;
    }
    const kind = route.kind || (["concrete", "masonry"].includes(route.stream) ? "mineral" : "separated");
    const isProxy = kind !== "mineral" && kind !== "mixed";
    if (isProxy && separatedHandling !== "benchmark") {
      unpriced.push({ key, item: label, tons: route.tons, reason: "분리 자재 전용 운반 조건·견적 필요" });
      continue;
    }
    const selectedDistance = route.distanceKm ?? (kind === "mineral" ? mineralDistanceKm : kind === "mixed" ? mixedDistanceKm : separatedDistanceKm) ?? distanceKm;
    const distanceMissing = !present(selectedDistance);
    const km = distanceMissing ? 30 : selectedDistance;
    const truckKey = route.truck ?? (kind === "mineral" ? mineralTruck : mixedTruck);
    const rate = transportRate(truckKey, km, { loadingIncluded: route.loadingIncluded ?? loadingIncluded });
    if (!rate.valid) {
      unpriced.push({ key, item: label, tons: route.tons, reason: rate.reason });
      continue;
    }
    const expectedKind = kind === "mineral" ? "mineral" : "mixed";
    if (rate.kind !== expectedKind) {
      unpriced.push({ key, item: label, tons: route.tons, reason: "폐기물 성상과 선택 차량의 공표표가 일치하지 않음" });
      continue;
    }
    if (distanceMissing) {
      benchmark = true;
      assumptions.push("수용처·실거리 미확인: 최소 30km의 공공 발주 참고조건으로 계산 · 현장 실제거리 아님");
    }
    if (rate.extrapolated) assumptions.push(`${label}: 60km 초과 구간은 공표표 주8의 50~60km 단가 기울기를 적용 · 원거리 현장 견적 확인 필요`);
    if (!route.receiver) assumptions.push(`${label}: 처리·매입 수용처 미지정 · 경로별 실제 견적 필요`);
    if (isProxy) {
      benchmark = true;
      issues.push(`${label}: 분리 자재 전용 공표값이 없어 혼합 암롤 단가를 대리 적용했습니다. 부피·적재비중·수용처 조건을 확인하세요.`);
    }
    const referenceLoads = route.tons / rate.referencePayloadTons;
    if (referenceLoads < 1) issues.push(`${label}: 기준 적재량 미만의 소량 반출입니다. 최소 배차비·분리 운행비는 견적 확인이 필요합니다.`);
    if (route.bulkDensity != null && route.bulkDensity !== TRANSPORT_RATES[truckKey].referenceDensity) issues.push(`${label}: 실제 적재비중이 공표표 기준과 다릅니다. 현장 운반 견적을 우선하세요.`);
    const amount = route.tons * rate.total;
    rows.push({ ...base, kind, isProxy, truck: truckKey, truckLabel: rate.label, distanceKm: km,
      appliedDistanceKm: rate.appliedDistanceKm, distanceAssumed: distanceMissing,
      interpolated: rate.interpolated, extrapolated: rate.extrapolated,
      rate: rate.total, loadingRate: rate.loading, haulRate: rate.haul, qty: route.tons, unit: "t", amount,
      loading: route.tons * rate.loading, haul: route.tons * rate.haul,
      referencePayloadTons: rate.referencePayloadTons, referenceLoads, referenceDispatches: Math.ceil(referenceLoads),
      referenceBulkDensity: TRANSPORT_RATES[truckKey].referenceDensity,
    });
    total += amount;
    publishedRangeMin += route.tons * rate.publishedDistanceRange.minRate;
    publishedRangeMax += route.tons * rate.publishedDistanceRange.maxRate;
  }
  if (rows.length) assumptions.push("톤당 공표 단가 적용 · 기준 적재비중을 사용한 참고 배차수이며 배차별 최소요금·압축·용적 제한을 추가 계산하지 않음");
  return result(unpriced.length ? (rows.length ? "partial" : "unknown") : rows.length ? "estimated" : "empty", !unpriced.length);
}

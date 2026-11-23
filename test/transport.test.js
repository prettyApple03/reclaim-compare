import test from "node:test";
import assert from "node:assert/strict";
import { estimateTransport, transportRate, TRANSPORT_RATES } from "../assets/js/transport.js";

test("공표 거리·차량별 운반단가와 상차비를 정확히 반영한다", () => {
  assert.equal(transportRate("dump24", 30).total, 20340);
  assert.equal(transportRate("dump24", 50).total, 27940);
  assert.equal(transportRate("dump2_5", 60).total, 120250);
  assert.equal(transportRate("armroll24", 30).total, 68300);
  assert.equal(transportRate("armroll16", 60).total, 117820);
  assert.equal(transportRate("dump15", 35).haul, 22170);
  assert.equal(transportRate("dump4_5", 40).haul, 48150);
});

test("편도 거리에 왕복비를 다시 곱하지 않고 30km하한·보간·상차중복 제외를 적용한다", () => {
  assert.equal(transportRate("dump24", 5).total, 20340);
  assert.equal(transportRate("dump24", 37.5).haul, (18380 + 20240) / 2);
  assert.equal(transportRate("dump24", 30, { loadingIncluded: true }).total, 16450);
  const result = estimateTransport({ routes: [{ key: "rc", tons: 100, kind: "mineral" }] });
  assert.equal(result.total, 2034000);
  assert.equal(result.benchmark, true);
  assert.equal(result.rows[0].distanceAssumed, true);
});

test("서로 다른 반출 경로·수용처·차량을 구분하며 총 원물량을 다시 더하지 않는다", () => {
  const result = estimateTransport({ routes: [
    { key: "concrete", tons: 100, kind: "mineral", receiver: "A", distanceKm: 30 },
    { key: "mixed", tons: 10, kind: "mixed", receiver: "B", distanceKm: 60 },
  ] });
  assert.equal(result.total, 100 * 20340 + 10 * 93040);
  assert.equal(result.routeTons, 110);
  assert.equal(result.rows[1].receiver, "B");
  assert.equal(result.rows[1].referencePayloadTons, 18.9);
  assert.equal(result.rows[0].referencePayloadTons, 24);
  assert.equal(TRANSPORT_RATES.armroll16.boxM3, 20);
});

test("한쪽 현장견적만 있어도 독립 적용하고 명시적 0원 견적을 보존한다", () => {
  const routes = [{ key: "rc", tons: 100, kind: "mineral" }];
  assert.equal(estimateTransport({ routes, quote: 12345 }).total, 12345);
  const zero = estimateTransport({ routes, quote: 0 });
  assert.equal(zero.total, 0);
  assert.equal(zero.status, "quote");
  assert.equal(zero.complete, true);
  assert.equal(estimateTransport({ routes }).total, 2034000);
});

test("60km 초과는 공식 주8의50~60km 기울기를 적용하고 별도 표시한다", () => {
  const rate = transportRate("dump24", 70);
  assert.equal(rate.haul, 31550);
  assert.equal(rate.total, 35440);
  assert.equal(rate.extrapolated, true);
  assert.equal(transportRate("armroll24", 70).haul, 94650);
  const result = estimateTransport({ routes: [{ key: "far", tons: 2, kind: "mineral", distanceKm: 70 }] });
  assert.equal(result.total, 70880);
  assert.ok(result.assumptions.some(value => value.includes("주8")));
});

test("잘못된입력·부적합차량은 0원확정 대신 미산정으로 남긴다", () => {
  assert.equal(transportRate("dump24", -1).valid, false);
  const result = estimateTransport({ routes: [
    { key: "valid", tons: 1, kind: "mineral", distanceKm: 30 },
    { key: "bad-distance", tons: 2, kind: "mixed", distanceKm: -5 },
    { key: "invalid", tons: -1, kind: "mineral" },
    { key: "wrong-truck", tons: 3, kind: "mixed", truck: "dump24" },
  ] });
  assert.equal(result.total, 20340);
  assert.equal(result.status, "partial");
  assert.equal(result.unpriced.length, 3);
  assert.equal(result.complete, false);
});

test("매각물은 수거포함 확인·견적 없이는 무료로 확정하지 않는다", () => {
  const route = { key: "scrap", tons: 2, destination: "salvage" };
  const unknown = estimateTransport({ routes: [route] });
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.complete, false);
  assert.equal(estimateTransport({ routes: [{ ...route, pickupIncluded: true }] }).total, 0);
  assert.equal(estimateTransport({ routes: [{ ...route, quote: 300000 }] }).total, 300000);
  assert.equal(estimateTransport({ routes: [route], salvageHandling: "buyer-pickup" }).complete, true);
});

test("분리자재의 대리단가는 가정을 표시하고 견적필요 모드도 지원한다", () => {
  const routes = [{ key: "wood", label: "분리 목재", tons: 1, kind: "separated" }];
  const proxy = estimateTransport({ routes, distanceKm: 30 });
  assert.equal(proxy.total, 68300);
  assert.equal(proxy.rows[0].isProxy, true);
  assert.ok(proxy.issues.some(issue => issue.includes("대리")));
  assert.equal(estimateTransport({ routes, separatedHandling: "quote" }).complete, false);
});

test("중복 경로는 두 번 청구하지 않으며 30/60km 민감도는 확률구간과 구분한다", () => {
  const routes = [{ key: "rc", tons: 10, kind: "mineral" }, { key: "rc", tons: 10, kind: "mineral" }];
  const result = estimateTransport({ routes, distanceKm: 40 });
  assert.equal(result.total, 10 * 24130);
  assert.equal(result.unpriced.length, 1);
  assert.deepEqual(result.publishedDistanceSensitivity, { at30Km: 203400, at60Km: 316900 });
});

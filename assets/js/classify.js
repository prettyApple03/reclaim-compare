// IFC 부재(종류·재료 층·부피·면적) → 폐기물 성상별 톤수. DOM·web-ifc를 쓰지 않는다.
import { SEPARATED, STREAMS, EXCLUDED, separation, concreteGrades } from "./scenario.js";

export const CATEGORY_LABEL = {
  wall: "벽", slab: "슬래브", beam: "보", column: "기둥", footing: "기초", stair: "계단", roof: "지붕",
  window: "창호", door: "문", covering: "마감", railing: "난간", plate: "판·부재", pipe: "배관·덕트", other: "기타",
};

// 재료 이름 키워드 → 재료 분류. 위에서부터 먼저 맞는 것을 쓴다.
// ponytail: 이름 키워드 방식이라 오분류가 있을 수 있다. 화면에서 그룹별로 성상을 고칠 수 있게 했다.
const MATERIALS = [
  ["panel", "panel", /sandwich[ -]?panel|샌드위치[ -]?(?:패널|판넬)/i],
  ["insulation", "resin", /insulation|단열|\beps\b|\bxps\b|styro|urethane|우레탄|스티로폼/i],
  ["board", "board", /gypsum|석고|plasterboard|drywall|보드|board|텍스/i],
  ["glass", "glass", /glass|유리|glazing/i],
  ["aluminum", "aluminum", /alumin|알루미늄|샤시|sash/i],
  ["copper", "copper", /copper|구리|동관|brass|황동/i],
  ["resin", "resin", /pvc|vinyl|plastic|polymer|합성수지|장판|linoleum|리놀륨|epoxy|carpet|카펫|벽지|wallpaper|rubber/i],
  ["wood", "wood", /wood|timber|plywood|목재|합판|마루|lumber|mdf|oak|pine|각재/i],
  ["metal", "metal", /steel|강재|철골|강관|강봉|형강|강판|\bSTK[MNR]?\s*\d|iron|metal|\bSS\d|\bSM\d|SHN|H-?beam|stud|galvan/i],
  ["masonry", "masonry", /brick|block|masonry|조적|벽돌|블록|cmu|stone|석재/i],
  ["tile", "tile", /tile|타일|ceramic|도기/i],
  ["mixed", "mixed", /plaster|회반죽|paint|도장/i],
  ["concrete", "concrete", /concrete|콘크리트|\brc\b|cast|mortar|모르타르|screed|cement|시멘트/i],
];
// 재료 이름으로 알 수 없을 때 부재 종류로 정하는 기본값
const FALLBACK = {
  wall: "concrete", slab: "concrete", beam: "concrete", column: "concrete", footing: "concrete", stair: "concrete", roof: "concrete",
  covering: "mixed", railing: "metal", plate: "metal", pipe: "resin", other: "mixed",
};
const STRUCTURAL = new Set(["wall", "slab", "beam", "column", "footing", "stair", "roof"]);
const streamOf = (cls) => MATERIALS.find((m) => m[0] === cls)?.[1] || cls;

export function materialClass(name) {
  return MATERIALS.find(([, , re]) => re.test(name || ""))?.[0] || null;
}

export const groupKey = (el) => `${el.category}|${el.layers.map((l) => l.name).join("+") || "(재료 없음)"}`;

// 부재 하나 → { parts: [{cls, stream, m3, tons}], tons, stream(가장 무거운 성상), guessed }
export function classify(el, rates, overrides = {}) {
  const D = rates.density, parts = [];
  let guessed = false;
  const push = (cls, m3, tons) => parts.push({ cls, stream: streamOf(cls), m3, tons: tons ?? m3 * (D[cls] ?? D[streamOf(cls)] ?? 0) });

  if (el.category === "window") {
    // 유리 + 창틀: 두께를 알기 어려워 면적당 무게로 계산
    const knownFrame = el.layers.map((l) => (materialClass(l.name) || materialClass(l.category))).find((c) => c && c !== "glass");
    const frame = knownFrame || "aluminum";
    guessed = !knownFrame;
    push("glass", 0, el.area * rates.perArea.window_glass);
    push(frame, 0, el.area * rates.perArea.window_frame);
  } else if (el.category === "door") {
    const cls = el.layers.map((l) => (materialClass(l.name) || materialClass(l.category))).find(Boolean);
    if (!cls) guessed = true;
    push(cls || "wood", 0, el.area * rates.perArea.door);
  } else {
    const named = el.layers.map((l) => ({ ...l, cls: (materialClass(l.name) || materialClass(l.category)) }));
    const thick = named.reduce((s, l) => s + l.thickness, 0);
    if (thick > 0) {
      // 복합 부재: 층 두께 비율로 부피를 나눈다
      for (const l of named) {
        if (!l.thickness) continue;
        if (!l.cls || l.cls === "panel") guessed = true;
        push(l.cls || FALLBACK[el.category], (el.volume * l.thickness) / thick);
      }
    } else {
      const cls = named.find((l) => l.cls)?.cls;
      if (!cls || cls === "panel") guessed = true;
      push(cls || FALLBACK[el.category], el.volume);
    }
  }

  // 단일 강재 부재의 수량표 중량을 우선한다. 복합 부재의 전체 중량은 강재에 배정하지 않는다.
  if (parts.length === 1 && parts[0].cls === "metal" && !guessed
      && el.layers.every(l => (materialClass(l.name) || materialClass(l.category)) === "metal")
      && Number.isFinite(el.weightTons) && el.weightTons > 0) {
    parts[0].tons = el.weightTons;
  }
  // IfcBuildingElementProxy(기타)는 가구·가전·위생기구·조경수 같은 객체가 대부분이고 형상이 닫힌 솔리드가 아니어서
  // 부피가 터무니없이 나온다 (나무 한 그루가 수백 t). 기본은 집계에서 빼고, 화면에서 성상을 고르면 넣는다.
  if (el.category === "other") { for (const p of parts) p.stream = EXCLUDED; guessed = false; }
  const over = overrides[groupKey(el)];
  if (over) { for (const p of parts) p.stream = over; guessed = false; }
  const tons = parts.reduce((s, p) => s + p.tons, 0);
  const stream = [...parts].sort((a, b) => b.tons - a.tons)[0]?.stream || "mixed";
  return { ...el, parts, tons, stream, guessed };
}

// 벽·바닥·지붕이 모델링되지 않은 개방형 철골은 건축물 RC 견적식의 적용 대상에서 뺀다.
export function isOpenSteelFrame(classified) {
  const above = classified.filter(el => !el.basement && el.category !== "footing" && el.stream !== EXCLUDED);
  return !above.some(el => ["wall", "slab", "roof"].includes(el.category))
    && above.some(el => el.category === "column" && el.stream === "metal")
    && above.some(el => ["beam", "plate"].includes(el.category) && el.stream === "metal");
}

// 분류한 부재 목록 → 엔진 물량. 철근은 모델에 없으므로 엔진이 콘크리트 부피에서 추정한다.
export function quantitiesFromElements(classified, area_m2) {
  const t = Object.fromEntries(STREAMS.map((s) => [s, 0]));
  const areaTypes = { board: "board", tile: "tile", aluminum: "aluminum", pvc: "resin" };
  const finishAreas = {};
  for (const [key, cls] of Object.entries(areaTypes)) {
    const frame = key === "aluminum" || key === "pvc";
    const matching = classified.filter((el) => !el.guessed && el.area > 0
      && (key !== "pvc" || el.layers.some((layer) => /pvc|vinyl|염화비닐/i.test(layer.name)))
      && (!frame || el.category === "window")
      && el.parts.some((p) => p.cls === cls && p.stream === streamOf(cls)));
    if (matching.length) finishAreas[key] = matching.reduce((sum, el) => sum + el.area, 0);
  }
  let concrete_m3 = 0;
  for (const el of classified) for (const p of el.parts) {
    if (!(p.stream in t)) continue; // 제외한 부재
    t[p.stream] += p.tons;
    if (p.cls === "concrete" && STRUCTURAL.has(el.category)) concrete_m3 += p.m3;
  }
  return { area_m2, concrete_m3, finishAreas, rebarFromConcrete: true, t, basis: "IFC" };
}

// 모델에 내장재가 빠져 있으면 표준품셈 원단위로 채운다 (모델 값이 원단위의 절반 미만인 성상만)
export function supplement(q, usage, rates) {
  const u = rates.wasteUnits[usage], added = {}, t = { ...q.t };
  for (const s of ["wood", "resin", "mixed"]) {
    const expected = u[s] * q.area_m2;
    if (t[s] < expected * 0.5) { added[s] = expected - t[s]; t[s] = expected; }
  }
  return { ...q, t, added };
}

// 모델의 t/㎡을 원단위와 비교 (검산)
export function checkAgainstUnits(q, usage, rates) {
  const u = rates.wasteUnits[usage];
  return Object.keys(u).map((s) => {
    const model = (s === "metal" && q.rebarFromConcrete ? q.t.metal + (q.concrete_m3 * rates.params.rebar_kg_per_m3.value) / 1000 : q.t[s]) / q.area_m2;
    return { stream: s, model, unit: u[s], ratio: model / u[s] };
  });
}

// 부재별 결과 (전면 분별 시나리오 기준) — CSV와 Revit 되쓰기에 쓴다
// mixedFee: 건물 전체로 판정한 분별 후 혼합건설폐기물 단가 (scenario.js의 mixedWaste().fee)
export function elementResults(classified, p, mixedFee = p.fee_mixed_unverified, q = {}) {
  const cost = (net) => Math.max(0, -net), gain = (net) => Math.max(0, net);
  const split = separation(p);
  const quotedShare = q.cleanPrice == null ? 0 : (q.cleanSel ?? 0) / 100;
  const gradeFee = concreteGrades(p, true, q.concreteCase).reduce((sum, grade) => sum + grade.share * grade.fee, 0);
  const concreteFee = (1 - quotedShare) * gradeFee + quotedShare * (q.cleanPrice ?? 0);
  const fee = (s) => s === "concrete" ? concreteFee
    : s === "masonry" ? p.fee_concrete
    : s === "wood" ? split.wood * cost(p.net_wood) + (1 - split.wood) * mixedFee
    : s === "resin" ? split.resin * cost(p.net_resin) + (1 - split.resin) * mixedFee
    : s === "glass" ? split.glass * Math.max(0, p.fee_glass_separate) + (1 - split.glass) * mixedFee
    : s === "board" ? split.board * Math.max(0, p.fee_board_separate) + (1 - split.board) * mixedFee
    : s === "panel" ? Math.max(0, p.fee_panel)
    : s === "mixed" || s === "tile" ? mixedFee : 0;
  const price = (s) => s === "metal" ? p.rec_scrap_sel * p.price_scrap
    : s === "copper" ? (p.rec_copper_sel ?? p.rec_nonferrous_sel) * p.price_copper
    : s === "aluminum" ? p.rec_nonferrous_sel * p.price_aluminum
    : s === "wood" ? split.wood * gain(p.net_wood)
    : s === "resin" ? split.resin * gain(p.net_resin) : 0;
  return classified.map((el) => ({
    globalId: el.globalId, tag: el.tag, category: el.category, floor: el.floor, stream: el.stream,
    method: el.stream === EXCLUDED ? "제외" : SEPARATED.has(el.stream) ? "분별" : "압쇄",
    tons: el.tons,
    disposal: el.parts.reduce((s, x) => s + x.tons * fee(x.stream), 0),
    revenue: el.parts.reduce((s, x) => s + x.tons * price(x.stream), 0),
  }));
}

export function toCsv(results) {
  const head = "GlobalId,ElementId,Category,Floor,RC_Waste,RC_Method,RC_Tons,RC_DisposalCost,RC_Revenue";
  return [head, ...results.map((r) => [r.globalId, r.tag, r.category, r.floor, r.stream, r.method, r.tons.toFixed(4), Math.round(r.disposal), Math.round(r.revenue)].join(","))].join("\n") + "\n";
}

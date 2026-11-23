// IFC 부재(종류·재료 층·부피·면적) → 폐기물 성상별 톤수. DOM·web-ifc를 쓰지 않는다.
import { SEPARATED, STREAMS, EXCLUDED, separation, concreteGrades, rebarTons, streamTons } from "./scenario.js?v=salvage-20261123";
import { hasRebarDesignation, isPlanRebarMember, nonRebarConcrete } from "./rebar-evidence.js?v=salvage-20261123";

export const CATEGORY_LABEL = {
  wall: "벽", slab: "슬래브", beam: "보", column: "기둥", footing: "기초", stair: "계단", roof: "지붕",
  window: "창호", door: "문", covering: "마감", railing: "난간", plate: "판·부재", pipe: "배관·덕트", rebar: "철근 (모델)", other: "기타",
};

// 재료 이름 키워드 → 재료 분류. 위에서부터 먼저 맞는 것을 쓴다.
// ponytail: 이름 키워드 방식이라 오분류가 있을 수 있다. 화면에서 그룹별로 성상을 고칠 수 있게 했다.
const MATERIALS = [
  ["panel", "panel", /sandwich[ -]?panel|샌드위치[ -]?(?:패널|판넬)/i],
  // 철근·섬유로 "보강한" 콘크리트는 철근(강재)·유리섬유(단열재)보다 먼저 콘크리트로 잡는다
  ["concrete", "concrete", /철근\s*콘크리트|보강\s*콘크리트|reinforced\s*concrete|fib(?:er|re)[- ]?reinforced|GFRC|\bRC\b/i],
  // 유리섬유·광물섬유 단열재는 "glass/유리"보다 먼저 잡는다. 판유리 밀도(2.5t/㎥)로 세면 수십~수백 배 무거워진다.
  ["mineralInsulation", "mixed", /glass\s*wool|fib(?:er|re)\s*glass|mineral\s*wool|rock\s*wool|그라스울|글라스울|유리\s*섬유|섬유\s*유리|유리면|암면|미네랄\s*울/i],
  ["insulation", "resin", /\beps\b|\bxps\b|styro|urethane|우레탄|스티로폼|polystyrene|폴리스티렌/i],
  ["unknownInsulation", "mixed", /insulation|단열|보온재/i],
  ["cementBoard", "board", /CRC\s*보드|\bCRC\b|cement[ -]?(?:fiber[ -]?)?board|시멘트\s*보드|섬유\s*시멘트/i],
  ["board", "board", /gypsum|석고|plasterboard|drywall|보드|board|텍스/i],
  ["glass", "glass", /glass|유리|glaz/i],
  ["aluminum", "aluminum", /alumin|알루미늄|샤시|sash/i],
  ["unsortedNonferrous", "mixed", /brass|bronze|황동|청동|구리\s*합금|copper[ -]?(?:alloy|plated|clad)|동도금|동박적층|구리\s*도금/i],
  ["copper", "copper", /copper|구리|동관|동판|순동/i],
  ["resin", "resin", /pvc|염화비닐|비닐|vinyl|plastic|플라스틱|polymer|폴리|합성수지|아크릴|acrylic|장판|linoleum|리놀륨|epoxy|에폭시|carpet|카펫|벽지|wallpaper|rubber|고무|asphalt|아스팔트|방수|습기\s*차단|방습|waterproof|membrane|bitumen/i],
  ["wood", "wood", /wood|timber|plywood|목재|합판|마루|lumber|mdf|oak|pine|각재|떡갈나무|벚나무|소나무|장선|서까래|joist|rafter/i],
  ["metal", "metal", /steel|강철|스틸|스테인리스|stainless|금속|강재|철골|철근|rebar|강관|강봉|형강|강판|철판|\bSTK[MNR]?\s*\d|iron|metal|\bSS\d|\bSM\d|SHN|H-?beam|stud|galvan|zinc|징크|아연/i],
  ["tile", "tile", /tile|타일|ceramic|도기/i],
  ["masonry", "masonry", /brick|block|masonry|조적|벽돌|블[록럭]|cmu|stone|석재|화강|granite|대리석|marble|석회석|limestone|사암|sandstone/i],
  ["mixed", "mixed", /plaster|플라스터|회반죽|paint|도장/i],
  ["concrete", "concrete", /concrete|콘크리트|\brc\b|cast|mortar|모르타르|screed|cement|시멘트/i],
];
const STRUCTURAL = new Set(["wall", "slab", "beam", "column", "footing", "stair", "roof"]);
const streamOf = (cls) => MATERIALS.find((m) => m[0] === cls)?.[1] || cls;
const rebarCandidate = (el, part) => part.stream === "concrete" && !part.reinforced
  && (STRUCTURAL.has(el.category) || el.category === "other")
  && part.manualInput?.reinforced !== false
  && !nonRebarConcrete.test(el.name ?? "") && !nonRebarConcrete.test(part.layer ?? "");
const framingName = /장선|서까래|joist|rafter|\bstud\b|framing/i;
const applianceName = /냉장고|보일러|세척기|세탁기|쿡탑|간이\s*부엌|싱크대|변기|욕조|화장실-가정용|refrigerator|boiler|dishwasher|washing\s*machine|cooktop|kitchenette|toilet|bathtub|\bsink\b/i;

export function excludedEquipment(el) {
  return el.category === "other" && (applianceName.test(el.name ?? "")
    || /IFCFURNISHINGELEMENT|IFCFLOWTERMINAL|IFCFURNITURE|IFCSANITARYTERMINAL|IFCUNITARYEQUIPMENT/i.test(el.ifcType ?? ""));
}

export function materialClass(name) {
  return MATERIALS.find(([, , re]) => re.test(name || ""))?.[0] || null;
}

// IFC 수량표 중량 ÷ 형상 부피가 강재 밀도(약 7.85t/㎥) 범위이면 재료 정보가 없어도 강재로 본다
export function impliedSteel(el) {
  const density = el.weightTons / el.volume;
  return el.volume > 0 && Number.isFinite(density) && density >= 6.5 && density <= 9;
}

export const groupKey =(el) => `${el.category}${el.category === "plate" && /계단|디딤판|\btreads?\b|\bstairs?\b/i.test(el.name) ? "·stair" : ""}|${el.layers.map((l) => l.name).join("+") || "(재료 없음)"}`;

// 부재 하나 → { parts: [{cls, stream, m3, tons}], tons, stream(가장 무거운 성상), guessed }
export function classify(el, rates, overrides = {}, unknownFrame = "aluminum", options = {}) {
  const D = rates.density, parts = [];
  let guessed = false, guessedConcreteTread = false;
  const quantityIssues = [];
  const push = (cls, m3, tons, info = {}) => {
    const density = info.density ?? (["mineralInsulation", "unknownInsulation", "cementBoard", "unknown", "unsortedNonferrous"].includes(cls) ? D[cls] : D[cls] ?? D[streamOf(cls)]);
    const unresolved = tons == null && (!(density >= 0) || info.unresolved);
    const part = { cls, stream: cls === "unknown" ? "mixed" : streamOf(cls), m3,
      tons: tons ?? (unresolved ? 0 : m3 * density),
      massBasis: tons != null ? "area-factor" : unresolved ? "unquantified" : "volume-density-assumption",
      density: unresolved ? undefined : density, ...info, unresolved: Boolean(unresolved) };
    parts.push(part);
    if (part.unresolved) quantityIssues.push(`${info.layer || el.name || CATEGORY_LABEL[el.category] || "부재"}: ${info.reason || "재료·밀도 미확인"} (${m3.toFixed(3)}㎥, 중량 미산정)`);
    return part;
  };

  // 일부 IFC는 유리와 프레임을 하나의 판형 창호로 내보낸다.
  const combinedFrame = el.category === "window" || el.category === "plate"
    ? el.layers.find(layer => !layer.thickness && /유리|glass|glaz/i.test(layer.name)
      && /알루미늄|alumin|\bpvc\b|염화비닐|vinyl/i.test(layer.name))
    : null;
  const areaBased = el.category === "window" || el.category === "door"
    || (combinedFrame && el.area > 0 && !el.layers.some(layer => layer.thickness > 0));
  if (areaBased && el.category !== "door") {
    // 유리 + 창틀: 두께를 알기 어려워 면적당 무게로 계산
    const knownFrame = el.layers.map((l) => (materialClass(l.name) || materialClass(l.category))).find((c) => c && c !== "glass");
    const frame = combinedFrame
      ? (/\bpvc\b|염화비닐|vinyl/i.test(combinedFrame.name) ? "resin" : "aluminum")
      : knownFrame || unknownFrame;
    guessed = !knownFrame || el.category !== "window";
    push("glass", 0, el.area * rates.perArea.window_glass);
    push(frame, 0, el.area * rates.perArea.window_frame);
    parts[1].windowAssembly = true;
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
        const m3 = el.volume * l.thickness / thick;
        // 장선·스터드 층은 빈 공간을 포함한 조립체다. 충전율을 확인하기 전에는 솔리드 목재로 계산하지 않는다.
        const cavity = l.cls === "wood" && (framingName.test(l.name)
          || l.thickness >= 0.038 / (el.lengthScale || 1) && named.some(other => /Insulation/i.test(other.cls ?? "") || other.cls === "insulation")
            && named.some(other => other !== l && /Insulation/i.test(other.cls ?? "") && Math.abs(other.thickness - l.thickness) < l.thickness * 0.05));
        const fraction = l.framingFraction ?? el.framingFraction;
        const framingVerified = Number.isFinite(fraction) && fraction > 0 && fraction <= 1;
        const part = push(l.cls || "unknown", cavity && framingVerified ? m3 * fraction : m3, undefined, {
          layer: l.name || l.category || "재료 없음", reinforced: l.cls === "concrete" && hasRebarDesignation(l.name + " " + l.category),
          unresolved: cavity && !framingVerified,
          reason: cavity && !framingVerified ? "목구조 층의 실재적 비율 미확인" : !l.cls ? "재료 미확인" : /Insulation/i.test(l.cls) ? "해당 단열재 밀도 미확인" : undefined,
          framingEnvelope_m3: cavity ? m3 : undefined, framingFraction: cavity && framingVerified ? fraction : undefined,
        });
        const thicknessM = l.thickness * (el.lengthScale || 1);
        if (["board", "tile"].includes(streamOf(l.cls)) && thicknessM > 0) part.area = m3 / thicknessM;
      }
    } else {
      const constituents = new Set(named.map(l => l.cls).filter(Boolean));
      const verifiedUntagged = options.verifiedStructuralConcrete && STRUCTURAL.has(el.category)
        && !named.some(l => l.name || l.category) && !nonRebarConcrete.test(el.name ?? "");
      const planMember = isPlanRebarMember(el, options.rebarEvidence) && (named.length === 1
        && named[0].cls === "concrete" && !nonRebarConcrete.test([named[0].name, named[0].category, el.name].join(" "))
        || named.length === 0 && options.rebarEvidence.allowUntagged && !impliedSteel(el));
      let cls = constituents.size > 1 ? "unknown" : named.find((l) => l.cls)?.cls;
      if (!cls || cls === "panel") guessed = true;
      if (!cls) {
        // 재료가 없으면 ① 수량표 중량/형상 부피로 본 밀도, ② 부재 이름(예: "System Panel: Glazed") 순으로 추정한다.
        // 재료 없는 강재 보를 콘크리트(2.4t/㎥)로, 유리 패널을 강재(7.85t/㎥)로 세는 것을 막는다.
        cls = (impliedSteel(el) ? "metal" : null) || materialClass(el.name)
          || (planMember || verifiedUntagged ? "concrete" : "unknown");
      }
      const knownWeight = Number.isFinite(el.weightTons) && el.weightTons >= 0 ? el.weightTons : undefined;
      const part = push(cls, el.volume, cls === "unknown" ? knownWeight : undefined, {
        layer: named.find(l => l.cls)?.name || el.name || "재료 없음",
        reason: constituents.size > 1 ? "두께·구성비 없는 복합 재료" : undefined,
        reinforced: cls === "concrete" && (planMember || hasRebarDesignation(named.map(l => l.name + " " + l.category).join(" ") + " " + (el.name ?? ""))
          || verifiedUntagged),
      });
      if (planMember && part.reinforced) {
        part.rebarBasis = "plan-structural-member-estimate";
        if (!named.length) part.massBasis = "plan-structural-member-estimate";
      }
      if (verifiedUntagged && cls === "concrete") part.massBasis = "verified-rc-structure-assumption";
      if (knownWeight != null && cls === "unknown") {
        part.massBasis = "ifc-weight";
        quantityIssues.push(`${el.name || CATEGORY_LABEL[el.category]}: IFC 중량은 있으나 폐기물 성상 미확인`);
      }
    }
  }

  // 단일 재료의 수량표 순중량은 밀도 가정보다 우선한다. 복합 부재의 총중량을 한 재료에 몰아 넣지 않는다.
  if (!areaBased && parts.length === 1 && Number.isFinite(el.weightTons) && el.weightTons > 0) {
    parts[0].tons = el.weightTons;
    parts[0].massBasis = "ifc-weight";
    parts[0].unresolved = false;
    if (parts[0].cls !== "unknown") quantityIssues.length = 0;
  }
  // Cable assemblies include insulation, and a pipe mesh may represent its outer cylinder.
  // Retain the geometry for inspection; only material-specific mass is marketable as copper.
  for (const part of parts) {
    if (part.stream !== "copper") continue;
    const name = [part.layer, el.name, el.ifcType].filter(Boolean).join(" ");
    const cable = /전선|케이블|cable|insulated wire/i.test(name);
    const pipe = el.category === "pipe" || /동관|배관|pipe|tub(?:e|ing)/i.test(name);
    if (cable || (pipe && (parts.length !== 1 || (!el.hasNetVolume && !el.hasNetWeight)))) {
      part.reason = cable ? "피복·접속부를 제외한 순동 중량 미확인" : "동관 벽체의 순체적·순중량 미확인";
      part.tons = 0;
      part.unresolved = true;
      part.massBasis = "unquantified";
      quantityIssues.push(`${el.name || part.layer}: ${part.reason}`);
    } else if (pipe && el.hasNetVolume && !el.hasNetWeight) {
      part.tons = part.m3 * D.copper;
      part.massBasis = "net-volume-density";
    }
  }
  // IfcBuildingElementProxy(기타)는 가구·가전·위생기구·조경수 같은 객체가 대부분이고 형상이 닫힌 솔리드가 아니어서
  // 부피가 터무니없이 나온다 (나무 한 그루가 수백 t). 기본은 집계에서 빼고, 화면에서 성상을 고르면 넣는다.
  // 단, 재료 이름으로 성상을 알 수 있는 기타 객체(콘크리트·강재 등으로 모델링한 구조 부재)는 넣는다.
  // ArchiCAD 등은 구조 부재를 IfcBuildingElementProxy로 내보내는 경우가 있어, 통째로 빼면 물량이 크게 빠진다.
  const excludedReason = excludedEquipment(el) ? "가전·가구·위생설비는 솔리드 건축재 물량에서 제외; 별도 반출 견적 필요"
    : el.category === "other" && guessed ? "용도·재료가 확인되지 않은 기타 객체" : "";
  if (excludedReason) {
    for (const p of parts) { p.stream = EXCLUDED; p.tons = 0; p.unresolved = false; p.massBasis = "excluded-equipment"; }
    quantityIssues.length = 0;
    guessed = false;
  }
  const over = overrides[groupKey(el)];
  if (over) {
    if (over === EXCLUDED) {
      for (const part of parts) { part.stream = over; part.unresolved = false; }
    } else if (over === "mixed") {
      // 수동 성상 지정은 명시적 밀도 가정이다. 원래 미확정 부피를 숨기지 않고 출처를 남긴다.
      for (const part of parts) {
        if (part.unresolved || part.massBasis === "excluded-equipment") part.tons = part.m3 * D.mixed;
        part.stream = over; part.unresolved = false; part.massBasis = "manual-material-density-assumption";
      }
    } else if (!parts.every(part => part.stream === over)) {
      // 창호·문의 면적 기준 질량은 성상 정정 후에도 유지한다.
      const areaWeight = areaBased ? parts.reduce((sum, part) => sum + part.tons, 0) : undefined;
      parts.length = 0;
      push(over, areaBased ? 0 : el.volume, areaWeight);
      parts[0].massBasis = "manual-material-density-assumption";
      parts[0].reinforced = over === "concrete" && hasRebarDesignation(el.name ?? "");
    }
    guessed = false;
    guessedConcreteTread = false;
    quantityIssues.length = 0;
  }
  if (parts.length === 1 && parts[0].stream === "panel" && Number.isFinite(el.weightTons) && el.weightTons > 0) {
    parts[0].tons = el.weightTons;
    parts[0].massBasis = "ifc-weight";
    parts[0].unresolved = false;
  }
  const tons = parts.reduce((s, p) => s + p.tons, 0);
  const stream = [...parts].sort((a, b) => b.tons - a.tons)[0]?.stream || "mixed";
  return { ...el, parts, tons, stream, guessed, guessedConcreteTread, quantityIssues, excludedReason: over ? "" : excludedReason,
    unresolvedParts: parts.filter(p => p.unresolved) };
}

// 층별 수동 보정은 그룹 전체의 계근 중량(kg)을 부피 비율로 나누거나 유효밀도(kg/㎥)를 적용한다.
// 동일 그룹의 각 부재에 그룹 총중량을 반복 적용하지 않는다. 가전 제외와 수동 성상 지정은 별도다.
export function classifyElements(elements, rates, overrides = {}, unknownFrame = "aluminum", options = {}) {
  const classified = elements.map(el => classify(el, rates, overrides, unknownFrame, options));
  const layerOverrides = options.layerOverrides ?? {};
  const volumeOf = new Map();
  const keyOf = (el, part) => JSON.stringify([groupKey(el), part.layer]);
  for (const el of classified) for (const part of el.parts) {
    if (part.stream === EXCLUDED) continue;
    const key = keyOf(el, part);
    volumeOf.set(key, (volumeOf.get(key) ?? 0) + part.m3);
  }
  for (const el of classified) {
    let changed = false;
    for (const part of el.parts) {
      const input = layerOverrides[groupKey(el)]?.[part.layer];
      if (!input || part.stream === EXCLUDED) continue;
      const massKnown = input.massKg != null && Number.isFinite(input.massKg) && input.massKg >= 0;
      const densityKnown = input.densityKgPerM3 != null && Number.isFinite(input.densityKgPerM3) && input.densityKgPerM3 >= 0;
      if (!massKnown && !densityKnown) continue;
      const material = STREAMS.includes(input.material) ? input.material : null;
      if (material) { part.cls = material; part.stream = material; }
      part.geometryVolume_m3 ??= part.m3;
      const originalVolume = part.m3;
      part.tons = massKnown ? input.massKg / 1000 * originalVolume / (volumeOf.get(keyOf(el, part)) || 1) : originalVolume * input.densityKgPerM3 / 1000;
      part.massBasis = massKnown ? "manual-group-layer-weight" : "manual-effective-density";
      part.density = densityKnown ? input.densityKgPerM3 / 1000 : rates.density[part.cls];
      if (part.density > 0) part.m3 = part.tons / part.density;
      if (part.tons === 0) part.m3 = 0;
      part.unresolved = false;
      part.manualInput = { ...input };
      part.reinforced = part.cls === "concrete" && (input.reinforced ?? part.reinforced) === true;
      changed = true;
    }
    if (!changed) continue;
    el.tons = el.parts.reduce((sum, part) => sum + part.tons, 0);
    el.stream = [...el.parts].sort((a, b) => b.tons - a.tons)[0]?.stream || "mixed";
    el.unresolvedParts = el.parts.filter(part => part.unresolved);
    el.guessed = el.parts.some(part => part.unresolved || part.cls === "unknown");
    el.quantityIssues = el.parts.flatMap(part => part.unresolved
      ? [`${part.layer || el.name}: ${part.reason || "재료·밀도 미확인"} (${part.m3.toFixed(3)}㎥, 중량 미산정)`]
      : part.cls === "unknown" && part.tons > 0 ? [`${part.layer || el.name}: 중량 확인, 폐기물 성상 미확인`] : []);
  }
  return classified;
}

// 벽·바닥·지붕이 모델링되지 않은 개방형 철골은 건축물 RC 견적식의 적용 대상에서 뺀다.
export function isOpenSteelFrame(classified) {
  const above = classified.filter(el => !el.basement && el.category !== "footing" && el.stream !== EXCLUDED);
  const canopy = above.some(el => ["roof", "covering"].includes(el.category) && /차양막|막구조|canopy/i.test(el.name ?? ""));
  const enclosed = above.some(el => ["wall", "slab", "roof"].includes(el.category)
    && !(canopy && el.category !== "slab" && ["panel", "resin"].includes(el.stream)));
  return !enclosed
    && above.some(el => el.category === "column" && el.stream === "metal")
    && above.some(el => ["beam", "plate"].includes(el.category) && el.stream === "metal");
}

// 분류한 부재 목록 → 엔진 물량. 철근은 모델에 없으므로 엔진이 콘크리트 부피에서 추정한다.
export function quantitiesFromElements(classified, area_m2) {
  const t = Object.fromEntries(STREAMS.map((s) => [s, 0]));
  let salvageCopperTons = 0, separateCopperTons = 0;
  const areaTypes = { board: "board", tile: "tile", aluminum: "aluminum", pvc: "resin" };
  const finishAreas = {};
  for (const [key, cls] of Object.entries(areaTypes)) {
    const frame = key === "aluminum" || key === "pvc";
    const layerAreas = !frame ? classified.flatMap(el => el.parts.filter(p => p.stream === streamOf(cls) && p.area > 0 && !p.unresolved).map(p => p.area)) : [];
    if (layerAreas.length) { finishAreas[key] = layerAreas.reduce((sum, area) => sum + area, 0); continue; }
    const matching = classified.filter((el) => !el.guessed && el.area > 0
      && (key !== "pvc" || el.layers.some((layer) => /pvc|vinyl|염화비닐/i.test(layer.name)))
      && (!frame || el.category === "window")
      && el.parts.some((p) => p.cls === cls && p.stream === streamOf(cls)));
    if (matching.length) finishAreas[key] = matching.reduce((sum, el) => sum + el.area, 0);
  }
  let concrete_m3 = 0, masonry_m3 = 0, rebarConcrete_m3 = 0, unverifiedRebarConcrete_m3 = 0, planRebarConcrete_m3 = 0;
  const quantityIssues = classified.flatMap(el => el.quantityIssues ?? []);
  const unresolvedParts = classified.flatMap(el => (el.unresolvedParts ?? []).map(part => ({
    expressID: el.expressID, name: el.name, groupKey: groupKey(el), category: el.category,
    layer: part.layer, cls: part.cls, m3: part.m3, reason: part.reason || "재료·밀도 미확인",
  })));
  for (const el of classified) for (const p of el.parts) {
    if (!(p.stream in t)) continue; // 제외한 부재
    t[p.stream] += p.tons;
    const copper = saleableCopperPart(el, p);
    if (copper) salvageCopperTons += p.tons;
    if (copper === "separate") separateCopperTons += p.tons;
    // 실제 압쇄되는 콘크리트·모르타르·조적은 IFC 분류가 proxy/plate/covering이어도 누락하지 않는다.
    if (p.stream === "concrete") {
      concrete_m3 += p.m3;
      if (p.reinforced) rebarConcrete_m3 += p.m3;
      else if (rebarCandidate(el, p)) unverifiedRebarConcrete_m3 += p.m3;
      if (p.reinforced && p.rebarBasis === "plan-structural-member-estimate") planRebarConcrete_m3 += p.m3;
    }
    // 조적벽도 압쇄기로 허물므로 장비 시간·구조체 공기에 넣는다 (철근 추정에는 넣지 않는다)
    if (p.stream === "masonry") masonry_m3 += p.m3;
  }
  // 모델에 그린 철근(IfcReinforcingBar 등)은 이미 metal에 들어 있다. 엔진은 콘크리트 부피로 추정한 철근량에서 이만큼을 뺀다.
  const rebarModeledTons = classified.filter((el) => el.category === "rebar" && el.stream === "metal").reduce((sum, el) => sum + el.tons, 0);
  if (unverifiedRebarConcrete_m3 > 0) quantityIssues.push(`콘크리트 ${unverifiedRebarConcrete_m3.toFixed(3)}㎥의 철근콘크리트 여부 미확인: 해당 부피에서 철근을 자동 매각하지 않습니다.`);
  return { area_m2, concrete_m3, masonry_m3, rebarConcrete_m3, planRebarConcrete_m3, unverifiedRebarConcrete_m3, finishAreas,
    rebarFromConcrete: true, rebarModeledTons, salvageCopperTons, separateCopperTons, t, basis: "IFC",
    quantityIssues: [...new Set(quantityIssues)], unresolvedParts,
    unresolvedMaterialVolume_m3: unresolvedParts.reduce((sum, part) => sum + part.m3, 0),
    excludedEquipmentCount: classified.filter(el => el.excludedReason).length,
  };
}

// Board and tile use one takeoff for labor and disposal. Reserve estimated mass from
// untyped mixed waste first, since that stock may already include those finishes.
export function connectFinishTakeoff(q, raw, rates, params) {
  q.t = { ...q.t };
  q.finishAreas = { ...q.finishAreas };
  q.finishTakeoff = {};
  let estimated = 0;
  for (const key of ["board", "tile"]) {
    const tonsPerArea = rates.density[key] * rates.finishThickness[key];
    const inputWeight = q[key + "Weight"];
    const measured = inputWeight ?? raw.t[key];
    const hasWeight = inputWeight != null || measured > 0;
    const modeledArea = q.finishAreas[key];
    const noIfcSupplement = (q.basis === "IFC" || raw.basis === "IFC") && !q.supplemented;
    const unverified = (q.finishFallbackDisabled || noIfcSupplement) && !hasWeight && modeledArea == null;
    const area = modeledArea ?? (hasWeight ? measured / tonsPerArea : unverified ? 0 : q.area_m2 * params["int_" + key + "_ratio"]);
    const tons = hasWeight ? measured : area * tonsPerArea;
    q.finishAreas[key] = area;
    q.t[key] = tons;
    q.finishTakeoff[key] = { area, tons, estimatedWeight: !hasWeight && !unverified, estimatedArea: modeledArea == null && !unverified, unverified,
      source: inputWeight != null ? "manual-weight" : measured > 0 ? "ifc-material-volume" : modeledArea != null ? "manual-or-ifc-area" : unverified ? "not-modeled" : "area-supplement-assumption" };
    if (!hasWeight) estimated += tons;
  }
  const untyped = Math.max(0, 1 - (q.mixedMineral ?? 0) - (q.mixedCombustible ?? 0));
  const reused = Math.min(estimated, q.t.mixed * untyped);
  if (reused > 0) {
    const original = q.t.mixed;
    q.t.mixed -= reused;
    const scale = q.t.mixed > 0 ? original / q.t.mixed : 0;
    q.mixedMineral = (q.mixedMineral ?? 0) * scale;
    q.mixedCombustible = (q.mixedCombustible ?? 0) * scale;
  }
  q.finishMixedReallocated = reused;
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
export function checkAgainstUnits(q, usage, rates, rebarKgPerM3 = rates.params.rebar_kg_per_m3.value) {
  const u = rates.wasteUnits[usage];
  const { t, rebarAdded } = streamTons(q, { rebar_kg_per_m3: rebarKgPerM3 });
  return Object.keys(u).map((s) => {
    const model = t[s] / q.area_m2;
    return { stream: s, model, unit: u[s], ratio: model / u[s], estimatedRebarTons: s === "metal" ? rebarAdded : 0 };
  });
}

// 부재별 결과 — CSV, 보고서, Revit 되쓰기에 쓴다. mode: "selective"(전면 분별) | "crush"(일괄 압쇄)
// mixedFee: 건물 전체로 판정한 그 공법의 혼합건설폐기물 단가 (scenario.js의 mixedWaste().fee)
// 단가·성상 배분·회수율은 scenario.js의 건물 전체 계산과 같은 값을 쓴다.
export function isStructuralSteelPart(el, part) {
  return part.stream === "metal" && (["beam", "column"].includes(el.category) || el.category === "plate" && !el.guessed);
}

function saleableCopperPart(el, part) {
  if (part.stream !== "copper" || part.unresolved || !(part.tons > 0)) return null;
  const measured = part.manualInput?.material === "copper" && part.manualInput?.massKg != null;
  const layer = part.layer || "", description = [layer, el.name, el.ifcType].filter(Boolean).join(" ");
  if (!measured && (excludedEquipment(el) || /전선|케이블|cable|insulated wire/i.test(description))) return null;
  if (!measured && (el.category === "pipe" || /동관|배관|pipe|tub(?:e|ing)/i.test(description)) && !el.hasNetVolume && !el.hasNetWeight) return null;
  if (!measured && (part.massBasis === "area-factor" || el.guessed || !el.layers.some(l => (materialClass(l.name) || materialClass(l.category)) === "copper"))) return null;
  const sheet = /동판|구리판|순동판|copper[ -]?(?:sheet|plate)|동박|copper[ -]?foil/i.test(description)
    || (el.category === "plate" && !/동관|배관|pipe|tub(?:e|ing)/i.test(description));
  return sheet ? "separate" : "unallocated";
}

export function elementResults(classified, p, mixedFee = p.fee_mixed_unverified, q = {}, mode = "selective", scenario = null) {
  const sel = mode === "selective";
  const cost = (net) => Math.max(0, -net), gain = (net) => Math.max(0, net);
  mixedFee = scenario?.mixed?.fee ?? q[sel ? "mixedFeeSel" : "mixedFeeCrush"] ?? mixedFee;
  const windowMixedFee = q[sel ? "mixedFeeSel" : "mixedFeeCrush"] ?? (p.fee_mixed_quote >= 0 ? p.fee_mixed_quote : p.fee_mixed_unverified);
  const unsoldMetalFee = q.metalFee ?? q[sel ? "mixedFeeSel" : "mixedFeeCrush"] ?? p.fee_mixed_unverified;
  const woodNet = q.woodNetPrice ?? p.net_wood, resinNet = q.resinNetPrice ?? p.net_resin;
  // 목재·수지·유리의 기본 분리율은 분별 공법에 적용한다.
  const split = sel ? separation(p) : { wood: 0, resin: 0, glass: 0, board: 0 };
  const quotedShare = q.cleanPrice == null ? 0 : ((sel ? q.cleanSel : q.cleanCrush) ?? 0) / 100;
  const gradeFee = concreteGrades(p, sel, q.concreteCase, q.t ? q : undefined).reduce((sum, grade) => sum + grade.share * grade.fee, 0);
  const concreteFee = (1 - quotedShare) * gradeFee + quotedShare * (q.cleanPrice ?? 0);
  const finishFee = (key, quote, fallback) => {
    if (!scenario) return fallback;
    const route = scenario.finishRoutes?.[key];
    const total = route?.total ?? q.t?.[key] ?? 0;
    if (!(total > 0)) return fallback;
    const separate = route?.separate ?? scenario.split[key];
    const carryover = route?.concreteCarryover ?? 0;
    const mixed = total - separate - carryover;
    return (separate * Math.max(0, quote) + mixed * mixedFee + carryover * p.fee_concrete) / total;
  };
  const boardFee = q.boardFee ?? p.fee_board_separate;
  const fee = (s) => s === "concrete" ? concreteFee
    : s === "masonry" ? p.fee_concrete
    : s === "wood" ? split.wood * cost(woodNet) + (1 - split.wood) * mixedFee
    : s === "resin" ? split.resin * cost(resinNet) + (1 - split.resin) * mixedFee
    : s === "glass" ? split.glass * Math.max(0, p.fee_glass_separate) + (1 - split.glass) * mixedFee
    : s === "board" ? finishFee("board", boardFee, split.board * Math.max(0, boardFee) + (1 - split.board) * mixedFee)
    : s === "tile" ? finishFee("tile", q.tileFee ?? -1, mixedFee)
    : s === "panel" ? Math.max(0, p.fee_panel)
    : s === "mixed" ? mixedFee : 0;
  const scrapRecovery = sel ? p.rec_scrap_sel : p.rec_scrap_crush;
  const nonferrous = sel ? p.rec_nonferrous_sel : p.rec_nonferrous_crush;
  const copperRate = (sel ? p.rec_copper_sel : p.rec_copper_crush) ?? nonferrous;
  const price = (s) => s === "metal" ? scrapRecovery * p.price_scrap
    : s === "copper" ? (q.fixedComparison ? 0 : copperRate * p.price_copper)
    : s === "aluminum" ? nonferrous * p.price_aluminum
    : s === "wood" ? split.wood * gain(woodNet)
    : s === "resin" ? split.resin * gain(resinNet) : 0;
  // 구조 콘크리트 안의 철근 추정량은 엔진과 같이 폐콘크리트에서 빼서 고철로 센다
  // 모델 철근이 있으면 엔진과 같이: 콘크리트에서는 철근 전체를 빼고, 고철 수익은 모델에 없는 추정분만 콘크리트 부재에 배분한다
  const total = q.concrete_m3 > 0 ? streamTons({ ...q, t: { concrete: Infinity } }, p) : null;
  const estimated = q.concrete_m3 > 0 ? rebarTons(q, p.rebar_kg_per_m3) : 0;
  const scale = total && estimated > 0 ? total.rebar / estimated : 1, sold = total && total.rebar > 0 ? total.rebarAdded / total.rebar : 1;
  const rebarOf = (el, x) => x.cls === "concrete" && x.stream === "concrete"
    && (q.rebarConcrete_m3 == null ? STRUCTURAL.has(el.category) : x.reinforced || q.rebarConcreteConfirmed && rebarCandidate(el, x))
    ? Math.min(x.tons, scale * rebarTons({ concrete_m3: x.m3, rebarConcrete_m3: x.m3, rebarKgPerM3: q.rebarKgPerM3 }, p.rebar_kg_per_m3)) : 0;
  const windowPart = (el, part) => q.windowMode && (el.category === "window" || part.windowAssembly);
  const frameRate = (key) => Math.max(0, Math.min(100, q[key + (sel ? "Sel" : "Crush")] ?? 100)) / 100;
  const partFee = (el, part) => {
    if (q.windowMode && part.stream === "glass" && (el.category === "window" || el.parts.some(p => p.windowAssembly))) return windowMixedFee;
    if (windowPart(el, part) && part.stream === "aluminum") return (1 - frameRate("al")) * unsoldMetalFee;
    if (windowPart(el, part) && part.stream === "resin") {
      const rate = q.pvcPrice == null ? 0 : frameRate("pvc");
      return rate * cost((q.pvcPrice ?? 0) * 1000) + (1 - rate) * mixedFee;
    }
    return fee(part.stream);
  };
  const partPrice = (el, part) => {
    if (part.stream === "copper" && q.fixedComparison) {
      const source = saleableCopperPart(el, part);
      const distinctOnly = scenario?.copperSales?.distinctOnly ?? (q.copperPipeSold != null || q.pipeInstalled != null);
      return source && (!distinctOnly || source === "separate") ? copperRate * p.price_copper : 0;
    }
    if (windowPart(el, part) && part.stream === "aluminum") return frameRate("al") * (q.alPrice == null ? p.price_aluminum : q.alPrice * 1000);
    if (windowPart(el, part) && part.stream === "resin") return q.pvcPrice == null ? 0 : frameRate("pvc") * gain(q.pvcPrice * 1000);
    return q.steelWork && isStructuralSteelPart(el, part) ? (p.rec_structural_steel ?? p.rec_scrap_sel) * p.price_scrap : price(part.stream);
  };
  return classified.map((el) => ({
    globalId: el.globalId, tag: el.tag, category: el.category, floor: el.floor, stream: el.stream,
    // 처리 방식은 실제로 적용한 작업이다. 철근 회수 효과는 아래 금액(공법별 회수율)에 반영한다.
    method: el.stream === EXCLUDED ? "제외" : sel && SEPARATED.has(el.stream) ? "분별 해체" : "압쇄 해체",
    tons: el.tons,
    disposal: el.parts.reduce((s, x) => s + (x.tons - rebarOf(el, x)) * partFee(el, x)
      + (q.fixedComparison && x.stream === "metal" && el.category !== "rebar" ? x.tons * (1 - (q.steelWork && isStructuralSteelPart(el, x) ? p.rec_structural_steel ?? p.rec_scrap_sel : scrapRecovery)) * unsoldMetalFee : 0)
      + rebarOf(el, x) * (1 - scrapRecovery) * p.fee_concrete, 0),
    revenue: el.parts.reduce((s, x) => s + x.tons * partPrice(el, x) + rebarOf(el, x) * sold * price("metal"), 0),
  }));
}

export function reconcileElementResults(results, appliedTons, scenario) {
  const exported = results.reduce((sum, row) => {
    if (row.stream !== EXCLUDED) sum.weightUnits += Math.round(Number(row.tons.toFixed(4)) * 10000);
    sum.disposal += Math.round(row.disposal);
    sum.revenue += Math.round(row.revenue);
    return sum;
  }, { weightUnits: 0, disposal: 0, revenue: 0 });
  const weightUnits = Math.round(appliedTons * 10000) - exported.weightUnits;
  const disposal = Math.round(scenario.disposal) - exported.disposal;
  const revenue = Math.round(scenario.revenue) - exported.revenue;
  if (weightUnits === 0 && disposal === 0 && revenue === 0) return results;
  return [...results, {
    globalId: "", tag: "", category: "adjustment", floor: "", stream: "",
    method: "부재 미귀속", tons: weightUnits / 10000, disposal, revenue,
  }];
}

export function toCsv(results) {
  const head = "GlobalId,ElementId,Category,Floor,RC_Waste,RC_Method,RC_Tons,RC_DisposalCost,RC_Revenue";
  return [head, ...results.map((r) => [r.globalId, r.tag, r.category, r.floor, r.stream, r.method, r.tons.toFixed(4), Math.round(r.disposal), Math.round(r.revenue)].join(","))].join("\n") + "\n";
}

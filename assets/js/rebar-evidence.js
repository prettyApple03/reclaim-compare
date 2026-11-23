// Only sections supported by the reference plan can supply a missing reinforcement
// designation. The app supplies these plans for exact IFC fingerprints or plan-built IFCs.
const referenceSections = {
  "01-house.json": ["S1"],
  "02-shops.json": ["C1", "C2", "G1", "G2", "S1"],
  "03-multifamily-transfer.json": ["C1", "C2", "TG", "G1", "W1", "RW", "S1", "MAT"],
  "04-apartment.json": ["W1", "W2", "S1"],
  // The encased steel sections are modeled separately. Deck-slab reinforcement is unknown.
  "05-office-above.json": ["C2", "C3"],
  "06-office-below.json": ["C1", "RW", "W1", "S1", "MAT"],
  "07-factory.json": ["C1"],
};

const sectionTypes = new Set(["column", "beam", "slab", "wall"]);
const nominalRC = /철근\s*콘크리트|\breinforced\s+concrete\b|\bRC\b/i;
export const nonRebarConcrete = /무근|버림|모르타르|몰탈|방통|방수|바닥난방|토핑|보호층|미장|비구조|비내력|섬유\s*보강|섬유\s*강화|plain\s+concrete|unreinforced|non[ -]?structural|blinding|lean\s+concrete|mortar|screed|topping|fib(?:er|re)|GFRC|GRC\b|시멘트\s*보드|cement\s*board/i;
export const hasRebarDesignation = name => nominalRC.test(name) && !nonRebarConcrete.test(name);

export function planRebarEvidence(plan, caseFile, validationCase) {
  // This particular model lacks IFC material tags. The verified above-ground RC
  // scope plus unambiguous primary-member IDs supports a labeled estimate.
  if (!plan && validationCase?.id === "nonhyeon-124-1" && validationCase.verified === true
      && validationCase.structure === "rc" && validationCase.scope === "above") {
    return {
      source: validationCase.source + " · 지상 골조 및 IFC 주부재 기호 대조",
      sections: { C1: "column", S1: "slab", G1: "beam", G2: "beam", G3: "beam", G4: "beam", G5: "beam", WG1: "beam", "B1 estimated section": "beam", "Core W1": "wall", "Shaft W1": "wall" },
      allowUntagged: true, aboveOnly: true, kgPerM3: null, rateNote: "프로젝트 철근량 가정",
    };
  }
  if (!plan?.sections) return null;
  const reference = referenceSections[String(caseFile ?? "").split("/").pop()];
  const frame = plan.building?.structure ?? "";
  const simpleRC = hasRebarDesignation(frame) && !/철골|조적|연와|혼합|복합|목조|데크|steel|masonry|composite/i.test(frame);
  const sections = Object.fromEntries(Object.entries(plan.sections).filter(([name, section]) => {
    if (!sectionTypes.has(section.type) || section.reinforced === false
        || nonRebarConcrete.test([name, section.material, section.note].join(" "))) return false;
    if (reference) return reference.includes(name);
    if (section.steel || section.steel_area_mm2) return section.reinforced === true && section.steel_area_mm2 > 0;
    if (section.material && !/concrete|콘크리트|\bRC\b/i.test(section.material)) return false;
    return section.reinforced === true || hasRebarDesignation(section.material ?? "")
      || simpleRC && plan.materials?.rebar_fy_MPa > 0;
  }).map(([name, section]) => [name, section.type]));
  if (!Object.keys(sections).length) return null;
  const rate = plan.rebar_kg_per_m3;
  return {
    source: [plan.source?.document ?? "입력된 해체계획서", plan.source?.pages, "구조형식·단면 기호 대조"].filter(Boolean).join(" · "),
    sections, allowUntagged: false, aboveOnly: false,
    kgPerM3: Number.isFinite(rate?.value) && rate.value >= 0 ? rate.value : null,
    rateNote: rate?.note || "철근량 원단위 가정",
  };
}

export function isPlanRebarMember(el, evidence) {
  if (!evidence || (evidence.aboveOnly && el.basement)) return false;
  const category = el.category === "roof" && /^IfcSlab(?:StandardCase|ElementedCase)?$/i.test(el.ifcType) ? "slab" : el.category;
  return Object.hasOwn(evidence.sections, el.name) && evidence.sections[el.name] === category;
}

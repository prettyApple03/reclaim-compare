// 해체계획서 데이터(JSON, schema "reclaim-plan/1") → 구조체 부재 목록 → IFC 텍스트.
// 계획서의 구조도면(그리드, 부재 목록, 배치)을 옮긴 JSON만 있으면 Revit 없이 구조체 모델이 만들어진다.
// 좌표는 mm, y는 도면처럼 아래로 증가. 보·벽은 축에 나란한 선분만 지원한다.

const m = (mm) => mm / 1000;

// 계획서 → 상자 목록 [{kind, name, level, cx, cy, z, dx, dy, dz}] (m 단위, z는 바닥 높이)
export function planMembers(plan, { demolitionOnly = true } = {}) {
  const out = [], S = plan.sections, levels = plan.levels;
  const start = demolitionOnly && plan.demolition?.fromLevel ? Math.max(0, levels.findIndex((l) => l.name === plan.demolition.fromLevel)) : 0;
  const finish = plan.materials?.floor_finish;
  levels.forEach((lv, i) => {
    if (i < start) return;
    const lay = plan.layouts[lv.layout], z0 = lv.elevation, height = levels[i + 1] ? levels[i + 1].elevation - z0 : 0;
    const slabT = lay.slabs.length ? S[lay.slabs[0].s].t : 0;
    const add = (kind, name, cx, cy, z, dx, dy, dz, extra) => out.push({ kind, name, level: lv.name, cx: m(cx), cy: -m(cy), z: m(z), dx: m(dx), dy: m(dy), dz: m(dz), ...extra });
    const along = (o, width) => {
      const horizontal = o.y1 === o.y2, len = Math.abs(horizontal ? o.x2 - o.x1 : o.y2 - o.y1);
      return [(o.x1 + o.x2) / 2, (o.y1 + o.y2) / 2, horizontal ? len : width, horizontal ? width : len];
    };
    for (const o of lay.slabs) {
      const box = [(o.x1 + o.x2) / 2, (o.y1 + o.y2) / 2, 0, Math.abs(o.x2 - o.x1), Math.abs(o.y2 - o.y1)];
      add("slab", o.s, box[0], box[1], z0 - S[o.s].t, box[3], box[4], S[o.s].t, { roof: !height || lv.layout === "roof" });
      if (finish && height) add("finish", finish.material, box[0], box[1], z0, box[3], box[4], finish.thickness, { material: finish.material });
    }
    for (const o of lay.beams) {
      const [cx, cy, dx, dy] = along(o, S[o.s].b), drop = S[o.s].h - slabT; // 슬래브와 겹치는 부분은 뺀다
      add("beam", o.s, cx, cy, z0 - slabT - drop, dx, dy, drop);
    }
    if (!height) return;
    for (const o of lay.columns) add("column", o.s, o.x, o.y, z0, S[o.s].b, S[o.s].h, height);
    for (const o of lay.walls) { const [cx, cy, dx, dy] = along(o, S[o.s].t); add("wall", o.s, cx, cy, z0, dx, dy, height); }
  });
  return out;
}

// 종류별 부피(㎥) — 생성한 IFC의 검산과 계획서 폐기물량 비교에 쓴다
export function planVolumes(members) {
  const v = { column: 0, wall: 0, beam: 0, slab: 0, finish: 0 };
  for (const b of members) v[b.kind] += b.dx * b.dy * b.dz;
  return { ...v, structure: v.column + v.wall + v.beam + v.slab };
}

const B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
const IFC_TYPE = { column: "IFCCOLUMN", wall: "IFCWALLSTANDARDCASE", beam: "IFCBEAM", slab: "IFCSLAB", finish: "IFCCOVERING" };

export function planToIfc(plan, opts) {
  const members = planMembers(plan, opts), L = [];
  const add = (s) => { L.push(`#${L.length + 1}=${s};`); return `#${L.length}`; };
  const r = (x) => { const s = String(+x.toFixed(5)); return s.includes(".") ? s : s + "."; };
  let g = 0;
  const guid = () => { let n = ++g, s = ""; for (let i = 0; i < 21; i++) { s = B64[n % 64] + s; n = Math.floor(n / 64); } return `'0${s}'`; };

  const origin = add("IFCCARTESIANPOINT((0.,0.,0.))"), dirZ = add("IFCDIRECTION((0.,0.,1.))");
  const wcs = add(`IFCAXIS2PLACEMENT3D(${origin},$,$)`);
  const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,${wcs},$)`);
  const units = add(`IFCUNITASSIGNMENT((${add("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)")},${add("IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)")},${add("IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)")}))`);
  const project = add(`IFCPROJECT(${guid()},$,'ReClaim plan model',$,$,$,$,(${ctx}),${units})`);
  const place0 = add(`IFCLOCALPLACEMENT($,${wcs})`);
  const site = add(`IFCSITE(${guid()},$,'Site',$,$,${place0},$,$,.ELEMENT.,$,$,$,$,$)`);
  const building = add(`IFCBUILDING(${guid()},$,'Building',$,$,${place0},$,$,.ELEMENT.,$,$,$)`);
  add(`IFCRELAGGREGATES(${guid()},$,$,$,${project},(${site}))`);
  add(`IFCRELAGGREGATES(${guid()},$,$,$,${site},(${building}))`);
  const p2d = add(`IFCAXIS2PLACEMENT2D(${add("IFCCARTESIANPOINT((0.,0.))")},$)`);

  // IFC 문자열에는 한글을 그대로 넣지 않는다 (층·부재 이름은 영문·숫자)
  const concrete = add(`IFCMATERIAL('Concrete ${plan.materials?.concrete_fck_MPa ?? ""}MPa')`);
  const mats = new Map([["", { ref: concrete, els: [] }]]);
  const storeys = new Map(plan.levels.map((lv) => [lv.name, { ref: add(`IFCBUILDINGSTOREY(${guid()},$,'${lv.name}',$,$,${place0},$,$,.ELEMENT.,${r(m(lv.elevation))})`), els: [] }]));

  let tag = 0;
  for (const b of members) {
    const placement = add(`IFCLOCALPLACEMENT($,${add(`IFCAXIS2PLACEMENT3D(${add(`IFCCARTESIANPOINT((${r(b.cx)},${r(b.cy)},${r(b.z)}))`)},$,$)`)})`);
    const solid = add(`IFCEXTRUDEDAREASOLID(${add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,${p2d},${r(b.dx)},${r(b.dy)})`)},${wcs},${dirZ},${r(b.dz)})`);
    const rep = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${add(`IFCSHAPEREPRESENTATION(${ctx},'Body','SweptSolid',(${solid}))`)}))`);
    const extra = b.kind === "slab" ? `,.${b.roof ? "ROOF" : "FLOOR"}.` : b.kind === "finish" ? ",.FLOORING." : "";
    const el = add(`${IFC_TYPE[b.kind]}(${guid()},$,'${b.name}',$,$,${placement},${rep},'P${++tag}'${extra})`);
    storeys.get(b.level).els.push(el);
    const key = b.material || "";
    if (!mats.has(key)) mats.set(key, { ref: add(`IFCMATERIAL('${key}')`), els: [] });
    mats.get(key).els.push(el);
  }
  add(`IFCRELAGGREGATES(${guid()},$,$,$,${building},(${[...storeys.values()].map((s) => s.ref).join(",")}))`);
  for (const s of storeys.values()) if (s.els.length) add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${guid()},$,$,$,(${s.els.join(",")}),${s.ref})`);
  for (const mt of mats.values()) if (mt.els.length) add(`IFCRELASSOCIATESMATERIAL(${guid()},$,$,$,(${mt.els.join(",")}),${mt.ref})`);

  return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');\nFILE_NAME('plan.ifc','',(''),(''),'reclaim-compare','reclaim-compare','');\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n${L.join("\n")}\nENDSEC;\nEND-ISO-10303-21;\n`;
}

// 계획서의 현장·장비 조건 → 모델 입력값. 명시한 값을 우선하고, 없으면 해체공법 문구로 탑재 여부를 추정한다.
// demolition: { site: "wide"|"normal"|"tight"|"restricted", equipment: "large"|"small"|"mounted",
//               crane_days: 숫자, ground_floors: 지상 장비가 해체하는 하부 층수 }
export function planConditions(plan, { sites = {}, equipments = {} } = {}) {
  const d = plan?.demolition || {}, out = {}, notes = [];
  const number = (x) => Number.isFinite(x) && x >= 0 ? x : undefined;
  if (Object.hasOwn(equipments, d.equipment) && d.equipment !== "auto") { out.equipment = d.equipment; notes.push("장비 방식(계획서 값)"); }
  else if (/탑재|크레인/.test(d.method || "")) { out.equipment = "mounted"; notes.push(`장비 방식: 해체공법 "${d.method}"에서 탑재로 추정`); }
  if (Object.hasOwn(sites, d.site)) { out.site = d.site; notes.push("대지 조건(계획서 값)"); }
  else if (out.equipment === "mounted") { out.site = "tight"; notes.push("대지 조건: 탑재 방식이라 협소로 추정"); }
  if (number(d.crane_days) != null) out.craneDays = number(d.crane_days);
  if (number(d.ground_floors) != null) out.groundFloors = number(d.ground_floors);
  return { values: out, notes };
}

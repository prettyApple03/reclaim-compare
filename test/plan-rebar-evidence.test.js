import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planMembers } from "../assets/js/plan.js";
import { planRebarEvidence } from "../assets/js/rebar-evidence.js";
import { classifyElements, elementResults, quantitiesFromElements } from "../assets/js/classify.js";
import { compare, paramValues, streamTons } from "../assets/js/scenario.js";

const read = file => JSON.parse(readFileSync(new URL("../assets/data/" + file, import.meta.url)));
const rates = read("rates.json");
const p = paramValues(rates);
const near = (a, b, tol = 1e-7) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);
const element = (category, name, material, volume = 1, extra = {}) => ({
  category, name, volume, layers: material ? [{ name: material, thickness: 0 }] : [], area: 1, ...extra,
});
const classify = (es, evidence) => classifyElements(es, rates, {}, "aluminum", { rebarEvidence: evidence });

test("전후 동일한 KALIS 모델에서 계획서의 RC 부재를 복원하고 별도 모르타르와 매입 형강을 제외한다", () => {
  const expected = {
    "01-house.json": 44.3, "02-shops.json": 1263.4, "03-multifamily-transfer.json": 3125.4,
    "04-apartment.json": 2938.8, "05-office-above.json": 336.4, "06-office-below.json": 4654.2,
    "07-factory.json": 303.8,
  };
  for (const [file, volume] of Object.entries(expected)) {
    const plan = read("plans/kalis/" + file);
    const evidence = planRebarEvidence(plan, file);
    const es = planMembers(plan).map(b => element(b.roof ? "roof" : b.kind === "finish" ? "covering" : b.kind, b.name,
      b.material || "Concrete " + plan.materials.concrete_fck_MPa + "MPa", b.dx * b.dy * b.dz,
      { ifcType: b.kind === "slab" ? "IfcSlab" : null }));
    const q = quantitiesFromElements(classify(es, evidence), 100);
    near(q.planRebarConcrete_m3, volume, 0.15);
    near(q.rebarConcrete_m3, q.planRebarConcrete_m3);
    assert.equal(evidence.kgPerM3, plan.rebar_kg_per_m3.value);
    const { t, rebar } = streamTons({ ...q, rebarKgPerM3: evidence.kgPerM3 }, p);
    near(rebar, q.planRebarConcrete_m3 * evidence.kgPerM3 / 1000);
    near(t.concrete + t.metal, q.t.concrete + q.t.metal);
  }
});

test("다른 구조의 동명 부재, 혼합층, SRC 형강과 무근 재료를 계획서 RC 근거로 대체하지 않는다", () => {
  const file = "05-office-above.json", ev = planRebarEvidence(read("plans/kalis/" + file), file);
  const es = [
    element("column", "C2", "Concrete 21MPa"),
    element("column", "C2", "Steel SS400"), element("column", "C2", "unreinforced concrete"),
    element("column", "C2", "fiber-reinforced concrete"), element("column", "C2", "바닥난방 모르타르"),
    element("beam", "C2", "Concrete"), element("column", "C2", null),
    element("slab","S1","Concrete"), element("wall","W1","Concrete"),
    element("column","C2",null,1,{layers:[{name:"Concrete",thickness:0.1},{name:"Insulation",thickness:0.1}]}),
  ];
  const classified = classify(es, ev);
  assert.deepEqual(classified.map(e=>e.parts.some(part=>part.reinforced)), [true,false,false,false,false,false,false,false,false,false]);
});

test("논현 지상 RC 계획과 대응하는 무재료 주부재만 복원하고 범위 외 부재와 파사드를 남긴다", () => {
  const record = read("plan-validation.json").cases.find(row=>row.id === "nonhyeon-124-1");
  const ev = planRebarEvidence(null, null, record);
  assert.equal(planRebarEvidence(null, null, {...record, verified:false}), null);
  const es = [element("column","C1",null),element("beam","G3",null),element("wall","Core W1",null),
    element("column","C1",null,1,{basement:true}),element("wall","Parapet",null),element("plate","Stair tread",null),
    element("beam","C1",null),element("column","C1","Brick masonry")];
  const q = quantitiesFromElements(classify(es,ev),100);
  near(q.planRebarConcrete_m3,3);
  assert.equal(q.rebarConcrete_m3,3);
  near(quantitiesFromElements(classify(es,null),100).rebarConcrete_m3,0);
});

test("수동 RC 확인은 미확인 구조 콘크리트 부재에 매각수익을 귀속하고 무근·몰탈은 빼 둔다", () => {
  const es = [element("column","A","Concrete"), element("wall","B","Mortar"), element("slab","C","무근 콘크리트"), element("wall","D","블럭(시멘트블럭)")];
  const classified = classify(es,null);
  const raw = quantitiesFromElements(classified,100);
  near(raw.unverifiedRebarConcrete_m3,1);
  near(raw.masonry_m3,1);
  const q={...raw,rebarConcrete_m3:raw.unverifiedRebarConcrete_m3,rebarConcreteConfirmed:true,
    floors:1,site:"normal",labor:"paper",scope:"above",structure:"rc",height:6,transportCrush:0,transportSel:0};
  const cmp=compare(q,p);
  for (const mode of ["crush","selective"]) {
    const rows=elementResults(classified,p,0,q,mode,cmp[mode]);
    near(rows[0].revenue,cmp[mode].revenue);
    near(rows[1].revenue+rows[2].revenue,0);
  }
});

test("직접 입력한 계획서도 명시된 RC 단면과 실제 IFC 재료가 일치할 때 적용한다", () => {
  const plan={building:{structure:"철골조"},sections:{C1:{type:"column",material:"Reinforced concrete"},C2:{type:"column",material:"Steel"},W:{type:"wall"}}};
  const ev=planRebarEvidence(plan);
  assert.deepEqual(ev.sections,{C1:"column"});
  assert.equal(planRebarEvidence({...plan,sections:{W:{type:"wall"}}}),null);
  assert.equal(quantitiesFromElements(classify([element("column","C1","Concrete")],ev),100).planRebarConcrete_m3,1);
});

test("천마의 집 무근 바닥처럼 부재명에만 비구조 조건이 있어도 후보에서 제외하고 층별 확인값은 우선한다", () => {
  const names = ["1층 바닥(무근콘크리트 THK150) 구간2","버림 콘크리트","비구조 토핑","바닥 모르타르","Plain concrete slab"];
  const source = names.map(name => element("slab",name,"Concrete"));
  const taggedComposite=classifyElements([element("wall","외벽 1층 1","외벽(복합)")],rates,{},"aluminum",{verifiedStructuralConcrete:true});
  near(quantitiesFromElements(taggedComposite,100).rebarConcrete_m3,0);
  for (const options of [{}, { verifiedStructuralConcrete:true }]) {
    const es = classifyElements(source,rates,{},"aluminum",options);
    const q=quantitiesFromElements(es,100);
    near(q.concrete_m3,source.length);
    near(q.rebarConcrete_m3,0);
    near(q.unverifiedRebarConcrete_m3,0);
    const rows=elementResults(es,p,0,{...q,rebarConcreteConfirmed:true});
    near(rows.reduce((total,row)=>total+row.revenue,0),0);
  }
  const corrected = classifyElements(source.slice(0,1),rates,{},"aluminum",{
    layerOverrides: { "slab|Concrete": { Concrete:{material:"concrete",massKg:2400,reinforced:true} } },
  });
  near(quantitiesFromElements(corrected,100).rebarConcrete_m3,1);
  const noRebar=classifyElements([element("slab","S1","Reinforced concrete")],rates,{},"aluminum",{
    layerOverrides: { "slab|Reinforced concrete": { "Reinforced concrete":{massKg:2400,reinforced:false} } },
  });
  near(quantitiesFromElements(noRebar,100).rebarConcrete_m3,0);
  near(quantitiesFromElements(noRebar,100).unverifiedRebarConcrete_m3,0);
});

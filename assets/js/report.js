// 보고서 인쇄 · PDF: Revit의 RC-01, RC-02, RC-03 시트와 같은 구성을 A1 종이로 만든다.
// DOM을 쓰지 않는 순수 함수만 둔다 (HTML 문자열을 만든다).

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const won = (n) => `${Math.round(Number(n) || 0).toLocaleString("ko-KR")}원`;
const signedWon = (n) => `${n > 0 ? "+" : ""}${won(n)}`;
const tons = (n) => (Number(n) || 0).toFixed(3);

export const SHEET = {
  // 종이 (mm). RC-01은 세로, RC-02·03은 가로 A1
  portrait: { width: 594, height: 841 },
  landscape: { width: 841, height: 594 },
  margin: 12,          // 종이 가장자리 → 테두리
  band: 70,            // 하단 표제란 높이
};
export const MAX_COLUMNS = 4;
export const ROWS_PER_COLUMN = 90;   // Revit에서 한 열 높이(약 41cm)에 해당하는 행 수

// 표 행 수 → 세로 열 수 (1~4). 같은 열은 위아래로 나누지 않는다.
export const columnCount = (rows) => Math.max(1, Math.min(MAX_COLUMNS, Math.ceil(rows / ROWS_PER_COLUMN)));

// 행을 열마다 고르게 나눈다 (앞 열부터 채움).
export function splitColumns(rows, columns) {
  const per = Math.ceil(rows.length / columns) || 0;
  return Array.from({ length: columns }, (_, i) => rows.slice(i * per, (i + 1) * per));
}

// 열 하나의 높이에 맞춰 글자 크기(mm)를 정한다. Revit 일람표 본문 크기(약 2.5mm)를 넘지 않는다.
export function rowSize(rowsPerColumn, availableHeight) {
  const row = Math.min(4.2, availableHeight / Math.max(1, rowsPerColumn + 2));
  return { row, font: Math.max(1.2, Math.min(2.5, row * 0.62)) };
}

export function kstStamp(date = new Date()) {
  const k = new Date(date.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}:${p(k.getUTCSeconds())}`;
}

const projectName = (source) => String(source || "").replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "") || "ReClaim 모델";

function titleBlock({ number, heading, source, url, logo, stamp }) {
  return `<div class="rp-band">
    <div class="rp-cell rp-logo"><img src="${esc(logo)}" alt=""><span class="rp-url">${esc(url)}</span></div>
    <div class="rp-cell rp-project"><span class="rp-label">프로젝트 이름</span><strong class="rp-name">${esc(projectName(source))}</strong></div>
    <div class="rp-cell rp-meta">
      <strong class="rp-heading">${esc(heading)}</strong>
      <span class="rp-line">생성 일시 (KST)&nbsp;&nbsp;${esc(stamp)}</span>
      <span class="rp-line">소유자</span>
    </div>
    <div class="rp-cell rp-number">${esc(number)}</div>
  </div>`;
}

const recommended = (s) => ({ selective: "분별해체", crush: "압쇄해체", tie: "동일" })[s.recommended] ?? "판정 보류";

function rc01(ctx) {
  const s = ctx.summary;
  const area = s.area_m2 ? `${Number(s.area_m2).toLocaleString("ko-KR", { maximumFractionDigits: 1 })} m²` : "미입력";
  const rows = [
    ["일괄 압쇄", won(s.crush_total_won), true],
    ["전면 분별", won(s.selective_total_won), true],
    ["차액 (분별 − 압쇄)", signedWon(s.delta_won), true],
    ["분별이 더 저렴할 확률", `${(Number(s.p_selective_cheaper) * 100).toFixed(1)}%`, false],
    ["비교 결과", recommended(s), false],
  ];
  const unpriced = s.unpriced_concrete_cut?.length || Object.values(s.unpriced_disposal ?? {}).some((v) => v?.length);
  return `<section class="rp-sheet rp-portrait">
    <div class="rp-frame">
      <div class="rp-body rp-01">
        <div class="rp-box rp-title"><h1>RC-01&nbsp;&nbsp;해체 공법 경제성 비교</h1><p>${esc(s.source === "area" ? "면적 원단위 계산" : s.source)}&nbsp;&nbsp;·&nbsp;&nbsp;연면적 ${esc(area)}</p></div>
        <div class="rp-box"><h2>순비용 비교</h2>
          <table class="rp-compare"><thead><tr><th>항목</th><th>결과</th></tr></thead><tbody>
          ${rows.map(([label, value, amount]) => `<tr><td>${label}</td><td class="${amount ? "rp-amount" : ""}">${esc(value)}</td></tr>`).join("")}
          </tbody></table>
          <p class="rp-note">${ctx.elements.length ? `부재 ${ctx.elements.length.toLocaleString("ko-KR")}개 집계 · 부재별 결과는 RC-02 및 RC-03 참조` : "면적 원단위 계산 · 부재별 결과 없음"}</p>
        </div>
        <div class="rp-box rp-figure"><h2>해체 대상 3D</h2>
          ${ctx.modelPng ? `<img src="${ctx.modelPng}" alt="해체 대상 3D"><p class="rp-legend"><i style="background:#1baf7a"></i>분별해체 대상 <i style="background:#9c9084"></i>구조체와 함께 압쇄</p>` : `<p class="rp-empty">IFC 모델이 없어 3D 그림을 넣지 않았습니다.</p>`}
        </div>
        <div class="rp-box rp-figure"><h2>공법별 비용 구성</h2>
          ${ctx.chartPng ? `<img src="data:image/png;base64,${ctx.chartPng}" alt="공법별 비용 구성">` : `<p class="rp-empty">비용 그래프를 만들지 못했습니다.</p>`}
          ${unpriced ? `<p class="rp-note">일부 항목은 미산정 상태입니다.</p>` : ""}
        </div>
      </div>
      ${titleBlock({ ...ctx, source: ctx.summary.source, number: "RC-01", heading: "경제성 비교" })}
    </div>
  </section>`;
}

function methodSheet(ctx, { number, name, heading, rows, costs, net, scope, fields, unattributed }) {
  const page = SHEET.landscape;
  const columns = columnCount(rows.length);
  const parts = splitColumns(rows, columns);
  // 테두리 안 높이 − 표제란 − 머리 칸(약 72mm) − 합계 칸(14mm) − 여백
  const available = page.height - 2 * SHEET.margin - SHEET.band - 72 - 14 - 16;
  const size = rowSize(parts[0]?.length ?? 0, available);
  const total = fields.reduce((sum, field) => sum + field[3], 0);
  const cols = `<colgroup>${fields.map((field) => `<col style="width:${(field[3] / total * 100).toFixed(2)}%">`).join("")}</colgroup>`;
  const table = (part) => `<table class="rp-schedule">${cols}<thead>
      <tr><th colspan="${fields.length}" class="rp-schedule-title">${esc(name)}</th></tr>
      <tr>${fields.map(([label, , right]) => `<th${right ? ' class="r"' : ""}>${label}</th>`).join("")}</tr>
    </thead><tbody>${part.map((r) => `<tr>${fields.map(([, key, right]) => `<td${right ? ' class="r"' : ""}>${esc(r[key])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  return `<section class="rp-sheet rp-landscape">
    <div class="rp-frame">
      <div class="rp-body rp-method">
        <table class="rp-grid">
          <tr><td colspan="2" class="rp-sheet-title">${esc(name)}</td></tr>
          <tr><td class="rp-k">대상 IFC</td><td>${esc(ctx.summary.source)}</td></tr>
          <tr><td class="rp-k">건물 전체 처리비</td><td class="rp-k">건물 전체 매각수익</td></tr>
          <tr><td class="rp-big">${costs ? won(costs.disposal) : "자료 없음"}</td><td class="rp-big">${costs ? won(costs.revenue) : "자료 없음"}</td></tr>
          <tr><td colspan="2">${esc(scope)}</td></tr>
        </table>
        <div class="rp-columns" style="--rp-cols:${columns};--rp-row:${size.row.toFixed(2)}mm;--rp-font:${size.font.toFixed(2)}mm">
          ${parts.map(table).join("")}
        </div>
        <table class="rp-grid rp-total">
          ${unattributed ? `<tr><td class="rp-k">부재 미귀속 처리비 · 매각수익<br><span class="rp-hint">원단위 보충·수동 보정 등 부재에 연결할 수 없는 금액. 부재별 소계 + 미귀속 = 건물 전체</span></td><td>처리비 ${won(unattributed.disposal)} · 매각수익 ${won(unattributed.revenue)}</td></tr>` : ""}
          <tr><td class="rp-k">최종 합계 · 건물 전체 순비용</td><td class="rp-big">${won(net)}</td></tr>
        </table>
      </div>
      ${titleBlock({ ...ctx, source: ctx.summary.source, number, heading })}
    </div>
  </section>`;
}

const WASTE_ORDER = ["concrete", "masonry", "metal", "wood", "resin", "glass", "tile", "board", "panel", "mixed", "copper", "aluminum", "excluded"];

// Revit 일람표와 같이 성상 → 처리 방식 순으로 정렬한다. 금액이 없으면 '미산정'으로 표시한다.
export function scheduleRows(elements) {
  const order = (stream) => { const i = WASTE_ORDER.indexOf(stream); return i < 0 ? WASTE_ORDER.length : i; };
  const amount = (v) => (v == null || Number.isNaN(Number(v)) ? "미산정" : Math.round(v).toLocaleString("ko-KR"));
  return elements
    .filter((r) => r.category !== "adjustment")
    .map((r) => ({ ...r, tonsText: tons(r.tons), disposalText: amount(r.disposal), revenueText: amount(r.revenue) }))
    .sort((a, b) => order(a.stream) - order(b.stream) || String(a.method).localeCompare(String(b.method), "ko")
      || String(a.typeName).localeCompare(String(b.typeName), "ko"));
}

// ctx: { summary, elements / crushElements:[{category,categoryLabel,typeName,stream,streamLabel,method,tons,disposal,revenue}],
//        unattributed:{selective:{disposal,revenue},crush:{...}},
//        costs:{selective:{disposal,revenue},crush:{...}}, chartPng, modelPng, logo, url, stamp }
export function reportHtml(ctx) {
  const sheets = [rc01(ctx)];
  if (ctx.elements.length) {
    const label = (rows) => rows.map((r) => ({ ...r, waste: r.streamLabel ?? r.stream }));
        // [제목, 값, 오른쪽 정렬, Revit 열 너비 비율]
    const fields = [["범주", "categoryLabel", false, 13], ["패밀리 및 유형", "typeName", false, 32], ["폐기물 성상", "waste", false, 14],
      ["부재 처리 방식", "method", false, 15], ["중량(t)", "tonsText", true, 13],
      ["처리비(원)", "disposalText", true, 16], ["매각수익(원)", "revenueText", true, 16]];
    sheets.push(methodSheet(ctx, {
      number: "RC-02", name: "전면 분별 · 부재별 해체 결과", heading: "전면 분별",
      rows: label(scheduleRows(ctx.elements)), costs: ctx.costs?.selective, net: ctx.summary.selective_total_won,
      scope: "전면 분별 시나리오에서도 콘크리트 구조체 등은 압쇄 처리할 수 있습니다.",
      fields, unattributed: ctx.unattributed?.selective,
    }));
    sheets.push(methodSheet(ctx, {
      number: "RC-03", name: "일괄 압쇄 · 부재별 처리 및 중량", heading: "일괄 압쇄",
      rows: label(scheduleRows(ctx.crushElements ?? [])), costs: ctx.costs?.crush, net: ctx.summary.crush_total_won,
      scope: "일괄 압쇄의 마감재 처리비에는 입력 조건에 따른 선철거와 반출 경로를 반영합니다.",
      fields, unattributed: ctx.unattributed?.crush,
    }));
  }
  return sheets.join("");
}

// 브라우저에서 실제 높이를 재서, 표가 칸을 넘치면 행 높이와 글자를 줄인다.
export function fitSchedules(root) {
  for (const box of root.querySelectorAll(".rp-columns")) {
    for (let i = 0; i < 4; i++) {
      const tallest = Math.max(...[...box.querySelectorAll(".rp-schedule")].map((t) => t.offsetHeight));
      const room = box.clientHeight;
      if (!(tallest > room) || !room) break;
      const scale = (room / tallest) * 0.98;
      for (const name of ["--rp-row", "--rp-font"]) {
        const value = parseFloat(box.style.getPropertyValue(name));
        box.style.setProperty(name, `${(value * scale).toFixed(3)}mm`);
      }
    }
  }
}

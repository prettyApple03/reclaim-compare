import { streamTons } from "./scenario.js?v=salvage-20261123";

// Itemize revenue already deducted by the scenario. The underlying cost rows keep
// their negative sign; this ledger presents gross proceeds as positive amounts.
export function salvageLedger(q, p, result) {
  const { t, rebar, rebarAdded } = streamTons(q, p);
  const scrapRate = result.mode === "selective" ? p.rec_scrap_sel : p.rec_scrap_crush;
  const items = [];
  const record = (item, quantity, unit, unitPrice, amount) => {
    if (quantity > 0) items.push({ item, quantity, unit, unitPrice, amount });
  };
  for (const row of result.rows) {
    if (row.group !== "매각수익") continue;
    if (row.item !== "고철") {
      record(row.item, row.qty, row.unit, row.price, -row.amount);
      continue;
    }
    const structure = Math.min(Math.max(0, t.metal - rebar), q.structuralSteelTons ?? 0);
    const structuralSale = structure * (p.rec_structural_steel ?? p.rec_scrap_sel);
    const rebarSale = Math.min(t.metal - structure, Math.max(rebar, q.rebarModeledTons ?? 0)) * scrapRate;
    for (const [item, tons] of [
      ["철근", rebarSale], ["구조용 철골", structuralSale],
      ["기타 고철", Math.max(0, row.qty - rebarSale - structuralSale)],
    ]) record(item, tons, "t", row.price, tons * row.price);
  }
  let pendingRebar = null;
  if (!q.rebarConcreteConfirmed && q.unverifiedRebarConcrete_m3 > 0) {
    const expanded = streamTons({ ...q, rebarConcrete_m3: (q.rebarConcrete_m3 ?? 0) + q.unverifiedRebarConcrete_m3 }, p);
    const extraRebar = Math.max(0, expanded.rebarAdded - rebarAdded);
    const recoverableTons = extraRebar * scrapRate;
    if (extraRebar > 0) pendingRebar = { volume_m3: q.unverifiedRebarConcrete_m3, installed_t: extraRebar,
      sale_t: recoverableTons, price_won_per_t: p.price_scrap, gross_won: recoverableTons * p.price_scrap };
  }
  return { total_won: result.revenue, items, pending_rebar: pendingRebar };
}

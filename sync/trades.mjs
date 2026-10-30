// Flea market vs. trader buy-back prices for every item that has both.
// "Profit" = what the best trader pays minus the lowest current flea offer: buy on the flea, sell to the trader.

export function computeTrades({ items, tr, traderById }) {
  const rows = [];
  for (const it of Object.values(items)) {
    if (it.types?.includes("preset") || it.types?.includes("noFlea")) continue;
    if (!(it.lastLowPrice > 0)) continue;
    const sells = (it.sellToTrader ?? [])
      .filter((s) => s.priceRUB > 0)
      .sort((a, b) => b.priceRUB - a.priceRUB)
      .slice(0, 3)
      .map((s) => ({ trader: traderById.get(s.trader)?.name ?? s.trader, priceRUB: s.priceRUB, price: s.price, currency: s.currency }));
    if (!sells.length) continue;
    rows.push({
      id: it.id,
      name: tr.items(it.name, it.normalizedName),
      shortName: tr.items(it.shortName, ""),
      icon: it.iconLink ?? null,
      wiki: it.wikiLink ?? null,
      w: it.width ?? 1,
      h: it.height ?? 1,
      basePrice: it.basePrice ?? null, // input for the flea listing fee
      low: it.lastLowPrice,
      avg: it.avg24hPrice ?? null,
      offers: it.lastOfferCount ?? null,
      updated: it.updated ?? null,
      minLevel: it.minLevelForFlea ?? null,
      sells,
      profit: sells[0].priceRUB - it.lastLowPrice,
    });
  }
  rows.sort((a, b) => b.profit - a.profit);
  return rows;
}

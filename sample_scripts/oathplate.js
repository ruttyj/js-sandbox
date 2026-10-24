const geTools = importScope('geTools');


// Recipe ===============
// What one Oathplate piece takes.
const crushedShaleToMakePlate = 2520;
const shardToMakePlate = 450;

const quantityToMakePerPeice = {
  CrushedInfernalShale: crushedShaleToMakePlate,
  OathplateShards: shardToMakePlate
}

// Items ================
const OathplateShards = getOsrsItem('Oathplate shards');
const CrushedInfernalShale = getOsrsItem('Crushed infernal shale');
const OathplateChest = getOsrsItem('Oathplate chest');
const OathplateHelm = getOsrsItem('Oathplate helm');
const OathplateLegs = getOsrsItem('Oathplate legs');
const OthplateProducts = [OathplateChest, OathplateLegs, OathplateHelm];
const items = [CrushedInfernalShale, OathplateShards, ...OthplateProducts];

// Form =================
// The fields are refs: changing one redraws only the panels that read it, without re-running the code.
// The ingredient costs start at the live high prices; type your own to see what they'd make.
ui.heading('Oathplate calculator');
const shaleCost = ui.input.priceRef('Crushed shale cost (each)', { default: CrushedInfernalShale.highPrice, min: 0 });
const shardCost = ui.input.priceRef('Shard cost (each)', { default: OathplateShards.highPrice, min: 0 });
const PlatesToMakePerHour = ui.input.numberRef('Pieces per hour', { default: 4, min: 1, integer: true });
const sellPriceField = ui.input.selectRef('Sell products at', [
  { label: 'High price', value: 'highPrice' },
  { label: 'Low price', value: 'lowPrice' },
], { default: 'highPrice' });

ui.heading('Inventory & Target');
const piecesToMake = ui.input.numberRef('Oathplate pieces', { default: 1, min: 1, integer: true });
const shaleOwned = ui.input.numberRef('Shale already purchased', { default: 0, min: 0, integer: true });
const shardsOwned = ui.input.numberRef('Shards already purchased', { default: 0, min: 0, integer: true });

// Cost of one piece ====
const ingredientPrices = ui.computed(() => ({
  CrushedInfernalShale: shaleCost.value,
  OathplateShards: shardCost.value,
}));

const OathPlateCosts = ui.computed(() => MUL(ingredientPrices.value, quantityToMakePerPeice));
const OathPlateCost = ui.computed(() => SUM(OathPlateCosts.value));

// Profit per product ===
// Every product at that cost; the best one is the one with the most profit after tax.
const productResults = ui.computed(() => OthplateProducts.map(product => {
  const salePrice = product[sellPriceField.value];
  const tax = geTools.findTax(salePrice);
  const profit = salePrice - OathPlateCost.value - tax;
  return {
    product,
    salePrice,
    tax,
    cost: OathPlateCost.value,
    profit,
    profitPerHour: profit * PlatesToMakePerHour.value,
  };
}));

const best = ui.computed(() => {
  let top = productResults.value[0];
  for (const result of productResults.value) {
    if (result.profit > top.profit) {
      top = result;
    }
  }
  return top;
});

// Summary of the best ==
const perItem = ui.computed(() => ({
  item: best.value.product.name,
  salePrice: best.value.salePrice,
  costEach: OathPlateCost.value,
  quantity: {
    plates:    1,
    shards:    String(shardToMakePlate),
    shale:     String(crushedShaleToMakePlate),
  },
  costs: {
    items: OathPlateCosts.value,
    total: OathPlateCost.value,
  },
  breakEven: geTools.getBreakEvenPrice(OathPlateCost.value),
  profit: best.value.profit,
}));

const effectivePrices = ui.computed(() => ({
  ...ingredientPrices.value,
  SaleItem: best.value.salePrice,
}));

// Oathplate Ingredient Details
// @tags: PROFIT/HR
const summary = ui.computed(() => ({
  prices: formatValuesAsStrings(effectivePrices.value),
  hourly: MUL(PlatesToMakePerHour.value, perItem.value),
  each: perItem.value
}));

// Shopping list ========
// What's left to buy for the target number of pieces, after what's already owned.
const shoppingList = ui.computed(() => {
  const ingredients = [
    { item: CrushedInfernalShale, quantity: crushedShaleToMakePlate, price: shaleCost.value, owned: shaleOwned.value },
    { item: OathplateShards, quantity: shardToMakePlate, price: shardCost.value, owned: shardsOwned.value },
  ];
  return ingredients.map(ingredient => {
    const totalQuantity = ingredient.quantity * piecesToMake.value;
    const toBuy = Math.max(0, totalQuantity - ingredient.owned);
    return { ...ingredient, totalQuantity, toBuy, totalCost: toBuy * ingredient.price };
  });
});

// Results ==============
ui.stats(() => [
  { label: 'Best to make', value: best.value.product },
  { label: 'Cost per piece', value: OathPlateCost.value, type: 'price' },
  { label: 'Break-even sale', value: perItem.value.breakEven, type: 'price' },
  { label: 'Profit each', value: best.value.profit, type: 'signedPrice' },
  { label: 'Profit per hour', value: summary.value.hourly.profit, type: 'signedPrice' },
]);

ui.table(productResults, {
  title: 'All products',
  sortBy: 'Profit each',
  sortDir: 'desc',
  columns: [
    { label: 'Item', type: 'item', key: 'product' },
    { label: 'Sell at', type: 'price', key: 'salePrice' },
    { label: 'Tax', type: 'price', key: 'tax' },
    { label: 'Cost', type: 'price', key: 'cost' },
    { label: 'Profit each', type: 'signedPrice', key: 'profit' },
    { label: 'Profit / hr', type: 'signedPrice', key: 'profitPerHour' },
  ],
});

ui.table(shoppingList, {
  title: () => `Ingredients for ${piecesToMake.value} piece${piecesToMake.value === 1 ? '' : 's'}`,
  columns: [
    { label: 'Item', type: 'item', key: 'item' },
    { label: 'Per Piece', type: 'number', key: 'quantity' },
    { label: 'Total Qty', type: 'number', key: 'totalQuantity' },
    { label: 'Owned', type: 'number', key: 'owned' },
    { label: 'To Buy', type: 'number', key: 'toBuy' },
    { label: 'Each', type: 'price', key: 'price' },
    { label: 'Total Cost', type: 'price', key: 'totalCost', total: 'sum' },
  ],
});

// summary and profitPerHour are live outputs: the Values panel and importing scopes follow them.
return {
  summary,
  crushedShaleToMakePlate,
  shardToMakePlate,
  profitPerHour: ui.computed(() => summary.value.hourly.profit),
};

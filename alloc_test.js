// Quick test for allocateProportionalToCents
function allocateProportionalToCents(totalAmount, weights) {
  const totalCents = Math.round(Number(totalAmount) * 100);
  const weightNums = weights.map(w => Number(w) || 0);
  const weightSum = weightNums.reduce((s, v) => s + v, 0);

  if (totalCents === 0 || weightSum === 0) {
    return weights.map(() => (0).toFixed(2));
  }

  const exactShares = weightNums.map(w => (w / weightSum) * totalCents);
  const floorShares = exactShares.map(s => Math.floor(s));
  const fractions = exactShares.map((s, i) => ({ i, frac: s - floorShares[i] }));

  let assigned = floorShares.reduce((a, b) => a + b, 0);
  let remainder = totalCents - assigned;
  fractions.sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remainder; k++) {
    floorShares[fractions[k].i] += 1;
  }

  return floorShares.map(c => (c / 100).toFixed(2));
}

function sumStringsToFloat(arr) {
  return arr.reduce((s, v) => s + parseFloat(v), 0);
}

const cases = [
  { total: 1272.34, costs: [20.36,1179.99,71.99] },
  { total: 100.00, costs: [33,33,34] },
  { total: 100.00, costs: [33.33,33.33,33.34] },
  { total: 123.45, costs: [10,20,30,40] },
  { total: 0.01, costs: [0.005, 0.005] },
];

cases.forEach((c, i) => {
  const f = allocateProportionalToCents(c.total, c.costs);
  const s = sumStringsToFloat(f).toFixed(2);
  console.log(`case ${i+1}: total=${c.total} -> alloc=${JSON.stringify(f)} sum=${s}`);
});

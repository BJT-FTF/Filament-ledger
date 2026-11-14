#!/usr/bin/env node
/* Unit tests for Filament Ledger core math and data flows. */
const assert = require("assert");
const L = require("./app.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("  ok  " + name);
  } catch (err) {
    failed += 1;
    console.error("  FAIL " + name);
    console.error("       " + (err && err.stack ? err.stack : err));
  }
}

console.log("Filament Ledger logic tests\n");

test("$240 / 750 g = $0.32/g", () => {
  const cpg = L.costPerGram({ priceAUD: 240, netGrams: 750 });
  assert.strictEqual(cpg, 0.32);
  assert.strictEqual(L.roundMoney(cpg), 0.32);
});

test("145 g print costs $46.40", () => {
  const cost = L.printCost(145, L.costPerGram({ priceAUD: 240, netGrams: 750 }));
  assert.strictEqual(cost, 46.40);
  const manual = L.calculate({ priceAUD: 240, netGrams: 750, grams: 145 });
  assert.strictEqual(manual.cost, 46.40);
});

test("352 g print costs $112.64", () => {
  const cost = L.printCost(352, L.costPerGram({ priceAUD: 240, netGrams: 750 }));
  assert.strictEqual(cost, 112.64);
  const manual = L.calculate({ priceAUD: 240, netGrams: 750, grams: 352 });
  assert.strictEqual(manual.cost, 112.64);
});

test("AUD formatting includes 46.40 and 112.64", () => {
  const a = L.formatAUD(46.4);
  const b = L.formatAUD(112.64);
  assert.ok(a.includes("46.40"), a);
  assert.ok(b.includes("112.64"), b);
});

test("per-gram formatting shows $0.32/g", () => {
  const s = L.formatPerGram(0.32);
  assert.ok(s.includes("0.32"), s);
  assert.ok(s.endsWith("/g"), s);
});

test("add spool starts at full net weight and computes remainder value", () => {
  const state = L.emptyState();
  const spool = L.addSpool(state, {
    name: "PPA-CF Black",
    brand: "Bambu Lab",
    material: "PPA-CF",
    priceAUD: 240,
    netGrams: 750
  });
  assert.strictEqual(spool.remainingGrams, 750);
  assert.strictEqual(L.percentLeft(spool), 100);
  assert.strictEqual(L.remainingValue(spool), 240);
});

test("logging a print deducts grams and records cost", () => {
  const state = L.emptyState();
  const spool = L.addSpool(state, { name: "PPA-CF", material: "PPA-CF", priceAUD: 240, netGrams: 750 });
  const print = L.addPrint(state, { spoolId: spool.id, partName: "Test bracket", gramsUsed: 145, job: "Workshop" });
  assert.strictEqual(print.costAUD, 46.40);
  assert.strictEqual(spool.remainingGrams, 605);
  assert.strictEqual(L.formatPercent(L.percentLeft(spool)), "80.7%");
  assert.strictEqual(L.remainingValue(spool), 193.60);
});

test("deleting a print re-credits the spool", () => {
  const state = L.emptyState();
  const spool = L.addSpool(state, { name: "PPA-CF", material: "PPA-CF", priceAUD: 240, netGrams: 750 });
  const print = L.addPrint(state, { spoolId: spool.id, partName: "Bracket", gramsUsed: 145 });
  L.deletePrint(state, print.id);
  assert.strictEqual(spool.remainingGrams, 750);
  assert.strictEqual(state.prints.length, 0);
});

test("editing a print moves grams and recalculates cost", () => {
  const state = L.emptyState();
  const a = L.addSpool(state, { name: "A", material: "PPA-CF", priceAUD: 240, netGrams: 750 });
  const b = L.addSpool(state, { name: "B", material: "PETG", priceAUD: 40, netGrams: 1000 });
  const print = L.addPrint(state, { spoolId: a.id, partName: "Cap", gramsUsed: 145 });
  L.updatePrint(state, print.id, { spoolId: b.id, gramsUsed: 100, partName: "Cap v2" });
  assert.strictEqual(a.remainingGrams, 750);
  assert.strictEqual(b.remainingGrams, 900);
  assert.strictEqual(print.gramsUsed, 100);
  assert.strictEqual(print.costAUD, 4.00);
  assert.strictEqual(print.partName, "Cap v2");
  assert.strictEqual(print.material, "PETG");
});

test("adjust remaining records an audit entry", () => {
  const state = L.emptyState();
  const spool = L.addSpool(state, { name: "PPA-CF", material: "PPA-CF", priceAUD: 240, netGrams: 750 });
  L.addPrint(state, { spoolId: spool.id, partName: "Job", gramsUsed: 145 });
  const result = L.adjustRemaining(state, spool.id, 580, "Weighed after print");
  assert.strictEqual(spool.remainingGrams, 580);
  assert.strictEqual(result.adjustment.previousGrams, 605);
  assert.strictEqual(state.adjustments.length, 1);
});

test("low-spool warning at configurable 15%", () => {
  const state = L.emptyState();
  const spool = L.addSpool(state, { name: "Low", material: "PLA", priceAUD: 30, netGrams: 1000 });
  spool.remainingGrams = 150;
  assert.strictEqual(L.isLow(spool, 15), true);
  spool.remainingGrams = 151;
  assert.strictEqual(L.isLow(spool, 15), false);
  L.archiveSpool(state, spool.id, true);
  spool.remainingGrams = 10;
  assert.strictEqual(L.isLow(spool, 15), false);
});

test("failed prints still deduct filament and count in cost", () => {
  const state = L.emptyState();
  const spool = L.addSpool(state, { name: "PPA-CF", material: "PPA-CF", priceAUD: 240, netGrams: 750 });
  L.addPrint(state, { spoolId: spool.id, partName: "Failed clamp", gramsUsed: 145, success: false });
  const sum = L.summarize(state);
  assert.strictEqual(spool.remainingGrams, 605);
  assert.strictEqual(sum.failedGrams, 145);
  assert.strictEqual(sum.failedCost, 46.40);
  assert.strictEqual(sum.totalPrintCost, 46.40);
  assert.strictEqual(sum.totalGramsPrinted, 145);
});

test("summary totals spend, materials and jobs", () => {
  const state = L.emptyState();
  const ppa = L.addSpool(state, { name: "PPA", material: "PPA-CF", priceAUD: 240, netGrams: 750 });
  const petg = L.addSpool(state, { name: "PETG", material: "PETG", priceAUD: 40, netGrams: 1000 });
  L.addPrint(state, { spoolId: ppa.id, partName: "Bracket", gramsUsed: 145, job: "Workshop" });
  L.addPrint(state, { spoolId: petg.id, partName: "Enclosure", gramsUsed: 200, job: "Workshop" });
  const sum = L.summarize(state);
  assert.strictEqual(sum.totalSpend, 280);
  assert.strictEqual(sum.totalGramsPrinted, 345);
  assert.strictEqual(sum.totalPrintCost, 54.40);
  assert.strictEqual(sum.materialRows[0].material, "PPA-CF");
  assert.strictEqual(sum.materialRows[0].cost, 46.40);
  assert.strictEqual(sum.jobRows[0].job, "Workshop");
  assert.strictEqual(sum.jobRows[0].cost, 54.40);
  assert.strictEqual(sum.partRows.length, 2);
});

test("changing spool price recalculates historical print costs", () => {
  const state = L.emptyState();
  const spool = L.addSpool(state, { name: "PPA-CF", material: "PPA-CF", priceAUD: 240, netGrams: 750 });
  const print = L.addPrint(state, { spoolId: spool.id, partName: "Bracket", gramsUsed: 145 });
  L.updateSpool(state, spool.id, { priceAUD: 300 });
  assert.strictEqual(print.costAUD, 58);
});

test("delete spool unlinks but keeps print history", () => {
  const state = L.emptyState();
  const spool = L.addSpool(state, { name: "PPA-CF Black", brand: "Bambu Lab", material: "PPA-CF", priceAUD: 240, netGrams: 750 });
  const print = L.addPrint(state, { spoolId: spool.id, partName: "Bracket", gramsUsed: 145 });
  const result = L.deleteSpool(state, spool.id);
  assert.strictEqual(state.spools.length, 0);
  assert.strictEqual(result.unlinkedPrints, 1);
  assert.strictEqual(print.spoolId, "");
  assert.ok(print.spoolName.indexOf("PPA-CF Black") !== -1);
  assert.strictEqual(print.costAUD, 46.40);
});

test("JSON export/import replace and merge", () => {
  const a = L.emptyState();
  L.addSpool(a, { name: "One", material: "PLA", priceAUD: 30, netGrams: 1000, idSkip: true });
  const payload = L.exportPayload(a);
  assert.strictEqual(payload.app, "filament-ledger");
  const b = L.emptyState();
  L.addSpool(b, { name: "Two", material: "PETG", priceAUD: 40, netGrams: 1000 });
  const merged = L.importPayload(b, payload, "merge");
  assert.strictEqual(merged.spools.length, 2);
  const replaced = L.importPayload(b, payload, "replace");
  assert.strictEqual(replaced.spools.length, 1);
  assert.strictEqual(replaced.spools[0].name, "One");
});

test("CSV export includes cost and escapes quotes", () => {
  const state = L.emptyState();
  const spool = L.addSpool(state, { name: 'Roll "A"', material: "PPA-CF", priceAUD: 240, netGrams: 750 });
  L.addPrint(state, { spoolId: spool.id, partName: 'Part, "quoted"', gramsUsed: 145, notes: "line\nbreak" });
  const csv = L.exportPrintsCSV(state);
  assert.ok(csv.indexOf("Cost (AUD)") !== -1);
  assert.ok(csv.indexOf("46.40") !== -1);
  assert.ok(csv.indexOf('""quoted""') !== -1);
});

test("example spool is clearly labelled and matches known pricing", () => {
  const s = L.exampleSpool();
  assert.ok(/safe to delete/i.test(s.name));
  assert.strictEqual(s.priceAUD, 240);
  assert.strictEqual(s.netGrams, 750);
  assert.strictEqual(L.printCost(145, L.costPerGram(s)), 46.40);
});

test("invalid adjust and print inputs throw", () => {
  const state = L.emptyState();
  const spool = L.addSpool(state, { name: "X", material: "PLA", priceAUD: 30, netGrams: 1000 });
  assert.throws(() => L.adjustRemaining(state, spool.id, -1), /0 or more/);
  assert.throws(() => L.addPrint(state, { spoolId: spool.id, partName: "Y", gramsUsed: 0 }), /greater than 0/);
  assert.throws(() => L.addPrint(state, { spoolId: "missing", partName: "Y", gramsUsed: 10 }), /Choose a spool/);
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);

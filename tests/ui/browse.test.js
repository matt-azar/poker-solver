const assert = require("node:assert");
const fs = require("node:fs");
const vm = require("node:vm");

const context = {console};
vm.createContext(context);
vm.runInContext(fs.readFileSync("ui/browse.js", "utf8"), context);

const {groupHands, frequencyOf, shouldApply, nextGeneration} = context;

function cellOf(node, text) {
  const cell = groupHands(node).find((item) => item.text === text);
  assert.ok(cell, text);
  return cell;
}

const mixed = {
  reach_defined: true,
  actions: ["Check", "Bet 50", "Bet 100"],
  combos: ["AhAd"],
  marginal: [1],
  strategy: [[0.2, 0.3, 0.5]]
};
const mixedCell = cellOf(mixed, "AA");
assert.ok(Math.abs(frequencyOf(mixedCell, "aggression") - 0.8) < 1e-12);
assert.ok(Math.abs(frequencyOf(mixedCell, "0") - 0.2) < 1e-12);
assert.ok(Math.abs(frequencyOf(mixedCell, "1") - 0.3) < 1e-12);
assert.ok(Math.abs(frequencyOf(mixedCell, "2") - 0.5) < 1e-12);

const weighted = {
  reach_defined: true,
  actions: ["Check", "Bet 50", "Bet 100"],
  combos: ["AhAd", "AsAc"],
  marginal: [0.25, 0.75],
  strategy: [[0.2, 0.3, 0.5], [0, 0, 1]]
};
const weightedCell = cellOf(weighted, "AA");
assert.strictEqual(weightedCell.marginalSum, 1);
assert.ok(Math.abs(frequencyOf(weightedCell, "1") - 0.075) < 1e-12);
assert.ok(Math.abs(frequencyOf(weightedCell, "2") - 0.875) < 1e-12);
assert.ok(Math.abs(frequencyOf(weightedCell, "aggression") - 0.95) < 1e-12);

const checkOnly = {
  reach_defined: true,
  actions: ["Check"],
  combos: ["AhAd"],
  marginal: [1],
  strategy: [[1]]
};
assert.strictEqual(frequencyOf(cellOf(checkOnly, "AA"), "aggression"), 0);

const facing = {
  reach_defined: true,
  actions: ["Fold", "Call", "Raise 150"],
  combos: ["KhKd"],
  marginal: [1],
  strategy: [[0.1, 0.2, 0.7]]
};
const facingCell = cellOf(facing, "KK");
assert.ok(Math.abs(frequencyOf(facingCell, "aggression") - 0.7) < 1e-12);
assert.ok(Math.abs(frequencyOf(facingCell, "0") - 0.1) < 1e-12);
assert.ok(Math.abs(frequencyOf(facingCell, "1") - 0.2) < 1e-12);

const quiet = {
  reach_defined: true,
  actions: ["Check", "Bet 50"],
  combos: ["QsQh"],
  marginal: [0.4],
  strategy: [[1, 0]]
};
assert.strictEqual(frequencyOf(cellOf(quiet, "QQ"), "aggression"), 0);

const empty = {
  reach_defined: true,
  actions: ["Check", "Bet 50"],
  combos: ["JsJh"],
  marginal: [0],
  strategy: [[0.2, 0.8]]
};
assert.strictEqual(frequencyOf(cellOf(empty, "JJ"), "aggression"), null);
assert.strictEqual(frequencyOf(cellOf(empty, "JJ"), "1"), null);

const undefinedReach = {
  reach_defined: false,
  actions: ["Check", "Bet 50"],
  combos: ["TsTh"],
  marginal: null,
  strategy: [[0, 1]]
};
assert.strictEqual(frequencyOf(cellOf(undefinedReach, "TT"), "aggression"), null);

async function main() {
const renders = [];
const state = {token: 1, solutionId: "s1"};
let resolveOld;
const oldJson = new Promise((resolve) => {
  resolveOld = resolve;
});
const oldRead = (async () => {
  const body = await oldJson;
  if (!shouldApply(1, state.token, "s1", state.solutionId)) {
    return null;
  }
  return body;
})();
state.token = 2;
state.solutionId = "s2";
const newer = await (async () => {
  const body = await Promise.resolve({node: "new"});
  if (!shouldApply(2, state.token, "s2", state.solutionId)) {
    return null;
  }
  return body;
})();
renders.push(newer.node);
resolveOld({node: "old"});
const older = await oldRead;
if (older) {
  renders.push(older.node);
}
assert.deepStrictEqual(renders, ["new"]);

const errors = [];
const errorState = {token: 1, solutionId: "s1"};
let resolveError;
const errorJson = new Promise((resolve) => {
  resolveError = resolve;
});
const errorRead = (async () => {
  const body = await errorJson;
  if (!shouldApply(1, errorState.token, "s1", errorState.solutionId)) {
    return null;
  }
  return body;
})();
errorState.token = 2;
resolveError({error: "stale"});
const staleError = await errorRead;
if (staleError) {
  errors.push(staleError.error);
}
assert.deepStrictEqual(errors, []);

let seen = -1;
seen = nextGeneration({status_generation: 4}, seen);
assert.strictEqual(seen, 4);
assert.strictEqual(nextGeneration({status_generation: 3}, seen), null);
assert.strictEqual(nextGeneration({status_generation: 4}, seen), 4);

console.log("browse tests passed");
}

main();

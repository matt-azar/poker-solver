const assert = require("node:assert");
const fs = require("node:fs");
const vm = require("node:vm");

const context = {console};
vm.createContext(context);
vm.runInContext(fs.readFileSync("ui/browse.js", "utf8"), context);

const appSource = fs.readFileSync("ui/app.js", "utf8");
const historyBlock = appSource.match(/\/\* range-history \*\/([\s\S]*?)\/\* end-range-history \*\//);
assert.ok(historyBlock, "range-history helpers must exist in ui/app.js");
vm.runInContext(historyBlock[1], context);

const {
  groupHands,
  frequencyOf,
  groupEv,
  shouldApply,
  nextGeneration,
  solutionNeedsReload,
  createRangeHistory,
  snapshotWeights,
  cloneWeightGrid,
  snapshotsEqual,
  RANGE_HISTORY_LIMIT
} = context;

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

const split = {
  node_id: "n",
  reach_defined: true,
  actions: ["A", "B"],
  combos: ["AhKh", "AsKs"],
  marginal: [0.5, 0.5],
  strategy: [[1, 0], [0, 1]]
};
const splitValues = {
  node_id: "n",
  pending: false,
  ev_defined: [true, true],
  action_ev: [[10, 0], [0, 10]],
  value: [10, 10]
};
const splitEv = groupEv(split, splitValues, cellOf(split, "AKs"));
assert.ok(Math.abs(splitEv.mixed - 10) < 1e-12);
assert.ok(Math.abs(splitEv.action[0] - 5) < 1e-12);
assert.ok(Math.abs(splitEv.action[1] - 5) < 1e-12);

const zeroMass = {
  node_id: "n",
  reach_defined: true,
  actions: ["A", "B"],
  combos: ["AhKh", "AsKs"],
  marginal: [0, 0],
  strategy: [[1, 0], [0, 1]]
};
assert.strictEqual(groupEv(zeroMass, splitValues, cellOf(zeroMass, "AKs")), null);
assert.strictEqual(groupEv(split, Object.assign({}, splitValues, {pending: true}), cellOf(split, "AKs")), null);
assert.strictEqual(groupEv(Object.assign({}, split, {reach_defined: false}), splitValues, cellOf(split, "AKs")), null);

function blankGrid() {
  return Array.from({length: 13}, () => Array(13).fill(0));
}

function setCell(store, player, row, column, weight) {
  store[player][row][column] = weight;
}

function paintWithHistory(history, store, player, row, column, weight) {
  const before = snapshotWeights(store);
  setCell(store, player, row, column, weight);
  if (!snapshotsEqual(before, snapshotWeights(store))) {
    history.push(before);
  }
}

{
  const store = {oop: blankGrid(), ip: blankGrid()};
  const history = createRangeHistory(RANGE_HISTORY_LIMIT);
  setCell(store, "oop", 0, 0, 1);
  paintWithHistory(history, store, "oop", 0, 0, 0.5);
  assert.strictEqual(store.oop[0][0], 0.5);
  assert.ok(history.canUndo());
  const restored = history.undo(store);
  assert.ok(restored);
  store.oop = cloneWeightGrid(restored.oop);
  store.ip = cloneWeightGrid(restored.ip);
  assert.strictEqual(store.oop[0][0], 1);
  assert.ok(history.canRedo());
  const redone = history.redo(store);
  store.oop = cloneWeightGrid(redone.oop);
  store.ip = cloneWeightGrid(redone.ip);
  assert.strictEqual(store.oop[0][0], 0.5);
}

{
  const store = {oop: blankGrid(), ip: blankGrid()};
  const history = createRangeHistory(3);
  for (let i = 1; i <= 5; i++) {
    const before = snapshotWeights(store);
    setCell(store, "ip", 1, 1, i / 10);
    history.push(before);
  }
  assert.strictEqual(history.past.length, 3);
  assert.ok(!snapshotsEqual(history.past[0], history.past[1]));
}

{
  const store = {oop: blankGrid(), ip: blankGrid()};
  const history = createRangeHistory(RANGE_HISTORY_LIMIT);
  setCell(store, "oop", 2, 2, 1);
  const before = snapshotWeights(store);
  assert.ok(history.push(before));
  assert.strictEqual(history.push(before), false);
  assert.strictEqual(history.past.length, 1);
}

{
  const markup = fs.readFileSync("ui/index.html", "utf8");
  assert.ok(markup.includes('id="undo-range"'));
  assert.ok(markup.includes('id="redo-range"'));
}

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

const finished = {running: false, solution_id: "s1"};
assert.strictEqual(solutionNeedsReload(finished, "s1", true), true);
assert.strictEqual(solutionNeedsReload(finished, "s1", false), false);
assert.strictEqual(solutionNeedsReload(finished, "s2", false), true);
assert.strictEqual(solutionNeedsReload({running: true, solution_id: "s1"}, null, true), false);
assert.strictEqual(solutionNeedsReload({running: false, solution_id: null}, null, true), false);

console.log("browse tests passed");
}

main();

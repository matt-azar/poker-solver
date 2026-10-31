const ranks = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];
const order = "AKQJT98765432";
let latest = null;
let poll = null;
let solutionId = null;
let baselineSolutionId = null;
let continuationPending = false;
let nodeToken = 0;
let seenGeneration = -1;
let currentNode = null;
let riverExport = null;
let nodeValues = null;
let valueToken = 0;
let valuePoll = null;
let categoryToken = 0;
let selected = null;
let drag = null;

const weights = {oop: blank(), ip: blank()};

const $ = (id) => document.getElementById(id);

function blank() {
  return Array.from({length: 13}, () => Array(13).fill(0));
}

/* range-history */
const RANGE_HISTORY_LIMIT = 50;

function cloneWeightGrid(grid) {
  return grid.map((row) => row.slice());
}

function weightGridsEqual(left, right) {
  for (let row = 0; row < 13; row++) {
    for (let column = 0; column < 13; column++) {
      if (left[row][column] !== right[row][column]) {
        return false;
      }
    }
  }
  return true;
}

function snapshotWeights(store) {
  return {
    oop: cloneWeightGrid(store.oop),
    ip: cloneWeightGrid(store.ip)
  };
}

function snapshotsEqual(left, right) {
  return weightGridsEqual(left.oop, right.oop) && weightGridsEqual(left.ip, right.ip);
}

function createRangeHistory(limit) {
  const max = limit == null ? RANGE_HISTORY_LIMIT : limit;
  const past = [];
  const future = [];
  return {
    past,
    future,
    push(before) {
      const snap = {
        oop: cloneWeightGrid(before.oop),
        ip: cloneWeightGrid(before.ip)
      };
      const top = past[past.length - 1];
      if (top && snapshotsEqual(top, snap)) {
        return false;
      }
      past.push(snap);
      while (past.length > max) {
        past.shift();
      }
      future.length = 0;
      return true;
    },
    undo(current) {
      if (!past.length) {
        return null;
      }
      const previous = past.pop();
      future.push(snapshotWeights(current));
      return previous;
    },
    redo(current) {
      if (!future.length) {
        return null;
      }
      const next = future.pop();
      past.push(snapshotWeights(current));
      return next;
    },
    canUndo() {
      return past.length > 0;
    },
    canRedo() {
      return future.length > 0;
    }
  };
}
/* end-range-history */

const rangeHistory = createRangeHistory(RANGE_HISTORY_LIMIT);
let strokeBefore = null;

function sizes(text) {
  return text.split(",").map((part) => part.trim()).filter(Boolean).map(Number).filter((value) => !Number.isNaN(value));
}

function boardCards(text) {
  return text.split(/[\s,]+/).filter(Boolean);
}

function parseCard(text) {
  const raw = text.trim();
  if (raw.length < 2) {
    return null;
  }
  let rank = raw[0].toUpperCase();
  let suit = raw[raw.length - 1].toLowerCase();
  if (raw.toLowerCase().startsWith("10")) {
    rank = "T";
  }
  if (!order.includes(rank) || !"cdhs".includes(suit)) {
    return null;
  }
  return rank + suit;
}

function boardSet() {
  return new Set(boardCards($("board").value).map(parseCard).filter(Boolean));
}

function liveCombos(row, column, blocked) {
  const high = ranks[Math.min(row, column)];
  const low = ranks[Math.max(row, column)];
  const suits = ["c", "d", "h", "s"];
  let total = 0;
  let live = 0;
  if (row === column) {
    for (let i = 0; i < suits.length; i++) {
      for (let j = i + 1; j < suits.length; j++) {
        total += 1;
        const a = high + suits[i];
        const b = high + suits[j];
        if (!blocked.has(a) && !blocked.has(b)) {
          live += 1;
        }
      }
    }
    return {total, live};
  }
  const suited = row < column;
  for (const left of suits) {
    for (const right of suits) {
      if (suited ? left !== right : left === right) {
        continue;
      }
      total += 1;
      if (!blocked.has(high + left) && !blocked.has(low + right)) {
        live += 1;
      }
    }
  }
  return {total, live};
}

function pairName(row, column) {
  if (row === column) {
    return ranks[row] + ranks[column];
  }
  const high = Math.min(row, column);
  const low = Math.max(row, column);
  return ranks[high] + ranks[low] + (row < column ? "s" : "o");
}

function rangeText(grid) {
  const parts = [];
  for (let row = 0; row < 13; row++) {
    for (let column = 0; column < 13; column++) {
      const weight = grid[row][column];
      if (weight <= 0) {
        continue;
      }
      const name = pairName(row, column);
      parts.push(weight >= 0.999 ? name : name + ":" + trimWeight(weight));
    }
  }
  return parts.join(",");
}

function trimWeight(weight) {
  return String(Math.round(weight * 1000) / 1000);
}

function rankAt(text) {
  const index = order.indexOf(text.toUpperCase());
  if (index < 0) {
    throw new Error("bad rank");
  }
  return index;
}

function setPair(grid, rank, weight) {
  const index = rankAt(rank);
  grid[index][index] = weight;
}

function setSuited(grid, high, low, weight) {
  const left = rankAt(high);
  const right = rankAt(low);
  grid[Math.min(left, right)][Math.max(left, right)] = weight;
}

function setOffsuit(grid, high, low, weight) {
  const left = rankAt(high);
  const right = rankAt(low);
  grid[Math.max(left, right)][Math.min(left, right)] = weight;
}

function applyShape(grid, token, weight) {
  if (token.length === 2 && token[0] === token[1]) {
    setPair(grid, token[0], weight);
    return true;
  }
  if (token.length === 2) {
    setSuited(grid, token[0], token[1], weight);
    setOffsuit(grid, token[0], token[1], weight);
    return true;
  }
  if (token.length === 3 && token[2] === "s") {
    setSuited(grid, token[0], token[1], weight);
    return true;
  }
  if (token.length === 3 && token[2] === "o") {
    setOffsuit(grid, token[0], token[1], weight);
    return true;
  }
  return false;
}

function applyPlus(grid, token, weight) {
  if (token.length === 2 && token[0] === token[1]) {
    const start = rankAt(token[0]);
    for (let index = start; index >= 0; index--) {
      grid[index][index] = weight;
    }
    return true;
  }
  if (token.length < 2) {
    return false;
  }
  const shape = token.length === 3 ? token[2] : "";
  const high = rankAt(token[0]);
  const low = rankAt(token[1]);
  const begin = Math.max(high, low);
  const end = Math.min(high, low);
  for (let kicker = begin; kicker > end; kicker--) {
    if (kicker === high) {
      continue;
    }
    if (shape !== "o") {
      grid[Math.min(high, kicker)][Math.max(high, kicker)] = weight;
    }
    if (shape !== "s") {
      grid[Math.max(high, kicker)][Math.min(high, kicker)] = weight;
    }
  }
  return true;
}

function applySpan(grid, left, right, weight) {
  if (left.length === 2 && left[0] === left[1] && right.length === 2 && right[0] === right[1]) {
    const start = rankAt(left[0]);
    const end = rankAt(right[0]);
    for (let index = Math.min(start, end); index <= Math.max(start, end); index++) {
      grid[index][index] = weight;
    }
    return true;
  }
  const shape = left.length === 3 ? left[2] : "";
  const high = rankAt(left[0]);
  const from = rankAt(left[1]);
  const to = rankAt(right[1] || right[0]);
  for (let kicker = Math.min(from, to); kicker <= Math.max(from, to); kicker++) {
    if (kicker === high) {
      continue;
    }
    if (shape !== "o") {
      grid[Math.min(high, kicker)][Math.max(high, kicker)] = weight;
    }
    if (shape !== "s") {
      grid[Math.max(high, kicker)][Math.min(high, kicker)] = weight;
    }
  }
  return true;
}

function readText(player, text) {
  const grid = blank();
  text.split(",").map((part) => part.trim()).filter(Boolean).forEach((token) => {
    let weight = 1;
    const colon = token.indexOf(":");
    if (colon >= 0) {
      weight = Number(token.slice(colon + 1));
      token = token.slice(0, colon).trim();
    }
    if (!token || Number.isNaN(weight) || weight < 0) {
      return;
    }
    try {
      if (token === "random" || token === "*") {
        for (let row = 0; row < 13; row++) {
          for (let column = 0; column < 13; column++) {
            grid[row][column] = weight;
          }
        }
        return;
      }
      const dash = token.indexOf("-");
      if (dash > 0) {
        applySpan(grid, token.slice(0, dash), token.slice(dash + 1), weight);
        return;
      }
      if (token.endsWith("+")) {
        applyPlus(grid, token.slice(0, -1), weight);
        return;
      }
      applyShape(grid, token, weight);
    } catch (error) {
      return;
    }
  });
  weights[player] = grid;
}

function comboCount(player) {
  const blocked = boardSet();
  let count = 0;
  for (let row = 0; row < 13; row++) {
    for (let column = 0; column < 13; column++) {
      if (weights[player][row][column] <= 0) {
        continue;
      }
      count += liveCombos(row, column, blocked).live * Math.min(weights[player][row][column], 1);
    }
  }
  return count;
}

function paintCell(button, player, row, column, weight) {
  weights[player][row][column] = weight;
  button.classList.toggle("on", weight > 0);
  if (weight > 0) {
    const ink = 0.28 + 0.72 * Math.min(weight, 1);
    button.style.background = "rgba(36, 92, 52, " + ink + ")";
  } else {
    button.style.background = "";
  }
  $(player).value = rangeText(weights[player]);
  $(player + "-count").textContent = formatCount(comboCount(player));
}

function applyWeightSnapshot(snap) {
  weights.oop = cloneWeightGrid(snap.oop);
  weights.ip = cloneWeightGrid(snap.ip);
  $("oop").value = rangeText(weights.oop);
  $("ip").value = rangeText(weights.ip);
  drawPick("oop");
  drawPick("ip");
  syncRangeHistoryButtons();
}

function syncRangeHistoryButtons() {
  const undo = $("undo-range");
  const redo = $("redo-range");
  if (undo) {
    undo.disabled = !rangeHistory.canUndo();
  }
  if (redo) {
    redo.disabled = !rangeHistory.canRedo();
  }
}

function pushRangeSnapshot(before) {
  const changed = rangeHistory.push(before);
  syncRangeHistoryButtons();
  return changed;
}

function finishPaintStroke() {
  if (!strokeBefore) {
    return;
  }
  const before = strokeBefore;
  strokeBefore = null;
  if (!snapshotsEqual(before, snapshotWeights(weights))) {
    pushRangeSnapshot(before);
  }
}

function undoRangeEdit() {
  const previous = rangeHistory.undo(weights);
  if (!previous) {
    return;
  }
  applyWeightSnapshot(previous);
}

function redoRangeEdit() {
  const next = rangeHistory.redo(weights);
  if (!next) {
    return;
  }
  applyWeightSnapshot(next);
}

function formatCount(count) {
  return count.toFixed(1).replace(/\.0$/, "") + " combos";
}

function drawPick(player) {
  const root = $(player + "-pick");
  const blocked = boardSet();
  root.innerHTML = "";
  root.appendChild(axis(""));
  ranks.forEach((rank) => root.appendChild(axis(rank)));
  ranks.forEach((rank, row) => {
    root.appendChild(axis(rank));
    ranks.forEach((_, column) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cell";
      button.textContent = pairName(row, column);
      const live = liveCombos(row, column, blocked).live;
      const weight = weights[player][row][column];
      if (live === 0) {
        button.classList.add("blocked");
        button.disabled = true;
      } else if (weight > 0) {
        button.classList.add("on");
        const ink = 0.28 + 0.72 * Math.min(weight, 1);
        button.style.background = "rgba(36, 92, 52, " + ink + ")";
      }
      button.addEventListener("mousedown", (event) => {
        if (live === 0) {
          return;
        }
        event.preventDefault();
        const slider = Number($("weight").value) / 100;
        const next = slider <= 0 || Math.abs(weights[player][row][column] - slider) < 0.001 ? 0 : slider;
        if (!strokeBefore) {
          strokeBefore = snapshotWeights(weights);
        }
        drag = {player, weight: next};
        paintCell(button, player, row, column, next);
      });
      button.addEventListener("mouseenter", (event) => {
        if ((event.buttons & 1) === 0) {
          if (drag) {
            finishPaintStroke();
          }
          drag = null;
          return;
        }
        if (!drag || drag.player !== player || live === 0) {
          return;
        }
        paintCell(button, player, row, column, drag.weight);
      });
      root.appendChild(button);
    });
  });
  $(player + "-count").textContent = formatCount(comboCount(player));
}

function updateSpot() {
  const count = boardCards($("board").value).length;
  const names = {
    3: "Flop, turn, and river in one tree",
    4: "Turn and river in one tree",
    5: "River. The flop and the turn are already over"
  };
  $("spot").textContent = names[count] || "Use 3, 4, or 5 cards";
  $("flop-row").hidden = count !== 3;
  $("turn-row").hidden = count > 4;
  $("river-row").hidden = count > 4;
  $("donk-label").hidden = count > 4;
  $("pot-cap").parentElement.hidden = count > 4;
  $("no-three-bet").parentElement.hidden = count > 4;
  // Frozen is available on flop, turn, and river; threads>1 still require it.
  $("frozen").disabled = false;
  if ((count === 3 || count === 4 || count === 5) && !$("frozen").dataset.touched) {
    $("frozen").checked = true;
  }
  drawPick("oop");
  drawPick("ip");
}

document.addEventListener("mouseup", () => {
  if (drag || strokeBefore) {
    finishPaintStroke();
  }
  drag = null;
});

$("weight").addEventListener("input", () => {
  $("weight-label").textContent = $("weight").value + "%";
});

$("clear-ranges").addEventListener("click", () => {
  const before = snapshotWeights(weights);
  weights.oop = blank();
  weights.ip = blank();
  $("oop").value = "";
  $("ip").value = "";
  drawPick("oop");
  drawPick("ip");
  if (!snapshotsEqual(before, snapshotWeights(weights))) {
    pushRangeSnapshot(before);
  } else {
    syncRangeHistoryButtons();
  }
});

$("undo-range").addEventListener("click", () => {
  undoRangeEdit();
});

$("redo-range").addEventListener("click", () => {
  redoRangeEdit();
});

document.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  const mod = event.metaKey || event.ctrlKey;
  if (!mod) {
    return;
  }
  const target = event.target;
  const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
  if (typing && target.id !== "oop" && target.id !== "ip") {
    return;
  }
  if (key === "z" && !event.shiftKey) {
    event.preventDefault();
    undoRangeEdit();
    return;
  }
  if ((key === "z" && event.shiftKey) || key === "y") {
    event.preventDefault();
    redoRangeEdit();
  }
});

async function populateRangePresets() {
  const select = $("range-preset");
  if (!select) {
    return;
  }
  try {
    const response = await fetch("/api/ranges");
    if (!response.ok) {
      return;
    }
    const presets = await response.json();
    presets.forEach((entry) => {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.name || entry.id;
      select.appendChild(option);
    });
  } catch (error) {
    // Range presets are optional when the explorer has no configs/ranges tree.
  }
}

async function applySelectedRangePreset() {
  const id = $("range-preset").value;
  const player = $("range-preset-target").value === "ip" ? "ip" : "oop";
  if (!id) {
    $("message").textContent = "Choose a range preset first";
    return;
  }
  const response = await fetch("/api/ranges/" + encodeURIComponent(id));
  const body = await readBody(response);
  if (!response.ok) {
    $("message").textContent = body.error || "Range preset failed";
    return;
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  $(player).value = text;
  readText(player, text);
  drawPick(player);
  $("message").textContent = "Loaded range " + id + " into " + player.toUpperCase();
}

$("apply-range-preset").addEventListener("click", () => {
  applySelectedRangePreset().catch((error) => {
    $("message").textContent = error.message || "Range preset failed";
  });
});
populateRangePresets();

$("oop").addEventListener("input", () => {
  const before = snapshotWeights(weights);
  readText("oop", $("oop").value);
  drawPick("oop");
  if (!snapshotsEqual(before, snapshotWeights(weights))) {
    pushRangeSnapshot(before);
  }
});

$("ip").addEventListener("input", () => {
  const before = snapshotWeights(weights);
  readText("ip", $("ip").value);
  drawPick("ip");
  if (!snapshotsEqual(before, snapshotWeights(weights))) {
    pushRangeSnapshot(before);
  }
});

$("board").addEventListener("input", updateSpot);
$("frozen").addEventListener("change", () => {
  $("frozen").dataset.touched = "1";
});

$("setup").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("message").textContent = "Solving…";
  $("run").disabled = true;
  $("pause").disabled = false;
  $("stop").disabled = false;
  const body = {
    board: boardCards($("board").value),
    oop_range: $("oop").value,
    ip_range: $("ip").value,
    pot: Number($("pot").value),
    stack: Number($("stack").value),
    oop_bets: sizes($("oop-bets").value),
    ip_bets: sizes($("ip-bets").value),
    oop_flop_bets: sizes($("oop-flop").value),
    ip_flop_bets: sizes($("ip-flop").value),
    oop_turn_bets: sizes($("oop-turn").value),
    ip_turn_bets: sizes($("ip-turn").value),
    oop_river_bets: sizes($("oop-river").value),
    ip_river_bets: sizes($("ip-river").value),
    oop_donk: sizes($("oop-donk").value),
    pot_cap: Number($("pot-cap").value) || 0,
    allow_three_bet: $("no-three-bet").checked ? 0 : 1,
    geometric: $("geometric").checked ? 1 : 0,
    all_in_threshold: Number($("threshold").value) || 0,
    allow_all_in: $("all-in").checked ? 1 : 0,
    frozen: $("frozen").checked ? 1 : 0,
    accuracy: $("accuracy").value.trim() === "" ? -1 : Number($("accuracy").value),
    max_raises: Number($("max-raises").value),
    iterations: Number($("iterations").value),
    memory_mib: Number($("memory-mib").value),
    threads: Number($("threads").value),
    algorithm: $("algorithm").value,
    samples: Math.max(1, Math.min(20, Number($("samples").value) || 5))
  };
  const timeLimitText = $("time-limit").value.trim();
  if (timeLimitText !== "") {
    body.time_limit = Number(timeLimitText);
  }
  const response = await fetch("/api/solve", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body)
  });
  if (!response.ok && response.status !== 202) {
    const failed = await response.json().catch(() => ({error: response.statusText}));
    $("message").textContent = failed.error || "Solve failed";
    $("run").disabled = false;
    $("pause").disabled = true;
    $("stop").disabled = true;
    return;
  }
  if (poll) {
    clearInterval(poll);
  }
  poll = setInterval(refresh, 250);
  refresh();
});

$("continue").addEventListener("click", async () => {
  if (!solutionId) {
    return;
  }
  $("message").textContent = "Continuing…";
  $("run").disabled = true;
  $("continue").disabled = true;
  if ($("resolve-locked")) {
    $("resolve-locked").disabled = true;
  }
  $("pause").disabled = false;
  $("stop").disabled = false;
  const continueBody = {iterations: Number($("iterations").value)};
  const continueTimeLimit = $("time-limit").value.trim();
  if (continueTimeLimit !== "") {
    continueBody.time_limit = Number(continueTimeLimit);
  }
  const response = await fetch("/api/solutions/" + solutionId + "/continue", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(continueBody)
  });
  if (!response.ok && response.status !== 202) {
    const failed = await response.json().catch(() => ({error: response.statusText}));
    $("message").textContent = failed.error || "Continue failed";
    $("run").disabled = false;
    $("continue").disabled = false;
    if ($("resolve-locked")) {
      $("resolve-locked").disabled = !solutionId;
    }
    $("pause").disabled = true;
    $("stop").disabled = true;
    return;
  }
  dropDisplayedSolution();
  continuationPending = true;
  if (poll) {
    clearInterval(poll);
  }
  poll = setInterval(refresh, 250);
  refresh();
});

if ($("resolve-locked")) {
  $("resolve-locked").addEventListener("click", async () => {
    if (!solutionId) {
      return;
    }
    $("message").textContent = "Resolving with locks (reset + re-solve)…";
    $("run").disabled = true;
    $("continue").disabled = true;
    $("resolve-locked").disabled = true;
    $("pause").disabled = false;
    $("stop").disabled = false;
    const body = {iterations: Number($("iterations").value)};
    const timeLimitText = $("time-limit").value.trim();
    if (timeLimitText !== "") {
      body.time_limit = Number(timeLimitText);
    }
    const response = await fetch("/api/solutions/" + solutionId + "/resolve-locked", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body)
    });
    if (!response.ok && response.status !== 202) {
      const failed = await response.json().catch(() => ({error: response.statusText}));
      $("message").textContent = failed.error || "Resolve locked failed";
      $("run").disabled = false;
      $("continue").disabled = false;
      $("resolve-locked").disabled = false;
      $("pause").disabled = true;
      $("stop").disabled = true;
      return;
    }
    dropDisplayedSolution();
    continuationPending = true;
    if (poll) {
      clearInterval(poll);
    }
    poll = setInterval(refresh, 250);
    refresh();
  });
}

$("pause").addEventListener("click", async () => {
  await fetch("/api/pause", {method: "POST"});
  $("message").textContent = "Pausing after the current sample…";
});

$("stop").addEventListener("click", async () => {
  await fetch("/api/stop", {method: "POST"});
  $("message").textContent = "Stopping after the current sample…";
});

$("calculate-ev").addEventListener("click", () => {
  calculateEv();
});

$("save-solution").addEventListener("click", saveSolution);
$("open-solution").addEventListener("click", openSolution);
$("open-recent").addEventListener("click", openRecentSolution);
$("config-file").addEventListener("change", loadConfigFile);
refreshRecentSolutions();
$("load-template").addEventListener("click", loadSelectedTemplate);
populateTemplates();
$("compare-runouts").addEventListener("click", compareRunouts);
$("node-equity").addEventListener("click", calculateEquity);
$("node-categories").addEventListener("click", loadCategories);

$("export").addEventListener("click", () => {
  let payload = currentNode || riverExport;
  if (!payload) {
    return;
  }
  if (currentNode && nodeValues && !nodeValues.pending
      && nodeValues.node_id === currentNode.node_id
      && nodeValues.solution_id === currentNode.solution_id) {
    payload = Object.assign({}, currentNode, {values: nodeValues});
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type: "application/json"});
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = currentNode ? "node.json" : "strategy.json";
  link.click();
});

$("path").addEventListener("change", () => renderLines(riverExport || {}));
$("frequency").addEventListener("change", () => {
  if (currentNode && currentNode.kind === "decision") {
    renderNode(currentNode);
  }
});

async function refresh() {
  const response = await fetch("/api/status");
  const status = await response.json();
  const generation = nextGeneration(status, seenGeneration);
  if (generation === null) {
    return;
  }
  seenGeneration = generation;
  latest = status;
  if (status.running && solutionId) {
    dropDisplayedSolution();
  }
  render(status);
  if (solutionNeedsReload(status, solutionId, continuationPending)) {
    continuationPending = false;
    solutionId = status.solution_id;
    currentNode = null;
    riverExport = null;
    clearValues();
    if (status.root_node_id) {
      loadNode(status.root_node_id);
    } else {
      loadRiverExport();
    }
  }
  if (!status.running && poll) {
    clearInterval(poll);
    poll = null;
    $("run").disabled = false;
    $("pause").disabled = true;
    $("stop").disabled = true;
  }
  $("pause").disabled = !status.running;
  $("stop").disabled = !status.running;
  $("continue").disabled = Boolean(status.running) || !status.solution_id;
  if ($("resolve-locked")) {
    $("resolve-locked").disabled = Boolean(status.running) || !status.solution_id;
  }
  $("save-solution").disabled = Boolean(status.running) || !status.solution_id;
  $("export").disabled = !(currentNode || riverExport);
  baselineSolutionId = status.baseline_solution_id || null;
  if ($("show-baseline")) {
    $("show-baseline").textContent = baselineSolutionId || "—";
  }
  if (!status.running && baselineSolutionId && status.solution_id && currentNode) {
    refreshCompare(baselineSolutionId, status.solution_id, currentNode.node_id);
  } else if ($("compare-note")) {
    $("compare-note").hidden = true;
  }
}

async function readBody(response) {
  try {
    return await response.json();
  } catch (error) {
    return {error: response.statusText || "unreadable response"};
  }
}

function dropDisplayedSolution() {
  solutionId = null;
  currentNode = null;
  riverExport = null;
  nodeToken += 1;
  clearValues();
  $("export").disabled = true;
  $("node-actions").innerHTML = "";
  $("node-line").textContent = "";
  $("node-meta").textContent = "";
  drawGrid("oop-grid", [], "OOP");
  drawGrid("ip-grid", [], "IP");
  if ($("compare-note")) {
    $("compare-note").hidden = true;
  }
}

async function refreshCompare(baselineId, scenarioId, nodeId) {
  const note = $("compare-note");
  if (!note || !baselineId || !scenarioId || !nodeId) {
    return;
  }
  try {
    const response = await fetch(
      "/api/compare?baseline=" + encodeURIComponent(baselineId)
        + "&scenario=" + encodeURIComponent(scenarioId)
        + "&node_id=" + encodeURIComponent(nodeId)
    );
    const body = await readBody(response);
    if (!response.ok) {
      note.hidden = true;
      return;
    }
    note.hidden = false;
    note.textContent = "Compare " + baselineId + " → " + scenarioId
      + ": EV delta " + Number(body.value_delta).toFixed(4)
      + " (baseline " + Number(body.baseline_value).toFixed(4)
      + ", scenario " + Number(body.scenario_value).toFixed(4) + ")";
  } catch (error) {
    note.hidden = true;
  }
}

async function lockHand(handIndex, probs) {
  if (!solutionId || !currentNode || currentNode.kind !== "decision") {
    return;
  }
  const response = await fetch("/api/solutions/" + solutionId + "/locks", {
    method: "PUT",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      node_id: currentNode.node_id,
      kind: "selected",
      hand_indices: [handIndex],
      probs
    })
  });
  const body = await readBody(response);
  if (!response.ok) {
    $("message").textContent = body.error || "Lock failed";
    return;
  }
  $("message").textContent = "Locked hand index " + handIndex + " at " + currentNode.node_id;
}

async function unlockHand() {
  if (!solutionId || !currentNode) {
    return;
  }
  const response = await fetch(
    "/api/solutions/" + solutionId + "/locks?node_id=" + encodeURIComponent(currentNode.node_id),
    {method: "DELETE"}
  );
  const body = await readBody(response);
  if (!response.ok) {
    $("message").textContent = body.error || "Unlock failed";
    return;
  }
  $("message").textContent = "Unlocked " + currentNode.node_id;
}

function clearValues() {
  nodeValues = null;
  valueToken += 1;
  categoryToken += 1;
  if (valuePoll) {
    clearInterval(valuePoll);
    valuePoll = null;
  }
  const note = $("ev-note");
  if (note) {
    note.textContent = "";
  }
  const equity = $("equity-note");
  if (equity) {
    equity.textContent = "";
  }
  const categoriesNote = $("categories-note");
  if (categoriesNote) {
    categoriesNote.textContent = "";
  }
  const categories = $("categories");
  if (categories) {
    categories.innerHTML = "";
  }
  const runout = $("runout");
  if (runout) {
    runout.innerHTML = "";
  }
}

async function loadNode(nodeId) {
  clearValues();
  const token = ++nodeToken;
  const solution = solutionId;
  const response = await fetch("/api/solutions/" + solution + "/nodes/" + nodeId);
  const body = await readBody(response);
  if (!shouldApply(token, nodeToken, solution, solutionId)) {
    return;
  }
  if (!response.ok) {
    $("message").textContent = body.error || "Node request failed";
    return;
  }
  currentNode = body;
  riverExport = null;
  renderNode(currentNode);
  $("export").disabled = false;
}

async function loadRiverExport() {
  const token = ++nodeToken;
  const solution = solutionId;
  const response = await fetch("/api/solutions/" + solution + "/export");
  const body = await readBody(response);
  if (!shouldApply(token, nodeToken, solution, solutionId)) {
    return;
  }
  if (!response.ok) {
    $("message").textContent = body.error || "Export failed";
    return;
  }
  riverExport = body;
  currentNode = null;
  render(latest);
  $("export").disabled = false;
}

function render(status) {
  if (status.error) {
    $("message").textContent = status.error;
  } else if (status.running) {
    $("message").textContent = "Iteration " + status.iterations + (status.spot ? " · " + status.spot : "");
  } else if (status.paused) {
    $("message").textContent = "Paused at iteration " + status.iterations;
  } else if (status.cancelled) {
    $("message").textContent = "Stopped at iteration " + status.iterations;
  } else if (status.time_limit_reached) {
    $("message").textContent = "Time limit at iteration " + status.iterations;
  } else if (status.iterations > 0) {
    $("message").textContent = "Finished";
  }
  if (!status.iterations) {
    return;
  }
  $("summary").hidden = false;
  $("show-spot").textContent = status.spot || "";
  $("show-plays").textContent = status.plays || "";
  $("show-pot").textContent = status.pot;
  $("show-stack").textContent = status.stack;
  $("show-board").textContent = (status.board || []).join(" ");
  $("show-iterations").textContent = String(status.iterations);
  $("show-value").textContent = status.player0_expected_utility === null || status.player0_expected_utility === undefined
    ? "—"
    : Number(status.player0_expected_utility).toFixed(4);
  $("show-gap").textContent = status.nash_gap === null || status.nash_gap === undefined
    ? "—"
    : Number(status.nash_gap).toPrecision(4);
  const pot = Number(status.pot) || 1;
  $("show-fraction").textContent = status.nash_gap === null || status.nash_gap === undefined
    ? "—"
    : (Number(status.nash_gap) / pot).toPrecision(3);
  drawChart(status.gap_series || []);
  if (currentNode) {
    renderNode(currentNode);
    return;
  }
  const view = riverExport || {};
  drawGrid("oop-grid", view.oop_matrix || [], "OOP");
  drawGrid("ip-grid", view.ip_matrix || [], "IP");
  const path = $("path");
  const previous = path.value;
  path.innerHTML = "";
  (view.paths || []).forEach((item) => {
    const option = document.createElement("option");
    option.value = item;
    option.textContent = item;
    path.appendChild(option);
  });
  if ([...path.options].some((option) => option.value === previous)) {
    path.value = previous;
  }
  $("path-label").hidden = (view.paths || []).length === 0;
  $("tree").hidden = status.running || (view.paths || []).length === 0;
  $("node-actions").innerHTML = "";
  $("node-line").textContent = "";
  $("node-meta").textContent = "";
  $("calculate-ev").hidden = true;
  $("compare-runouts").hidden = true;
  $("node-equity").hidden = !riverExport;
  $("node-categories").hidden = !riverExport;
  if (!valuePoll) {
    $("ev-note").textContent = "";
  }
  if (riverExport) {
    loadCategories();
  }
  renderLines(view);
}

function renderNode(node) {
  $("tree").hidden = false;
  $("path-label").hidden = true;
  $("lines").innerHTML = "";
  $("node-line").textContent = (node.place ? node.place + " · " : "") + (node.line || "");
  const who = node.player === 0 ? "OOP" : node.player === 1 ? "IP" : "";
  $("node-meta").textContent = node.kind === "decision"
    ? who + (node.reach_defined ? "" : " · reach undefined")
    : node.kind === "terminal"
      ? (node.folded === null || node.folded === undefined ? "showdown" : "fold " + node.folded)
      : "deal a card";
  const host = $("node-actions");
  host.innerHTML = "";
  $("calculate-ev").hidden = node.kind !== "decision";
  $("compare-runouts").hidden = node.kind !== "chance";
  $("node-equity").hidden = false;
  const boardComplete = Array.isArray(node.board) && node.board.length === 5;
  $("node-categories").hidden = !boardComplete;
  if (!valuePoll) {
    $("ev-note").textContent = nodeValues && nodeValues.node_id === node.node_id && !nodeValues.pending
      ? evSummary(nodeValues)
      : "";
  }
  if (boardComplete) {
    loadCategories();
  }
  fillFrequency(node);
  if (node.kind === "decision") {
    node.actions.forEach((label, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => loadNode(node.children[index]));
      host.appendChild(button);
    });
    const matrix = matrixFromNode(node, $("frequency").value || "aggression");
    if (node.player === 0) {
      drawGrid("oop-grid", matrix, "OOP");
      drawGrid("ip-grid", [], "IP");
    } else {
      drawGrid("oop-grid", [], "OOP");
      drawGrid("ip-grid", matrix, "IP");
    }
  } else {
    drawGrid("oop-grid", [], "OOP");
    drawGrid("ip-grid", [], "IP");
  }
  (node.cards || []).forEach((choice) => {
    const button = document.createElement("button");
    button.type = "button";
    const weight = choice.weight === null || choice.weight === undefined ? "" : " " + Number(choice.weight).toFixed(3);
    button.textContent = choice.card + weight;
    button.addEventListener("click", () => loadNode(choice.child_id));
    host.appendChild(button);
  });
}

function fillFrequency(node) {
  const select = $("frequency");
  const label = $("frequency-label");
  if (!select || node.kind !== "decision") {
    if (label) {
      label.hidden = true;
    }
    return;
  }
  const previous = select.value || "aggression";
  const options = frequencyOptions(node);
  select.innerHTML = "";
  options.forEach((option) => {
    const item = document.createElement("option");
    item.value = option.id;
    item.textContent = option.label;
    select.appendChild(item);
  });
  if ([...select.options].some((option) => option.value === previous)) {
    select.value = previous;
  }
  label.hidden = false;
}

function matrixFromNode(node, mode) {
  return groupHands(node).map((cell) => ({
    ...cell,
    bet: frequencyOf(cell, mode || "aggression")
  }));
}

function frequencyLabel(mode, node) {
  const match = frequencyOptions(node).find((option) => option.id === mode);
  return match ? match.label : "Bet or raise";
}

function drawChart(series) {
  const svg = $("chart");
  $("chart-wrap").hidden = series.length === 0;
  if (series.length === 0) {
    return;
  }
  const maxGap = Math.max(...series.map((point) => point.nash_gap), 1e-9);
  const maxIter = Math.max(...series.map((point) => point.iterations), 1);
  const coords = series.map((point) => {
    const x = 40 + (point.iterations / maxIter) * 580;
    const y = 20 + (1 - point.nash_gap / maxGap) * 140;
    return x + "," + y;
  });
  svg.innerHTML = "<polyline fill='none' stroke='#1c1915' stroke-width='2' points='" + coords.join(" ") + "'/>";
}

function drawGrid(id, cells, player) {
  const root = $(id);
  root.innerHTML = "";
  const lookup = new Map(cells.map((cell) => [cell.row + ":" + cell.col, cell]));
  root.appendChild(axis(""));
  ranks.forEach((rank) => root.appendChild(axis(rank)));
  ranks.forEach((rank, row) => {
    root.appendChild(axis(rank));
    ranks.forEach((_, column) => {
      const cell = lookup.get(row + ":" + column);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cell";
      const name = cell ? cell.text : pairName(row, column);
      button.textContent = name;
      if (cell && (cell.range_combos > 0 || (cell.hands && cell.hands.length))) {
        button.classList.add("in-range");
        const bet = cell.bet === null || cell.bet === undefined ? 0 : cell.bet;
        button.style.background = "rgb(" + Math.round(236 - 180 * bet) + "," + Math.round(231 - 80 * bet) + "," + Math.round(220 - 160 * bet) + ")";
        button.addEventListener("click", () => showCell(player, cell, button));
      }
      if (selected && selected.player === player && selected.text === name) {
        button.classList.add("selected");
      }
      root.appendChild(button);
    });
  });
}

function axis(text) {
  const node = document.createElement("div");
  node.className = "axis";
  node.textContent = text;
  return node;
}

function formatChips(value) {
  return Number(value).toFixed(3);
}

function evSummary(values) {
  const nodeEv = values.node_ev_defined ? formatChips(values.node_ev) + " chips" : "undefined";
  return "Node EV " + nodeEv + ". Chips, root-centered, including earlier investments.";
}

function handEv(combo) {
  if (!nodeValues || !currentNode || nodeValues.pending || nodeValues.node_id !== currentNode.node_id) {
    return null;
  }
  const index = (nodeValues.combos || []).indexOf(combo);
  if (index < 0) {
    return null;
  }
  if (!nodeValues.ev_defined[index]) {
    return {defined: false};
  }
  return {
    defined: true,
    actions: nodeValues.action_ev[index],
    mixed: nodeValues.value[index]
  };
}

function showCell(player, cell, button) {
  selected = {player, text: cell.text};
  document.querySelectorAll("#oop-grid .cell.selected, #ip-grid .cell.selected").forEach((node) => node.classList.remove("selected"));
  button.classList.add("selected");
  paintDetail(player, cell);
}

function paintDetail(player, cell) {
  $("detail").hidden = false;
  $("detail-title").textContent = player + " " + cell.text;
  const frequency = cell.bet === null || cell.bet === undefined ? "undefined" : Number(cell.bet).toFixed(3);
  const mode = $("frequency") ? ($("frequency").value || "aggression") : "aggression";
  let text = cell.range_combos + " combos, " + frequencyLabel(mode, currentNode || {actions: []}) + " " + frequency;
  if (currentNode && nodeValues && !nodeValues.pending && nodeValues.node_id === currentNode.node_id) {
    const grouped = groupEv(currentNode, nodeValues, cell);
    if (!grouped) {
      text += ". Group EV undefined";
    } else {
      text += ". Group EV " + formatChips(grouped.mixed);
      (currentNode.actions || []).forEach((label, index) => {
        text += ". If " + label + " is forced, " + formatChips(grouped.action[index]);
      });
    }
  }
  $("detail-meta").textContent = text;
  const host = $("detail-hands");
  host.innerHTML = "";
  const nodeCombos = (currentNode && currentNode.combos) || [];
  (cell.hands || []).forEach((hand) => {
    const block = document.createElement("div");
    block.className = "mix";
    const title = document.createElement("strong");
    title.textContent = hand.combo;
    block.appendChild(title);
    const inputs = [];
    (hand.actions || []).forEach((action, actionIndex) => {
      const row = document.createElement("div");
      row.className = "line";
      const label = document.createElement("span");
      label.textContent = action.action;
      const probability = document.createElement("input");
      probability.type = "number";
      probability.min = "0";
      probability.max = "1";
      probability.step = "0.01";
      probability.value = Number(action.probability).toFixed(3);
      probability.style.width = "4.5rem";
      inputs[actionIndex] = probability;
      row.appendChild(label);
      row.appendChild(probability);
      block.appendChild(row);
    });
    const handIndex = nodeCombos.indexOf(hand.combo);
    if (solutionId && currentNode && currentNode.kind === "decision" && handIndex >= 0) {
      const controls = document.createElement("div");
      controls.className = "line";
      const lockButton = document.createElement("button");
      lockButton.type = "button";
      lockButton.textContent = "Lock";
      lockButton.addEventListener("click", () => {
        const probs = inputs.map((input) => Number(input.value));
        lockHand(handIndex, probs);
      });
      const unlockButton = document.createElement("button");
      unlockButton.type = "button";
      unlockButton.textContent = "Unlock";
      unlockButton.addEventListener("click", () => unlockHand(handIndex));
      controls.appendChild(lockButton);
      controls.appendChild(unlockButton);
      block.appendChild(controls);
    }
    const values = handEv(hand.combo);
    if (values && !values.defined) {
      const row = document.createElement("div");
      row.className = "line";
      row.textContent = "EV undefined";
      block.appendChild(row);
    } else if (values && values.defined) {
      (currentNode.actions || []).forEach((label, index) => {
        const row = document.createElement("div");
        row.className = "line";
        const name = document.createElement("span");
        name.textContent = label + " EV";
        const amount = document.createElement("span");
        amount.textContent = formatChips(values.actions[index]);
        row.appendChild(name);
        row.appendChild(amount);
        block.appendChild(row);
      });
      const mixed = document.createElement("div");
      mixed.className = "line";
      const name = document.createElement("span");
      name.textContent = "Mixed EV";
      const amount = document.createElement("span");
      amount.textContent = formatChips(values.mixed);
      mixed.appendChild(name);
      mixed.appendChild(amount);
      block.appendChild(mixed);
    }
    host.appendChild(block);
  });
}

async function calculateEv() {
  if (!currentNode || currentNode.kind !== "decision" || !solutionId) {
    return;
  }
  const token = ++valueToken;
  const solution = solutionId;
  const nodeId = currentNode.node_id;
  if (valuePoll) {
    clearInterval(valuePoll);
    valuePoll = null;
  }
  $("ev-note").textContent = "Calculating EVs…";
  const tick = async () => {
    let response;
    try {
      response = await fetch("/api/solutions/" + solution + "/nodes/" + nodeId + "/values");
    } catch (error) {
      if (!shouldApply(token, valueToken, solution, solutionId)) {
        return;
      }
      $("ev-note").textContent = "EV request failed";
      clearInterval(valuePoll);
      valuePoll = null;
      return;
    }
    const body = await readBody(response);
    if (!shouldApply(token, valueToken, solution, solutionId)) {
      return;
    }
    if (typeof body.status_generation === "number" && nextGeneration(body, seenGeneration) === null) {
      clearInterval(valuePoll);
      valuePoll = null;
      return;
    }
    if (body.pending) {
      $("ev-note").textContent = "Calculating EVs…";
      return;
    }
    if ((body.solution_id && body.solution_id !== solution) || (body.node_id && body.node_id !== nodeId)) {
      return;
    }
    if (!response.ok) {
      $("ev-note").textContent = body.error || "EV request failed";
      clearInterval(valuePoll);
      valuePoll = null;
      return;
    }
    nodeValues = body;
    clearInterval(valuePoll);
    valuePoll = null;
    if (currentNode) {
      renderNode(currentNode);
    }
    if (selected && currentNode) {
      const cell = groupHands(currentNode).find((item) => item.text === selected.text);
      if (cell) {
        paintDetail(selected.player, cell);
      }
    }
  };
  valuePoll = setInterval(tick, 250);
  tick();
}

function joinSizes(values) {
  return (values || []).map((value) => String(value)).join(", ");
}

async function refreshRecentSolutions() {
  const select = $("recent-solutions");
  if (!select) {
    return;
  }
  const previous = select.value;
  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose a recent file…";
  select.appendChild(placeholder);
  try {
    const response = await fetch("/api/recent-solutions");
    if (!response.ok) {
      return;
    }
    const recent = await response.json();
    recent.forEach((entry) => {
      const option = document.createElement("option");
      option.value = entry.path || "";
      option.textContent = entry.name || entry.path || "";
      select.appendChild(option);
    });
    if (previous) {
      select.value = previous;
    }
  } catch (error) {
    // Recent files are optional when the sidecar is unavailable.
  }
}

async function saveSolution() {
  if (!solutionId) {
    return;
  }
  const path = $("solution-path").value.trim();
  if (!path) {
    $("message").textContent = "Enter a solution file path";
    return;
  }
  const response = await fetch("/api/solutions/" + solutionId + "/save", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({path})
  });
  const body = await readBody(response);
  $("message").textContent = response.ok ? "Saved " + path : (body.error || "Save failed");
  if (response.ok) {
    await refreshRecentSolutions();
  }
}

async function openSolution() {
  const path = $("solution-path").value.trim();
  if (!path) {
    $("message").textContent = "Enter a solution file path";
    return;
  }
  const response = await fetch("/api/open", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({path})
  });
  const body = await readBody(response);
  if (!response.ok) {
    $("message").textContent = body.error || "Open failed";
    return;
  }
  seenGeneration = body.status_generation || seenGeneration;
  latest = body;
  solutionId = null;
  continuationPending = true;
  render(body);
  if (solutionNeedsReload(body, solutionId, continuationPending)) {
    continuationPending = false;
    solutionId = body.solution_id;
    currentNode = null;
    riverExport = null;
    clearValues();
    if (body.root_node_id) {
      loadNode(body.root_node_id);
    } else {
      loadRiverExport();
    }
  }
  $("message").textContent = "Opened " + path;
  $("save-solution").disabled = !body.solution_id;
  $("continue").disabled = !body.solution_id;
  await refreshRecentSolutions();
}

async function openRecentSolution() {
  const path = $("recent-solutions").value.trim();
  if (!path) {
    $("message").textContent = "Choose a recent file first";
    return;
  }
  $("solution-path").value = path;
  await openSolution();
}

async function applyConfigText(text, label) {
  const response = await fetch("/api/config", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({text})
  });
  const body = await readBody(response);
  if (!response.ok) {
    $("message").textContent = body.error || "Configuration failed";
    return;
  }
  $("board").value = (body.board || []).join(" ");
  const beforeRanges = snapshotWeights(weights);
  $("oop").value = body.oop_range || "";
  $("ip").value = body.ip_range || "";
  readText("oop", $("oop").value);
  readText("ip", $("ip").value);
  if (!snapshotsEqual(beforeRanges, snapshotWeights(weights))) {
    pushRangeSnapshot(beforeRanges);
  }
  $("pot").value = body.pot;
  $("stack").value = body.stack;
  $("max-raises").value = body.max_raises;
  $("all-in").checked = Boolean(body.allow_all_in);
  if (body.kind === "street") {
    $("oop-bets").value = joinSizes(body.oop_bets);
    $("ip-bets").value = joinSizes(body.ip_bets);
    $("oop-flop").value = joinSizes(body.oop_flop_bets);
    $("ip-flop").value = joinSizes(body.ip_flop_bets);
    $("oop-turn").value = joinSizes(body.oop_turn_bets);
    $("ip-turn").value = joinSizes(body.ip_turn_bets);
    $("oop-river").value = joinSizes(body.oop_river_bets);
    $("ip-river").value = joinSizes(body.ip_river_bets);
    $("oop-donk").value = joinSizes(body.oop_donk);
    $("pot-cap").value = body.pot_cap;
    $("no-three-bet").checked = body.allow_three_bet === false;
    $("geometric").checked = Boolean(body.geometric);
    $("threshold").value = body.all_in_threshold;
    $("memory-mib").value = body.memory_mib;
    $("threads").value = body.threads;
  } else {
    $("oop-bets").value = joinSizes(body.oop_bets);
    $("ip-bets").value = joinSizes(body.ip_bets);
  }
  updateSpot();
  $("message").textContent = "Loaded " + (label || (body.kind + " configuration"));
}

async function loadConfigFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) {
    return;
  }
  await applyConfigText(await file.text());
}

async function populateTemplates() {
  const select = $("template-select");
  if (!select) {
    return;
  }
  try {
    const response = await fetch("/api/templates");
    if (!response.ok) {
      return;
    }
    const templates = await response.json();
    templates.forEach((entry) => {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.name || entry.id;
      select.appendChild(option);
    });
  } catch (error) {
    // Templates are optional when the explorer has no configs/templates tree.
  }
}

async function loadSelectedTemplate() {
  const id = $("template-select").value;
  if (!id) {
    $("message").textContent = "Choose a template first";
    return;
  }
  const response = await fetch("/api/templates/" + encodeURIComponent(id));
  const body = await readBody(response);
  if (!response.ok) {
    $("message").textContent = body.error || "Template failed";
    return;
  }
  await applyConfigText(body.text, "template " + id);
}

function renderRunout(page) {
  const host = $("runout");
  if (!host) {
    return;
  }
  host.innerHTML = "";
  if (!page || page.pending) {
    return;
  }
  const note = document.createElement("p");
  note.textContent = "Runout EV is in chips, root-centered. OOP and IP are each player's own chips.";
  host.appendChild(note);
  const table = document.createElement("table");
  table.className = "runout";
  const head = document.createElement("tr");
  ["Card", "Probability", "OOP EV", "IP EV"].forEach((label, index) => {
    const cell = document.createElement("th");
    cell.textContent = label;
    cell.addEventListener("click", () => {
      const rows = [...page.cards];
      const key = ["card", "probability", "oop_ev", "ip_ev"][index];
      rows.sort((left, right) => {
        const a = left[key];
        const b = right[key];
        if (a === null || a === undefined) {
          return 1;
        }
        if (b === null || b === undefined) {
          return -1;
        }
        return a < b ? -1 : a > b ? 1 : 0;
      });
      renderRunout(Object.assign({}, page, {cards: rows}));
    });
    head.appendChild(cell);
  });
  table.appendChild(head);
  (page.cards || []).forEach((card) => {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = card.card;
    button.addEventListener("click", () => loadNode(card.child_id));
    name.appendChild(button);
    const probability = document.createElement("td");
    probability.textContent = card.probability_defined ? Number(card.probability).toFixed(4) : "undefined";
    const oop = document.createElement("td");
    oop.textContent = card.ev_defined ? formatChips(card.oop_ev) : "undefined";
    const ip = document.createElement("td");
    ip.textContent = card.ev_defined ? formatChips(card.ip_ev) : "undefined";
    row.appendChild(name);
    row.appendChild(probability);
    row.appendChild(oop);
    row.appendChild(ip);
    table.appendChild(row);
  });
  host.appendChild(table);
  if (page.parent_ev_defined) {
    const parent = document.createElement("p");
    parent.textContent = "Weighted parent EV  OOP " + formatChips(page.parent_oop_ev)
      + "  IP " + formatChips(page.parent_ip_ev);
    host.appendChild(parent);
  }
}

async function pollStudy(path, token, solution, nodeId, onReady) {
  if (valuePoll) {
    clearInterval(valuePoll);
    valuePoll = null;
  }
  const tick = async () => {
    let response;
    try {
      response = await fetch(path);
    } catch (error) {
      if (!shouldApply(token, valueToken, solution, solutionId)) {
        return;
      }
      $("ev-note").textContent = "Study request failed";
      clearInterval(valuePoll);
      valuePoll = null;
      return;
    }
    const body = await readBody(response);
    if (!shouldApply(token, valueToken, solution, solutionId)) {
      return;
    }
    if (body.pending) {
      return;
    }
    clearInterval(valuePoll);
    valuePoll = null;
    if (!response.ok) {
      $("ev-note").textContent = body.error || "Study request failed";
      return;
    }
    onReady(body);
  };
  valuePoll = setInterval(tick, 250);
  tick();
}

function compareRunouts() {
  if (!currentNode || currentNode.kind !== "chance" || !solutionId) {
    return;
  }
  const token = ++valueToken;
  const solution = solutionId;
  const nodeId = currentNode.node_id;
  $("ev-note").textContent = "Comparing runouts…";
  pollStudy(
    "/api/solutions/" + solution + "/nodes/" + nodeId + "/runouts",
    token,
    solution,
    nodeId,
    (body) => {
      $("ev-note").textContent = "Runout comparison uses the stored average strategy.";
      renderRunout(body);
    });
}

function calculateEquity() {
  if (!solutionId) {
    return;
  }
  const token = ++valueToken;
  const solution = solutionId;
  const nodeId = currentNode ? currentNode.node_id : "root";
  const path = currentNode
    ? "/api/solutions/" + solution + "/nodes/" + nodeId + "/equity"
    : "/api/solutions/" + solution + "/equity";
  $("equity-note").textContent = "Calculating check-down equity…";
  pollStudy(path, token, solution, nodeId, (body) => {
    if (!body.defined) {
      $("equity-note").textContent = "Check-down equity is undefined for this node.";
      return;
    }
    $("equity-note").textContent = "Check-down equity, fraction of the pot. OOP "
      + Number(body.oop_equity).toFixed(4) + " · IP " + Number(body.ip_equity).toFixed(4)
      + ". This is not chip EV.";
  });
}

function renderCategories(body) {
  const host = $("categories");
  const note = $("categories-note");
  if (!host || !note) {
    return;
  }
  host.innerHTML = "";
  if (!body.available) {
    note.textContent = body.reason || "Made-hand categories require a five-card board.";
    return;
  }
  note.textContent = "Made-hand categories on the current board (not draws). Fractions of each player's positive reach mass.";
  const names = body.categories || [];
  const table = document.createElement("table");
  table.className = "categories";
  const head = document.createElement("tr");
  ["Category", "OOP", "IP"].forEach((label) => {
    const th = document.createElement("th");
    th.textContent = label;
    head.appendChild(th);
  });
  table.appendChild(head);
  names.forEach((name, index) => {
    const oop = body.oop && body.oop.defined ? Number(body.oop.fractions[index] || 0) : null;
    const ip = body.ip && body.ip.defined ? Number(body.ip.fractions[index] || 0) : null;
    if ((oop === null || oop === 0) && (ip === null || ip === 0)) {
      return;
    }
    const row = document.createElement("tr");
    const label = document.createElement("td");
    label.textContent = name;
    row.appendChild(label);
    [oop, ip].forEach((value) => {
      const cell = document.createElement("td");
      if (value === null) {
        cell.textContent = "—";
      } else {
        const bar = document.createElement("span");
        bar.className = "bar";
        bar.style.width = Math.max(0, Math.min(1, value)) * 72 + "px";
        cell.appendChild(bar);
        cell.appendChild(document.createTextNode(" " + (value * 100).toFixed(1) + "%"));
      }
      row.appendChild(cell);
    });
    table.appendChild(row);
  });
  host.appendChild(table);
}

async function loadCategories() {
  if (!solutionId) {
    return;
  }
  const token = ++categoryToken;
  const solution = solutionId;
  const nodeId = currentNode ? currentNode.node_id : "root";
  const path = currentNode
    ? "/api/solutions/" + solution + "/nodes/" + nodeId + "/categories"
    : "/api/solutions/" + solution + "/categories";
  const note = $("categories-note");
  if (note) {
    note.textContent = "Loading made-hand categories…";
  }
  const response = await fetch(path);
  const body = await readBody(response);
  if (!shouldApply(token, categoryToken, solution, solutionId)) {
    return;
  }
  if (!response.ok) {
    if (note) {
      note.textContent = body.error || "Category request failed";
    }
    return;
  }
  renderCategories(body);
}

function lineOf(infoset) {
  const parts = infoset.split(" | ");
  return parts.slice(1).join(" | ");
}

function renderLines(status) {
  const host = $("lines");
  if (!host || !status) {
    return;
  }
  host.innerHTML = "";
  const path = $("path").value;
  const grouped = new Map();
  (status.entries || []).forEach((entry) => {
    if (lineOf(entry.infoset) !== path) {
      return;
    }
    if (!grouped.has(entry.infoset)) {
      grouped.set(entry.infoset, []);
    }
    grouped.get(entry.infoset).push(entry);
  });
  grouped.forEach((actions, infoset) => {
    const block = document.createElement("div");
    block.className = "mix";
    const title = document.createElement("strong");
    title.textContent = infoset;
    block.appendChild(title);
    actions.forEach((action) => {
      const row = document.createElement("div");
      row.className = "line";
      const label = document.createElement("span");
      label.textContent = action.action;
      const probability = document.createElement("span");
      probability.textContent = Number(action.probability).toFixed(3);
      row.appendChild(label);
      row.appendChild(probability);
      block.appendChild(row);
    });
    host.appendChild(block);
  });
}

readText("oop", $("oop").value);
readText("ip", $("ip").value);
updateSpot();
syncRangeHistoryButtons();
refresh();

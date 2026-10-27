const ranks = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];
const order = "AKQJT98765432";
let latest = null;
let poll = null;
let selected = null;
let drag = null;

const weights = {oop: blank(), ip: blank()};

const $ = (id) => document.getElementById(id);

function blank() {
  return Array.from({length: 13}, () => Array(13).fill(0));
}

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
        drag = {player, weight: next};
        paintCell(button, player, row, column, next);
      });
      button.addEventListener("mouseenter", (event) => {
        if ((event.buttons & 1) === 0) {
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
  $("frozen").disabled = count === 5;
  if (count === 5) {
    $("frozen").checked = false;
  } else if ((count === 3 || count === 4) && !$("frozen").dataset.touched) {
    $("frozen").checked = true;
  }
  drawPick("oop");
  drawPick("ip");
}

document.addEventListener("mouseup", () => {
  drag = null;
});

$("weight").addEventListener("input", () => {
  $("weight-label").textContent = $("weight").value + "%";
});

$("clear-ranges").addEventListener("click", () => {
  weights.oop = blank();
  weights.ip = blank();
  $("oop").value = "";
  $("ip").value = "";
  drawPick("oop");
  drawPick("ip");
});

$("oop").addEventListener("input", () => {
  readText("oop", $("oop").value);
  drawPick("oop");
});

$("ip").addEventListener("input", () => {
  readText("ip", $("ip").value);
  drawPick("ip");
});

$("board").addEventListener("input", updateSpot);
$("frozen").addEventListener("change", () => {
  $("frozen").dataset.touched = "1";
});

$("setup").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("message").textContent = "Solving…";
  $("run").disabled = true;
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
    samples: 5
  };
  const response = await fetch("/api/solve", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body)
  });
  if (!response.ok && response.status !== 202) {
    const failed = await response.json().catch(() => ({error: response.statusText}));
    $("message").textContent = failed.error || "Solve failed";
    $("run").disabled = false;
    $("stop").disabled = true;
    return;
  }
  if (poll) {
    clearInterval(poll);
  }
  poll = setInterval(refresh, 250);
  refresh();
});

$("stop").addEventListener("click", async () => {
  await fetch("/api/stop", {method: "POST"});
  $("message").textContent = "Stopping after the current sample…";
});

$("export").addEventListener("click", () => {
  if (!latest) {
    return;
  }
  const blob = new Blob([JSON.stringify(latest, null, 2)], {type: "application/json"});
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "strategy.json";
  link.click();
});

$("path").addEventListener("change", () => renderLines(latest));

async function refresh() {
  const response = await fetch("/api/status");
  const status = await response.json();
  latest = status;
  render(status);
  if (!status.running && poll) {
    clearInterval(poll);
    poll = null;
    $("run").disabled = false;
    $("stop").disabled = true;
    $("export").disabled = !status.entries;
  }
}

function render(status) {
  if (status.error) {
    $("message").textContent = status.error;
  } else if (status.running) {
    $("message").textContent = "Iteration " + status.iterations + (status.spot ? " · " + status.spot : "");
  } else if (status.cancelled) {
    $("message").textContent = "Stopped at iteration " + status.iterations;
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
  $("show-value").textContent = Number(status.player0_expected_utility).toFixed(4);
  $("show-gap").textContent = Number(status.nash_gap).toPrecision(4);
  const pot = Number(status.pot) || 1;
  $("show-fraction").textContent = (Number(status.nash_gap) / pot).toPrecision(3);
  drawChart(status.gap_series || []);
  drawGrid("oop-grid", status.oop_matrix || [], "OOP");
  drawGrid("ip-grid", status.ip_matrix || [], "IP");
  const path = $("path");
  const previous = path.value;
  path.innerHTML = "";
  (status.paths || []).forEach((item) => {
    const option = document.createElement("option");
    option.value = item;
    option.textContent = item;
    path.appendChild(option);
  });
  if ([...path.options].some((option) => option.value === previous)) {
    path.value = previous;
  }
  $("tree").hidden = (status.paths || []).length === 0;
  renderLines(status);
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
        const bet = cell.bet || 0;
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

function showCell(player, cell, button) {
  selected = {player, text: cell.text};
  document.querySelectorAll("#oop-grid .cell.selected, #ip-grid .cell.selected").forEach((node) => node.classList.remove("selected"));
  button.classList.add("selected");
  $("detail").hidden = false;
  $("detail-title").textContent = player + " " + cell.text;
  $("detail-meta").textContent = cell.range_combos + " combos in range, open bet frequency " + Number(cell.bet).toFixed(3);
  const host = $("detail-hands");
  host.innerHTML = "";
  (cell.hands || []).forEach((hand) => {
    const block = document.createElement("div");
    block.className = "mix";
    const title = document.createElement("strong");
    title.textContent = hand.combo;
    block.appendChild(title);
    (hand.actions || []).forEach((action) => {
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

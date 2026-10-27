const ranks = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];
let latest = null;
let poll = null;
let selected = null;

const $ = (id) => document.getElementById(id);

function sizes(text) {
  return text.split(",").map((part) => Number(part.trim())).filter((value) => !Number.isNaN(value));
}

function boardCards(text) {
  return text.split(/[\s,]+/).filter(Boolean);
}

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
    iterations: Number($("iterations").value),
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
  link.download = "river-strategy.json";
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
    $("message").textContent = "Iteration " + status.iterations;
  } else if (status.cancelled) {
    $("message").textContent = "Stopped at iteration " + status.iterations;
  } else if (status.iterations > 0) {
    $("message").textContent = "Finished";
  }
  if (!status.iterations) {
    return;
  }
  $("summary").hidden = false;
  $("show-pot").textContent = status.pot;
  $("show-stack").textContent = status.stack;
  $("show-board").textContent = (status.board || []).join(" ");
  $("show-iterations").textContent = String(status.iterations);
  $("show-value").textContent = Number(status.player0_expected_utility).toFixed(4);
  $("show-gap").textContent = Number(status.nash_gap).toPrecision(4);
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

function pairName(row, column) {
  if (row === column) {
    return ranks[row] + ranks[column];
  }
  const high = Math.min(row, column);
  const low = Math.max(row, column);
  return ranks[high] + ranks[low] + (row < column ? "s" : "o");
}

function showCell(player, cell, button) {
  selected = {player, text: cell.text};
  document.querySelectorAll(".cell.selected").forEach((node) => node.classList.remove("selected"));
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
      row.innerHTML = "<span>" + action.action + "</span><span>" + Number(action.probability).toFixed(3) + "</span>";
      block.appendChild(row);
    });
    host.appendChild(block);
  });
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
    const parts = entry.infoset.split(" | ");
    if (parts[1] !== path) {
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
      row.innerHTML = "<span>" + action.action + "</span><span>" + Number(action.probability).toFixed(3) + "</span>";
      block.appendChild(row);
    });
    host.appendChild(block);
  });
}

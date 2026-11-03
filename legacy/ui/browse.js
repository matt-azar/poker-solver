const browseRanks = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];

function isAggressive(label) {
  return label.startsWith("Bet") || label.startsWith("Raise");
}

function foldActionIndex(actions) {
  if (!actions) {
    return -1;
  }
  return actions.findIndex((label) => label === "Fold");
}

// Local EV treats chips already invested as sunk cost (fold → 0). Engine payloads
// stay root_centered; pass basis "root_centered" to keep global chips.
function withEvBasis(values, basis, actionLabels) {
  const mode = basis || "local";
  if (!values || values.pending || mode === "root_centered") {
    return values;
  }
  if (values.utility_basis === "local") {
    return values;
  }
  const actions = actionLabels || values.actions || [];
  const foldIdx = foldActionIndex(actions);
  const offset = Number(values.local_offset || 0);
  const actionEv = (values.action_ev || []).map((row, hand) => {
    if (!row || !values.ev_defined || !values.ev_defined[hand]) {
      return row;
    }
    const baseline = foldIdx >= 0 ? Number(row[foldIdx] || 0) : -offset;
    return row.map((entry) =>
      entry === null || entry === undefined || Number.isNaN(Number(entry))
        ? entry
        : Number(entry) - baseline);
  });
  const mixed = (values.value || []).map((entry, hand) => {
    if (!values.ev_defined || !values.ev_defined[hand]
        || entry === null || entry === undefined || Number.isNaN(Number(entry))) {
      return entry;
    }
    const row = values.action_ev && values.action_ev[hand];
    const baseline = foldIdx >= 0 && row
      ? Number(row[foldIdx] || 0)
      : -offset;
    return Number(entry) - baseline;
  });
  const nodeEv = values.node_ev === null || values.node_ev === undefined
      || Number.isNaN(Number(values.node_ev))
    ? values.node_ev
    : Number(values.node_ev) + offset;
  return Object.assign({}, values, {
    utility_basis: "local",
    action_ev: actionEv,
    value: mixed,
    node_ev: nodeEv
  });
}

function frequencyOptions(node) {
  const options = [{id: "aggression", label: "Bet or raise"}];
  (node.actions || []).forEach((label, index) => {
    options.push({id: String(index), label});
  });
  return options;
}

function shouldApply(token, nodeToken, solution, solutionId) {
  return token === nodeToken && solution === solutionId;
}

function nextGeneration(body, seen) {
  if (typeof body.status_generation !== "number" || body.status_generation < seen) {
    return null;
  }
  return body.status_generation;
}

function solutionNeedsReload(status, solutionId, continuationPending) {
  if (!status || status.running || !status.solution_id) {
    return false;
  }
  return status.solution_id !== solutionId || continuationPending === true;
}

function groupHands(node) {
  const cells = new Map();
  (node.combos || []).forEach((combo, index) => {
    const high = browseRanks.indexOf(combo[0]);
    const low = browseRanks.indexOf(combo[2]);
    const suited = combo[1] === combo[3];
    let row = high;
    let column = low;
    if (combo[0] !== combo[2] && suited) {
      row = Math.min(high, low);
      column = Math.max(high, low);
    } else if (combo[0] !== combo[2]) {
      row = Math.max(high, low);
      column = Math.min(high, low);
    }
    const key = row + ":" + column;
    if (!cells.has(key)) {
      const text = combo[0] === combo[2]
        ? browseRanks[row] + browseRanks[column]
        : row < column
          ? browseRanks[row] + browseRanks[column] + "s"
          : browseRanks[column] + browseRanks[row] + "o";
      cells.set(key, {
        row,
        col: column,
        text,
        hands: [],
        marginalSum: 0,
        actionMass: (node.actions || []).map(() => 0),
        aggressionMass: 0,
        defined: !!node.reach_defined
      });
    }
    const cell = cells.get(key);
    const strategy = node.strategy ? node.strategy[index] : null;
    const marginal = node.reach_defined ? Number(node.marginal[index]) : 0;
    const actions = strategy
      ? node.actions.map((action, actionIndex) => ({action, probability: strategy[actionIndex]}))
      : [];
    cell.hands.push({combo, actions});
    cell.range_combos = cell.hands.length;
    if (!node.reach_defined) {
      return;
    }
    cell.marginalSum += marginal;
    if (!strategy) {
      return;
    }
    strategy.forEach((probability, actionIndex) => {
      cell.actionMass[actionIndex] += marginal * probability;
      if (isAggressive(node.actions[actionIndex])) {
        cell.aggressionMass += marginal * probability;
      }
    });
  });
  return [...cells.values()];
}

function frequencyOf(cell, mode) {
  if (!cell.defined || cell.marginalSum === 0) {
    return null;
  }
  if (mode === "aggression") {
    return cell.aggressionMass / cell.marginalSum;
  }
  return cell.actionMass[Number(mode)] / cell.marginalSum;
}

// Posterior-weighted. Each hand contributes its own mixed value, m(h) * V(h).
// A zero-mass group stays null even when the counterfactual hand values exist.
// Default display basis is local decision EV.
function groupEv(node, values, cell, basis) {
  const displayed = withEvBasis(values, basis || "local", node && node.actions);
  if (!node || !node.reach_defined || !displayed || displayed.pending || !cell) {
    return null;
  }
  if (displayed.node_id && node.node_id && displayed.node_id !== node.node_id) {
    return null;
  }
  const combos = displayed.combos || node.combos || [];
  let mass = 0;
  let mixed = 0;
  const action = (node.actions || []).map(() => 0);
  for (const hand of cell.hands || []) {
    const nodeIndex = (node.combos || []).indexOf(hand.combo);
    const valueIndex = combos.indexOf(hand.combo);
    if (nodeIndex < 0 || valueIndex < 0) {
      continue;
    }
    const marginal = Number(node.marginal[nodeIndex]);
    if (!(marginal > 0)) {
      continue;
    }
    if (!displayed.ev_defined || !displayed.ev_defined[valueIndex]) {
      return null;
    }
    const row = displayed.action_ev[valueIndex] || [];
    mass += marginal;
    mixed += marginal * Number(displayed.value[valueIndex]);
    action.forEach((_, index) => {
      action[index] += marginal * Number(row[index]);
    });
  }
  if (!(mass > 0)) {
    return null;
  }
  return {
    mixed: mixed / mass,
    action: action.map((entry) => entry / mass)
  };
}

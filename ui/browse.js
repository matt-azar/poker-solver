const browseRanks = ["A", "K", "Q", "J", "T", "9", "8", "7", "6", "5", "4", "3", "2"];

function isAggressive(label) {
  return label.startsWith("Bet") || label.startsWith("Raise");
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

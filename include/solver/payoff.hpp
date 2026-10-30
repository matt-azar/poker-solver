#pragma once

namespace poker::solver
{

// Both players' actual terminal utilities for the configured payoff model.
//
// Chip EV is zero-sum and root-centered: utility[1] == -utility[0], and the
// numbers are net chips from the start of the street (dead pot/2 plus street
// investments). Rake, ICM, and incentives (M8) need this dual return because
// those models are not generally zero-sum under a single player-0 vector.
struct PlayerPayoff
{
    double utility[2]{};
};

} // namespace poker::solver

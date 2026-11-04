#pragma once

// Predictive CFR+ (PRM+) frozen iteration schedule for StreetBatchSolver::Engine.
// Read this file alone for one complete PCFR+ frozen iteration.
//
// Prediction state: Engine::prediction_ holds last instantaneous CF regret m per
// action slot. While pcfr_collect_ is true, the walk writes instantaneous
// regrets into prediction_; pcfr_commit folds m into R and floors (CFR+).
// Cold-start m = 0. Average weight is linear in completed iteration t.
// Slot ops (freeze_sigma, pcfr_zero_prediction, pcfr_commit) and frozen_walk
// stay on Engine; this file only owns the schedule.

#include "solver/pcfr.hpp"

namespace poker::solver
{

inline void StreetBatchSolver::Engine::train_frozen_pcfr_plus_iterations(int count)
{
    for (int step = 0; step < count; ++step)
    {
        ++trained;
        // PCFR+: RM on R+m, accumulate instantaneous into prediction_,
        // commit+floor updating player; linear sigma weight t.
        const double weight_iter = static_cast<double>(trained);
        freeze_sigma();
        pcfr_zero_prediction(0);
        pcfr_collect_ = true;
        std::fill(workspace.scratch[0].pi0.begin(), workspace.scratch[0].pi0.end(), 1.0);
        std::fill(workspace.scratch[0].pi1.begin(), workspace.scratch[0].pi1.end(), 1.0);
        frozen_walk(workspace, 0, -1, -1, 0, 0, weight_iter, false);
        pcfr_collect_ = false;
        pcfr_commit(0);
        freeze_sigma();
        pcfr_zero_prediction(1);
        pcfr_collect_ = true;
        std::fill(workspace.scratch[0].pi0.begin(), workspace.scratch[0].pi0.end(), 1.0);
        std::fill(workspace.scratch[0].pi1.begin(), workspace.scratch[0].pi1.end(), 1.0);
        frozen_walk(workspace, 0, -1, -1, 0, 1, weight_iter, false);
        pcfr_collect_ = false;
        pcfr_commit(1);
    }
}

} // namespace poker::solver

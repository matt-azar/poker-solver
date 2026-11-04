#pragma once

// DCFR frozen iteration schedule for StreetBatchSolver::Engine.
// Read this file alone for one complete DCFR frozen iteration.
// Discount math lives in solver/dcfr.hpp; slot ops (freeze_sigma,
// discount_and_freeze, discount_player) and frozen_walk stay on Engine.

#include "solver/dcfr.hpp"

namespace poker::solver
{

inline void StreetBatchSolver::Engine::train_frozen_dcfr_iterations(int count)
{
    for (int step = 0; step < count; ++step)
    {
        ++trained;
        // DCFR(1.5,0,2): freeze, update OOP, discount(OOP)+freeze, update IP,
        // discount(IP). Both passes share t; sigma weight is t².
        const DcfrFactors factors = dcfr_factors(trained, dcfr_params_);
        slot_positive_discount_ = factors.positive_discount;
        slot_negative_discount_ = factors.negative_discount;
        freeze_sigma();
        std::fill(workspace.scratch[0].pi0.begin(), workspace.scratch[0].pi0.end(), 1.0);
        std::fill(workspace.scratch[0].pi1.begin(), workspace.scratch[0].pi1.end(), 1.0);
        frozen_walk(workspace, 0, -1, -1, 0, 0, factors.average_weight, false);
        discount_and_freeze(0, factors.positive_discount, factors.negative_discount);
        std::fill(workspace.scratch[0].pi0.begin(), workspace.scratch[0].pi0.end(), 1.0);
        std::fill(workspace.scratch[0].pi1.begin(), workspace.scratch[0].pi1.end(), 1.0);
        frozen_walk(workspace, 0, -1, -1, 0, 1, factors.average_weight, false);
        discount_player(1, factors.positive_discount, factors.negative_discount);
    }
}

} // namespace poker::solver

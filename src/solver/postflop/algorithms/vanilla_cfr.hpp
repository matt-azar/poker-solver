#pragma once

// Vanilla CFR iteration schedules for StreetBatchSolver::Engine.
// Read this file alone for one complete vanilla CFR frozen (or sequential) iteration.
// Slot ops (freeze_sigma) and traversal (frozen_pass, cfr_deal) stay on Engine;
// this file only owns the schedule.

namespace poker::solver
{

inline void StreetBatchSolver::Engine::train_frozen_vanilla_iterations(int count)
{
    for (int step = 0; step < count; ++step)
    {
        ++trained;
        frozen_pass(-1, 1.0, Algorithm::VanillaCfr);
    }
}

inline void StreetBatchSolver::Engine::train_more_vanilla_iterations(int count)
{
    for (int step = 0; step < count; ++step)
    {
        ++trained;
        freeze_sigma();
        for (const Deal& deal : deals)
        {
            cfr_deal(0, 1.0, 1.0, deal.probability, deal, -1, -1, -1, 1.0);
        }
    }
}

} // namespace poker::solver

#pragma once

// CFR+ iteration schedules for StreetBatchSolver::Engine.
// Read this file alone for one complete CFR+ frozen (or sequential) iteration.
// Slot ops (freeze_sigma, floor_player, floor_and_freeze) and traversal
// (frozen_walk, cfr_deal) stay on Engine; this file only owns the schedule.

namespace poker::solver
{

inline void StreetBatchSolver::Engine::train_frozen_cfr_plus_iterations(int count)
{
    for (int step = 0; step < count; ++step)
    {
        ++trained;
        // CFR+: freeze, update OOP, fuse floor(OOP)+freeze, update IP, floor(IP).
        // Same tables as two frozen_pass calls; one fewer full slot scan.
        const double weight_iter = static_cast<double>(trained);
        freeze_sigma();
        std::fill(workspace.scratch[0].pi0.begin(), workspace.scratch[0].pi0.end(), 1.0);
        std::fill(workspace.scratch[0].pi1.begin(), workspace.scratch[0].pi1.end(), 1.0);
        frozen_walk(workspace, 0, -1, -1, 0, 0, weight_iter, false);
        floor_and_freeze(0);
        std::fill(workspace.scratch[0].pi0.begin(), workspace.scratch[0].pi0.end(), 1.0);
        std::fill(workspace.scratch[0].pi1.begin(), workspace.scratch[0].pi1.end(), 1.0);
        frozen_walk(workspace, 0, -1, -1, 0, 1, weight_iter, false);
        floor_player(1);
    }
}

inline void StreetBatchSolver::Engine::train_more_cfr_plus_iterations(int count)
{
    for (int step = 0; step < count; ++step)
    {
        ++trained;
        const double weight_iter = static_cast<double>(trained);
        freeze_sigma();
        for (const Deal& deal : deals)
        {
            cfr_deal(0, 1.0, 1.0, deal.probability, deal, -1, -1, 0, weight_iter);
        }
        floor_player(0);
        freeze_sigma();
        for (const Deal& deal : deals)
        {
            cfr_deal(0, 1.0, 1.0, deal.probability, deal, -1, -1, 1, weight_iter);
        }
        floor_player(1);
    }
}

} // namespace poker::solver

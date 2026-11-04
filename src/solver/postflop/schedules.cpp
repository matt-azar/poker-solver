// StreetBatchSolver::Engine training dispatch. Lives in the same TU as the
// algorithm schedule headers so the inline train_*_iterations definitions are
// visible at the call sites (one TU only).

#include "engine.hpp"

namespace poker::solver
{

void StreetBatchSolver::Engine::train_more(int count, Algorithm algorithm)
{
    check_usable();
    if (config.threads > 1)
    {
        throw std::invalid_argument("multiple threads require the frozen street pass");
    }
    if (algorithm == Algorithm::Dcfr)
    {
        throw std::invalid_argument("DCFR requires the frozen street pass");
    }
    if (algorithm == Algorithm::PcfrPlus)
    {
        throw std::invalid_argument("PCFR+ requires the frozen street pass");
    }
    if (algorithm != Algorithm::VanillaCfr && algorithm != Algorithm::CfrPlus)
    {
        throw std::invalid_argument("the public street tree implements vanilla CFR and CFR+");
    }
    bind_training_algorithm(algorithm);
    average_ready = false;
    const auto started = std::chrono::steady_clock::now();
    if (algorithm == Algorithm::VanillaCfr)
    {
        train_more_vanilla_iterations(count);
    }
    else
    {
        train_more_cfr_plus_iterations(count);
    }
    train_seconds_ += std::chrono::duration<double>(
        std::chrono::steady_clock::now() - started).count();
}

void StreetBatchSolver::Engine::train_frozen(int count, Algorithm algorithm)
{
    check_usable();
    if (algorithm != Algorithm::VanillaCfr
        && algorithm != Algorithm::CfrPlus
        && algorithm != Algorithm::Dcfr
        && algorithm != Algorithm::PcfrPlus)
    {
        throw std::invalid_argument(
            "the frozen street pass implements vanilla CFR, CFR+, DCFR, and PCFR+");
    }
    bind_training_algorithm(algorithm);
    if (algorithm == Algorithm::PcfrPlus)
    {
        ensure_pcfr_prediction_table();
    }
    average_ready = false;
    ensure_ranks();
    ensure_support_masks();
    const auto started = std::chrono::steady_clock::now();
    if (algorithm == Algorithm::VanillaCfr)
    {
        train_frozen_vanilla_iterations(count);
    }
    else if (algorithm == Algorithm::Dcfr)
    {
        train_frozen_dcfr_iterations(count);
    }
    else if (algorithm == Algorithm::PcfrPlus)
    {
        train_frozen_pcfr_plus_iterations(count);
    }
    else
    {
        train_frozen_cfr_plus_iterations(count);
    }
    train_seconds_ += std::chrono::duration<double>(
        std::chrono::steady_clock::now() - started).count();
}

} // namespace poker::solver

// Algorithm schedules: one header per CFR variant (header-only).
// Included after Engine is complete and outside the TU namespace so each header
// can open namespace poker::solver for out-of-line Engine member definitions.
#include "algorithms/vanilla_cfr.hpp"
#include "algorithms/cfr_plus.hpp"
#include "algorithms/dcfr.hpp"
#include "algorithms/pcfr_plus.hpp"

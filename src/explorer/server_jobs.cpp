#include "server_shared.hpp"

#include <algorithm>
#include <cctype>
#include <charconv>
#include <cmath>
#include <condition_variable>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <limits>
#include <mutex>
#include <optional>
#include <span>
#include <sstream>
#include <stdexcept>
#include <system_error>

namespace explorer_detail
{

void solve_job(std::uint64_t job_id, Job job)
{
    std::vector<int> sample_iterations;
    std::vector<double> sample_values;
    std::vector<double> sample_gaps;
    double value = 0.0;
    double p1 = 0.0;
    double p2 = 0.0;
    double gap = 0.0;
    int done = 0;
    bool evaluated = false;
    bool time_limit_reached = false;
    const auto started = std::chrono::steady_clock::now();
    const auto seconds_now = [&]()
    {
        return std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
    };
    const auto wall_exhausted = [&]()
    {
        return job.time_limit >= 0.0 && seconds_now() >= job.time_limit;
    };
    const auto remember = [&](const poker::solver::EvaluationResult& evaluation)
    {
        value = evaluation.u0;
        p1 = evaluation.br0;
        p2 = evaluation.br1;
        gap = evaluation.nash_gap;
        evaluated = true;
        sample_iterations.push_back(done);
        sample_values.push_back(value);
        sample_gaps.push_back(gap);
    };
    try
    {
        if (g_session.stop_requested(job_id))
        {
            g_session.finish_cancelled(job_id, build_status(draft_for(
                job, job_id, done, seconds_now(), evaluated, value, p1, p2, gap,
                sample_iterations, sample_values, sample_gaps, nullptr)));
            return;
        }
        const int chunk = std::max(1, job.iterations / job.samples);
        // Flop, turn, and river share StreetBatchSolver. RiverBatchSolver
        // remains only for opening older river-kind PSOL checkpoints and for
        // the river_solver CLI.
        auto street = std::make_shared<poker::solver::StreetBatchSolver>(street_config(job));
        poker::solver::StreetMemoryReport street_memory = street->memory_report();
        const poker::solver::StreetMemoryReport* memory_ptr = &street_memory;
        const auto hold_current = [&]()
        {
            auto kept_solution = std::make_shared<HeldSolution>();
            kept_solution->job = job;
            kept_solution->job_id = job_id;
            kept_solution->iterations = done;
            kept_solution->runtime_seconds = seconds_now();
            kept_solution->value = value;
            kept_solution->p1_best_response = p1;
            kept_solution->p2_best_response = p2;
            kept_solution->nash_gap = gap;
            kept_solution->time_limit_reached = time_limit_reached;
            kept_solution->sample_iterations = sample_iterations;
            kept_solution->sample_values = sample_values;
            kept_solution->sample_gaps = sample_gaps;
            street->prepare_inspection();
            kept_solution->street = street;
            kept_solution->root_id = street->root_node_id();
            kept_solution->memory = street->memory_report();
            kept_solution->has_memory = true;
            street_memory = kept_solution->memory;
            return kept_solution;
        };
        const auto publish_stopped = [&]()
        {
            if (done <= 0)
            {
                StatusDraft draft = draft_for(
                    job, job_id, done, seconds_now(), evaluated, value, p1, p2, gap,
                    sample_iterations, sample_values, sample_gaps, memory_ptr);
                draft.cancelled = true;
                g_session.finish_cancelled(job_id, build_status(draft));
                return;
            }
            auto kept_solution = hold_current();
            const poker::explorer::Session::Permit kept_permit = g_session.prepare_kept(job_id);
            StatusDraft kept = draft_for(
                job, job_id, done, kept_solution->runtime_seconds, true, value, p1, p2, gap,
                kept_solution->sample_iterations, kept_solution->sample_values, kept_solution->sample_gaps,
                kept_solution->has_memory ? &kept_solution->memory : nullptr);
            kept.cancelled = true;
            if (!kept_permit.allowed)
            {
                g_session.finish_cancelled(job_id, build_status(kept));
                return;
            }
            kept_solution->id = kept_permit.solution_id;
            kept.solution_id = kept_permit.solution_id;
            kept.root_id = kept_solution->root_id;
            const bool published = g_session.commit_kept(
                job_id, kept_solution, kept_permit.solution_id, [&](std::uint64_t generation)
                {
                    StatusDraft draft = kept;
                    draft.generation = generation;
                    return build_status(draft);
                });
            if (!published && g_session.phase() == poker::explorer::Phase::Running)
            {
                StatusDraft draft = kept;
                draft.error = "failed to keep the solve";
                draft.solution_id = 0;
                draft.root_id.clear();
                g_session.finish_failed(job_id, build_status(draft));
            }
        };
        const auto publish_paused = [&]()
        {
            if (done <= 0)
            {
                return false;
            }
            auto kept_solution = hold_current();
            const poker::explorer::Session::Permit kept_permit = g_session.prepare_kept(job_id);
            StatusDraft kept = draft_for(
                job, job_id, done, kept_solution->runtime_seconds, true, value, p1, p2, gap,
                kept_solution->sample_iterations, kept_solution->sample_values, kept_solution->sample_gaps,
                kept_solution->has_memory ? &kept_solution->memory : nullptr);
            kept.paused = true;
            if (!kept_permit.allowed)
            {
                return false;
            }
            kept_solution->id = kept_permit.solution_id;
            kept.solution_id = kept_permit.solution_id;
            kept.root_id = kept_solution->root_id;
            const bool published = g_session.commit_paused(
                job_id, kept_solution, kept_permit.solution_id, [&](std::uint64_t generation)
                {
                    StatusDraft draft = kept;
                    draft.generation = generation;
                    return build_status(draft);
                });
            if (!published && g_session.phase() == poker::explorer::Phase::Running)
            {
                StatusDraft draft = kept;
                draft.error = "failed to pause the solve";
                draft.solution_id = 0;
                draft.root_id.clear();
                g_session.finish_failed(job_id, build_status(draft));
            }
            return published || g_session.phase() != poker::explorer::Phase::Running;
        };
        while (done < job.iterations)
        {
            if (g_session.stop_requested(job_id))
            {
                publish_stopped();
                return;
            }
            if (g_session.pause_requested(job_id) && done > 0)
            {
                if (publish_paused())
                {
                    return;
                }
            }
            const int step = std::min(chunk, job.iterations - done);
            // Fresh solves start with empty locks; continue_job / resolve-locked pass HeldSolution locks.
            if (job.frozen)
            {
                street->continue_frozen_iterations(step, job.algorithm, nullptr);
            }
            else
            {
                street->continue_iterations(step, job.algorithm, nullptr);
            }
            done += step;
            remember(street->evaluate());
            street_memory = street->memory_report();
            if (g_session.stop_requested(job_id))
            {
                publish_stopped();
                return;
            }
            if (g_session.pause_requested(job_id))
            {
                if (publish_paused())
                {
                    return;
                }
            }
            StatusDraft progress = draft_for(
                job, job_id, done, seconds_now(), evaluated, value, p1, p2, gap,
                sample_iterations, sample_values, sample_gaps, memory_ptr);
            progress.running = true;
            progress.time_limit_reached = time_limit_reached;
            g_session.set_progress(job_id, build_status(progress));
            if (job.accuracy >= 0.0
                && gap <= job.accuracy * poker::tenths_to_chips(job.pot))
            {
                break;
            }
            if (wall_exhausted())
            {
                time_limit_reached = true;
                break;
            }
        }
        if (done == 0 || g_session.stop_requested(job_id))
        {
            publish_stopped();
            return;
        }
        if (g_session.pause_requested(job_id))
        {
            if (publish_paused())
            {
                return;
            }
        }
        auto held = std::make_shared<HeldSolution>();
        held->job = job;
        held->job_id = job_id;
        held->iterations = done;
        held->runtime_seconds = seconds_now();
        held->value = value;
        held->p1_best_response = p1;
        held->p2_best_response = p2;
        held->nash_gap = gap;
        held->time_limit_reached = time_limit_reached;
        held->sample_iterations = sample_iterations;
        held->sample_values = sample_values;
        held->sample_gaps = sample_gaps;
        street->prepare_inspection();
        held->street = std::move(street);
        held->root_id = held->street->root_node_id();
        held->memory = held->street->memory_report();
        held->has_memory = true;
        street_memory = held->memory;
        if (g_session.stop_requested(job_id))
        {
            const poker::explorer::Session::Permit kept_permit = g_session.prepare_kept(job_id);
            StatusDraft kept = draft_for(
                job, job_id, done, held->runtime_seconds, true, value, p1, p2, gap,
                held->sample_iterations, held->sample_values, held->sample_gaps,
                held->has_memory ? &held->memory : nullptr);
            kept.cancelled = true;
            if (!kept_permit.allowed)
            {
                g_session.finish_cancelled(job_id, build_status(kept));
                return;
            }
            held->id = kept_permit.solution_id;
            kept.solution_id = kept_permit.solution_id;
            kept.root_id = held->root_id;
            g_session.commit_kept(job_id, held, kept_permit.solution_id, [&](std::uint64_t generation)
            {
                StatusDraft draft = kept;
                draft.generation = generation;
                return build_status(draft);
            });
            return;
        }
        if (g_session.pause_requested(job_id))
        {
            const poker::explorer::Session::Permit kept_permit = g_session.prepare_kept(job_id);
            StatusDraft kept = draft_for(
                job, job_id, done, held->runtime_seconds, true, value, p1, p2, gap,
                held->sample_iterations, held->sample_values, held->sample_gaps,
                held->has_memory ? &held->memory : nullptr);
            kept.paused = true;
            if (kept_permit.allowed)
            {
                held->id = kept_permit.solution_id;
                kept.solution_id = kept_permit.solution_id;
                kept.root_id = held->root_id;
                g_session.commit_paused(job_id, held, kept_permit.solution_id, [&](std::uint64_t generation)
                {
                    StatusDraft draft = kept;
                    draft.generation = generation;
                    return build_status(draft);
                });
                return;
            }
        }
        const poker::explorer::Session::Permit permit = g_session.prepare_success(job_id);
        if (!permit.allowed)
        {
            if (g_session.stop_requested(job_id))
            {
                const poker::explorer::Session::Permit kept_permit = g_session.prepare_kept(job_id);
                StatusDraft kept = draft_for(
                    job, job_id, done, held->runtime_seconds, true, value, p1, p2, gap,
                    held->sample_iterations, held->sample_values, held->sample_gaps,
                    held->has_memory ? &held->memory : nullptr);
                kept.cancelled = true;
                if (kept_permit.allowed)
                {
                    held->id = kept_permit.solution_id;
                    kept.solution_id = kept_permit.solution_id;
                    kept.root_id = held->root_id;
                    g_session.commit_kept(job_id, held, kept_permit.solution_id, [&](std::uint64_t generation)
                    {
                        StatusDraft draft = kept;
                        draft.generation = generation;
                        return build_status(draft);
                    });
                    return;
                }
            }
            if (g_session.pause_requested(job_id))
            {
                const poker::explorer::Session::Permit kept_permit = g_session.prepare_kept(job_id);
                StatusDraft kept = draft_for(
                    job, job_id, done, held->runtime_seconds, true, value, p1, p2, gap,
                    held->sample_iterations, held->sample_values, held->sample_gaps,
                    held->has_memory ? &held->memory : nullptr);
                kept.paused = true;
                if (kept_permit.allowed)
                {
                    held->id = kept_permit.solution_id;
                    kept.solution_id = kept_permit.solution_id;
                    kept.root_id = held->root_id;
                    g_session.commit_paused(job_id, held, kept_permit.solution_id, [&](std::uint64_t generation)
                    {
                        StatusDraft draft = kept;
                        draft.generation = generation;
                        return build_status(draft);
                    });
                    return;
                }
            }
            StatusDraft draft = draft_for(
                job, job_id, done, held->runtime_seconds, true, value, p1, p2, gap,
                sample_iterations, sample_values, sample_gaps, held->has_memory ? &held->memory : nullptr);
            draft.cancelled = true;
            g_session.finish_cancelled(job_id, build_status(draft));
            return;
        }
        held->id = permit.solution_id;
        StatusDraft success = draft_for(
            job, job_id, done, held->runtime_seconds, true, value, p1, p2, gap,
            held->sample_iterations, held->sample_values, held->sample_gaps,
            held->has_memory ? &held->memory : nullptr);
        success.solution_id = permit.solution_id;
        success.root_id = held->root_id;
        success.time_limit_reached = time_limit_reached;
        const bool published = g_session.commit_success(job_id, held, permit.solution_id, [&](std::uint64_t generation, bool accepted)
        {
            StatusDraft draft = success;
            draft.generation = generation;
            draft.cancelled = !accepted;
            if (!accepted)
            {
                draft.solution_id = 0;
                draft.root_id.clear();
            }
            return build_status(draft);
        });
        if (!published && g_session.phase() == poker::explorer::Phase::Running)
        {
            StatusDraft draft = success;
            draft.generation = g_session.generation() + 1;
            draft.error = "failed to publish the solve";
            draft.solution_id = 0;
            draft.root_id.clear();
            g_session.finish_failed(job_id, build_status(draft));
        }
    }
    catch (const std::exception& error)
    {
        StatusDraft draft = draft_for(
            job, job_id, done, seconds_now(), evaluated, value, p1, p2, gap,
            sample_iterations, sample_values, sample_gaps, nullptr);
        draft.error = error.what();
        draft.cancelled = g_session.stop_requested(job_id);
        g_session.finish_failed(job_id, build_status(draft));
    }
}

poker::explorer::TrainingSnapshot completed_snapshot(
    const HeldSolution& held,
    int done,
    double value,
    double p1,
    double p2,
    double gap)
{
    poker::explorer::TrainingSnapshot snapshot;
    snapshot.iterations = done;
    snapshot.value = value;
    snapshot.p1_best_response = p1;
    snapshot.p2_best_response = p2;
    snapshot.nash_gap = gap;
    int trained = done;
    if (held.street)
    {
        trained = held.street->completed_iterations();
    }
    else if (held.river)
    {
        trained = held.river->completed_iterations();
    }
    snapshot.iterations = trained;
    if (trained == done)
    {
        return snapshot;
    }
    try
    {
        if (held.street)
        {
            const poker::solver::EvaluationResult evaluation = held.street->evaluate();
            snapshot.value = evaluation.u0;
            snapshot.p1_best_response = evaluation.br0;
            snapshot.p2_best_response = evaluation.br1;
            snapshot.nash_gap = evaluation.nash_gap;
        }
        else if (held.river)
        {
            const poker::solver::EvaluationResult evaluation = held.river->evaluate();
            snapshot.value = evaluation.u0;
            snapshot.p1_best_response = evaluation.br0;
            snapshot.p2_best_response = evaluation.br1;
            snapshot.nash_gap = evaluation.nash_gap;
        }
    }
    catch (const std::exception&)
    {
        snapshot.value = held.value;
        snapshot.p1_best_response = held.p1_best_response;
        snapshot.p2_best_response = held.p2_best_response;
        snapshot.nash_gap = held.nash_gap;
    }
    return snapshot;
}

poker::explorer::RetainedTraining take_retained(HeldSolution& held)
{
    poker::explorer::RetainedTraining retained;
    retained.job_id = held.job_id;
    retained.iterations = held.iterations;
    retained.runtime_seconds = held.runtime_seconds;
    retained.value = held.value;
    retained.p1_best_response = held.p1_best_response;
    retained.p2_best_response = held.p2_best_response;
    retained.nash_gap = held.nash_gap;
    retained.sample_iterations.swap(held.sample_iterations);
    retained.sample_values.swap(held.sample_values);
    retained.sample_gaps.swap(held.sample_gaps);
    return retained;
}

void store_retained(HeldSolution& held, poker::explorer::RetainedTraining& retained)
{
    held.job_id = retained.job_id;
    held.iterations = retained.iterations;
    held.runtime_seconds = retained.runtime_seconds;
    held.value = retained.value;
    held.p1_best_response = retained.p1_best_response;
    held.p2_best_response = retained.p2_best_response;
    held.nash_gap = retained.nash_gap;
    held.sample_iterations.swap(retained.sample_iterations);
    held.sample_values.swap(retained.sample_values);
    held.sample_gaps.swap(retained.sample_gaps);
}

void adopt_completed_training(
    HeldSolution& held,
    std::uint64_t job_id,
    double seconds,
    const poker::explorer::TrainingSnapshot& snapshot)
{
    const int previous = held.iterations;
    poker::explorer::RetainedTraining retained = take_retained(held);
    try
    {
        poker::explorer::remember_completed_training(retained, job_id, seconds, snapshot);
        poker::explorer::append_completed_sample(retained, snapshot);
    }
    catch (const std::bad_alloc&)
    {
    }
    store_retained(held, retained);
    if (!held.street || snapshot.iterations == previous)
    {
        return;
    }
    try
    {
        held.street->prepare_inspection();
        held.memory = held.street->memory_report();
        held.has_memory = true;
    }
    catch (const std::exception&)
    {
    }
}

void continue_job(std::uint64_t job_id, int extra, double time_limit)
{
    // Claim returns while cancelled value queries may still hold the engine.
    // Match solve: wait for quiet off the accept thread before mutating.
    g_session.wait_until_quiet();
    const std::shared_ptr<HeldSolution> held =
        std::static_pointer_cast<HeldSolution>(g_session.training_resource(job_id));
    if (!held || (!held->street && !held->river))
    {
        g_session.abort_continuation(
            job_id,
            "{\"running\":false,\"cancelled\":false,\"error\":\"missing solution\",\"solution_id\":null}");
        return;
    }
    if (time_limit >= 0.0)
    {
        held->job.time_limit = time_limit;
    }
    held->time_limit_reached = false;
    const auto started = std::chrono::steady_clock::now();
    int done = held->iterations;
    if (extra > std::numeric_limits<int>::max() - done)
    {
        StatusDraft draft = draft_for(
            held->job, job_id, done, held->runtime_seconds, true,
            held->value, held->p1_best_response, held->p2_best_response, held->nash_gap,
            held->sample_iterations, held->sample_values, held->sample_gaps,
            held->has_memory ? &held->memory : nullptr);
        draft.error = "iteration count overflow";
        draft.solution_id = held->id;
        draft.root_id = held->root_id;
        g_session.abort_continuation(job_id, build_status(draft));
        return;
    }
    const int target = done + extra;
    double value = held->value;
    double p1 = held->p1_best_response;
    double p2 = held->p2_best_response;
    double gap = held->nash_gap;
    bool time_limit_reached = false;
    const int samples = std::max(1, held->job.samples);
    const int chunk = std::max(1, extra / samples);
    const auto seconds_now = [&]()
    {
        return held->runtime_seconds
            + std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
    };
    const auto continuation_seconds = [&]()
    {
        return std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
    };
    const auto wall_exhausted = [&]()
    {
        return time_limit >= 0.0 && continuation_seconds() >= time_limit;
    };
    try
    {
        const std::size_t chunks = static_cast<std::size_t>((extra + chunk - 1) / chunk);
        held->sample_iterations.reserve(held->sample_iterations.size() + chunks);
        held->sample_values.reserve(held->sample_values.size() + chunks);
        held->sample_gaps.reserve(held->sample_gaps.size() + chunks);
        while (done < target)
        {
            if (g_session.stop_requested(job_id) || g_session.pause_requested(job_id))
            {
                break;
            }
            const int step = std::min(chunk, target - done);
            const poker::solver::LockSet* const locks = locks_arg(*held);
            if (held->street)
            {
                if (held->job.frozen)
                {
                    held->street->continue_frozen_iterations(step, held->job.algorithm, locks);
                }
                else
                {
                    held->street->continue_iterations(step, held->job.algorithm, locks);
                }
                const poker::solver::EvaluationResult evaluation = held->street->evaluate();
                value = evaluation.u0;
                p1 = evaluation.br0;
                p2 = evaluation.br1;
                gap = evaluation.nash_gap;
            }
            else
            {
                held->river->continue_iterations(step, held->job.algorithm);
                const poker::solver::EvaluationResult evaluation = held->river->evaluate();
                value = evaluation.u0;
                p1 = evaluation.br0;
                p2 = evaluation.br1;
                gap = evaluation.nash_gap;
            }
            done += step;
            held->sample_iterations.push_back(done);
            held->sample_values.push_back(value);
            held->sample_gaps.push_back(gap);
            if (g_session.stop_requested(job_id) || g_session.pause_requested(job_id))
            {
                break;
            }
            poker::solver::StreetMemoryReport memory{};
            const poker::solver::StreetMemoryReport* memory_ptr = nullptr;
            if (held->street)
            {
                memory = held->street->memory_report();
                memory_ptr = &memory;
            }
            StatusDraft progress = draft_for(
                held->job, job_id, done, seconds_now(), true, value, p1, p2, gap,
                held->sample_iterations, held->sample_values, held->sample_gaps, memory_ptr);
            progress.running = true;
            progress.solution_id = held->id;
            progress.root_id = held->root_id;
            progress.time_limit_reached = time_limit_reached;
            g_session.set_progress(job_id, build_status(progress));
            if (held->job.accuracy >= 0.0
                && gap <= held->job.accuracy * poker::tenths_to_chips(held->job.pot))
            {
                break;
            }
            if (wall_exhausted())
            {
                time_limit_reached = true;
                break;
            }
        }
        const double seconds = seconds_now();
        held->iterations = done;
        held->runtime_seconds = seconds;
        held->value = value;
        held->p1_best_response = p1;
        held->p2_best_response = p2;
        held->nash_gap = gap;
        held->time_limit_reached = time_limit_reached;
        held->job_id = job_id;
        // Training rebuilds the average from strategy_sum; drop session overlays.
        held->strategy_edits.clear();
        if (held->street)
        {
            held->street->prepare_inspection();
            held->memory = held->street->memory_report();
            held->has_memory = true;
        }
        else if (held->river)
        {
            held->river->prepare_inspection();
            held->root_id = held->river->root_node_id();
        }
        const bool pause_after = g_session.pause_requested(job_id) && !g_session.stop_requested(job_id);
        StatusDraft success = draft_for(
            held->job, job_id, done, seconds, true, value, p1, p2, gap,
            held->sample_iterations, held->sample_values, held->sample_gaps,
            held->has_memory ? &held->memory : nullptr);
        success.solution_id = held->id;
        success.root_id = held->root_id;
        success.baseline_solution_id = held->baseline_solution_id;
        success.paused = pause_after;
        success.time_limit_reached = time_limit_reached;
        const bool published = g_session.commit_continuation(job_id, [&](std::uint64_t generation)
        {
            StatusDraft draft = success;
            draft.generation = generation;
            return build_status(draft);
        });
        if (!published && g_session.phase() == poker::explorer::Phase::Running)
        {
            StatusDraft draft = success;
            draft.error = "failed to publish the continuation";
            g_session.abort_continuation(job_id, build_status(draft));
        }
    }
    catch (const std::exception& error)
    {
        const poker::explorer::TrainingSnapshot snapshot =
            completed_snapshot(*held, done, value, p1, p2, gap);
        adopt_completed_training(*held, job_id, seconds_now(), snapshot);
        StatusDraft draft = draft_for(
            held->job, held->job_id, held->iterations, held->runtime_seconds, true,
            held->value, held->p1_best_response, held->p2_best_response, held->nash_gap,
            held->sample_iterations, held->sample_values, held->sample_gaps,
            held->has_memory ? &held->memory : nullptr);
        draft.error = error.what();
        draft.solution_id = held->id;
        draft.root_id = held->root_id;
        draft.baseline_solution_id = held->baseline_solution_id;
        draft.time_limit_reached = held->time_limit_reached;
        g_session.abort_continuation(job_id, build_status(draft));
    }
}

// Warm-start policy for v1: reset training tables and re-solve from zero with locks.
// Retains the prior revision as Session baseline so compare/export still work.
void resolve_locked_job(
    std::uint64_t job_id,
    int iterations,
    double accuracy,
    int samples,
    double time_limit,
    bool warm_start)
{
    g_session.wait_until_quiet();
    const std::shared_ptr<HeldSolution> held =
        std::static_pointer_cast<HeldSolution>(g_session.training_resource(job_id));
    if (!held || !held->street)
    {
        g_session.abort_continuation(
            job_id,
            "{\"running\":false,\"cancelled\":false,\"error\":\"resolve-locked requires a street solution\","
            "\"solution_id\":null}");
        return;
    }
    if (accuracy >= 0.0)
    {
        held->job.accuracy = accuracy;
    }
    if (samples >= 1)
    {
        held->job.samples = samples;
    }
    if (time_limit >= 0.0)
    {
        held->job.time_limit = time_limit;
    }
    held->time_limit_reached = false;
    const std::uint64_t prior_id = held->id;
    try
    {
        if (g_session.baseline_solution() == 0)
        {
            try
            {
                const std::shared_ptr<HeldSolution> baseline = clone_held_baseline(*held);
                baseline->id = prior_id;
                g_session.set_baseline(baseline, prior_id);
            }
            catch (const std::bad_alloc&)
            {
                StatusDraft draft = draft_for(
                    held->job, job_id, held->iterations, held->runtime_seconds, true,
                    held->value, held->p1_best_response, held->p2_best_response, held->nash_gap,
                    held->sample_iterations, held->sample_values, held->sample_gaps,
                    held->has_memory ? &held->memory : nullptr);
                draft.error = "baseline clone could not fit in memory";
                draft.solution_id = prior_id;
                draft.root_id = held->root_id;
                g_session.abort_continuation(job_id, build_status(draft));
                return;
            }
            catch (const std::runtime_error& error)
            {
                StatusDraft draft = draft_for(
                    held->job, job_id, held->iterations, held->runtime_seconds, true,
                    held->value, held->p1_best_response, held->p2_best_response, held->nash_gap,
                    held->sample_iterations, held->sample_values, held->sample_gaps,
                    held->has_memory ? &held->memory : nullptr);
                draft.error = error.what();
                draft.solution_id = prior_id;
                draft.root_id = held->root_id;
                g_session.abort_continuation(job_id, build_status(draft));
                return;
            }
        }
        held->baseline_solution_id = g_session.baseline_solution();

        const poker::streets::StreetConfig config = held->street->config();
        // warm_start keeps regrets/strategy-sums and continues from the prior
        // iteration count under the current locks. Default remains reset-from-zero.
        // Float→float copy avoids a full TrainingTables double transfer.
        const std::shared_ptr<poker::solver::StreetBatchSolver> prior_solver = held->street;
        const int prior_iterations = held->iterations;
        const double prior_runtime = held->runtime_seconds;
        std::shared_ptr<poker::solver::StreetBatchSolver> rebuilt;
        try
        {
            rebuilt = std::make_shared<poker::solver::StreetBatchSolver>(config);
            if (warm_start)
            {
                rebuilt->copy_training_state_from(*prior_solver);
            }
        }
        catch (const std::bad_alloc&)
        {
            StatusDraft draft = draft_for(
                held->job, job_id, held->iterations, held->runtime_seconds, true,
                held->value, held->p1_best_response, held->p2_best_response, held->nash_gap,
                held->sample_iterations, held->sample_values, held->sample_gaps,
                held->has_memory ? &held->memory : nullptr);
            draft.error = "resolve-locked rebuild could not fit in memory";
            draft.solution_id = prior_id;
            draft.root_id = held->root_id;
            draft.baseline_solution_id = held->baseline_solution_id;
            g_session.abort_continuation(job_id, build_status(draft));
            return;
        }
        held->street = std::move(rebuilt);
        if (warm_start)
        {
            held->iterations = prior_iterations;
            held->runtime_seconds = prior_runtime;
        }
        else
        {
            held->sample_iterations.clear();
            held->sample_values.clear();
            held->sample_gaps.clear();
            held->iterations = 0;
            held->runtime_seconds = 0.0;
            held->value = 0.0;
            held->p1_best_response = 0.0;
            held->p2_best_response = 0.0;
            held->nash_gap = 0.0;
        }

        const auto started = std::chrono::steady_clock::now();
        int done = held->iterations;
        if (iterations > std::numeric_limits<int>::max() - done)
        {
            StatusDraft draft = draft_for(
                held->job, job_id, done, held->runtime_seconds, true,
                held->value, held->p1_best_response, held->p2_best_response, held->nash_gap,
                held->sample_iterations, held->sample_values, held->sample_gaps,
                held->has_memory ? &held->memory : nullptr);
            draft.error = "iteration count overflow";
            draft.solution_id = prior_id;
            draft.root_id = held->root_id;
            draft.baseline_solution_id = held->baseline_solution_id;
            g_session.abort_continuation(job_id, build_status(draft));
            return;
        }
        const int target = done + iterations;
        double value = held->value;
        double p1 = held->p1_best_response;
        double p2 = held->p2_best_response;
        double gap = held->nash_gap;
        bool time_limit_reached = false;
        const int eval_samples = std::max(1, held->job.samples);
        const int chunk = std::max(1, iterations / eval_samples);
        const auto seconds_now = [&]()
        {
            return held->runtime_seconds
                + std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
        };
        const auto continuation_seconds = [&]()
        {
            return std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
        };
        const auto wall_exhausted = [&]()
        {
            return held->job.time_limit >= 0.0 && continuation_seconds() >= held->job.time_limit;
        };
        const poker::solver::LockSet* const locks = locks_arg(*held);
        while (done < target)
        {
            if (g_session.stop_requested(job_id) || g_session.pause_requested(job_id))
            {
                break;
            }
            const int step = std::min(chunk, target - done);
            if (held->job.frozen)
            {
                held->street->continue_frozen_iterations(step, held->job.algorithm, locks);
            }
            else
            {
                held->street->continue_iterations(step, held->job.algorithm, locks);
            }
            done += step;
            const poker::solver::EvaluationResult evaluation = held->street->evaluate();
            value = evaluation.u0;
            p1 = evaluation.br0;
            p2 = evaluation.br1;
            gap = evaluation.nash_gap;
            held->sample_iterations.push_back(done);
            held->sample_values.push_back(value);
            held->sample_gaps.push_back(gap);
            StatusDraft progress = draft_for(
                held->job, job_id, done, seconds_now(), true, value, p1, p2, gap,
                held->sample_iterations, held->sample_values, held->sample_gaps,
                nullptr);
            progress.running = true;
            progress.solution_id = held->id;
            progress.root_id = held->root_id;
            progress.baseline_solution_id = held->baseline_solution_id;
            progress.time_limit_reached = time_limit_reached;
            g_session.set_progress(job_id, build_status(progress));
            if (held->job.accuracy >= 0.0
                && gap <= held->job.accuracy * poker::tenths_to_chips(held->job.pot))
            {
                break;
            }
            if (wall_exhausted())
            {
                time_limit_reached = true;
                break;
            }
        }
        if (done == 0)
        {
            StatusDraft draft = draft_for(
                held->job, job_id, 0, seconds_now(), false, 0.0, 0.0, 0.0, 0.0,
                held->sample_iterations, held->sample_values, held->sample_gaps, nullptr);
            draft.error = "resolve-locked produced no iterations";
            draft.solution_id = prior_id;
            draft.root_id = held->root_id;
            draft.baseline_solution_id = held->baseline_solution_id;
            g_session.abort_continuation(job_id, build_status(draft));
            return;
        }
        // Locked re-solve rebuilds the average; drop any prior free-form overlays.
        held->strategy_edits.clear();
        held->street->prepare_inspection();
        held->root_id = held->street->root_node_id();
        held->memory = held->street->memory_report();
        held->has_memory = true;
        held->iterations = done;
        held->runtime_seconds = seconds_now();
        held->value = value;
        held->p1_best_response = p1;
        held->p2_best_response = p2;
        held->nash_gap = gap;
        held->time_limit_reached = time_limit_reached;
        held->job_id = job_id;

        const poker::explorer::Session::Permit permit = g_session.prepare_success(job_id);
        if (!permit.allowed)
        {
            StatusDraft draft = draft_for(
                held->job, job_id, done, held->runtime_seconds, true, value, p1, p2, gap,
                held->sample_iterations, held->sample_values, held->sample_gaps,
                &held->memory);
            draft.error = "resolve-locked was stopped before publish";
            draft.solution_id = prior_id;
            draft.root_id = held->root_id;
            draft.baseline_solution_id = held->baseline_solution_id;
            g_session.abort_continuation(job_id, build_status(draft));
            return;
        }
        held->id = permit.solution_id;
        StatusDraft success = draft_for(
            held->job, job_id, done, held->runtime_seconds, true, value, p1, p2, gap,
            held->sample_iterations, held->sample_values, held->sample_gaps,
            &held->memory);
        success.solution_id = held->id;
        success.root_id = held->root_id;
        success.baseline_solution_id = held->baseline_solution_id;
        success.time_limit_reached = time_limit_reached;
        const bool published = g_session.commit_success(
            job_id,
            held,
            permit.solution_id,
            [&](std::uint64_t generation, bool accepted)
            {
                StatusDraft draft = success;
                draft.generation = generation;
                if (!accepted)
                {
                    draft.cancelled = true;
                    draft.solution_id = 0;
                    draft.root_id.clear();
                }
                return build_status(draft);
            });
        if (!published && g_session.phase() == poker::explorer::Phase::Running)
        {
            StatusDraft draft = success;
            draft.error = "failed to publish the locked resolve";
            g_session.abort_continuation(job_id, build_status(draft));
        }
    }
    catch (const std::exception& error)
    {
        StatusDraft draft = draft_for(
            held->job, job_id, held->iterations, held->runtime_seconds, true,
            held->value, held->p1_best_response, held->p2_best_response, held->nash_gap,
            held->sample_iterations, held->sample_values, held->sample_gaps,
            held->has_memory ? &held->memory : nullptr);
        draft.error = error.what();
        draft.solution_id = held->id;
        draft.root_id = held->root_id;
        draft.baseline_solution_id = held->baseline_solution_id;
        g_session.abort_continuation(job_id, build_status(draft));
    }
}


}  // namespace explorer_detail

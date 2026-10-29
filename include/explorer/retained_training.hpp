#pragma once

#include <cstdint>
#include <vector>

namespace poker::explorer
{

struct TrainingSnapshot
{
    int iterations = 0;
    double value = 0.0;
    double p1_best_response = 0.0;
    double p2_best_response = 0.0;
    double nash_gap = 0.0;
};

// The fields a published solution keeps beside the engine.
struct RetainedTraining
{
    std::uint64_t job_id = 0;
    int iterations = 0;
    double runtime_seconds = 0.0;
    double value = 0.0;
    double p1_best_response = 0.0;
    double p2_best_response = 0.0;
    double nash_gap = 0.0;
    std::vector<int> sample_iterations;
    std::vector<double> sample_values;
    std::vector<double> sample_gaps;
};

// When the engine has finished iterations the record does not yet name, the
// record takes that count, job, and value. Scalars are stored before history
// growth, so a later allocation failure leaves the count and job in place.
inline void remember_completed_training(
    RetainedTraining& retained,
    std::uint64_t job_id,
    double runtime_seconds,
    const TrainingSnapshot& engine)
{
    if (engine.iterations == retained.iterations)
    {
        return;
    }
    retained.job_id = job_id;
    retained.iterations = engine.iterations;
    retained.runtime_seconds = runtime_seconds;
    retained.value = engine.value;
    retained.p1_best_response = engine.p1_best_response;
    retained.p2_best_response = engine.p2_best_response;
    retained.nash_gap = engine.nash_gap;
}

// Adds the engine's current point when history does not already end there.
// Growth uses temporary vectors, so a throw leaves the previous series intact.
inline void append_completed_sample(RetainedTraining& retained, const TrainingSnapshot& engine)
{
    const bool recorded = !retained.sample_iterations.empty()
        && retained.sample_iterations.back() == engine.iterations
        && retained.sample_values.size() == retained.sample_iterations.size()
        && retained.sample_gaps.size() == retained.sample_iterations.size();
    if (recorded || engine.iterations != retained.iterations)
    {
        return;
    }
    std::vector<int> iterations = retained.sample_iterations;
    std::vector<double> values = retained.sample_values;
    std::vector<double> gaps = retained.sample_gaps;
    iterations.push_back(engine.iterations);
    values.push_back(engine.value);
    gaps.push_back(engine.nash_gap);
    retained.sample_iterations.swap(iterations);
    retained.sample_values.swap(values);
    retained.sample_gaps.swap(gaps);
}

} // namespace poker::explorer

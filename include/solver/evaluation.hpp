#pragma once

#include <cmath>

namespace poker::solver
{

// Shared on-profile + best-response evaluation. NashConv is the sum of
// unilateral deviation gains under the same modeled payoff as training:
//   (br0 - u0) + (br1 - u1)
// Pio "Accuracy" / exploitability is the average of those gains:
//   NashConv / 2
// Under zero-sum chip EV, u0 + u1 = 0 so NashConv equals br0 + br1. With rake,
// ICM, or incentives the absolute-sum form is wrong; accuracy stopping and
// reported gaps must use this result.
struct EvaluationResult
{
    double u0 = 0.0; // on-profile utility[0]
    double u1 = 0.0; // on-profile utility[1]
    double br0 = 0.0; // u0(BR0, σ1)
    double br1 = 0.0; // u1(σ0, BR1)
    double gain0 = 0.0; // br0 - u0
    double gain1 = 0.0; // br1 - u1
    double nash_gap = 0.0; // gain0 + gain1 (general-sum NashConv)
    double accuracy = 0.0; // (gain0 + gain1) / 2 (Pio exploitability)
};

inline EvaluationResult make_evaluation(double u0, double u1, double br0, double br1)
{
    EvaluationResult result;
    result.u0 = u0;
    result.u1 = u1;
    result.br0 = br0;
    result.br1 = br1;
    result.gain0 = br0 - u0;
    result.gain1 = br1 - u1;
    result.nash_gap = result.gain0 + result.gain1;
    result.accuracy = 0.5 * result.nash_gap;
    return result;
}

} // namespace poker::solver

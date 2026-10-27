#pragma once

#include <array>
#include <string>
#include <string_view>
#include <vector>

namespace poker::holdem
{

// One weight for each of the 1,326 unordered two-card hands.
// Index 0 is the lowest card ids, (2c, 2d). Weights are nonnegative.
//
// A parsed range keeps the weights it was given. normalize() divides by their
// sum. remove_blockers() zeros every combo that uses a dead card.
//
// The joint convention is documented in docs/HOLDEM.md: player hands are
// ordered, and a pair of hands is legal only when the four cards and the
// board are disjoint. Probability is proportional to the product of weights.
class Range
{
public:
    Range();

    static int combo_index(int card0, int card1);
    static void combo_cards(int index, int& card0, int& card1);
    static std::string combo_text(int index);

    static Range parse(std::string_view text);
    static Range from_json(std::string_view json);

    double weight(int index) const;
    double weight_of(int card0, int card1) const;
    void set_weight(int card0, int card1, double value);
    double total() const;

    void normalize();
    void remove_blockers(const int* dead, int dead_count);
    Range conditioned(const int* dead, int dead_count) const;

    std::string to_json() const;
    std::string to_combo_list() const;

    const std::array<double, 1326>& weights() const { return weights_; }

private:
    std::array<double, 1326> weights_{};
};

struct HandPairProbability
{
    int combo0 = 0;
    int combo1 = 0;
    double probability = 0.0;
};

// Unnormalized sum of w0(h0) w1(h1) over legal ordered hand pairs.
double joint_mass(const Range& left, const Range& right, const int* board, int board_count);

// Normalized joint distribution. Empty when every product is zero.
std::vector<HandPairProbability> joint_distribution(
    const Range& left,
    const Range& right,
    const int* board,
    int board_count);

} // namespace poker::holdem

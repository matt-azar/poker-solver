#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <optional>
#include <span>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace poker::solver
{

// How a NodeLock applies across combos at one infoset / public node.
enum class LockKind
{
    FullNode,        // locked row applies to every combo at the node
    SelectedCombos,  // locked row applies only to listed combo indices
};

// Validated probability vector over legal actions.
// Empty means the node (or selected combos) is unlocked — free for CFR updates.
// A non-empty row must be nonnegative, free of NaN, length == action_count,
// and sum to 1 within 1e-12. Zero probability on an action is a lock, not unlock.
struct ActionLockRow
{
    std::vector<double> probs;

    bool unlocked() const
    {
        return probs.empty();
    }

    std::size_t size() const
    {
        return probs.size();
    }
};

inline constexpr double kLockProbSumTolerance = 1e-12;

// Rejects NaN, negatives, wrong length, and sums outside 1 ± 1e-12.
// Empty probs are valid and mean unlocked (action_count is ignored).
inline bool validate_action_row(std::span<const double> probs, int action_count)
{
    if (probs.empty())
    {
        return true;
    }
    if (action_count < 0 || static_cast<std::size_t>(action_count) != probs.size())
    {
        return false;
    }
    double sum = 0.0;
    for (const double p : probs)
    {
        if (!std::isfinite(p) || p < 0.0)
        {
            return false;
        }
        sum += p;
    }
    return std::abs(sum - 1.0) <= kLockProbSumTolerance;
}

inline ActionLockRow make_action_lock_row(std::span<const double> probs, int action_count)
{
    if (!validate_action_row(probs, action_count))
    {
        throw std::invalid_argument("invalid action lock probability row");
    }
    ActionLockRow row;
    row.probs.assign(probs.begin(), probs.end());
    return row;
}

// One lock at an infoset (or stable public-node key).
struct NodeLock
{
    std::size_t infoset_id = 0;
    LockKind kind = LockKind::FullNode;
    // Used only when kind == SelectedCombos. Empty SelectedCombos means no
    // combo is currently locked (lookup always free).
    std::vector<std::size_t> combo_indices;
    ActionLockRow actions;
};

inline bool combo_is_selected(const NodeLock& lock, std::size_t combo_index)
{
    for (const std::size_t index : lock.combo_indices)
    {
        if (index == combo_index)
        {
            return true;
        }
    }
    return false;
}

// Returns the locked probability for (combo, action), or nullopt when free.
// FullNode applies to every combo. SelectedCombos applies only to listed combos.
// An unlocked (empty) action row always returns nullopt — distinct from locking
// an action at probability 0.0.
inline std::optional<double> locked_probability(
    const NodeLock& lock,
    std::size_t combo_index,
    std::size_t action)
{
    if (lock.actions.unlocked())
    {
        return std::nullopt;
    }
    if (action >= lock.actions.probs.size())
    {
        return std::nullopt;
    }
    if (lock.kind == LockKind::SelectedCombos && !combo_is_selected(lock, combo_index))
    {
        return std::nullopt;
    }
    return lock.actions.probs[action];
}

// Collection of NodeLock keyed by infoset / public-node id.
class LockSet
{
public:
    void upsert(NodeLock lock)
    {
        const std::size_t id = lock.infoset_id;
        by_id_[id] = std::move(lock);
    }

    bool erase(std::size_t infoset_id)
    {
        return by_id_.erase(infoset_id) > 0;
    }

    const NodeLock* find(std::size_t infoset_id) const
    {
        const auto it = by_id_.find(infoset_id);
        if (it == by_id_.end())
        {
            return nullptr;
        }
        return &it->second;
    }

    void clear()
    {
        by_id_.clear();
    }

    bool empty() const
    {
        return by_id_.empty();
    }

    std::size_t size() const
    {
        return by_id_.size();
    }

    // Sorted infoset ids for stable text round-trips.
    std::vector<std::size_t> infoset_ids() const
    {
        std::vector<std::size_t> ids;
        ids.reserve(by_id_.size());
        for (const auto& entry : by_id_)
        {
            ids.push_back(entry.first);
        }
        std::sort(ids.begin(), ids.end());
        return ids;
    }

private:
    std::unordered_map<std::size_t, NodeLock> by_id_;
};

// Text format: one lock per line
//   lock <infoset> full probs <p0 p1 ...>
//   lock <infoset> combos <c0,c1,...> probs <p0 p1 ...>
//   lock <infoset> full        (unlocked / empty row)
//   lock <infoset> combos <c0,c1,...>   (selected combos, unlocked row)
inline std::string format_node_lock(const NodeLock& lock)
{
    std::ostringstream out;
    out << "lock " << lock.infoset_id << ' ';
    if (lock.kind == LockKind::FullNode)
    {
        out << "full";
    }
    else
    {
        out << "combos ";
        for (std::size_t i = 0; i < lock.combo_indices.size(); ++i)
        {
            if (i > 0)
            {
                out << ',';
            }
            out << lock.combo_indices[i];
        }
    }
    if (!lock.actions.unlocked())
    {
        out << " probs";
        for (const double p : lock.actions.probs)
        {
            out << ' ' << p;
        }
    }
    return out.str();
}

inline std::string format_lock_set(const LockSet& locks, const std::vector<std::size_t>& order)
{
    std::string out;
    for (const std::size_t id : order)
    {
        const NodeLock* lock = locks.find(id);
        if (lock == nullptr)
        {
            continue;
        }
        out += format_node_lock(*lock);
        out.push_back('\n');
    }
    return out;
}

inline std::string format_lock_set(const LockSet& locks)
{
    return format_lock_set(locks, locks.infoset_ids());
}

namespace detail
{

inline std::vector<std::string_view> split_ws(std::string_view text)
{
    std::vector<std::string_view> parts;
    std::size_t i = 0;
    while (i < text.size())
    {
        while (i < text.size() && (text[i] == ' ' || text[i] == '\t'))
        {
            ++i;
        }
        if (i >= text.size())
        {
            break;
        }
        const std::size_t start = i;
        while (i < text.size() && text[i] != ' ' && text[i] != '\t')
        {
            ++i;
        }
        parts.push_back(text.substr(start, i - start));
    }
    return parts;
}

inline std::size_t parse_size(std::string_view text, const char* what)
{
    if (text.empty())
    {
        throw std::invalid_argument(std::string("missing ") + what);
    }
    std::size_t index = 0;
    const unsigned long long value = std::stoull(std::string(text), &index, 10);
    if (index != text.size())
    {
        throw std::invalid_argument(std::string("invalid ") + what);
    }
    return static_cast<std::size_t>(value);
}

inline double parse_prob(std::string_view text)
{
    std::size_t index = 0;
    const double value = std::stod(std::string(text), &index);
    if (index != text.size())
    {
        throw std::invalid_argument("invalid lock probability");
    }
    return value;
}

inline std::vector<std::size_t> parse_combo_list(std::string_view text)
{
    std::vector<std::size_t> combos;
    if (text.empty())
    {
        return combos;
    }
    std::size_t start = 0;
    while (start <= text.size())
    {
        const std::size_t comma = text.find(',', start);
        const std::string_view piece =
            comma == std::string_view::npos ? text.substr(start) : text.substr(start, comma - start);
        if (!piece.empty())
        {
            combos.push_back(parse_size(piece, "combo index"));
        }
        if (comma == std::string_view::npos)
        {
            break;
        }
        start = comma + 1;
    }
    return combos;
}

} // namespace detail

inline NodeLock parse_node_lock(std::string_view line)
{
    const auto parts = detail::split_ws(line);
    if (parts.size() < 3 || parts[0] != "lock")
    {
        throw std::invalid_argument("lock line must start with: lock <id> full|combos ...");
    }
    NodeLock lock;
    lock.infoset_id = detail::parse_size(parts[1], "infoset id");
    std::size_t index = 2;
    if (parts[index] == "full")
    {
        lock.kind = LockKind::FullNode;
        ++index;
    }
    else if (parts[index] == "combos")
    {
        lock.kind = LockKind::SelectedCombos;
        ++index;
        if (index >= parts.size())
        {
            throw std::invalid_argument("combos lock needs a combo list or probs");
        }
        if (parts[index] != "probs")
        {
            lock.combo_indices = detail::parse_combo_list(parts[index]);
            ++index;
        }
    }
    else
    {
        throw std::invalid_argument("lock kind must be full or combos");
    }
    if (index < parts.size())
    {
        if (parts[index] != "probs")
        {
            throw std::invalid_argument("expected probs after lock header");
        }
        ++index;
        std::vector<double> probs;
        for (; index < parts.size(); ++index)
        {
            probs.push_back(detail::parse_prob(parts[index]));
        }
        lock.actions = make_action_lock_row(probs, static_cast<int>(probs.size()));
    }
    return lock;
}

inline LockSet parse_lock_set(std::string_view text)
{
    LockSet locks;
    std::size_t start = 0;
    while (start < text.size())
    {
        const std::size_t end = text.find('\n', start);
        const std::string_view line =
            end == std::string_view::npos ? text.substr(start) : text.substr(start, end - start);
        if (!line.empty() && line.find_first_not_of(" \t") != std::string_view::npos)
        {
            locks.upsert(parse_node_lock(line));
        }
        if (end == std::string_view::npos)
        {
            break;
        }
        start = end + 1;
    }
    return locks;
}

} // namespace poker::solver

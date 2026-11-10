#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <functional>
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

// Board scope for street locks. Node keeps the selected runout; Line applies to
// every runout of the betting line (turn=river stored as -1). Roots that are
// already pN.t-1.r-1 still need this flag so GET/JSON can report the intent.
enum class LockScope
{
    Node,
    Line,
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

// Composite key for a lock: public betting index plus optional runout cards.
// turn=river=-1 is a line lock (every runout that shares the betting line).
// Otherwise the lock applies only to that exact board (Pio lock_node).
struct LockKey
{
    std::size_t infoset_id = 0;
    std::int8_t turn = -1;
    std::int8_t river = -1;

    bool is_line() const
    {
        return turn < 0 && river < 0;
    }

    bool operator==(const LockKey& other) const
    {
        return infoset_id == other.infoset_id && turn == other.turn && river == other.river;
    }
};

struct LockKeyHash
{
    std::size_t operator()(const LockKey& key) const noexcept
    {
        std::size_t h = std::hash<std::size_t>{}(key.infoset_id);
        h ^= static_cast<std::size_t>(static_cast<unsigned char>(key.turn) + 1u) * 0x9e3779b97f4a7c15ull
            + (h << 6) + (h >> 2);
        h ^= static_cast<std::size_t>(static_cast<unsigned char>(key.river) + 1u) * 0x9e3779b97f4a7c15ull
            + (h << 6) + (h >> 2);
        return h;
    }
};

inline LockKey make_lock_key(std::size_t infoset_id, int turn = -1, int river = -1)
{
    LockKey key;
    key.infoset_id = infoset_id;
    key.turn = static_cast<std::int8_t>(turn);
    key.river = static_cast<std::int8_t>(river);
    return key;
}

inline LockKey line_lock_key(std::size_t infoset_id)
{
    return make_lock_key(infoset_id, -1, -1);
}

// One lock at an infoset (or stable public-node key), optionally scoped to a runout.
struct NodeLock
{
    std::size_t infoset_id = 0;
    // Encoded cards from the explorer node id (pN.tT.rR). Line locks force -1/-1.
    std::int8_t turn = -1;
    std::int8_t river = -1;
    LockScope scope = LockScope::Node;
    LockKind kind = LockKind::FullNode;
    // Used only when kind == SelectedCombos. Empty SelectedCombos means no
    // combo is currently locked (lookup always free).
    std::vector<std::size_t> combo_indices;
    ActionLockRow actions;

    LockKey key() const
    {
        return make_lock_key(infoset_id, turn, river);
    }

    bool is_line() const
    {
        return scope == LockScope::Line;
    }
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

// Collection of NodeLock keyed by (infoset, turn, river).
// Engine lookup prefers an exact runout lock, then falls back to a line lock.
class LockSet
{
public:
    void upsert(NodeLock lock)
    {
        const LockKey key = lock.key();
        by_key_[key] = std::move(lock);
    }

    bool erase(const LockKey& key)
    {
        return by_key_.erase(key) > 0;
    }

    bool erase(std::size_t infoset_id)
    {
        return erase(line_lock_key(infoset_id));
    }

    bool erase(std::size_t infoset_id, int turn, int river)
    {
        return erase(make_lock_key(infoset_id, turn, river));
    }

    // Remove one combo from a SelectedCombos lock. Returns true when the set changed.
    // FullNode locks cannot be partially unlocked this way (returns false).
    // If the last selected combo is removed, the node lock is erased.
    bool erase_combo(const LockKey& key, std::size_t combo_index)
    {
        const auto it = by_key_.find(key);
        if (it == by_key_.end())
        {
            return false;
        }
        if (it->second.kind != LockKind::SelectedCombos)
        {
            return false;
        }
        auto& indices = it->second.combo_indices;
        const auto found = std::find(indices.begin(), indices.end(), combo_index);
        if (found == indices.end())
        {
            return false;
        }
        indices.erase(found);
        if (indices.empty())
        {
            by_key_.erase(it);
        }
        return true;
    }

    bool erase_combo(std::size_t infoset_id, std::size_t combo_index)
    {
        return erase_combo(line_lock_key(infoset_id), combo_index);
    }

    bool erase_combo(std::size_t infoset_id, int turn, int river, std::size_t combo_index)
    {
        return erase_combo(make_lock_key(infoset_id, turn, river), combo_index);
    }

    const NodeLock* find_exact(const LockKey& key) const
    {
        const auto it = by_key_.find(key);
        if (it == by_key_.end())
        {
            return nullptr;
        }
        return &it->second;
    }

    const NodeLock* find_exact(std::size_t infoset_id, int turn, int river) const
    {
        return find_exact(make_lock_key(infoset_id, turn, river));
    }

    // Line-only lookup (infoset id with turn=river=-1). Used by Kuhn/CfrTrainer
    // and by callers that intentionally address a line lock.
    const NodeLock* find(std::size_t infoset_id) const
    {
        return find_exact(line_lock_key(infoset_id));
    }

    // StreetBatch slot lookup: exact runout first, then line fallback.
    const NodeLock* find_for_runout(std::size_t infoset_id, int turn, int river) const
    {
        if (const NodeLock* exact = find_exact(infoset_id, turn, river))
        {
            return exact;
        }
        if (turn >= 0 || river >= 0)
        {
            return find_exact(line_lock_key(infoset_id));
        }
        return nullptr;
    }

    void clear()
    {
        by_key_.clear();
    }

    bool empty() const
    {
        return by_key_.empty();
    }

    std::size_t size() const
    {
        return by_key_.size();
    }

    // Sorted keys for stable text / JSON round-trips.
    std::vector<LockKey> keys() const
    {
        std::vector<LockKey> out;
        out.reserve(by_key_.size());
        for (const auto& entry : by_key_)
        {
            out.push_back(entry.first);
        }
        std::sort(out.begin(), out.end(), [](const LockKey& a, const LockKey& b)
        {
            if (a.infoset_id != b.infoset_id)
            {
                return a.infoset_id < b.infoset_id;
            }
            if (a.turn != b.turn)
            {
                return a.turn < b.turn;
            }
            return a.river < b.river;
        });
        return out;
    }

    // Unique infoset ids (sorted). Prefer keys() when runout scope matters.
    std::vector<std::size_t> infoset_ids() const
    {
        std::vector<std::size_t> ids;
        ids.reserve(by_key_.size());
        for (const auto& entry : by_key_)
        {
            ids.push_back(entry.first.infoset_id);
        }
        std::sort(ids.begin(), ids.end());
        ids.erase(std::unique(ids.begin(), ids.end()), ids.end());
        return ids;
    }

private:
    std::unordered_map<LockKey, NodeLock, LockKeyHash> by_key_;
};

// Text format: one lock per line
//   lock <infoset> full probs <p0 p1 ...>                         (legacy line)
//   lock <infoset> line full probs <p0 p1 ...>                    (explicit line)
//   lock <infoset> at <turn> <river> full probs <p0 p1 ...>       (node / runout)
//   lock <infoset> at <turn> <river> combos <c0,c1,...> probs ...
//   lock <infoset> full        (unlocked / empty row)
// Legacy lines without `at` / `line` are line locks (prior Explorer behavior).
inline std::string format_node_lock(const NodeLock& lock)
{
    std::ostringstream out;
    out << "lock " << lock.infoset_id;
    if (lock.scope == LockScope::Line)
    {
        out << " line";
    }
    else
    {
        out << " at " << static_cast<int>(lock.turn) << ' ' << static_cast<int>(lock.river);
    }
    out << ' ';
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

inline std::string format_lock_set(const LockSet& locks, const std::vector<LockKey>& order)
{
    std::string out;
    for (const LockKey& key : order)
    {
        const NodeLock* lock = locks.find_exact(key);
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
    return format_lock_set(locks, locks.keys());
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

inline int parse_card_index(std::string_view text, const char* what)
{
    if (text.empty())
    {
        throw std::invalid_argument(std::string("missing ") + what);
    }
    std::size_t index = 0;
    const long long value = std::stoll(std::string(text), &index, 10);
    if (index != text.size())
    {
        throw std::invalid_argument(std::string("invalid ") + what);
    }
    if (value < -1 || value > 51)
    {
        throw std::invalid_argument(std::string("out-of-range ") + what);
    }
    return static_cast<int>(value);
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
        throw std::invalid_argument("lock line must start with: lock <id> [at t r] full|combos ...");
    }
    NodeLock lock;
    lock.infoset_id = detail::parse_size(parts[1], "infoset id");
    std::size_t index = 2;
    if (index < parts.size() && parts[index] == "at")
    {
        if (index + 2 >= parts.size())
        {
            throw std::invalid_argument("lock at needs turn and river card indexes");
        }
        lock.scope = LockScope::Node;
        lock.turn = static_cast<std::int8_t>(detail::parse_card_index(parts[index + 1], "turn card"));
        lock.river = static_cast<std::int8_t>(detail::parse_card_index(parts[index + 2], "river card"));
        index += 3;
    }
    else if (index < parts.size() && parts[index] == "line")
    {
        lock.scope = LockScope::Line;
        lock.turn = -1;
        lock.river = -1;
        ++index;
    }
    else
    {
        // Legacy PSOL / text without at|line: prior Explorer behavior was line-wide.
        lock.scope = LockScope::Line;
        lock.turn = -1;
        lock.river = -1;
    }
    if (index >= parts.size())
    {
        throw std::invalid_argument("lock kind must be full or combos");
    }
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

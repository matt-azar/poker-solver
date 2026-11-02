#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <memory_resource>
#include <span>
#include <stdexcept>
#include <vector>

namespace poker::solver
{

// Optional StreetBatch storage: regret / strategy-sum as int16 with a shared
// max-abs scale per fixed block of entries. Working updates expand into
// float/double scratch, apply the logical CFR change, then requantize.
//
// Encoding: value ≈ stored_i16 * scale[block], scale = max_abs / 32767.
// A zero block uses scale 0 and all-zero payloads.
//
// CFR+ must accumulate signed regret changes before the floor. Callers keep a
// float pass-delta (or an expanded working buffer) for the updating pass and
// quantize only after that logical update completes.

inline constexpr std::int16_t kI16QuantMax = 32767;
inline constexpr int kI16BlockSize = 32;

inline float i16_scale_from_max_abs(double max_abs)
{
    if (!(max_abs > 0.0) || !std::isfinite(max_abs))
    {
        return 0.0f;
    }
    return static_cast<float>(max_abs / static_cast<double>(kI16QuantMax));
}

inline std::size_t i16_block_count(std::size_t entries)
{
    if (entries == 0)
    {
        return 0;
    }
    return (entries + static_cast<std::size_t>(kI16BlockSize) - 1)
        / static_cast<std::size_t>(kI16BlockSize);
}

// Writes n int16 values. Returns the scale used for the row/block.
float compress_i16_row(std::span<const float> in, std::span<std::int16_t> out);
float compress_i16_row(std::span<const double> in, std::span<std::int16_t> out);

void expand_i16_row(
    std::span<const std::int16_t> in,
    float scale,
    std::span<float> out);
void expand_i16_row(
    std::span<const std::int16_t> in,
    float scale,
    std::span<double> out);

// Flat int16 payload plus one scale per kI16BlockSize-entry block.
class CompressedI16Table
{
public:
    using allocator_type = std::pmr::polymorphic_allocator<std::byte>;

    explicit CompressedI16Table(const allocator_type& alloc)
        : data_(alloc)
        , scale_(alloc)
    {
    }

    CompressedI16Table(const CompressedI16Table&) = delete;
    CompressedI16Table& operator=(const CompressedI16Table&) = delete;

    void clear()
    {
        data_.clear();
        scale_.clear();
    }

    void assign_zero(std::size_t entries)
    {
        data_.assign(entries, 0);
        scale_.assign(i16_block_count(entries), 0.0f);
    }

    std::size_t entry_count() const
    {
        return data_.size();
    }

    std::size_t block_count() const
    {
        return scale_.size();
    }

    bool empty() const
    {
        return data_.empty();
    }

    std::uint64_t storage_bytes() const
    {
        return static_cast<std::uint64_t>(data_.size()) * sizeof(std::int16_t)
            + static_cast<std::uint64_t>(scale_.size()) * sizeof(float);
    }

    std::span<std::int16_t> data()
    {
        return std::span<std::int16_t>(data_.data(), data_.size());
    }

    std::span<const std::int16_t> data() const
    {
        return std::span<const std::int16_t>(data_.data(), data_.size());
    }

    std::span<float> scales()
    {
        return std::span<float>(scale_.data(), scale_.size());
    }

    std::span<const float> scales() const
    {
        return std::span<const float>(scale_.data(), scale_.size());
    }

    void expand_range(int base, int n, std::span<float> out) const
    {
        expand_range_impl(base, n, out);
    }

    void expand_range(int base, int n, std::span<double> out) const
    {
        expand_range_impl(base, n, out);
    }

    // Replace [base, base+n) with `in`, recompressing every touched block.
    void write_range(int base, int n, std::span<const float> in)
    {
        write_range_impl(base, n, in);
    }

    void write_range(int base, int n, std::span<const double> in)
    {
        write_range_impl(base, n, in);
    }

    void zero_all()
    {
        std::fill(data_.begin(), data_.end(), 0);
        std::fill(scale_.begin(), scale_.end(), 0.0f);
    }

private:
    template <typename T>
    void expand_range_impl(int base, int n, std::span<T> out) const
    {
        if (n < 0 || out.size() != static_cast<std::size_t>(n))
        {
            throw std::invalid_argument("expand_range size mismatch");
        }
        for (int offset = 0; offset < n; ++offset)
        {
            const std::size_t at = static_cast<std::size_t>(base + offset);
            const std::size_t block = at / static_cast<std::size_t>(kI16BlockSize);
            out[static_cast<std::size_t>(offset)] = static_cast<T>(
                static_cast<double>(data_[at]) * static_cast<double>(scale_[block]));
        }
    }

    template <typename T>
    void write_range_impl(int base, int n, std::span<const T> in)
    {
        if (n < 0 || in.size() != static_cast<std::size_t>(n))
        {
            throw std::invalid_argument("write_range size mismatch");
        }
        if (n == 0)
        {
            return;
        }
        const std::size_t first = static_cast<std::size_t>(base);
        const std::size_t last = static_cast<std::size_t>(base + n - 1);
        const std::size_t first_block = first / static_cast<std::size_t>(kI16BlockSize);
        const std::size_t last_block = last / static_cast<std::size_t>(kI16BlockSize);
        double block_values[kI16BlockSize];
        std::int16_t block_store[kI16BlockSize];
        for (std::size_t block = first_block; block <= last_block; ++block)
        {
            const std::size_t block_begin = block * static_cast<std::size_t>(kI16BlockSize);
            const std::size_t block_end = std::min(
                block_begin + static_cast<std::size_t>(kI16BlockSize), data_.size());
            const int block_n = static_cast<int>(block_end - block_begin);
            expand_i16_row(
                std::span<const std::int16_t>(data_.data() + block_begin, static_cast<std::size_t>(block_n)),
                scale_[block],
                std::span<double>(block_values, static_cast<std::size_t>(block_n)));
            for (int offset = 0; offset < n; ++offset)
            {
                const std::size_t at = static_cast<std::size_t>(base + offset);
                if (at < block_begin || at >= block_end)
                {
                    continue;
                }
                block_values[at - block_begin] = static_cast<double>(in[static_cast<std::size_t>(offset)]);
            }
            scale_[block] = compress_i16_row(
                std::span<const double>(block_values, static_cast<std::size_t>(block_n)),
                std::span<std::int16_t>(block_store, static_cast<std::size_t>(block_n)));
            std::copy(
                block_store,
                block_store + block_n,
                data_.begin() + static_cast<std::ptrdiff_t>(block_begin));
        }
    }

    std::pmr::vector<std::int16_t> data_;
    std::pmr::vector<float> scale_;
};

} // namespace poker::solver

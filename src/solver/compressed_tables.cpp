#include "solver/compressed_tables.hpp"

#include <algorithm>
#include <stdexcept>

namespace poker::solver
{
namespace
{

template <typename T>
float compress_row_impl(std::span<const T> in, std::span<std::int16_t> out)
{
    if (in.size() != out.size())
    {
        throw std::invalid_argument("compress_i16_row size mismatch");
    }
    double max_abs = 0.0;
    for (T value : in)
    {
        const double absolute = std::fabs(static_cast<double>(value));
        if (absolute > max_abs)
        {
            max_abs = absolute;
        }
    }
    const float scale = i16_scale_from_max_abs(max_abs);
    if (scale == 0.0f)
    {
        std::fill(out.begin(), out.end(), static_cast<std::int16_t>(0));
        return 0.0f;
    }
    const double inv = 1.0 / static_cast<double>(scale);
    for (std::size_t index = 0; index < in.size(); ++index)
    {
        const double quantized = std::round(static_cast<double>(in[index]) * inv);
        const double clipped = std::clamp(
            quantized,
            static_cast<double>(-kI16QuantMax),
            static_cast<double>(kI16QuantMax));
        out[index] = static_cast<std::int16_t>(clipped);
    }
    return scale;
}

template <typename T>
void expand_row_impl(std::span<const std::int16_t> in, float scale, std::span<T> out)
{
    if (in.size() != out.size())
    {
        throw std::invalid_argument("expand_i16_row size mismatch");
    }
    for (std::size_t index = 0; index < in.size(); ++index)
    {
        out[index] = static_cast<T>(static_cast<double>(in[index]) * static_cast<double>(scale));
    }
}

} // namespace

float compress_i16_row(std::span<const float> in, std::span<std::int16_t> out)
{
    return compress_row_impl(in, out);
}

float compress_i16_row(std::span<const double> in, std::span<std::int16_t> out)
{
    return compress_row_impl(in, out);
}

void expand_i16_row(
    std::span<const std::int16_t> in,
    float scale,
    std::span<float> out)
{
    expand_row_impl(in, scale, out);
}

void expand_i16_row(
    std::span<const std::int16_t> in,
    float scale,
    std::span<double> out)
{
    expand_row_impl(in, scale, out);
}

} // namespace poker::solver

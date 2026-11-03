#include "explorer/checkpoint.hpp"

#include "solver/trainer.hpp"

#include <bit>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string_view>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace poker::explorer
{
namespace
{

constexpr char kMagic[4] = {'P', 'S', 'O', 'L'};
constexpr std::uint32_t kVersionMin = 1;
constexpr std::uint32_t kVersionMax = 3;
constexpr std::uint32_t kVersionLocks = 2;
constexpr std::uint32_t kVersionContinuation = 3;
constexpr std::string_view kUtility = "root_centered_zero_sum";
constexpr std::uint8_t kFlagDcfrParams = 1u;
constexpr std::uint8_t kFlagPrediction = 2u;
constexpr std::uint64_t kHeaderBytes = 32;

std::uint64_t fnv1a64_update(std::uint64_t hash, std::string_view bytes)
{
    for (unsigned char byte : bytes)
    {
        hash ^= byte;
        hash *= 1099511628211ull;
    }
    return hash;
}

std::uint64_t fnv1a64(std::string_view bytes)
{
    return fnv1a64_update(14695981039346656037ull, bytes);
}

std::uint32_t crc32_update(std::uint32_t crc, std::string_view bytes)
{
    for (unsigned char byte : bytes)
    {
        crc ^= byte;
        for (int shift = 0; shift < 8; ++shift)
        {
            const bool low_bit = (crc & 1u) != 0;
            crc >>= 1;
            if (low_bit)
            {
                crc ^= 0xedb88320u;
            }
        }
    }
    return crc;
}

std::uint32_t crc32(std::string_view bytes)
{
    return ~crc32_update(0xffffffffu, bytes);
}

class Reader
{
public:
    explicit Reader(std::string_view bytes)
        : bytes_(bytes)
    {
    }

    void need(std::size_t count) const
    {
        if (bytes_.size() - at_ < count)
        {
            throw std::invalid_argument("checkpoint ended early");
        }
    }

    std::uint8_t u8()
    {
        need(1);
        const auto value = static_cast<std::uint8_t>(bytes_[at_]);
        ++at_;
        return value;
    }

    std::uint32_t u32()
    {
        need(4);
        std::uint32_t value = 0;
        for (int index = 0; index < 4; ++index)
        {
            value |= static_cast<std::uint32_t>(static_cast<unsigned char>(bytes_[at_ + static_cast<std::size_t>(index)]))
                << (8 * index);
        }
        at_ += 4;
        return value;
    }

    std::uint64_t u64()
    {
        need(8);
        std::uint64_t value = 0;
        for (int index = 0; index < 8; ++index)
        {
            value |= static_cast<std::uint64_t>(static_cast<unsigned char>(bytes_[at_ + static_cast<std::size_t>(index)]))
                << (8 * index);
        }
        at_ += 8;
        return value;
    }

    int i32()
    {
        const std::uint32_t bits = u32();
        int value = 0;
        std::memcpy(&value, &bits, sizeof(value));
        return value;
    }

    std::uint16_t u16()
    {
        need(2);
        const auto value = static_cast<std::uint16_t>(
            static_cast<unsigned char>(bytes_[at_])
            | (static_cast<unsigned char>(bytes_[at_ + 1]) << 8));
        at_ += 2;
        return value;
    }

    double f64()
    {
        const std::uint64_t bits = u64();
        double value = 0.0;
        std::memcpy(&value, &bits, sizeof(value));
        return value;
    }

    std::string text()
    {
        const std::uint32_t count = u32();
        need(count);
        std::string value(bytes_.substr(at_, count));
        at_ += count;
        return value;
    }

    bool done() const
    {
        return at_ == bytes_.size();
    }

private:
    std::string_view bytes_;
    std::size_t at_ = 0;
};

class StreamWriter
{
public:
    explicit StreamWriter(std::ofstream& output)
        : output_(output)
    {
    }

    std::uint64_t size() const
    {
        return size_;
    }

    std::uint64_t fnv() const
    {
        return fnv_;
    }

    std::uint32_t crc() const
    {
        return ~crc_;
    }

    void raw(const void* data, std::size_t count)
    {
        if (count == 0)
        {
            return;
        }
        output_.write(static_cast<const char*>(data), static_cast<std::streamsize>(count));
        if (!output_)
        {
            throw std::runtime_error("checkpoint could not write a temporary file");
        }
        const std::string_view view(static_cast<const char*>(data), count);
        fnv_ = fnv1a64_update(fnv_, view);
        crc_ = crc32_update(crc_, view);
        size_ += count;
    }

    void u8(std::uint8_t value)
    {
        const char byte = static_cast<char>(value);
        raw(&byte, 1);
    }

    void u32(std::uint32_t value)
    {
        const unsigned char bytes[4] = {
            static_cast<unsigned char>(value & 0xffu),
            static_cast<unsigned char>((value >> 8) & 0xffu),
            static_cast<unsigned char>((value >> 16) & 0xffu),
            static_cast<unsigned char>((value >> 24) & 0xffu)};
        raw(bytes, 4);
    }

    void u64(std::uint64_t value)
    {
        unsigned char bytes[8];
        for (int index = 0; index < 8; ++index)
        {
            bytes[index] = static_cast<unsigned char>((value >> (8 * index)) & 0xffu);
        }
        raw(bytes, 8);
    }

    void i32(int value)
    {
        u32(static_cast<std::uint32_t>(value));
    }

    void f64(double value)
    {
        std::uint64_t bits = 0;
        std::memcpy(&bits, &value, sizeof(bits));
        u64(bits);
    }

    void text(std::string_view value)
    {
        if (value.size() > 0xffffffffu)
        {
            throw std::invalid_argument("checkpoint text is too long");
        }
        u32(static_cast<std::uint32_t>(value.size()));
        raw(value.data(), value.size());
    }

    void ints(const std::vector<int>& values)
    {
        if (values.size() > 0xffffffffu)
        {
            throw std::invalid_argument("checkpoint list is too long");
        }
        u32(static_cast<std::uint32_t>(values.size()));
        for (int value : values)
        {
            i32(value);
        }
    }

    void doubles(const std::vector<double>& values)
    {
        if (values.size() > 0xffffffffu)
        {
            throw std::invalid_argument("checkpoint list is too long");
        }
        u32(static_cast<std::uint32_t>(values.size()));
        for (double value : values)
        {
            f64(value);
        }
    }

    void scalar_as_doubles(std::span<const solver::TableScalar> values)
    {
        if (values.size() > 0xffffffffu)
        {
            throw std::invalid_argument("checkpoint list is too long");
        }
        u32(static_cast<std::uint32_t>(values.size()));
        for (solver::TableScalar value : values)
        {
            f64(static_cast<double>(value));
        }
    }

private:
    std::ofstream& output_;
    std::uint64_t size_ = 0;
    std::uint64_t fnv_ = 14695981039346656037ull;
    std::uint32_t crc_ = 0xffffffffu;
};

std::vector<int> read_ints(Reader& reader)
{
    const std::uint32_t count = reader.u32();
    std::vector<int> values;
    values.reserve(count);
    for (std::uint32_t index = 0; index < count; ++index)
    {
        values.push_back(reader.i32());
    }
    return values;
}

std::vector<double> read_doubles(Reader& reader)
{
    const std::uint32_t count = reader.u32();
    std::vector<double> values;
    values.reserve(count);
    for (std::uint32_t index = 0; index < count; ++index)
    {
        values.push_back(reader.f64());
    }
    return values;
}

void validate_document_shape(
    const CheckpointDocument& document,
    const CheckpointScalarTables* scalars)
{
    if (document.kind != 1 && document.kind != 2)
    {
        throw std::invalid_argument("checkpoint kind is not a street or river solve");
    }
    if (document.algorithm > poker::solver::kAlgorithmTagMax)
    {
        throw std::invalid_argument("checkpoint algorithm is unknown");
    }
    if (document.tables.iterations < 0 || document.samples < 1)
    {
        throw std::invalid_argument("checkpoint iteration count is invalid");
    }
    if (document.sample_iterations.size() != document.sample_values.size()
        || document.sample_iterations.size() != document.sample_gaps.size())
    {
        throw std::invalid_argument("checkpoint samples do not line up");
    }
    if (document.tables.slot_actions.size() > 0xffffffffu)
    {
        throw std::invalid_argument("checkpoint action list is too long");
    }
    const std::size_t regret_count = scalars != nullptr && !scalars->regret.empty()
        ? scalars->regret.size()
        : document.tables.regret.size();
    const std::size_t strategy_count = scalars != nullptr && !scalars->strategy_sum.empty()
        ? scalars->strategy_sum.size()
        : document.tables.strategy_sum.size();
    if (regret_count != strategy_count)
    {
        throw std::invalid_argument("checkpoint tables do not line up");
    }
    const bool use_scalar_prediction =
        scalars != nullptr && !scalars->prediction.empty();
    const std::size_t prediction_count =
        use_scalar_prediction ? scalars->prediction.size() : document.prediction.size();
    if (prediction_count != 0 && prediction_count != regret_count)
    {
        throw std::invalid_argument("checkpoint prediction size does not match tables");
    }
    if (document.has_dcfr_params)
    {
        if (!std::isfinite(document.dcfr.alpha)
            || !std::isfinite(document.dcfr.beta)
            || !std::isfinite(document.dcfr.gamma))
        {
            throw std::invalid_argument("checkpoint DCFR parameters must be finite");
        }
    }
}

bool wants_continuation_section(
    const CheckpointDocument& document,
    const CheckpointScalarTables* scalars)
{
    if (document.has_dcfr_params)
    {
        return true;
    }
    if (!document.prediction.empty())
    {
        return true;
    }
    return scalars != nullptr && !scalars->prediction.empty();
}

std::uint64_t list_bytes_u32_prefix(std::size_t count, std::size_t element_bytes)
{
    if (count > 0xffffffffu)
    {
        throw std::invalid_argument("checkpoint list is too long");
    }
    return 4ull + static_cast<std::uint64_t>(count) * static_cast<std::uint64_t>(element_bytes);
}

std::uint64_t text_bytes(std::size_t count)
{
    if (count > 0xffffffffu)
    {
        throw std::invalid_argument("checkpoint text is too long");
    }
    return 4ull + static_cast<std::uint64_t>(count);
}

void replace_file(const std::filesystem::path& temporary, const std::filesystem::path& destination)
{
#ifdef _WIN32
    if (!MoveFileExW(
            temporary.c_str(),
            destination.c_str(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    {
        throw std::runtime_error("checkpoint could not replace the destination");
    }
#else
    std::error_code error;
    std::filesystem::rename(temporary, destination, error);
    if (error)
    {
        throw std::runtime_error("checkpoint could not replace the destination");
    }
#endif
}

void write_header_bytes(
    std::ofstream& output,
    std::uint32_t version,
    std::uint64_t payload_bytes,
    std::uint64_t fnv,
    std::uint32_t crc)
{
    output.write(kMagic, 4);
    unsigned char header[28];
    auto put_u32 = [&](std::size_t at, std::uint32_t value)
    {
        header[at] = static_cast<unsigned char>(value & 0xffu);
        header[at + 1] = static_cast<unsigned char>((value >> 8) & 0xffu);
        header[at + 2] = static_cast<unsigned char>((value >> 16) & 0xffu);
        header[at + 3] = static_cast<unsigned char>((value >> 24) & 0xffu);
    };
    auto put_u64 = [&](std::size_t at, std::uint64_t value)
    {
        for (int index = 0; index < 8; ++index)
        {
            header[at + static_cast<std::size_t>(index)] =
                static_cast<unsigned char>((value >> (8 * index)) & 0xffu);
        }
    };
    put_u32(0, version);
    put_u64(4, payload_bytes);
    put_u64(12, fnv);
    put_u32(20, crc);
    put_u32(24, 0);
    output.write(reinterpret_cast<const char*>(header), 28);
    if (!output)
    {
        throw std::runtime_error("checkpoint could not write a temporary file");
    }
}

void stream_payload(
    StreamWriter& writer,
    const CheckpointDocument& document,
    const CheckpointScalarTables* scalars)
{
    writer.u8(document.kind);
    writer.u8(document.algorithm);
    writer.u8(document.frozen ? 1 : 0);
    writer.u8(0);
    writer.i32(document.tables.iterations);
    writer.i32(document.samples);
    writer.f64(document.accuracy);
    writer.text(kUtility);
    writer.text(document.config_text);
    writer.ints(document.tables.oop_combos);
    writer.ints(document.tables.ip_combos);
    if (document.tables.slot_actions.size() > 0xffffffffu)
    {
        throw std::invalid_argument("checkpoint action list is too long");
    }
    writer.u32(static_cast<std::uint32_t>(document.tables.slot_actions.size()));
    for (std::uint16_t count : document.tables.slot_actions)
    {
        const unsigned char bytes[2] = {
            static_cast<unsigned char>(count & 0xffu),
            static_cast<unsigned char>((count >> 8) & 0xffu)};
        writer.raw(bytes, 2);
    }
    if (scalars != nullptr && !scalars->regret.empty())
    {
        writer.scalar_as_doubles(scalars->regret);
    }
    else
    {
        writer.doubles(document.tables.regret);
    }
    if (scalars != nullptr && !scalars->strategy_sum.empty())
    {
        writer.scalar_as_doubles(scalars->strategy_sum);
    }
    else
    {
        writer.doubles(document.tables.strategy_sum);
    }
    writer.f64(document.value);
    writer.f64(document.p1_best_response);
    writer.f64(document.p2_best_response);
    writer.f64(document.nash_gap);
    writer.f64(document.runtime_seconds);
    writer.ints(document.sample_iterations);
    writer.doubles(document.sample_values);
    writer.doubles(document.sample_gaps);
    writer.text(document.locks_text);

    if (!wants_continuation_section(document, scalars))
    {
        return;
    }
    std::uint8_t flags = 0;
    if (document.has_dcfr_params)
    {
        flags = static_cast<std::uint8_t>(flags | kFlagDcfrParams);
    }
    const bool use_scalar_prediction =
        scalars != nullptr && !scalars->prediction.empty();
    if (use_scalar_prediction || !document.prediction.empty())
    {
        flags = static_cast<std::uint8_t>(flags | kFlagPrediction);
    }
    writer.u8(flags);
    if ((flags & kFlagDcfrParams) != 0)
    {
        writer.f64(document.dcfr.alpha);
        writer.f64(document.dcfr.beta);
        writer.f64(document.dcfr.gamma);
    }
    if ((flags & kFlagPrediction) != 0)
    {
        if (use_scalar_prediction)
        {
            writer.scalar_as_doubles(scalars->prediction);
        }
        else
        {
            writer.doubles(document.prediction);
        }
    }
}

} // namespace

std::uint64_t estimate_checkpoint_payload_bytes(
    const CheckpointDocument& document,
    const CheckpointScalarTables* scalars)
{
    validate_document_shape(document, scalars);
    const std::size_t regret_count = scalars != nullptr && !scalars->regret.empty()
        ? scalars->regret.size()
        : document.tables.regret.size();
    const std::size_t strategy_count = scalars != nullptr && !scalars->strategy_sum.empty()
        ? scalars->strategy_sum.size()
        : document.tables.strategy_sum.size();
    const bool use_scalar_prediction =
        scalars != nullptr && !scalars->prediction.empty();
    const std::size_t prediction_count =
        use_scalar_prediction ? scalars->prediction.size() : document.prediction.size();

    std::uint64_t bytes = 0;
    bytes += 4; // kind/algorithm/frozen/pad
    bytes += 4; // iterations
    bytes += 4; // samples
    bytes += 8; // accuracy
    bytes += text_bytes(kUtility.size());
    bytes += text_bytes(document.config_text.size());
    bytes += list_bytes_u32_prefix(document.tables.oop_combos.size(), 4);
    bytes += list_bytes_u32_prefix(document.tables.ip_combos.size(), 4);
    bytes += list_bytes_u32_prefix(document.tables.slot_actions.size(), 2);
    bytes += list_bytes_u32_prefix(regret_count, 8);
    bytes += list_bytes_u32_prefix(strategy_count, 8);
    bytes += 8 * 5; // value, brs, gap, runtime
    bytes += list_bytes_u32_prefix(document.sample_iterations.size(), 4);
    bytes += list_bytes_u32_prefix(document.sample_values.size(), 8);
    bytes += list_bytes_u32_prefix(document.sample_gaps.size(), 8);
    bytes += text_bytes(document.locks_text.size());
    if (wants_continuation_section(document, scalars))
    {
        bytes += 1; // flags
        if (document.has_dcfr_params)
        {
            bytes += 24;
        }
        if (prediction_count != 0)
        {
            bytes += list_bytes_u32_prefix(prediction_count, 8);
        }
    }
    return bytes;
}

void write_checkpoint(
    const std::string& path,
    const CheckpointDocument& document,
    CheckpointFault fault,
    std::uint64_t max_payload_bytes,
    const CheckpointScalarTables* scalars)
{
    static_assert(std::endian::native == std::endian::little);
    const std::uint64_t estimated = estimate_checkpoint_payload_bytes(document, scalars);
    if (estimated > max_payload_bytes)
    {
        throw std::invalid_argument("checkpoint is outside the allocation limit");
    }
    const std::uint32_t version = wants_continuation_section(document, scalars)
        ? kVersionContinuation
        : kVersionLocks;

    const std::filesystem::path destination(path);
    const std::filesystem::path temporary(destination.string() + ".tmp");
    try
    {
        {
            std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
            if (!output)
            {
                throw std::runtime_error("checkpoint could not open a temporary file");
            }
            // Placeholder header; rewritten after the payload checksums are known.
            write_header_bytes(output, version, 0, 0, 0);
            StreamWriter writer(output);
            stream_payload(writer, document, scalars);
            if (writer.size() != estimated)
            {
                throw std::runtime_error("checkpoint payload size mismatch");
            }
            if (writer.size() > max_payload_bytes)
            {
                throw std::invalid_argument("checkpoint is outside the allocation limit");
            }
            output.flush();
            if (!output)
            {
                throw std::runtime_error("checkpoint could not write a temporary file");
            }
            output.seekp(0, std::ios::beg);
            if (!output)
            {
                throw std::runtime_error("checkpoint could not write a temporary file");
            }
            write_header_bytes(output, version, writer.size(), writer.fnv(), writer.crc());
            output.flush();
            if (!output)
            {
                throw std::runtime_error("checkpoint could not write a temporary file");
            }
        }
        if (fault == CheckpointFault::BeforeReplace)
        {
            std::filesystem::remove(temporary);
            throw std::runtime_error("checkpoint replace aborted");
        }
        replace_file(temporary, destination);
    }
    catch (...)
    {
        std::error_code ignored;
        std::filesystem::remove(temporary, ignored);
        throw;
    }
}

CheckpointDocument read_checkpoint(const std::string& path, std::uint64_t max_payload_bytes)
{
    static_assert(std::endian::native == std::endian::little);
    const std::filesystem::path file_path(path);
    std::error_code error;
    const std::uintmax_t file_size = std::filesystem::file_size(file_path, error);
    if (error)
    {
        throw std::invalid_argument("checkpoint could not be read");
    }
    if (file_size < kHeaderBytes || file_size - kHeaderBytes > max_payload_bytes)
    {
        throw std::invalid_argument("checkpoint is outside the allocation limit");
    }
    std::ifstream input(file_path, std::ios::binary);
    if (!input)
    {
        throw std::invalid_argument("checkpoint could not be read");
    }
    std::string file(static_cast<std::size_t>(file_size), '\0');
    input.read(file.data(), static_cast<std::streamsize>(file.size()));
    if (!input || file.compare(0, 4, "PSOL") != 0)
    {
        throw std::invalid_argument("checkpoint could not be read");
    }
    Reader header(std::string_view(file).substr(4));
    const std::uint32_t version = header.u32();
    if (version < kVersionMin || version > kVersionMax)
    {
        throw std::invalid_argument("unsupported checkpoint version");
    }
    const std::uint64_t payload_bytes = header.u64();
    const std::uint64_t expected_fnv = header.u64();
    const std::uint32_t expected_crc = header.u32();
    (void)header.u32();
    if (payload_bytes > max_payload_bytes || payload_bytes != file.size() - kHeaderBytes)
    {
        throw std::invalid_argument("checkpoint is outside the allocation limit");
    }
    const std::string_view payload(file.data() + kHeaderBytes, static_cast<std::size_t>(payload_bytes));
    if (fnv1a64(payload) != expected_fnv || crc32(payload) != expected_crc)
    {
        throw std::invalid_argument("checkpoint checksum does not match");
    }
    Reader reader(payload);
    CheckpointDocument document;
    document.kind = reader.u8();
    document.algorithm = reader.u8();
    const std::uint8_t frozen = reader.u8();
    (void)reader.u8();
    document.tables.iterations = reader.i32();
    document.samples = reader.i32();
    document.accuracy = reader.f64();
    const std::string utility = reader.text();
    document.config_text = reader.text();
    document.tables.oop_combos = read_ints(reader);
    document.tables.ip_combos = read_ints(reader);
    const std::uint32_t slots = reader.u32();
    document.tables.slot_actions.reserve(slots);
    for (std::uint32_t index = 0; index < slots; ++index)
    {
        document.tables.slot_actions.push_back(reader.u16());
    }
    document.tables.regret = read_doubles(reader);
    document.tables.strategy_sum = read_doubles(reader);
    document.value = reader.f64();
    document.p1_best_response = reader.f64();
    document.p2_best_response = reader.f64();
    document.nash_gap = reader.f64();
    document.runtime_seconds = reader.f64();
    document.sample_iterations = read_ints(reader);
    document.sample_values = read_doubles(reader);
    document.sample_gaps = read_doubles(reader);
    if (version >= kVersionLocks)
    {
        document.locks_text = reader.text();
    }
    if (version >= kVersionContinuation)
    {
        const std::uint8_t flags = reader.u8();
        if ((flags & ~static_cast<std::uint8_t>(kFlagDcfrParams | kFlagPrediction)) != 0)
        {
            throw std::invalid_argument("checkpoint continuation flags are unknown");
        }
        if ((flags & kFlagDcfrParams) != 0)
        {
            document.has_dcfr_params = true;
            document.dcfr.alpha = reader.f64();
            document.dcfr.beta = reader.f64();
            document.dcfr.gamma = reader.f64();
        }
        if ((flags & kFlagPrediction) != 0)
        {
            document.prediction = read_doubles(reader);
        }
    }
    if (!reader.done())
    {
        throw std::invalid_argument("checkpoint has trailing bytes");
    }
    if ((document.kind != 1 && document.kind != 2)
        || document.algorithm > poker::solver::kAlgorithmTagMax
        || (frozen != 0 && frozen != 1))
    {
        throw std::invalid_argument("checkpoint shape is invalid");
    }
    document.frozen = frozen == 1;
    if (utility != kUtility || document.config_text.empty() || document.tables.iterations < 0 || document.samples < 1)
    {
        throw std::invalid_argument("checkpoint shape is invalid");
    }
    if (document.sample_iterations.size() != document.sample_values.size()
        || document.sample_iterations.size() != document.sample_gaps.size())
    {
        throw std::invalid_argument("checkpoint samples do not line up");
    }
    if (!document.prediction.empty()
        && document.prediction.size() != document.tables.regret.size())
    {
        throw std::invalid_argument("checkpoint prediction size does not match tables");
    }
    if (document.has_dcfr_params
        && (!std::isfinite(document.dcfr.alpha)
            || !std::isfinite(document.dcfr.beta)
            || !std::isfinite(document.dcfr.gamma)))
    {
        throw std::invalid_argument("checkpoint DCFR parameters must be finite");
    }
    return document;
}

} // namespace poker::explorer

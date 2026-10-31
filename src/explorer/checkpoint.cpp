#include "explorer/checkpoint.hpp"

#include <bit>
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
constexpr std::uint32_t kVersionWrite = 2;
constexpr std::uint32_t kVersionMin = 1;
constexpr std::uint32_t kVersionMax = 2;
constexpr std::string_view kUtility = "root_centered_zero_sum";

void append_bytes(std::string& out, const void* data, std::size_t size)
{
    out.append(static_cast<const char*>(data), size);
}

void append_u8(std::string& out, std::uint8_t value)
{
    out.push_back(static_cast<char>(value));
}

void append_u32(std::string& out, std::uint32_t value)
{
    const unsigned char bytes[4] = {
        static_cast<unsigned char>(value & 0xffu),
        static_cast<unsigned char>((value >> 8) & 0xffu),
        static_cast<unsigned char>((value >> 16) & 0xffu),
        static_cast<unsigned char>((value >> 24) & 0xffu)};
    append_bytes(out, bytes, 4);
}

void append_u64(std::string& out, std::uint64_t value)
{
    unsigned char bytes[8];
    for (int index = 0; index < 8; ++index)
    {
        bytes[index] = static_cast<unsigned char>((value >> (8 * index)) & 0xffu);
    }
    append_bytes(out, bytes, 8);
}

void append_i32(std::string& out, int value)
{
    append_u32(out, static_cast<std::uint32_t>(value));
}

void append_f64(std::string& out, double value)
{
    std::uint64_t bits = 0;
    static_assert(sizeof(double) == sizeof(bits));
    std::memcpy(&bits, &value, sizeof(bits));
    append_u64(out, bits);
}

std::uint64_t fnv1a64(std::string_view bytes)
{
    std::uint64_t hash = 14695981039346656037ull;
    for (unsigned char byte : bytes)
    {
        hash ^= byte;
        hash *= 1099511628211ull;
    }
    return hash;
}

std::uint32_t crc32(std::string_view bytes)
{
    std::uint32_t crc = 0xffffffffu;
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
    return ~crc;
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

void append_ints(std::string& out, const std::vector<int>& values)
{
    if (values.size() > 0xffffffffu)
    {
        throw std::invalid_argument("checkpoint list is too long");
    }
    append_u32(out, static_cast<std::uint32_t>(values.size()));
    for (int value : values)
    {
        append_i32(out, value);
    }
}

void append_doubles(std::string& out, const std::vector<double>& values)
{
    if (values.size() > 0xffffffffu)
    {
        throw std::invalid_argument("checkpoint list is too long");
    }
    append_u32(out, static_cast<std::uint32_t>(values.size()));
    for (double value : values)
    {
        append_f64(out, value);
    }
}

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

std::string payload_of(const CheckpointDocument& document)
{
    if (document.kind != 1 && document.kind != 2)
    {
        throw std::invalid_argument("checkpoint kind is not a street or river solve");
    }
    if (document.algorithm > 2)
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
    std::string out;
    append_u8(out, document.kind);
    append_u8(out, document.algorithm);
    append_u8(out, document.frozen ? 1 : 0);
    append_u8(out, 0);
    append_i32(out, document.tables.iterations);
    append_i32(out, document.samples);
    append_f64(out, document.accuracy);
    append_u32(out, static_cast<std::uint32_t>(kUtility.size()));
    out.append(kUtility);
    append_u32(out, static_cast<std::uint32_t>(document.config_text.size()));
    out.append(document.config_text);
    append_ints(out, document.tables.oop_combos);
    append_ints(out, document.tables.ip_combos);
    append_u32(out, static_cast<std::uint32_t>(document.tables.slot_actions.size()));
    for (std::uint16_t count : document.tables.slot_actions)
    {
        const unsigned char bytes[2] = {
            static_cast<unsigned char>(count & 0xffu),
            static_cast<unsigned char>((count >> 8) & 0xffu)};
        append_bytes(out, bytes, 2);
    }
    append_doubles(out, document.tables.regret);
    append_doubles(out, document.tables.strategy_sum);
    append_f64(out, document.value);
    append_f64(out, document.p1_best_response);
    append_f64(out, document.p2_best_response);
    append_f64(out, document.nash_gap);
    append_f64(out, document.runtime_seconds);
    append_ints(out, document.sample_iterations);
    append_doubles(out, document.sample_values);
    append_doubles(out, document.sample_gaps);
    // Version 2 trailing section: lock-set text (may be empty).
    append_u32(out, static_cast<std::uint32_t>(document.locks_text.size()));
    out.append(document.locks_text);
    return out;
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

} // namespace

void write_checkpoint(
    const std::string& path,
    const CheckpointDocument& document,
    CheckpointFault fault)
{
    static_assert(std::endian::native == std::endian::little);
    const std::string payload = payload_of(document);
    std::string file;
    file.append(kMagic, 4);
    append_u32(file, kVersionWrite);
    append_u64(file, payload.size());
    append_u64(file, fnv1a64(payload));
    append_u32(file, crc32(payload));
    append_u32(file, 0);
    file.append(payload);

    const std::filesystem::path destination(path);
    const std::filesystem::path temporary(destination.string() + ".tmp");
    {
        std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
        if (!output)
        {
            throw std::runtime_error("checkpoint could not open a temporary file");
        }
        output.write(file.data(), static_cast<std::streamsize>(file.size()));
        if (!output)
        {
            output.close();
            std::filesystem::remove(temporary);
            throw std::runtime_error("checkpoint could not write a temporary file");
        }
        output.flush();
        if (!output)
        {
            output.close();
            std::filesystem::remove(temporary);
            throw std::runtime_error("checkpoint could not write a temporary file");
        }
    }
    if (fault == CheckpointFault::BeforeReplace)
    {
        std::filesystem::remove(temporary);
        throw std::runtime_error("checkpoint replace aborted");
    }
    try
    {
        replace_file(temporary, destination);
    }
    catch (...)
    {
        std::filesystem::remove(temporary);
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
    constexpr std::uint64_t kHeader = 32;
    if (file_size < kHeader || file_size - kHeader > max_payload_bytes)
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
    if (payload_bytes > max_payload_bytes || payload_bytes != file.size() - kHeader)
    {
        throw std::invalid_argument("checkpoint is outside the allocation limit");
    }
    const std::string_view payload(file.data() + kHeader, static_cast<std::size_t>(payload_bytes));
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
    if (version >= 2)
    {
        document.locks_text = reader.text();
    }
    if (!reader.done())
    {
        throw std::invalid_argument("checkpoint has trailing bytes");
    }
    if ((document.kind != 1 && document.kind != 2) || document.algorithm > 2 || (frozen != 0 && frozen != 1))
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
    return document;
}

} // namespace poker::explorer

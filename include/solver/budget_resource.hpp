#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory_resource>
#include <new>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace poker::solver
{

// Upstream observer. Tests pass one of these as the solver's upstream so a
// throwing constructor can still be measured after it unwinds. Bookkeeping
// inside this object is not part of the engine budget.
class CountingResource final : public std::pmr::memory_resource
{
public:
    explicit CountingResource(std::pmr::memory_resource* upstream = std::pmr::new_delete_resource())
        : upstream_(upstream)
    {
    }

    std::uint64_t current() const
    {
        return current_;
    }

    std::uint64_t peak() const
    {
        return peak_;
    }

    void arm_failure()
    {
        fail_next_ = true;
    }

protected:
    void* do_allocate(std::size_t bytes, std::size_t alignment) override
    {
        if (fail_next_)
        {
            fail_next_ = false;
            throw std::bad_alloc();
        }
        void* pointer = upstream_->allocate(bytes, alignment);
        current_ += static_cast<std::uint64_t>(bytes);
        if (current_ > peak_)
        {
            peak_ = current_;
        }
        return pointer;
    }

    void do_deallocate(void* pointer, std::size_t bytes, std::size_t alignment) override
    {
        const auto size = static_cast<std::uint64_t>(bytes);
        if (size > current_)
        {
            throw std::logic_error("counting resource deallocation exceeded its charge");
        }
        current_ -= size;
        upstream_->deallocate(pointer, bytes, alignment);
    }

    bool do_is_equal(const std::pmr::memory_resource& other) const noexcept override
    {
        return this == &other;
    }

private:
    std::pmr::memory_resource* upstream_ = nullptr;
    std::uint64_t current_ = 0;
    std::uint64_t peak_ = 0;
    bool fail_next_ = false;
};

// Charges the bytes requested from the upstream allocator, including the
// header written in front of each block. The check happens before that call.
// A failed upstream allocation rolls the charge back. Deallocation releases
// it. Peak includes the moment a container holds its old block and its new
// block together.
//
// The component table in this object is control data. It is allocated with
// the global allocator, it is bounded by the number of stage names, and it
// does not store the tree. The header in front of each block is part of the
// charged request, not an exclusion.
class BudgetResource final : public std::pmr::memory_resource
{
public:
    struct Component
    {
        const char* name = "";
        std::uint64_t bytes = 0;
    };

    BudgetResource(std::pmr::memory_resource* upstream, std::uint64_t limit_bytes)
        : upstream_(upstream)
        , limit_(limit_bytes)
    {
        set_stage("allocation");
    }

    std::uint64_t limit() const
    {
        return limit_;
    }

    std::uint64_t current() const
    {
        return current_;
    }

    std::uint64_t peak() const
    {
        return peak_;
    }

    std::uint64_t reserved() const
    {
        return reserved_;
    }

    const std::vector<Component>& components() const
    {
        return components_;
    }

    void set_stage(const char* name)
    {
        stage_ = name;
        for (std::size_t index = 0; index < components_.size(); ++index)
        {
            if (std::strcmp(components_[index].name, name) == 0)
            {
                active_ = static_cast<std::uint16_t>(index);
                return;
            }
        }
        if (components_.size() >= 32)
        {
            throw std::logic_error("street solver budget has too many stages");
        }
        components_.push_back(Component{name, 0});
        active_ = static_cast<std::uint16_t>(components_.size() - 1);
    }

    // Bytes this resource requests from upstream for a user allocation.
    // Includes the header placed in front of the block.
    static std::size_t request_bytes(std::size_t bytes, std::size_t alignment)
    {
        const std::size_t header = header_bytes(alignment);
        if (bytes > std::numeric_limits<std::size_t>::max() - header)
        {
            throw std::bad_alloc();
        }
        return header + bytes;
    }

protected:
    void* do_allocate(std::size_t bytes, std::size_t alignment) override
    {
        const std::size_t raw = request_bytes(bytes, alignment);
        const auto request = static_cast<std::uint64_t>(raw);
        if (current_ > limit_ || request > limit_ - current_)
        {
            deny(stage_, request, saturating_sum(current_, request));
        }
        const std::uint64_t saved_current = current_;
        const std::uint64_t saved_peak = peak_;
        const std::uint64_t saved_component = components_[active_].bytes;
        const std::uint16_t component = active_;
        current_ += request;
        if (current_ > peak_)
        {
            peak_ = current_;
        }
        components_[component].bytes += request;
        try
        {
            const std::size_t align = std::max(alignment, alignof(Block));
            void* memory = upstream_->allocate(raw, align);
            auto* block = static_cast<Block*>(memory);
            block->raw_bytes = raw;
            block->user_bytes = bytes;
            block->component = component;
            return static_cast<unsigned char*>(memory) + header_bytes(alignment);
        }
        catch (...)
        {
            current_ = saved_current;
            peak_ = saved_peak;
            components_[component].bytes = saved_component;
            throw;
        }
    }

    void do_deallocate(void* pointer, std::size_t bytes, std::size_t alignment) override
    {
        const std::size_t header = header_bytes(alignment);
        auto* block = reinterpret_cast<Block*>(static_cast<unsigned char*>(pointer) - header);
        if (block->user_bytes != bytes)
        {
            throw std::logic_error("street solver budget deallocation size mismatch");
        }
        const auto raw = static_cast<std::uint64_t>(block->raw_bytes);
        const std::uint16_t component = block->component;
        if (component >= components_.size() || raw > current_ || raw > components_[component].bytes)
        {
            throw std::logic_error("street solver budget deallocation exceeded the charge");
        }
        current_ -= raw;
        components_[component].bytes -= raw;
        const std::size_t align = std::max(alignment, alignof(Block));
        upstream_->deallocate(block, block->raw_bytes, align);
    }

    bool do_is_equal(const std::pmr::memory_resource& other) const noexcept override
    {
        return this == &other;
    }

private:
    struct Block
    {
        std::size_t raw_bytes = 0;
        std::size_t user_bytes = 0;
        std::uint16_t component = 0;
    };

    static std::size_t header_bytes(std::size_t alignment)
    {
        if (alignment == 0 || (alignment & (alignment - 1)) != 0)
        {
            throw std::bad_alloc();
        }
        const std::size_t align = std::max(alignment, alignof(Block));
        return (sizeof(Block) + align - 1) & ~(align - 1);
    }

    static std::uint64_t saturating_sum(std::uint64_t left, std::uint64_t right)
    {
        if (left > std::numeric_limits<std::uint64_t>::max() - right)
        {
            return std::numeric_limits<std::uint64_t>::max();
        }
        return left + right;
    }

    [[noreturn]] void deny(const char* stage, std::uint64_t request, std::uint64_t requirement) const
    {
        throw std::invalid_argument(
            "street solver memory budget exceeded during " + std::string(stage)
            + ": budget " + std::to_string(limit_)
            + " bytes, allocated " + std::to_string(current_)
            + " bytes, request " + std::to_string(request)
            + " bytes, estimated requirement " + std::to_string(requirement)
            + " bytes");
    }

    std::pmr::memory_resource* upstream_ = nullptr;
    std::uint64_t limit_ = 0;
    std::uint64_t current_ = 0;
    std::uint64_t peak_ = 0;
    std::uint64_t reserved_ = 0;
    const char* stage_ = "allocation";
    std::uint16_t active_ = 0;
    std::vector<Component> components_;
};

} // namespace poker::solver

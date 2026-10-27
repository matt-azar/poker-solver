#include "harness.hpp"

#include "solver/budget_resource.hpp"

#include <cstdint>
#include <memory_resource>
#include <stdexcept>
#include <string>
#include <vector>

namespace
{

void test_exact_limit_and_one_byte_over()
{
    using poker::solver::BudgetResource;
    using poker::solver::CountingResource;
    const std::size_t bytes = 64;
    const std::size_t alignment = 8;
    const std::size_t request = BudgetResource::request_bytes(bytes, alignment);

    CountingResource upstream;
    BudgetResource exact(&upstream, static_cast<std::uint64_t>(request));
    void* pointer = exact.allocate(bytes, alignment);
    CHECK(exact.current() == request);
    CHECK(exact.peak() == request);
    CHECK(upstream.current() == request);
    bool second = false;
    void* extra = nullptr;
    try
    {
        extra = exact.allocate(bytes, alignment);
    }
    catch (const std::invalid_argument&)
    {
        second = true;
    }
    CHECK(second);
    CHECK(extra == nullptr);
    CHECK(exact.current() == request);
    exact.deallocate(pointer, bytes, alignment);
    CHECK(exact.current() == 0);
    CHECK(upstream.current() == 0);
    CHECK(exact.peak() == request);

    CountingResource denied_upstream;
    BudgetResource denied(&denied_upstream, static_cast<std::uint64_t>(request - 1));
    bool refused = false;
    void* denied_pointer = nullptr;
    std::string message;
    try
    {
        denied_pointer = denied.allocate(bytes, alignment);
    }
    catch (const std::invalid_argument& error)
    {
        refused = true;
        message = error.what();
    }
    CHECK(refused);
    CHECK(denied_pointer == nullptr);
    CHECK(message.find("memory budget") != std::string::npos);
    CHECK(message.find("budget ") != std::string::npos);
    CHECK(message.find("allocated ") != std::string::npos);
    CHECK(message.find("request ") != std::string::npos);
    CHECK(denied.current() == 0);
    CHECK(denied.peak() == 0);
    CHECK(denied_upstream.current() == 0);
}

void test_overlap_and_release()
{
    using poker::solver::BudgetResource;
    using poker::solver::CountingResource;
    CountingResource upstream;
    BudgetResource budget(&upstream, 1u << 20);
    void* first = budget.allocate(128, 8);
    void* second = budget.allocate(256, 8);
    const std::uint64_t both = budget.current();
    CHECK(both == budget.peak());
    CHECK(both >= BudgetResource::request_bytes(128, 8) + BudgetResource::request_bytes(256, 8));
    budget.deallocate(first, 128, 8);
    CHECK(budget.current() < budget.peak());
    CHECK(budget.peak() == both);
    budget.deallocate(second, 256, 8);
    CHECK(budget.current() == 0);
    CHECK(upstream.current() == 0);

    {
        std::pmr::vector<std::uint64_t> values(&budget);
        values.resize(8);
        const std::uint64_t after_first = budget.current();
        values.resize(values.capacity() + 1);
        CHECK(budget.peak() > after_first);
        CHECK(budget.peak() > budget.current());
        std::pmr::string text(&budget);
        text.append(4000, 'x');
        CHECK(budget.current() > 0);
    }
    CHECK(budget.current() == 0);
    CHECK(upstream.current() == 0);
}

void test_upstream_failure_rolls_back()
{
    using poker::solver::BudgetResource;
    using poker::solver::CountingResource;
    CountingResource upstream;
    BudgetResource budget(&upstream, 1u << 20);
    upstream.arm_failure();
    bool threw = false;
    void* failed = nullptr;
    try
    {
        failed = budget.allocate(32, 8);
    }
    catch (const std::bad_alloc&)
    {
        threw = true;
    }
    CHECK(threw);
    CHECK(failed == nullptr);
    CHECK(budget.current() == 0);
    CHECK(budget.peak() == 0);
    CHECK(upstream.current() == 0);
    void* pointer = budget.allocate(32, 8);
    CHECK(budget.current() == BudgetResource::request_bytes(32, 8));
    budget.deallocate(pointer, 32, 8);
    CHECK(budget.current() == 0);
    CHECK(upstream.peak() == BudgetResource::request_bytes(32, 8));
}

} // namespace

void run_budget_tests()
{
    test_exact_limit_and_one_byte_over();
    test_overlap_and_release();
    test_upstream_failure_rolls_back();
}

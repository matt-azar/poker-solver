#include "server_shared.hpp"

namespace explorer_detail
{

std::thread g_worker;
poker::explorer::ValueWorker* g_values = nullptr;
poker::explorer::Session g_session;
std::string g_ui_root = "legacy/ui";
std::uint64_t g_equity_max_pair_runouts = poker::holdem::kDefaultMaxPairRunouts;
std::filesystem::path g_templates_root;
std::filesystem::path g_ranges_root;

}  // namespace explorer_detail

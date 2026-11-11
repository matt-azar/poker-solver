#pragma once

// Product version from CMake PROJECT_VERSION; git SHA optional compile define.
#ifndef POKER_SOLVER_VERSION
#define POKER_SOLVER_VERSION "0.1.0"
#endif
#ifndef POKER_SOLVER_GIT_SHA
#define POKER_SOLVER_GIT_SHA "unknown"
#endif

namespace poker
{

inline constexpr const char* solver_version()
{
    return POKER_SOLVER_VERSION;
}

inline constexpr const char* solver_git_sha()
{
    return POKER_SOLVER_GIT_SHA;
}

} // namespace poker

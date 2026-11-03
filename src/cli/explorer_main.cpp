#include "../explorer/server_shared.hpp"

// server_shared.hpp lives under src/explorer/; added to include path in CMake.
int main(int argc, char** argv)
{
    return explorer_detail::run(argc, argv);
}

// Copyright (c) Matt Azar. UNLICENSED — no license is granted.
#pragma once

#include <cctype>
#include <string>
#include <string_view>

namespace poker::explorer
{

/// Origins allowed to call Explorer from a browser / Tauri webview.
/// Packaged Study (`--study-packaged`) reflects only these; developer mode
/// still falls back to `*` when the Origin is absent or unrecognized.
inline bool cors_origin_allowed(std::string_view origin)
{
    if (origin.empty() || origin.size() > 256)
    {
        return false;
    }
    for (const unsigned char ch : origin)
    {
        // Reject CR/LF / NUL so a malicious Origin cannot inject headers.
        if (ch < 0x20 || ch == 0x7f)
        {
            return false;
        }
    }
    if (origin == "https://tauri.localhost" || origin == "http://tauri.localhost"
        || origin == "tauri://localhost")
    {
        return true;
    }

    auto loopback_with_optional_port = [](std::string_view host_and_rest, std::string_view host) {
        if (host_and_rest == host)
        {
            return true;
        }
        if (host_and_rest.size() <= host.size() + 1)
        {
            return false;
        }
        if (host_and_rest.compare(0, host.size(), host) != 0 || host_and_rest[host.size()] != ':')
        {
            return false;
        }
        const std::string_view port = host_and_rest.substr(host.size() + 1);
        if (port.empty() || port.size() > 5)
        {
            return false;
        }
        int value = 0;
        for (const unsigned char ch : port)
        {
            if (!std::isdigit(ch))
            {
                return false;
            }
            value = value * 10 + (ch - '0');
            if (value > 65535)
            {
                return false;
            }
        }
        return value >= 1 && value <= 65535;
    };

    constexpr std::string_view kHttp = "http://";
    if (origin.size() > kHttp.size() && origin.compare(0, kHttp.size(), kHttp) == 0)
    {
        const std::string_view rest = origin.substr(kHttp.size());
        if (loopback_with_optional_port(rest, "127.0.0.1")
            || loopback_with_optional_port(rest, "localhost")
            || loopback_with_optional_port(rest, "[::1]"))
        {
            return true;
        }
    }
    return false;
}

/// Extract a single Origin header value (first match, trimmed). Empty if absent.
inline std::string cors_request_origin(std::string_view request)
{
    constexpr std::string_view kName = "origin:";
    std::size_t cursor = 0;
    while (cursor < request.size())
    {
        const std::size_t line_end = request.find("\r\n", cursor);
        const std::size_t end = line_end == std::string_view::npos ? request.size() : line_end;
        std::string_view line = request.substr(cursor, end - cursor);
        if (line.empty())
        {
            break; // end of headers
        }
        if (line.size() >= kName.size())
        {
            bool match = true;
            for (std::size_t i = 0; i < kName.size(); ++i)
            {
                const unsigned char a = static_cast<unsigned char>(line[i]);
                const unsigned char b = static_cast<unsigned char>(kName[i]);
                if (std::tolower(a) != b)
                {
                    match = false;
                    break;
                }
            }
            if (match)
            {
                std::string_view value = line.substr(kName.size());
                while (!value.empty() && (value.front() == ' ' || value.front() == '\t'))
                {
                    value.remove_prefix(1);
                }
                while (!value.empty() && (value.back() == ' ' || value.back() == '\t'))
                {
                    value.remove_suffix(1);
                }
                return std::string(value);
            }
        }
        if (line_end == std::string_view::npos)
        {
            break;
        }
        cursor = line_end + 2;
    }
    return {};
}

/// Build CORS response headers for one request.
/// - Allowed Origin → reflect it + Vary
/// - Developer mode + unrecognized/missing Origin → `*`
/// - Packaged mode + unrecognized/missing Origin → omit Allow-Origin
inline std::string cors_response_headers(std::string_view origin, bool study_packaged)
{
    std::string headers =
        "Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS\r\n"
        "Access-Control-Allow-Headers: Content-Type\r\n"
        "Access-Control-Allow-Private-Network: true\r\n";
    if (!origin.empty() && cors_origin_allowed(origin))
    {
        headers += "Access-Control-Allow-Origin: ";
        headers += origin;
        headers += "\r\n";
        headers += "Vary: Origin\r\n";
        return headers;
    }
    if (!study_packaged)
    {
        headers += "Access-Control-Allow-Origin: *\r\n";
    }
    return headers;
}

} // namespace poker::explorer

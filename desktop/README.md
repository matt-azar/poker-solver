# Hold'em Study client

React + TypeScript + Vite UI. Packaged Study talks to the Zig `solver-engine` sidecar over typed IPC (protocol 2). See [docs/DESKTOP_UI.md](../docs/DESKTOP_UI.md).

## Develop

```sh
# from repo root — Zig engine
zig build -Doptimize=ReleaseFast

# from desktop/ — Tauri shell (spawns solver-engine)
npm ci
npm run tauri dev
```

Browser-only `npm run dev` does not start an engine (HTTP `holdem-explorer` was removed).

## Test / build

```sh
npm test
npm run build
```

Live OpenAI interpretation eval (skipped without a key; **not** part of ordinary CI):

```sh
HOLDEM_STUDY_OPENAI_KEY=sk-... npm run test:assistant-live
```

## Setup assistant notes

- Range charts: Build → **Catalogue** (seat×action tree). See `configs/range-profiles/README.md`. Equity → **Import JSON** loads an equity scenario, not a range profile.
- OpenAI credentials: prefer Tauri `assistant_secret_*` (OS keyring; legacy `assistant_secrets.json` migrate-on-read) in the packaged app; browser prototype may use `holdem-study-openai-key` localStorage. Never commit keys. A distributed product should use an authenticated backend proxy.

## License

Package metadata is `UNLICENSED` (no license granted). See the repository `LICENSE`.

# Hold'em Study client

React + TypeScript + Vite UI for the `explorer` HTTP API. See [docs/DESKTOP_UI.md](../docs/DESKTOP_UI.md).

## Develop

```sh
# from repo root — build and run the engine
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --target explorer
./build/explorer --port 8765

# from desktop/
npm install
npm run dev
```

Open the Vite URL (default `http://127.0.0.1:5173`). `/api` is proxied to the explorer.

## Test / build

```sh
npm test
npm run build
```

Live OpenAI interpretation eval (skipped without a key; **not** part of ordinary CI):

```sh
HOLDEM_STUDY_OPENAI_KEY=sk-... npm run test:assistant-live
```

After `npm run build`, `explorer` prefers `desktop/dist` over legacy `ui/` when both are present.

## Setup assistant notes

- Range JSON import: Build → **Range catalogue** → Import JSON… (see `configs/range-profiles/README.md`).
- OpenAI credentials: prefer Tauri `assistant_secret_*` storage in the packaged app; browser prototype may use `holdem-study-openai-key` localStorage. Never commit keys. A distributed product should use an authenticated backend proxy.

## License

Package metadata is `UNLICENSED` (no license granted). See the repository `LICENSE`.

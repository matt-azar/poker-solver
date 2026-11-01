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

After `npm run build`, `explorer` prefers `desktop/dist` over legacy `ui/` when both are present.

## License

Package metadata is `UNLICENSED` (no license granted). See the repository `LICENSE`.

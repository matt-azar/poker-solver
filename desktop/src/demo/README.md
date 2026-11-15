# Public Hold’em Study demo (precomputed)

Browse-only Study UI over static packs under `public/demo/`. Live solving stays
on the Windows Tauri + `solver-engine` path. Private QA
(`?preview=node-locking` / `npm run preview:scenario`) is a **separate** entry.

## Pack layout

Written by `scripts/public-demo/export_solutions.py` (merged via #411).
Schema: `desktop/public-demo/schema/manifest.v1.schema.json`.

```text
public/demo/
  catalog.json
  flop-explore/
    manifest.json
    baseline/{status,locks,index,expected}.json
    baseline/{nodes,values,equity}/<node_id>.json
  river-lock/
    manifest.json
    baseline/…
    oop-always-check/… + lock_preset.json
```

## Run (dev)

```bash
cd desktop
npm run preview:scenario   # private QA — do not use for public demo
npx vite --host 127.0.0.1 --port 5173
# open http://127.0.0.1:5173/?demo=flop-explore
#      http://127.0.0.1:5173/?demo=river-lock&variant=oop-always-check
```

## Static build (CI / deploy)

```bash
cd desktop
npm run build:public-demo
# output: desktop/dist-public-demo/
npm run preview:public-demo
# http://127.0.0.1:4173/?demo=flop-explore
```

Sample URLs:

- `/?demo=flop-explore`
- `/?demo=flop-explore&node=p1.t-1.r-1`
- `/?demo=river-lock&variant=oop-always-check`

## Playwright

```bash
cd desktop
npm run build:public-demo
npm run test:e2e:public-demo
```

## Download for Windows

Banner link →  
`https://github.com/matt-azar/poker-solver/releases/latest/download/Holdem-Study-windows-x64-setup.exe`

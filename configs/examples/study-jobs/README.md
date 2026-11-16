# Example portable study jobs

`holdem-study-job/1` JSON + river `hand-history 1` fixtures for Build / CLI.

| File | Role |
| --- | --- |
| `river_btn_bb_srp.hh.txt` | HU river hand history (BTN vs BB SRP) |
| `river_btn_bb_srp.job.json` | Reviewable portable job (from `holdem-study-cli from-hh`) |

Range notes use **position + preflop family** (BTN vs BB SRP). They do not use stakes labels (e.g. 100NL) as range-selection keys.

```sh
zig build
./zig-out/bin/holdem-study-cli from-hh configs/examples/study-jobs/river_btn_bb_srp.hh.txt \
  --out configs/examples/study-jobs/river_btn_bb_srp.job.json --iterations 20
./zig-out/bin/holdem-study-cli plan configs/examples/study-jobs/river_btn_bb_srp.job.json
./zig-out/bin/holdem-study-cli solve configs/examples/study-jobs/river_btn_bb_srp.job.json \
  --out /tmp/study.psol --engine ./zig-out/bin/solver-engine
```

Build **Export job** / **Import job** round-trip the same JSON. Preview uses the job’s `street_config` text.

# Benchmarks

Product checks:

```sh
zig build test -Dcpu=x86_64_v2
python3 scripts/zig/study-contract-smoke.py ./zig-out/bin/solver-engine
```

Study fixture configs live under [benchmarks/study/](../../../benchmarks/study/). Optional digs are in [ZIG_RELEASE_GATES.md](ZIG_RELEASE_GATES.md). Accuracy and time-to-Accuracy scoreboards are not merge gates. See [TESTING.md](TESTING.md).

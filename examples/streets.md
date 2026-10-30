# Turn and flop CLI

```sh
street_solver
street_solver --config configs/street_default.txt
street_solver --board Ah,Kd,7c --pot 100 --stack 200 --oop-range QcQd --ip-range JcJd --no-all-in --max-raises 0 --iterations 1
```

`--config` reads a `street-config 1` document. Later flags override fields from the file. Rules: [docs/STREETS.md](../docs/STREETS.md).

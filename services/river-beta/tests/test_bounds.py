# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from bounds import (  # noqa: E402
    BoundsError,
    RiverBetaBounds,
    clamp_solve_params,
    enforce_river_only,
    rewrite_config_with_caps,
)


RIVER = """street-config 1
board Ah Kh Qh Jh 2c
pot 100
stack 100
oop-range AsQs:1,2d2h:1
ip-range AsQs:1,2d2h:1
oop-river-bets 1
ip-river-bets 1
memory-mib 64
threads 1
"""

FLOP = """street-config 1
board Ah Kh Qh
pot 100
stack 100
oop-range AsQs:1
ip-range AsQs:1
oop-flop-bets 0.5
ip-flop-bets 0.5
memory-mib 64
threads 1
"""


class BoundsTests(unittest.TestCase):
    def test_river_ok(self) -> None:
        fields = enforce_river_only(RIVER, RiverBetaBounds())
        self.assertEqual(fields["memory-mib"], "64")
        self.assertEqual(fields["threads"], "1")

    def test_rejects_flop_board(self) -> None:
        with self.assertRaises(BoundsError) as ctx:
            enforce_river_only(FLOP, RiverBetaBounds())
        self.assertEqual(ctx.exception.code, "river_only")

    def test_rejects_flop_bet_keys_on_river_board(self) -> None:
        text = RIVER + "oop-flop-bets 0.5\n"
        with self.assertRaises(BoundsError) as ctx:
            enforce_river_only(text, RiverBetaBounds())
        self.assertEqual(ctx.exception.code, "river_only")

    def test_memory_cap(self) -> None:
        text = RIVER.replace("memory-mib 64", "memory-mib 9999")
        with self.assertRaises(BoundsError) as ctx:
            enforce_river_only(text, RiverBetaBounds())
        self.assertEqual(ctx.exception.code, "memory_bound")

    def test_combo_cap(self) -> None:
        many = ",".join(f"As{r}:1" for r in "23456789TJQK")
        text = RIVER.replace("oop-range AsQs:1,2d2h:1", f"oop-range {many}")
        with self.assertRaises(BoundsError) as ctx:
            enforce_river_only(text, RiverBetaBounds(max_weighted_combos_per_player=4))
        self.assertEqual(ctx.exception.code, "tree_bound")

    def test_rewrite_caps(self) -> None:
        fields = enforce_river_only(RIVER, RiverBetaBounds())
        fields["memory-mib"] = "32"
        fields["threads"] = "1"
        out = rewrite_config_with_caps(RIVER, fields)
        self.assertIn("memory-mib 32", out)
        self.assertTrue(out.startswith("street-config 1\n"))

    def test_clamp_solve(self) -> None:
        b = RiverBetaBounds()
        params = clamp_solve_params({"iterations": 10, "time_limit": 5}, b)
        self.assertEqual(params["iterations"], 10)
        self.assertEqual(params["time_limit"], 5.0)

    def test_reject_unlimited_time(self) -> None:
        with self.assertRaises(BoundsError):
            clamp_solve_params({"time_limit": -1}, RiverBetaBounds())

    def test_reject_huge_iterations(self) -> None:
        with self.assertRaises(BoundsError) as ctx:
            clamp_solve_params({"iterations": 99999}, RiverBetaBounds())
        self.assertEqual(ctx.exception.code, "runtime_bound")


if __name__ == "__main__":
    unittest.main()

# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Allow ``python -m debug`` when ``scripts`` is on PYTHONPATH.

Examples::

  PYTHONPATH=scripts python -m debug collect --zip --stacks
  set PYTHONPATH=scripts&& python -m debug gui
"""

from __future__ import annotations

import sys
from pathlib import Path

# Support both ``PYTHONPATH=scripts python -m debug`` and direct path quirks.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

try:
    from .study_debug import main
except ImportError:
    from study_debug import main

raise SystemExit(main())

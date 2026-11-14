#!/usr/bin/env python3
# Copyright (c) Matt Azar. UNLICENSED — no license is granted.
"""Lightweight local GUI for the Study crash/hang debug suite.

Stdlib only (tkinter). Opens from::

  python scripts/debug/study_debug.py gui
  scripts\\debug\\study-debug.cmd

Does not ship with the installed Study product — tooling for a repo clone.
"""

from __future__ import annotations

import os
import queue
import subprocess
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, scrolledtext, ttk
from typing import Optional

_HERE = Path(__file__).resolve().parent
_STUDY_DEBUG = _HERE / "study_debug.py"


def _python() -> str:
    return sys.executable or "python3"


def _default_diagnostics_hint() -> str:
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA") or r"%LOCALAPPDATA%"
        return str(Path(local) / "Holdem Study" / "diagnostics")
    return str(Path.home() / ".local" / "share" / "Holdem Study" / "diagnostics")


class StudyDebugApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Holdem Study — Debug Suite")
        self.minsize(720, 520)
        self.geometry("880x640")

        self._proc: Optional[subprocess.Popen[str]] = None
        self._out_q: queue.Queue[str] = queue.Queue()
        self._worker: Optional[threading.Thread] = None

        self._build()
        self.after(100, self._drain_queue)

    def _build(self) -> None:
        pad = {"padx": 8, "pady": 4}
        root = ttk.Frame(self, padding=10)
        root.pack(fill=tk.BOTH, expand=True)

        intro = ttk.Label(
            root,
            text=(
                "External crash/hang tools for the Windows installed Study build.\n"
                "Leave Study open while frozen. Repo clone = tooling only."
            ),
            justify=tk.LEFT,
        )
        intro.pack(anchor=tk.W, **pad)

        paths = ttk.LabelFrame(root, text="Paths", padding=8)
        paths.pack(fill=tk.X, **pad)

        self.diag_var = tk.StringVar(
            value=os.environ.get("HOLDEM_STUDY_DIAGNOSTICS_DIR", _default_diagnostics_hint())
        )
        self.zip_var = tk.StringVar(value="")
        self.exe_var = tk.StringVar(
            value=os.environ.get("HOLDEM_STUDY_SOLVER_ENGINE", "")
        )

        self._path_row(paths, "Diagnostics dir", self.diag_var, self._browse_diag_dir)
        self._path_row(paths, "Diagnostics zip", self.zip_var, self._browse_zip)
        self._path_row(paths, "solver-engine.exe", self.exe_var, self._browse_exe)

        diary = ttk.LabelFrame(root, text="Repro diary (attached on Collect / Send)", padding=8)
        diary.pack(fill=tk.X, **pad)
        self.diary_symptom = tk.StringVar(value="")
        self.diary_clicked = tk.StringVar(value="")
        self.diary_street = tk.StringVar(value="")
        self.diary_notes = tk.StringVar(value="")
        self._diary_row(diary, "Symptom", self.diary_symptom)
        self._diary_row(diary, "What clicked", self.diary_clicked)
        self._diary_row(diary, "Street / solve", self.diary_street)
        self._diary_row(diary, "Notes", self.diary_notes)

        actions = ttk.LabelFrame(root, text="Actions", padding=8)
        actions.pack(fill=tk.X, **pad)

        buttons = [
            ("Collect bundle (while frozen)", self._on_collect),
            ("Analyze diagnostics", self._on_analyze),
            ("Send report to GitHub", self._on_send),
            ("Find crash dumps", self._on_dumps),
            ("Enable LocalDumps (once)", self._on_enable_dumps),
            ("Sidecar PE check", self._on_sidecar),
            ("IPC probe", self._on_probe),
            ("Watch hang (60s)", self._on_watch),
            ("Live snapshot", self._on_snapshot),
            ("Stop running tool", self._on_stop),
        ]
        grid = ttk.Frame(actions)
        grid.pack(fill=tk.X)
        for i, (label, cmd) in enumerate(buttons):
            b = ttk.Button(grid, text=label, command=cmd)
            b.grid(row=i // 4, column=i % 4, sticky=tk.EW, padx=4, pady=4)
        for c in range(4):
            grid.columnconfigure(c, weight=1)

        out_frame = ttk.LabelFrame(root, text="Output", padding=4)
        out_frame.pack(fill=tk.BOTH, expand=True, **pad)
        self.output = scrolledtext.ScrolledText(
            out_frame, wrap=tk.WORD, height=20, font=("Consolas", 10)
        )
        self.output.pack(fill=tk.BOTH, expand=True)

        status = ttk.Frame(root)
        status.pack(fill=tk.X, **pad)
        self.status_var = tk.StringVar(value="Ready")
        ttk.Label(status, textvariable=self.status_var).pack(side=tk.LEFT)
        ttk.Button(status, text="Clear output", command=self._clear).pack(side=tk.RIGHT)

    def _path_row(
        self,
        parent: ttk.LabelFrame,
        label: str,
        var: tk.StringVar,
        browse,
    ) -> None:
        row = ttk.Frame(parent)
        row.pack(fill=tk.X, pady=2)
        ttk.Label(row, text=label, width=18).pack(side=tk.LEFT)
        ttk.Entry(row, textvariable=var).pack(side=tk.LEFT, fill=tk.X, expand=True, padx=4)
        ttk.Button(row, text="Browse…", command=browse, width=10).pack(side=tk.RIGHT)

    def _diary_row(self, parent: ttk.LabelFrame, label: str, var: tk.StringVar) -> None:
        row = ttk.Frame(parent)
        row.pack(fill=tk.X, pady=2)
        ttk.Label(row, text=label, width=14).pack(side=tk.LEFT)
        ttk.Entry(row, textvariable=var).pack(side=tk.LEFT, fill=tk.X, expand=True, padx=4)

    def _diary_args(self) -> list[str]:
        args: list[str] = []
        if self.diary_symptom.get().strip():
            args.extend(["--diary-symptom", self.diary_symptom.get().strip()])
        if self.diary_clicked.get().strip():
            args.extend(["--diary-clicked", self.diary_clicked.get().strip()])
        if self.diary_street.get().strip():
            args.extend(["--diary-street", self.diary_street.get().strip()])
        if self.diary_notes.get().strip():
            args.extend(["--diary-notes", self.diary_notes.get().strip()])
        return args

    def _browse_diag_dir(self) -> None:
        path = filedialog.askdirectory(title="Diagnostics folder")
        if path:
            self.diag_var.set(path)

    def _browse_zip(self) -> None:
        path = filedialog.askopenfilename(
            title="Diagnostics zip",
            filetypes=[("Zip archives", "*.zip"), ("All files", "*.*")],
        )
        if path:
            self.zip_var.set(path)

    def _browse_exe(self) -> None:
        path = filedialog.askopenfilename(
            title="solver-engine.exe",
            filetypes=[
                ("Executable", "*.exe"),
                ("All files", "*.*"),
            ],
        )
        if path:
            self.exe_var.set(path)

    def _clear(self) -> None:
        self.output.delete("1.0", tk.END)

    def _append(self, text: str) -> None:
        self.output.insert(tk.END, text)
        self.output.see(tk.END)

    def _drain_queue(self) -> None:
        try:
            while True:
                self._append(self._out_q.get_nowait())
        except queue.Empty:
            pass
        self.after(100, self._drain_queue)

    def _busy(self) -> bool:
        return self._worker is not None and self._worker.is_alive()

    def _env(self) -> dict[str, str]:
        env = os.environ.copy()
        diag = self.diag_var.get().strip()
        if diag and not diag.startswith("%"):
            env["HOLDEM_STUDY_DIAGNOSTICS_DIR"] = diag
        exe = self.exe_var.get().strip()
        if exe:
            env["HOLDEM_STUDY_SOLVER_ENGINE"] = exe
        return env

    def _run(self, title: str, args: list[str]) -> None:
        if self._busy():
            messagebox.showinfo(
                "Busy",
                "A tool is already running. Click Stop, or wait for it to finish.",
            )
            return
        if not _STUDY_DEBUG.is_file():
            messagebox.showerror("Missing", f"Cannot find {_STUDY_DEBUG}")
            return

        self.status_var.set(f"Running: {title}…")
        self._append(f"\n=== {title} ===\n$ study_debug {' '.join(args)}\n\n")

        def worker() -> None:
            try:
                self._proc = subprocess.Popen(
                    [_python(), str(_STUDY_DEBUG), *args],
                    cwd=str(_HERE.parents[1]),
                    env=self._env(),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    errors="replace",
                )
                assert self._proc.stdout is not None
                for line in self._proc.stdout:
                    self._out_q.put(line)
                code = self._proc.wait()
                self._out_q.put(f"\n[exit {code}]\n")
                self.status_var.set(f"Done: {title} (exit {code})")
            except Exception as exc:  # noqa: BLE001 — surface in GUI
                self._out_q.put(f"\n[error] {exc}\n")
                self.status_var.set(f"Failed: {title}")
            finally:
                self._proc = None

        self._worker = threading.Thread(target=worker, daemon=True)
        self._worker.start()

    def _on_stop(self) -> None:
        proc = self._proc
        if proc and proc.poll() is None:
            proc.terminate()
            self._append("\n[terminated]\n")
            self.status_var.set("Stopped")
        else:
            self.status_var.set("Nothing to stop")

    def _on_collect(self) -> None:
        args = ["collect", "--zip", "--stacks", *self._diary_args()]
        self._run("Collect bundle", args)

    def _on_analyze(self) -> None:
        zip_path = self.zip_var.get().strip()
        diag = self.diag_var.get().strip()
        args = ["analyze"]
        if zip_path:
            args.extend(["--zip", zip_path])
        elif diag and not diag.startswith("%"):
            args.extend(["--dir", diag])
        self._run("Analyze diagnostics", args)

    def _on_send(self) -> None:
        zip_path = self.zip_var.get().strip()
        diag = self.diag_var.get().strip()
        if not zip_path and (not diag or diag.startswith("%")):
            messagebox.showinfo(
                "Send report",
                "Pick a diagnostics zip (Help → Copy diagnostics zip) or a "
                "diagnostics folder, then click Send again.\n\n"
                "Preferred: HOLDEM_STUDY_REPORT_WEBHOOK_URL + "
                "HOLDEM_STUDY_REPORT_WEBHOOK_SECRET "
                "(no gh on this PC).\n"
                "Fallback: gh auth login (repo + gist) or "
                "HOLDEM_STUDY_GITHUB_TOKEN.",
            )
            return
        webhook = bool(os.environ.get("HOLDEM_STUDY_REPORT_WEBHOOK_URL", "").strip())
        if webhook:
            prompt = (
                "POST this zip to your report webhook?\n"
                "The server opens the GitHub Issue (no local gh / PAT).\n\n"
                "Logs may contain paths/usernames — review if the repo is public.\n"
                "Nothing is committed into git history."
            )
        else:
            prompt = (
                "Create a GitHub Issue on poker-solver and upload the zip as a "
                "secret gist?\n\n"
                "Tip: set HOLDEM_STUDY_REPORT_WEBHOOK_URL to skip local gh auth "
                "(see scripts/debug/report-receiver/README.md).\n\n"
                "Logs may contain paths/usernames — review if the repo is public.\n"
                "Nothing is committed into git history."
            )
        if not messagebox.askyesno("Send report", prompt):
            return
        args = ["send", "--yes", *self._diary_args()]
        if zip_path:
            args.extend(["--zip", zip_path])
        elif diag and not diag.startswith("%"):
            args.extend(["--dir", diag])
        # Map diary notes into --notes when present.
        notes = self.diary_notes.get().strip()
        if notes:
            args.extend(["--notes", notes])
        self._run("Send report to GitHub", args)

    def _on_dumps(self) -> None:
        self._run("Find crash dumps", ["dumps", "--since-hours", "48"])

    def _on_enable_dumps(self) -> None:
        if sys.platform != "win32":
            messagebox.showinfo(
                "LocalDumps",
                "LocalDumps is Windows-only. See enable_local_dumps.ps1.",
            )
            return
        if not messagebox.askyesno(
            "Enable LocalDumps",
            "This writes HKLM LocalDumps for Holdem Study.exe and "
            "solver-engine.exe (needs Administrator once).\n\nContinue?",
        ):
            return
        self._run("Enable LocalDumps", ["enable-dumps"])

    def _on_sidecar(self) -> None:
        args = ["sidecar"]
        exe = self.exe_var.get().strip()
        if exe:
            args.extend(["--exe", exe])
        self._run("Sidecar PE check", args)

    def _on_probe(self) -> None:
        args = ["probe"]
        exe = self.exe_var.get().strip()
        if exe:
            args.extend(["--binary", exe])
        self._run("IPC probe", args)

    def _on_watch(self) -> None:
        self._run("Watch hang", ["watch", "--duration", "60", "--interval", "2"])

    def _on_snapshot(self) -> None:
        self._run("Live snapshot", ["snapshot"])


def main() -> int:
    try:
        app = StudyDebugApp()
    except tk.TclError as exc:
        print(
            f"error: tkinter GUI unavailable ({exc}). Use the CLI instead:\n"
            f"  python {_STUDY_DEBUG} collect\n"
            f"  python {_STUDY_DEBUG} analyze --zip <path>",
            file=sys.stderr,
        )
        return 1
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

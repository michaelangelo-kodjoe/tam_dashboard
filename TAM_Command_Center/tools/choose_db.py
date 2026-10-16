"""Database chooser for Launch_TAM_Command_Center.bat (stdlib only; same name rules as server/config.py).

  python tools/choose_db.py run --dir <data dir> --out <file>
      Lists the existing *.db files (names only), shows the last used one, and asks:
        Enter or ~10 s without a key = keep the last used database
        a number                     = open that existing database
        N                            = create a NEW database (asks for a name; an existing name is refused
                                       unless you type OPEN to confirm opening it)
      Writes the chosen bare name to --out and remembers it in <data dir>/last_database.txt (only after the
      name passed validation). Never creates, renames or deletes any database file.
      exit 0 = chosen, 1 = cancelled/error.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
from pathlib import Path

DEFAULT_NAME = "tam_command_center"
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
LAST_FILE = "last_database.txt"
TIMEOUT_S = 10.0


def validate(name: str) -> str | None:
    """Return an error message, or None when the name is acceptable."""
    if not NAME_RE.match(name):
        return "Use 1-40 letters, digits, underscores or hyphens only (no spaces, dots or slashes)."
    if name.lower() in RESERVED:
        return "That is a reserved Windows name; choose another."
    return None


def existing(data_dir: Path) -> list[str]:
    try:
        names = [p.stem for p in data_dir.iterdir() if p.is_file() and p.suffix.lower() == ".db" and not validate(p.stem)]
    except OSError:
        return []
    return sorted(set(names), key=str.lower)


def last_used(data_dir: Path) -> str:
    try:
        n = (data_dir / LAST_FILE).read_text(encoding="ascii", errors="replace").strip()
    except OSError:
        return DEFAULT_NAME
    return n if n and not validate(n) else DEFAULT_NAME


def remember(data_dir: Path, name: str) -> None:
    if validate(name):
        raise ValueError(name)
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / LAST_FILE).write_text(name + "\n", encoding="ascii")


def read_line(prompt: str, timeout: float | None) -> str | None:
    """Read a line. With a timeout, returns '' if no key was pressed in time (the timer stops at the first key).
    None = no usable console (non-interactive)."""
    if not sys.stdin or not sys.stdin.isatty():
        return None
    sys.stdout.write(prompt)
    sys.stdout.flush()
    if os.name == "nt":
        import msvcrt
        buf: list[str] = []
        start = time.time()
        while True:
            if msvcrt.kbhit():
                ch = msvcrt.getwch()
                if ch in ("\r", "\n"):
                    sys.stdout.write("\n")
                    return "".join(buf)
                if ch == "\x03":
                    raise KeyboardInterrupt
                if ch in ("\x00", "\xe0"):
                    msvcrt.getwch()
                    continue
                if ch == "\x08":
                    if buf:
                        buf.pop()
                        sys.stdout.write("\b \b")
                else:
                    buf.append(ch)
                    sys.stdout.write(ch)
                sys.stdout.flush()
                start = None  # user is typing: no more timeout
            elif timeout is not None and start is not None and time.time() - start > timeout:
                sys.stdout.write("\n")
                return ""
            else:
                time.sleep(0.05)
    import select
    if timeout is not None:
        r, _, _ = select.select([sys.stdin], [], [], timeout)
        if not r:
            sys.stdout.write("\n")
            return ""
    return sys.stdin.readline().rstrip("\r\n")


def ask_new_name(data_dir: Path, have: list[str], reader=read_line, say=print) -> str | None:
    lower = {n.lower() for n in have}
    while True:
        raw = reader("New database name (letters, digits, _ or -; Enter alone = cancel): ", None)
        if raw is None or not raw.strip():
            return None
        name = raw.strip()
        err = validate(name)
        if err:
            say(f"  Not accepted: {err}")
            continue
        if name.lower() in lower:
            say(f"  A database named '{name}' already exists. Nothing is overwritten.")
            conf = reader("  Type OPEN to open the existing one, or anything else to pick another name: ", None)
            if conf is not None and conf.strip().upper() == "OPEN":
                return name if name in have else next(n for n in have if n.lower() == name.lower())
            continue
        return name


def choose(data_dir: Path, reader=read_line, say=print) -> str | None:
    have = existing(data_dir)
    last = last_used(data_dir)
    say("")
    say("Databases in " + str(data_dir))
    shown = list(have)
    if last not in shown:
        shown.append(last)
    for i, n in enumerate(shown, 1):
        tags = []
        if n == last:
            tags.append("last used")
        if n == DEFAULT_NAME:
            tags.append("default")
        if n not in have:
            tags.append("not created yet")
        say(f"  [{i}] {n}" + (f"   ({', '.join(tags)})" if tags else ""))
    say("")
    say(f"  Enter (or wait {int(TIMEOUT_S)} s) = keep '{last}'   |   number = open that one   |   N = create a NEW database")
    while True:
        raw = reader("Your choice: ", TIMEOUT_S)
        if raw is None:
            return last  # no console: keep the last used one
        raw = raw.strip()
        if raw == "":
            return last
        if raw.upper() == "N":
            name = ask_new_name(data_dir, have, reader, say)
            if name is None:
                say("  Cancelled; keeping '" + last + "'.")
                return last
            return name
        if raw.isdigit() and 1 <= int(raw) <= len(shown):
            return shown[int(raw) - 1]
        say("  Please press Enter, a number from the list, or N.")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=("run",))
    ap.add_argument("--dir", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    data_dir = Path(a.dir)
    try:
        name = choose(data_dir)
        if name is None or validate(name):
            return 1
        remember(data_dir, name)
        Path(a.out).write_text(name + "\n", encoding="ascii")
    except (KeyboardInterrupt, EOFError, OSError):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

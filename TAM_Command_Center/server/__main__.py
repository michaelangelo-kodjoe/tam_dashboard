"""`python -m server` (run from TAM_Command_Center/). Binds 127.0.0.1 only."""
from __future__ import annotations

import sys

from .errors import StartupRefused


def _check_port(config) -> None:  # type: ignore[no-untyped-def]
    """Fail early and plainly when the port is taken (before the database or its lock is touched). Two databases can run
    at the same time only on different ports (TAM_PORT)."""
    import socket
    import os
    with socket.socket() as s:
        if os.name != "nt":
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)     # as uvicorn does: a port in TIME_WAIT is usable
        try:
            s.bind((config.host, config.port))
        except OSError:
            raise StartupRefused(
                f"Port {config.port} is already in use, probably by another TAM Command Center (possibly with a "
                f"different database). To run database '{config.db_name}' at the same time, set TAM_PORT to a free port; "
                "to use the other database, close that instance first.", exit_code=5) from None


def main() -> int:
    from .config import load_config
    try:
        config = load_config()
        _check_port(config)
        from .app import create_app
        app = create_app(config, monitor_thread=True)
    except StartupRefused as exc:
        print(f"TAM Command Center cannot start: {exc}", file=sys.stderr)
        return exc.exit_code
    import uvicorn
    uvicorn.run(app, host=config.host, port=config.port, log_config=None, access_log=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())

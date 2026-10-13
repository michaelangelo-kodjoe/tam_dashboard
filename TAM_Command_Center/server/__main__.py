"""`python -m server` (run from TAM_Command_Center/). Binds 127.0.0.1 only."""
from __future__ import annotations

import sys

from .errors import StartupRefused


def main() -> int:
    from .config import load_config
    try:
        config = load_config()
        from .app import create_app
        app = create_app(config)
    except StartupRefused as exc:
        print(f"TAM Command Center cannot start: {exc}", file=sys.stderr)
        return exc.exit_code
    import uvicorn
    uvicorn.run(app, host=config.host, port=config.port, log_config=None, access_log=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())

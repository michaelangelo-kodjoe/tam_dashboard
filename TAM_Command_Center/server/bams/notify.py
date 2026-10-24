"""Desktop notification seam for BAMS.

PROD uses the proven v8.2.5 Windows notification-area implementation:
PowerShell + System.Windows.Forms.NotifyIcon. It does not depend on browser
notification permission or packaged-app/AppUserModelID registration.

Notification delivery is best-effort and never raises into the BAMS monitor.
The Windows notifier also exposes an asynchronous queue so polling does not
wait for the balloon display duration.
"""
from __future__ import annotations

import base64
import datetime as _dt
import logging
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from typing import Callable, List, Optional, Tuple

log = logging.getLogger("tam.bams.notify")


@dataclass
class NotifyResult:
    ok: bool
    detail: str = ""


NotifyCallback = Callable[[NotifyResult], None]


class Notifier:
    def send(self, title: str, body: str) -> NotifyResult:
        raise NotImplementedError

    def send_async(self, title: str, body: str, callback: Optional[NotifyCallback] = None) -> NotifyResult:
        """Default compatibility path: deliver synchronously, then invoke callback."""
        result = self.send(title, body)
        if callback is not None:
            try:
                callback(result)
            except Exception:  # noqa: BLE001 - notification callbacks must never break monitoring
                log.exception("desktop notification callback failed")
        return result

    def info(self) -> dict:
        return {"available": True, "mode": type(self).__name__}

    def shutdown(self) -> None:
        return None


class DevNotifier(Notifier):
    """DEV: records the attempt as a success without displaying anything."""

    def __init__(self) -> None:
        self.sent: List[Tuple[str, str]] = []

    def send(self, title: str, body: str) -> NotifyResult:
        self.sent.append((title, body))
        return NotifyResult(True, "dev: not displayed")

    def info(self) -> dict:
        return {"available": True, "mode": "dev capture"}


# Keep the PowerShell body static. Alert text travels through environment variables,
# never through string interpolation into executable PowerShell source.
_PS_NOTIFYICON = r"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$notify = New-Object System.Windows.Forms.NotifyIcon
try {
    $notify.Icon = [System.Drawing.SystemIcons]::Information
    $notify.Visible = $true
    $notify.BalloonTipTitle = $env:TAM_NOTIFY_TITLE
    $notify.BalloonTipText = $env:TAM_NOTIFY_BODY
    $notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
    $duration = [int]$env:TAM_NOTIFY_DURATION_MS
    $notify.ShowBalloonTip($duration)
    $sleepMs = [Math]::Min($duration + 700, 10700)
    Start-Sleep -Milliseconds $sleepMs
    Write-Output 'WINDOWS_NOTIFICATION_SHOWN'
}
finally {
    $notify.Visible = $false
    $notify.Dispose()
}
"""


class WindowsToastNotifier(Notifier):
    """PowerShell NotifyIcon delivery for an unpackaged/local Windows app.

    This is the v8.2.5 notification-area approach adapted to the current notifier
    interface. `send` is synchronous for compatibility; `send_async` queues work
    on one daemon worker so BAMS polling is not blocked and overlapping balloons
    are serialized.
    """

    def __init__(self) -> None:
        self.test_mode = os.environ.get("TAM_BAMS_TEST_NOTIFY") == "1"
        self.sent: List[Tuple[str, str]] = []
        self.last_result: Optional[dict] = None
        self._delivery_lock = threading.Lock()
        self._queue: queue.Queue[object] = queue.Queue()
        self._closed = False
        self._worker = threading.Thread(
            target=self._delivery_worker,
            name="TAM-Windows-Notification-Queue",
            daemon=True,
        )
        self._worker.start()

    @staticmethod
    def _stamp() -> str:
        return _dt.datetime.now().astimezone().isoformat(timespec="seconds")

    @staticmethod
    def _clip(title: str, body: str) -> Tuple[str, str]:
        return str(title or "")[:120], str(body or "")[:500]

    @staticmethod
    def _duration(value: int) -> int:
        return max(1500, min(int(value), 10000))

    @staticmethod
    def _powershell() -> Optional[str]:
        return shutil.which("powershell.exe") or shutil.which("powershell")

    def info(self) -> dict:
        if self.test_mode:
            return {"available": True, "mode": "test capture", "last_result": self.last_result}
        if not sys.platform.startswith("win"):
            return {
                "available": False,
                "mode": "Windows notification",
                "error": "Windows notifications are available only on Windows.",
                "last_result": self.last_result,
            }
        if not self._powershell():
            return {
                "available": False,
                "mode": "Windows notification",
                "error": "PowerShell was not found.",
                "last_result": self.last_result,
            }
        return {
            "available": True,
            "mode": "Windows notification area",
            "detail": (
                "Uses local PowerShell + System.Windows.Forms.NotifyIcon; "
                "no browser permission or packaged AppUserModelID is required."
            ),
            "last_result": self.last_result,
        }

    def _run_sync(self, title: str, body: str, duration_ms: int = 5000) -> NotifyResult:
        title, body = self._clip(title, body)
        duration_ms = self._duration(duration_ms)

        if self.test_mode:
            self.sent.append((title, body))
            result = {
                "ok": True,
                "method": "test capture",
                "detail": "Captured in test mode",
                "sent_at": self._stamp(),
            }
            self.last_result = result
            return NotifyResult(True, result["detail"])

        info = self.info()
        if not info.get("available"):
            detail = str(info.get("error") or "Windows notification unavailable")
            self.last_result = {
                "ok": False,
                "method": info.get("mode", "Windows notification"),
                "detail": detail,
                "sent_at": self._stamp(),
            }
            return NotifyResult(False, detail)

        exe = self._powershell()
        assert exe is not None
        encoded = base64.b64encode(_PS_NOTIFYICON.encode("utf-16-le")).decode("ascii")
        env = dict(
            os.environ,
            TAM_NOTIFY_TITLE=title,
            TAM_NOTIFY_BODY=body,
            TAM_NOTIFY_DURATION_MS=str(duration_ms),
        )
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)

        try:
            proc = subprocess.run(
                [exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=max(15, int(duration_ms / 1000) + 10),
                creationflags=flags,
            )
            stdout = (proc.stdout or "").strip()
            stderr = (proc.stderr or "").strip()
            ok = proc.returncode == 0 and "WINDOWS_NOTIFICATION_SHOWN" in stdout
            detail = (
                "Windows notification displayed."
                if ok
                else (stderr or stdout or f"PowerShell exited with code {proc.returncode}.")
            )
            self.last_result = {
                "ok": ok,
                "method": "Windows notification area",
                "detail": detail[:1000],
                "exit_code": proc.returncode,
                "sent_at": self._stamp(),
            }
            if ok:
                log.info("Windows notification displayed title=%r", title[:80])
            else:
                log.warning("Windows notification failed: %s", detail[:1000])
            return NotifyResult(ok, detail[:1000])
        except Exception as exc:  # noqa: BLE001 - best effort by design
            detail = f"Desktop notification failed: {type(exc).__name__}: {exc}"[:1000]
            self.last_result = {
                "ok": False,
                "method": "Windows notification area",
                "detail": detail,
                "sent_at": self._stamp(),
            }
            log.warning("Windows notification execution failed: %s", type(exc).__name__)
            return NotifyResult(False, detail)

    def _deliver_serialized(self, title: str, body: str, duration_ms: int) -> NotifyResult:
        # Windows may suppress overlapping legacy notification-area balloons.
        with self._delivery_lock:
            result = self._run_sync(title, body, duration_ms)
            if not self.test_mode:
                time.sleep(0.75)
            return result

    def _delivery_worker(self) -> None:
        while True:
            item = self._queue.get()
            try:
                if item is None:
                    return
                title, body, duration_ms, callback = item  # type: ignore[misc]
                result = self._deliver_serialized(title, body, duration_ms)
                if callback is not None:
                    try:
                        callback(result)
                    except Exception:  # noqa: BLE001
                        log.exception("queued desktop notification callback failed")
            except Exception:  # noqa: BLE001
                log.exception("queued Windows notification failed")
            finally:
                self._queue.task_done()

    def send_sync(self, title: str, body: str, duration_ms: int = 3500) -> NotifyResult:
        title, body = self._clip(title, body)
        return self._deliver_serialized(title, body, duration_ms)

    def send(self, title: str, body: str) -> NotifyResult:
        # Compatibility method for call sites/tests that expect immediate result.
        return self.send_sync(title, body)

    def send_async(self, title: str, body: str, callback: Optional[NotifyCallback] = None) -> NotifyResult:
        title, body = self._clip(title, body)
        if self.test_mode:
            result = self._deliver_serialized(title, body, 1500)
            if callback is not None:
                callback(result)
            return result

        info = self.info()
        if not info.get("available"):
            result = NotifyResult(False, str(info.get("error") or "Windows notification unavailable"))
            if callback is not None:
                callback(result)
            return result

        if self._closed:
            result = NotifyResult(False, "Windows notification worker is shut down")
            if callback is not None:
                callback(result)
            return result

        self.last_result = {
            "ok": None,
            "method": "Windows notification area",
            "detail": "Queued for serialized background delivery",
            "sent_at": self._stamp(),
        }
        self._queue.put((title, body, 5000, callback))
        return NotifyResult(True, "queued for serialized Windows notification delivery")

    def shutdown(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._queue.put(None)
        if self._worker is not threading.current_thread():
            self._worker.join(timeout=2)


def select_notifier(mode: str) -> Notifier:
    return DevNotifier() if mode == "DEV" else WindowsToastNotifier()


def toast_text(kind: str, severity: str, privacy: bool, metric: str, where: str, value: object) -> Tuple[str, str]:
    if privacy:
        return f"BAMS alert {kind} ({severity})", "Open TAM Command Center for details."
    v = "" if value is None else f" · value {value:g}%"
    return f"{severity} {kind}: {metric}", f"{where}{v}"

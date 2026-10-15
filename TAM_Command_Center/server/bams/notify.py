"""Desktop notification seam (D-56). `Notifier.send` never raises; failures come back as ok=False and are logged
at warning by the caller. The Windows implementation is best-effort and UNVERIFIED until tested on Windows."""
from __future__ import annotations

import base64
import logging
import os
import subprocess
import sys
from dataclasses import dataclass
from typing import List, Tuple

log = logging.getLogger("tam.bams.notify")


@dataclass
class NotifyResult:
    ok: bool
    detail: str = ""


class Notifier:
    def send(self, title: str, body: str) -> NotifyResult:
        raise NotImplementedError


class DevNotifier(Notifier):
    """DEV: records the attempt as a success without displaying anything."""

    def __init__(self) -> None:
        self.sent: List[Tuple[str, str]] = []

    def send(self, title: str, body: str) -> NotifyResult:
        self.sent.append((title, body))
        return NotifyResult(True, "dev: not displayed")


_PS = r"""
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$n = $t.GetElementsByTagName('text')
$n.Item(0).AppendChild($t.CreateTextNode($env:TAM_TOAST_TITLE)) | Out-Null
$n.Item(1).AppendChild($t.CreateTextNode($env:TAM_TOAST_BODY)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($t)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('TAM Command Center').Show($toast)
"""


class WindowsToastNotifier(Notifier):
    """PowerShell toast. Text travels in environment variables (never interpolated into the script)."""

    def send(self, title: str, body: str) -> NotifyResult:
        if not sys.platform.startswith("win"):
            return NotifyResult(False, "Desktop notifications are only available on Windows")
        try:
            enc = base64.b64encode(_PS.encode("utf-16-le")).decode("ascii")
            env = dict(os.environ, TAM_TOAST_TITLE=title[:200], TAM_TOAST_BODY=body[:400])
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", enc], env=env,
                               capture_output=True, timeout=15, creationflags=flags)
            if r.returncode != 0:
                return NotifyResult(False, "PowerShell toast failed (exit %d)" % r.returncode)
            return NotifyResult(True, "")
        except Exception as exc:  # noqa: BLE001 - best effort by design
            return NotifyResult(False, ("Desktop notification failed: " + type(exc).__name__)[:200])


def select_notifier(mode: str) -> Notifier:
    return DevNotifier() if mode == "DEV" else WindowsToastNotifier()


def toast_text(kind: str, severity: str, privacy: bool, metric: str, where: str, value: object) -> Tuple[str, str]:
    if privacy:
        return f"BAMS alert {kind} ({severity})", "Open TAM Command Center for details."
    v = "" if value is None else f" · value {value:g}%"
    return f"{severity} {kind}: {metric}", f"{where}{v}"

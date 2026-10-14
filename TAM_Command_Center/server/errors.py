"""Structured errors: {"ok": false, "error": {"code", "message", "fields"?, "details"?}} (PM section 6)."""
from __future__ import annotations

from typing import Any, Dict, Optional


class AppError(Exception):
    code = "internal"
    status = 500

    def __init__(self, message: str, *, fields: Optional[Dict[str, str]] = None,
                 details: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(message)
        self.message = message
        self.fields = fields
        self.details = details

    def body(self) -> Dict[str, Any]:
        err: Dict[str, Any] = {"code": self.code, "message": self.message}
        if self.fields:
            err["fields"] = self.fields
        if self.details:
            err["details"] = self.details
        return {"ok": False, "error": err}


class ValidationFailed(AppError):
    code, status = "validation_error", 422


class NotFound(AppError):
    code, status = "not_found", 404


class ConfirmationRequired(AppError):
    code, status = "confirmation_required", 409


class StaleWrite(AppError):
    code, status = "stale_write", 409


class Conflict(AppError):
    code, status = "conflict", 409


class NotImplementedYet(AppError):
    code, status = "not_implemented", 501


class MethodNotAllowed(AppError):
    code, status = "method_not_allowed", 405


class ForbiddenOrigin(AppError):
    code, status = "forbidden_origin", 403


class PayloadTooLarge(AppError):
    code, status = "payload_too_large", 413


class BackupFailed(AppError):
    code, status = "backup_failed", 500


class StartupRefused(Exception):
    """Raised before the server starts (mode/channel/lock problems). `exit_code` is non-zero."""

    def __init__(self, message: str, exit_code: int = 3) -> None:
        super().__init__(message)
        self.exit_code = exit_code


# ---- Run 3: account bulk import (docs/04_API_CONTRACT.md section 10)
class InvalidFile(AppError):
    code, status = "invalid_file", 422


class ImportExpired(AppError):
    code, status = "import_expired", 410


class UnresolvedDuplicates(AppError):
    code, status = "unresolved_duplicates", 409


class PreviewStale(AppError):
    code, status = "preview_stale", 409


class AlreadyApplied(AppError):
    code, status = "already_applied", 409


class PossibleDuplicate(AppError):
    code, status = "possible_duplicate", 409

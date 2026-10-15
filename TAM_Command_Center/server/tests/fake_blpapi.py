"""Minimal fake of the blpapi surface BlpapiProvider uses (the real shapes are [U]; see blpapi_parse.py)."""
from __future__ import annotations

from typing import Any, Dict, List


class El:
    def __init__(self, fields: Dict[str, Any] = None, items: List[Any] = None, value: Any = None):
        self.f, self.items, self.value = fields or {}, items, value

    def hasElement(self, n): return n in self.f
    def getElement(self, n): return self.f[n]
    def getElementAsString(self, n): return str(self.f[n].value)
    def values(self): return list(self.items or [])
    def getValue(self): return self.value
    def appendValue(self, v): self.items.append(v)


def S(v): return El(value=v)


def sec_ok(sec, field, value):
    return El({"security": S(sec), "fieldData": El({field: S(value)}), "fieldExceptions": El(items=[])})


def sec_bad(sec):
    return El({"security": S(sec), "securityError": El({"category": S("BAD_SEC"), "message": S("Unknown")}),
               "fieldExceptions": El(items=[])})


def sec_badfield(sec, field):
    ex = El({"fieldId": S(field), "errorInfo": El({"category": S("BAD_FLD")})})
    return El({"security": S(sec), "fieldData": El(), "fieldExceptions": El(items=[ex])})


class Msg(El):
    def __init__(self, mtype, fields=None):
        super().__init__(fields)
        self.mt = mtype

    def messageType(self): return self.mt


class Event:
    TIMEOUT, SESSION_STATUS, SERVICE_STATUS, RESPONSE, PARTIAL_RESPONSE, REQUEST_STATUS = 1, 2, 3, 4, 5, 6

    def __init__(self, et, msgs=()):
        self.et, self.msgs = et, list(msgs)

    def eventType(self): return self.et
    def __iter__(self): return iter(self.msgs)


def response(*secs, partial=False):
    return Event(Event.PARTIAL_RESPONSE if partial else Event.RESPONSE,
                 [Msg("ReferenceDataResponse", {"securityData": El(items=list(secs))})])


class Req:
    def __init__(self):
        self.f = {"securities": El(items=[]), "fields": El(items=[])}

    def getElement(self, n): return self.f[n]


class Svc:
    def createRequest(self, name):
        assert name == "ReferenceDataRequest"
        return Req()


class FakeBlpapi:
    """Module stand-in. `script(securities, field)` returns the list of events for one request."""
    Event = Event

    def __init__(self, script=None, start_ok=True, open_ok=True):
        self.script, self.start_ok, self.open_ok = script, start_ok, open_ok
        self.sessions: List[Any] = []
        self.requests: List[Any] = []
        outer = self

        class SessionOptions:
            def setServerHost(self, h): self.host = h
            def setServerPort(self, p): self.port = p

        class Session:
            def __init__(self, opts):
                self.opts, self.events, self.stopped = opts, [], False
                outer.sessions.append(self)

            def start(self): return outer.start_ok
            def openService(self, n): return outer.open_ok
            def getService(self, n): return Svc()
            def stop(self): self.stopped = True

            def sendRequest(self, req):
                secs = [v for v in req.f["securities"].items]
                fld = req.f["fields"].items[0]
                outer.requests.append((secs, fld))
                self.events = list(outer.script(secs, fld))

            def nextEvent(self, ms):
                return self.events.pop(0) if self.events else Event(Event.TIMEOUT)

        self.SessionOptions, self.Session = SessionOptions, Session

    @staticmethod
    def version(): return "9.9.9"
    @staticmethod
    def cpp_sdk_version(): return "9.9.0"


def good_script(secs, field):
    return [response(*[sec_ok(s, field, 42.5) for s in secs])]

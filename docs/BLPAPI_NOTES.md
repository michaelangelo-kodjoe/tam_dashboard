# BLPAPI (Desktop API) polling notes

Research date: 2026-10-14. Purpose: build a read-only Bloomberg provider that runs against a fake session now and the Terminal workstation later.

Legend: **[V]** verified from a source I fetched this session (URL given). **[U]** UNVERIFIED: from general knowledge or third-party posts; confirm on the workstation or in Bloomberg docs. I could not fetch Bloomberg's own docs pages (bloomberg.com returned 403, GitHub example paths returned 404), so most semantics below are [U].

## 1. Install and environment check

- [V] Bloomberg pip index: `python -m pip install --index-url=https://blpapi.bloomberg.com/repository/releases/python/simple/ blpapi`. Newest listed at fetch time: 3.26.9.1, wheels `py3-none` for win_amd64, win32, manylinux2014_x86_64, macosx_11_0_arm64, plus sdist. https://blpapi.bloomberg.com/repository/releases/python/simple/blpapi/
- [V, via search summary of Bloomberg's API library page] Wheels bundle the C++ API, so no separate C++ SDK install is needed; minimum Python 3.8 per that page. https://www.bloomberg.com/professional/support/api-library/ (page itself 403 for me)
- [V] The repo README (msitt mirror of the official repo) says CPython 3.10+ and a same-version C++ SDK are needed when building from source (`BLPAPI_ROOT`, compiler). The SDK is not needed at runtime on Windows with the Terminal software. https://github.com/msitt/blpapi-python . The 3.8 vs 3.10 conflict is unresolved: pick Python 3.10+ to be safe.
- [U] Win64 Python recommended (the Terminal is 64-bit). VC++ redistributable may be required.
- [V] Utilities `blpapi.version()`, `blpapi.cpp_sdk_version()` exist. https://bloomberg.github.io/blpapi-docs/python/3.24.6/

Environment check should test, in order:
1. `import blpapi` succeeds; record `blpapi.version()` and `blpapi.cpp_sdk_version()`. If ImportError: report "blpapi not installed" and keep fake provider.
2. TCP connect to `localhost:8194` (2 s timeout). Refused means Terminal not running (or Desktop API not enabled) [U].
3. `Session.start()` returns True and a SessionStarted event arrives within a timeout.
4. `openService("//blp/refdata")` succeeds.
5. One cheap ReferenceDataRequest (`IBM US Equity`, `PX_LAST`) returns a value, which proves the user is logged in and entitled [U].

## 2. Session setup

```python
opts = blpapi.SessionOptions()
opts.setServerHost("localhost")   # [V] standard API setters; default is localhost
opts.setServerPort(8194)          # default Desktop API port [U on port, widely documented]
session = blpapi.Session(opts)
if not session.start():           # sync start; False on failure
    raise ProviderUnavailable("start failed")
if not session.openService("//blp/refdata"):
    raise ProviderUnavailable("refdata unavailable")
```

Event types to handle (names [U] from SDK, confirm in docs): `SESSION_STATUS` messages `SessionStarted`, `SessionStartupFailure`, `SessionTerminated`, `SessionConnectionUp/Down`; `SERVICE_STATUS` `ServiceOpened`, `ServiceOpenFailure`; `RESPONSE` / `PARTIAL_RESPONSE`; `REQUEST_STATUS` (request failed).

| Situation | Expected behaviour [U] |
|---|---|
| Terminal not running | `session.start()` returns False and/or SessionStartupFailure event; no listener on 8194 |
| Terminal running, not logged in | Session may start but requests fail or return authorisation/entitlement errors. Exact behaviour unknown: test it. |
| Terminal exits mid-run | SessionConnectionDown / SessionTerminated; must discard the session and create a new one |
| Network/Terminal restart | Do not reuse a terminated Session. Build a new Session, with backoff (e.g. 5 s to 60 s). |

Use `nextEvent(timeoutMs)` loops with a hard overall timeout so a hung Terminal cannot block the poller; run in a worker thread.

## 3. Snapshot polling (ReferenceDataRequest)

```python
svc = session.getService("//blp/refdata")
req = svc.createRequest("ReferenceDataRequest")
for s in ["IBM US Equity", "EURUSD Curncy"]:
    req.getElement("securities").appendValue(s)
for f in ["PX_LAST", "BID", "ASK"]:
    req.getElement("fields").appendValue(f)
session.sendRequest(req)
done = False
while not done:
    ev = session.nextEvent(5000)
    for msg in ev:
        if ev.eventType() in (blpapi.Event.RESPONSE, blpapi.Event.PARTIAL_RESPONSE):
            if msg.hasElement("responseError"):
                handle_request_error(msg.getElement("responseError"))
                continue
            for sd in msg.getElement("securityData").values():
                sec = sd.getElementAsString("security")
                if sd.hasElement("securityError"):
                    record_security_error(sec, sd.getElement("securityError"))
                    continue
                fd = sd.getElement("fieldData")
                for f in fields:
                    if fd.hasElement(f):
                        record(sec, f, fd.getElement(f).getValue())
                for ex in sd.getElement("fieldExceptions").values():
                    record_field_error(sec, ex.getElementAsString("fieldId"),
                                       ex.getElement("errorInfo").getElementAsString("category"))
    if ev.eventType() == blpapi.Event.RESPONSE:
        done = True
```

Response/error shapes (all [U]; confirm against the Bloomberg Reference Guide / Core Developer Guide, whose only copies I found were third-party Scribd uploads; a Stack Overflow thread confirms `securityData` array with `fieldExceptions` and `fieldData`: https://windows-hexerror.linestarve.com/q/so50972236-error-accessing-data-in-message-element):

| Where | Shape | Meaning |
|---|---|---|
| Message `ReferenceDataResponse` | `securityData[]` | One entry per requested security, possibly split across PARTIAL_RESPONSE events |
| `securityData[i]` | `security`, `sequenceNumber`, `fieldData`, `fieldExceptions[]`, optional `securityError` | |
| `securityError` | `source`, `code`, `category`, `message`, `subcategory` | Bad/unknown ticker, e.g. category `BAD_SEC` |
| `fieldExceptions[]` | `fieldId`, `errorInfo{source, code, category, message, subcategory}` | Bad or unauthorised field, e.g. category `BAD_FLD` |
| `fieldData` | Only fields with values appear | Missing field with no exception = no data (field must be treated as null) |
| Message `responseError` | `source`, `code`, `category`, `message` | Whole request failed |
| REQUEST_STATUS event | request failure | Whole request failed |

Notes:
- Access `fieldData` through each `securityData` element (not the array itself), per the SO thread above.
- Batching [U]: commonly cited limit ~ 500 securities per ReferenceDataRequest and a few hundred fields; use chunks of 100-200 securities to be safe. Unverified.
- Subscription vs polling at ~60 s [U]: `//blp/mktdata` subscriptions push ticks and are more efficient for many frequently changing prices, but count against the simultaneous real-time field cap (one source says 3,500 open fields: https://libguides.sdu.dk/Bloomberg/DataLimits ) and need event-loop/reconnect/resubscribe handling. For a ~60 s cadence over a modest list, repeated ReferenceDataRequest is simpler, stateless, and fits a fake-session design. Real-time fields in refdata (PX_LAST, BID, ASK) return the latest value, exchange-delay rules apply per entitlement [U]. Recommendation: poll with refdata first; keep a provider interface that could swap to subscriptions.

## 4. Identifiers

- [U] Format: `<ticker or ID> <exchange/country code> <asset class>`: `IBM US Equity`, `VOD LN Equity`, `EURUSD Curncy`, `USGG10YR Index`, `SPX Index`, `CL1 Comdty`, `T 2.5 05/15/24 Govt`, `AAPL US 01/19/24 C150 Equity`.
- [U] Identifier-based forms: `/ticker/IBM US Equity`, `/isin/US4592001014`, `/cusip/...`, `/sedol1/...`, `/bbgid/BBG000BLNNH6`. Custom/user-created securities and appliance/internal assets: unknown; ask user for sample strings.
- Invalid ticker: `securityError` present (category like BAD_SEC), and no `fieldData` values [U]. Invalid field: entry in `fieldExceptions` [U]. Use these to validate user-entered tickers in the UI.

## 5. Limits and licensing

- [Third-party only, https://library.london.edu/c.php?g=706470 , https://libguides.sdu.dk/Bloomberg/DataLimits] Three limit types: daily, monthly, and simultaneous real-time fields. A "hit" = one security/field pair (5 fields x 10 securities = 50 hits). One guide states a daily cap of 500,000 hits; monthly cap is based on unique securities and data type, reset on the 1st. These are older university pages, likely out of date, and may describe Excel/Desktop limits only.
- [U, older forum post] Limit errors may surface as -4001 (daily) / -4002 (monthly) or "#N/A Dly Lmt"/"#N/A Mth Lmt".
- Rough hit math for planning: 50 securities x 5 fields every 60 s for 8 h = 120,000 hits/day. Whether repeated requests for the same pair count each time, or only unique securities toward monthly, is UNVERIFIED. Prefer fewer fields, longer cadence off-hours, and pausing outside market hours.
- [U] Desktop API is licensed for the Terminal user's personal use on that machine: data cannot be redistributed or shown to others, and the Desktop API is not for server/unattended use (that is Server API / B-PIPE). An unattended, always-polling local app may be a grey area: UNVERIFIED, check the Bloomberg Services Agreement / ask the Bloomberg account rep. I could not find official text this session.
- Official docs to read: https://www.bloomberg.com/professional/support/api-library/ (SDK + developer guide), https://bloomberg.github.io/blpapi-docs/python/ (Python reference), WAPI<GO> on the Terminal (data limits, DAPI<GO> / "BBAPI" docs), DLIM<GO> to view current usage [U on function codes].

## Open questions for the workstation

1. `python -m pip install` from the Bloomberg index works? Python version? `blpapi.version()`?
2. Is port 8194 listening when the Terminal is logged in? What happens when logged out (start fails vs request error)?
3. Run the check request; paste the raw `ReferenceDataResponse` for one good ticker, one bad ticker, one bad field.
4. Which real tickers and asset classes (including custom ones) must be tracked, how many, which fields?
5. Check DLIM<GO> for actual daily/monthly limits; confirm with Bloomberg that unattended local polling is permitted.

## Workstation checklist (BlpapiProvider, built against a fake session only)

Code: `server/bams/provider.py` (BlpapiProvider), `server/bams/blpapi_parse.py` (ALL [U] response shapes; edit only this if the probe shows differences), tunables as class constants/ctor args: `HOST`, `PORT` 8194, `FIELD` LAST_PRICE (was PX_LAST before 0.2.0), `BATCH_SIZE` 500, `REQUEST_TIMEOUT_S` 30.

1. `python -m pip install --index-url=https://blpapi.bloomberg.com/repository/releases/python/simple/ blpapi` into the PROD venv (Python 3.10+, 64-bit).
2. Terminal logged in, then `python tools/bloomberg_probe.py "IBM US Equity" "NOTAREAL XX Equity" --fields PX_LAST NOT_A_FIELD`. Send back `bloomberg_probe_output.txt`. Compare against blpapi_parse.py: event type names, `securityError`/`fieldExceptions`/`fieldData` element names, how a numeric PX_LAST value appears.
3. Run `Check_PROD_Environment.bat`: expect the blpapi version, and "Terminal reachable".
4. Start PROD, add real metric tickers (percent-valued fields only, since BAMS values are percentages): confirm values arrive and the banner clears. Confirm the PX_LAST field is the right one for your metrics (change `FIELD` if not).
5. Quit the Terminal mid-run: banner returns within a poll; restart it: values resume without restarting the app (new session per poll after failure).
6. Logged out Terminal: note whether it shows "failed to start", a rejected request, or per-ticker "no value".
7. Large lists: if the Terminal rejects 500 securities per request, lower `BATCH_SIZE`.
8. Known simplification: refdata has no source timestamp, so a quote's `source_update` is when the value last CHANGED between polls (unchanged values go Stale per the existing freshness rules). If a timestamp field exists for your metrics, say so and the parser can use it.
9. Still open from section 5: DLIM limits and licensing for unattended polling.

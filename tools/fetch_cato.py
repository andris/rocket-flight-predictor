"""Download Estes CATO reports from motorcato.org (MESS) and flag engines on "CATO watch".

Writes data/cato.json. Run it now and then (before a build) to refresh; the app
never talks to motorcato.org itself, so it works offline.

    python3 tools/fetch_cato.py

Nobody publishes how many of each engine get launched, so a true failure rate
can't be computed. Instead we compare each engine's share of all Estes reports
in the last two years with its share in the four years before. Reporting going
up overall doesn't move the share; a problem with one engine does.

Counting: several engines failing at one launch (same engine, date and place)
count once. An engine goes on watch when, in the last two years, it has at
least MIN_RECENT reports, its share at least doubled, and the rise is unlikely
to be chance (one-sided Fisher exact test, p < MAX_P). The badge is gentle and
the first two conditions already screen out flukes, so MAX_P isn't corrected
for testing every engine.
"""
import csv
import io
import json
import re
import urllib.request
from datetime import date, timedelta
from math import comb
from pathlib import Path

URL = "https://www.motorcato.org/search.csv?manufacturer=Estes%20Industries"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "cato.json"

RECENT_DAYS = 730
BASELINE_DAYS = 4 * 365
MIN_RECENT = 8
MIN_RATIO = 2.0
MAX_P = 0.05

# Typos in the "Common Name" field, seen in the data.
FIXES = {"E1604": "E16", "D1205": "D12", "E126": "E12", "F156": "F15"}


def upper_tail(a, b, c, d):
    """One-sided Fisher exact p: chance of a or more in the top-left cell."""
    r1, c1, n = a + b, a + c, a + b + c + d
    total = comb(n, c1)
    return sum(comb(r1, x) * comb(n - r1, c1 - x) for x in range(a, min(r1, c1) + 1)) / total


def main():
    motors = json.loads((ROOT / "data" / "motors.json").read_text())
    req = urllib.request.Request(URL, headers={"User-Agent": "rocket-flight-predictor (personal, non-commercial)"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        rows = list(csv.DictReader(io.StringIO(resp.read().decode("utf-8"))))

    events = set()
    for r in rows:
        if not r["Failure Date"]:
            continue
        name = r["Common Name"].strip().upper()
        name = FIXES.get(name, name)
        place = re.sub(r"\W", "", r["Location"].lower())[:10]
        events.add((name, date.fromisoformat(r["Failure Date"][:10]), place))

    as_of = max(d for _, d, _ in events)
    recent_from = as_of - timedelta(days=RECENT_DAYS)
    base_from = recent_from - timedelta(days=BASELINE_DAYS)
    recent = [n for n, d, _ in events if d > recent_from]
    base = [n for n, d, _ in events if base_from < d <= recent_from]

    out = {}
    for name in motors:
        a, c = recent.count(name), base.count(name)
        b, d = len(recent) - a, len(base) - c
        share_now, share_before = a / len(recent), c / len(base)
        ratio = share_now / share_before if c else None
        p = upper_tail(a, b, c, d)
        watch = a >= MIN_RECENT and (ratio is None or ratio >= MIN_RATIO) and p < MAX_P
        out[name] = {
            "recent": a,
            "share_now": round(share_now, 4),
            "share_before": round(share_before, 4),
            "ratio": round(ratio, 2) if ratio else None,
            "p": round(p, 5),
            "watch": watch,
        }
        print(f"{name:6} last 2 yrs {a:3}  share {share_now:5.1%} (was {share_before:5.1%})  "
              f"{(ratio or 0):4.1f}x  p={p:.4f}{'  WATCH' if watch else ''}")

    OUT.write_text(json.dumps({
        "source": "https://www.motorcato.org/",
        "as_of": as_of.isoformat(),
        "recent_from": recent_from.isoformat(),
        "reports_recent": len(recent),
        "motors": out,
    }, indent=1) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(rows)} reports, data through {as_of}")


if __name__ == "__main__":
    main()

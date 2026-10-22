"""Download Estes motor data and thrust curves from ThrustCurve.org.

Writes data/motors.json. Run this when we add motors; the app never talks to
ThrustCurve itself, so it works offline.

    python3 tools/fetch_motors.py
"""
import json
import urllib.request
from pathlib import Path

API = "https://www.thrustcurve.org/api/v1"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "motors.json"

# Motor types (designation without delay) the kit catalog can reference.
WANTED = ["1/2A6", "A8", "B4", "B6", "C5", "C6", "C11", "D12", "E16", "F15"]

# ThrustCurve has no total weight for a few motors. Estimated from similar 18 mm Estes motors (unverified).
WEIGHT_FALLBACK_G = {"1/2A6": 15.4}


def post(path, body):
    req = urllib.request.Request(
        f"{API}/{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def impulse(samples):
    pts = [(s["time"], s["thrust"]) for s in samples]
    if pts[0][0] > 0:
        pts.insert(0, (0.0, 0.0))
    return sum((t1 - t0) * (f0 + f1) / 2 for (t0, f0), (t1, f1) in zip(pts, pts[1:]))


def pick_curve(motor, simfiles):
    """Prefer certified data; among those, the curve whose impulse best matches the rating."""
    cert = [s for s in simfiles if s.get("source") == "cert"] or simfiles
    return min(cert, key=lambda s: abs(impulse(s["samples"]) - motor["totImpulseNs"]))


def main():
    found = post("search.json", {"manufacturer": "Estes", "maxResults": 200})["results"]
    motors = {m["designation"]: m for m in found if m["designation"] in WANTED}
    missing = set(WANTED) - set(motors)
    if missing:
        raise SystemExit(f"ThrustCurve has no data for: {sorted(missing)}")

    ids = [m["motorId"] for m in motors.values()]
    files = post("download.json", {"motorIds": ids, "data": "samples"})["results"]

    out = {}
    for name in WANTED:
        m = motors[name]
        curve = pick_curve(m, [f for f in files if f["motorId"] == m["motorId"]])
        pts = [[round(s["time"], 4), round(s["thrust"], 3)] for s in curve["samples"]]
        if pts[0][0] > 0:
            pts.insert(0, [0.0, 0.0])
        if pts[-1][1] != 0:
            pts.append([pts[-1][0] + 0.01, 0.0])
        total_g = m.get("totalWeightG") or WEIGHT_FALLBACK_G[name]
        out[name] = {
            "name": name,
            "diameter_mm": m["diameter"],
            "length_mm": m["length"],
            "impulse_ns": round(m["totImpulseNs"], 2),
            "avg_thrust_n": round(m["avgThrustN"], 2),
            "burn_time_s": round(m["burnTimeS"], 3),
            "total_mass_g": round(total_g, 1),
            "prop_mass_g": round(m["propWeightG"], 1),
            "delays": m.get("delays", ""),
            "curve": pts,
            "source": f"https://www.thrustcurve.org/motors/Estes/{name}/",
        }
        print(f"{name:6} {m['diameter']}mm {m['totImpulseNs']:6.2f} Ns  {len(pts)} pts")

    OUT.write_text(json.dumps(out, indent=1) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

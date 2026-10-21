"""Run every kit/engine combo through both sims (Python and app/sim.js) and
fail if they disagree. JS runs under macOS's built-in JavaScriptCore
(osascript), so no Node install is needed.

    python3 tools/check_sim.py
"""
import json
import subprocess
import tempfile
from pathlib import Path

from sim import simulate

ROOT = Path(__file__).resolve().parent.parent

CASES = [
    ({}, {}),
    ({"angle_deg": 80, "toward_deg": 45, "elev_m": 1600}, {"speed": 4.5, "from_deg": 270, "temp_c": 10}),
]


def combos(kit):
    for cfg in kit["configs"]:
        stacks = [[]]
        for st in cfg["stages"]:
            stacks = [s + [e] for s in stacks for e in st["engines"]]
        for eng in stacks:
            yield cfg, eng


def main():
    cat = json.loads((ROOT / "app" / "catalog.json").read_text())
    jobs = []
    for kit in cat["kits"]:
        for cfg, eng in combos(kit):
            for launch, wind in CASES:
                jobs.append({"kit": kit["id"], "cfg": cfg["id"], "eng": eng, "launch": launch, "wind": wind})

    harness = (ROOT / "app" / "sim.js").read_text() + f"""
var cat = {json.dumps(cat)};
var jobs = {json.dumps(jobs)};
JSON.stringify(jobs.map(function (j) {{
  var kit = cat.kits.filter(function (k) {{ return k.id === j.kit; }})[0];
  var cfg = kit.configs.filter(function (c) {{ return c.id === j.cfg; }})[0];
  var r = RocketSim.simulate(kit, cfg, j.eng, cat.motors, j.launch, j.wind);
  return [r.apogee_m, r.landed.x, r.landed.y, r.landed.t];
}}));
"""
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(harness)
    js = json.loads(subprocess.run(["osascript", "-l", "JavaScript", f.name],
                                   capture_output=True, text=True, check=True).stdout)

    worst = 0.0
    for job, jr in zip(jobs, js):
        kit = next(k for k in cat["kits"] if k["id"] == job["kit"])
        cfg = next(c for c in kit["configs"] if c["id"] == job["cfg"])
        r = simulate(kit, cfg, job["eng"], cat["motors"], job["launch"], job["wind"])
        pr = [r["apogee_m"], r["landed"]["x"], r["landed"]["y"], r["landed"]["t"]]
        diff = max(abs(a - b) for a, b in zip(pr, jr))
        worst = max(worst, diff)
        if diff > 0.01:
            raise SystemExit(f"MISMATCH {job}: python {pr} js {jr}")
    print(f"{len(jobs)} flights match (worst difference {worst:.2e} m)")


if __name__ == "__main__":
    main()

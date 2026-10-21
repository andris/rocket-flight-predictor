"""Compare simulated apogee with Estes's published max altitude for every kit.

Sea level, no wind, vertical. Estes's numbers are best-case marketing figures
(light unpainted build, ideal conditions), so expect us to come in lower.

    python3 tools/validate.py
"""
import json
from pathlib import Path

from sim import simulate

ROOT = Path(__file__).resolve().parent.parent
FT = 3.28084


def main():
    kits = json.loads((ROOT / "data" / "kits.json").read_text())["kits"]
    motors = json.loads((ROOT / "data" / "motors.json").read_text())
    flown = []
    for kit in kits:
        for opt in kit.get("recovery_options", [None]):
            if opt is None:
                flown.append((kit, ""))
            else:
                k = dict(kit, recovery=opt, mass_g=kit["mass_g"] + opt.get("mass_delta_g", 0))
                flown.append((k, f" — {opt['name']}"))
    for kit, label in flown:
        print(f"\n{kit['name']}{label}  (Estes: {kit['estes_altitude_note']})")
        for cfg in kit["configs"]:
            stacks = [[]]
            for st in cfg["stages"]:
                stacks = [s + [e] for s in stacks for e in st["engines"]]
            for eng in stacks:
                r = simulate(kit, cfg, eng, motors)
                if "error" in r:
                    print(f"  {cfg['name']:26} {' + '.join(eng):14} {r['error']}")
                    continue
                ej = r["eject"]
                ej_txt = f"eject {ej['speed']:4.1f} m/s" if ej else "NO EJECTION before landing"
                print(f"  {cfg['name']:26} {' + '.join(eng):14} apogee {r['apogee_m']*FT:5.0f} ft"
                      f"  rod-exit {r['rod_exit_v']:4.1f} m/s  best delay {r['best_delay']:3.1f}s  {ej_txt}"
                      f"  descent {r['landed']['t']-r['apogee_t']:5.1f}s")


if __name__ == "__main__":
    main()

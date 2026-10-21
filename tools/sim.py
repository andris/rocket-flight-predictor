"""Reference flight simulator (3-DOF point mass).

This is the Python twin of app/sim.js. The app runs the JS version; this one
exists so we can check the physics from the command line and confirm the two
agree (tools/check_sim.py).

Coordinates: x = east, y = north, z = up, meters. Wind "from" direction is
meteorological (degrees clockwise from north, the direction it blows FROM).
"""
import math

G = 9.80665
RHO_CHUTE_CD = 0.8      # Estes plastic chute, on the flat diameter
STREAMER_CD = 0.3       # on streamer area (width x length)
TUMBLE_CD = 1.0         # booster tumbling, on side area (length x diameter)
WIND_REF_M = 10.0       # forecast wind is measured at 10 m
WIND_EXP = 1 / 7        # power-law wind profile
TURN_K = 0.15           # how fast fins swing the nose into the relative wind, per (m/s of airspeed) per second


def air_density(field_elev, z, temp_c=None):
    """Air density at height z above a field at field_elev (m).

    ISA pressure; ground temperature from the weather if we have it, else ISA.
    """
    alt = field_elev + z
    t_isa = 288.15 - 0.0065 * alt
    p = 101325 * (t_isa / 288.15) ** 5.2559
    t = t_isa if temp_c is None else temp_c + 273.15 - 0.0065 * z
    return p / (287.05 * t)


def wind_at(z, speed, from_deg):
    """Wind velocity (vx, vy) at height z for a 10 m reference speed."""
    if speed <= 0:
        return 0.0, 0.0
    h = max(z, 1.0)
    s = speed * (h / WIND_REF_M) ** WIND_EXP
    s = min(s, speed * 2.0)
    a = math.radians(from_deg)
    return -s * math.sin(a), -s * math.cos(a)


class Motor:
    def __init__(self, data, delay):
        self.name = data["name"]
        self.curve = data["curve"]
        self.burn = self.curve[-1][0]
        self.total = data["total_mass_g"] / 1000
        self.prop = data["prop_mass_g"] / 1000
        self.delay = delay
        # cumulative impulse at each sample, for propellant burn-off
        cum = [0.0]
        for (t0, f0), (t1, f1) in zip(self.curve, self.curve[1:]):
            cum.append(cum[-1] + (t1 - t0) * (f0 + f1) / 2)
        self.cum = cum
        self.impulse = cum[-1]

    def thrust(self, t):
        c = self.curve
        if t <= 0 or t >= self.burn:
            return 0.0
        for i in range(1, len(c)):
            if t <= c[i][0]:
                t0, f0 = c[i - 1]
                t1, f1 = c[i]
                return f0 + (f1 - f0) * (t - t0) / (t1 - t0)
        return 0.0

    def mass(self, t):
        if t <= 0:
            return self.total
        if t >= self.burn:
            return self.total - self.prop
        c = self.curve
        for i in range(1, len(c)):
            if t <= c[i][0]:
                t0, f0 = c[i - 1]
                t1, f1 = c[i]
                f = f0 + (f1 - f0) * (t - t0) / (t1 - t0)
                used = self.cum[i - 1] + (t - t0) * (f0 + f) / 2
                return self.total - self.prop * used / self.impulse
        return self.total - self.prop


def parse_engine(code):
    """'B6-4' -> ('B6', 4); 'C6-0' -> ('C6', 0)."""
    name, delay = code.rsplit("-", 1)
    return name, float(delay)


def recovery_area_cd(rec):
    if rec["type"] == "parachute":
        d = rec["diameter_in"] * 0.0254
        return RHO_CHUTE_CD * math.pi * d * d / 4
    if rec["type"] == "streamer":
        return STREAMER_CD * rec.get("count", 1) * rec["width_in"] * rec["length_in"] * 0.0254 ** 2
    raise ValueError(rec["type"])


def simulate(kit, config, engines, motors, launch=None, wind=None, overrides=None):
    """Simulate one flight.

    engines: one engine code per stage, bottom stage first, e.g. ['C6-0', 'C6-7'].
    launch:  {'angle_deg': 90, 'toward_deg': 0, 'rod_m': 0.9, 'elev_m': 0}
    wind:    {'speed': m/s at 10 m, 'from_deg': 0, 'temp_c': None}
    overrides: {'mass_g': {...}, 'cd_scale': 1, 'chute_scale': 1, 'thrust_scale': 1}
    """
    launch = {"angle_deg": 90, "toward_deg": 0, "rod_m": 0.9, "elev_m": 0, **(launch or {})}
    wind = {"speed": 0.0, "from_deg": 0, "temp_c": None, **(wind or {})}
    ov = {"mass_g": {}, "cd_scale": 1.0, "chute_scale": 1.0, "thrust_scale": 1.0, **(overrides or {})}

    stages = config["stages"]
    assert len(engines) == len(stages)
    ms = [Motor(motors[parse_engine(e)[0]], parse_engine(e)[1]) for e in engines]
    boosters = stages[:-1]
    booster_mass = [ov["mass_g"].get(f"booster{i}", s["mass_g"]) / 1000 for i, s in enumerate(boosters)]
    upper_mass = (ov["mass_g"].get("rocket", kit["mass_g"]) + config.get("payload_g", 0)) / 1000

    area = math.pi * kit["diameter_m"] ** 2 / 4
    cda_body = kit["cd"] * ov["cd_scale"] * area
    cda_rec = recovery_area_cd(kit["recovery"]) * ov["chute_scale"]

    el = math.radians(launch["angle_deg"])
    az = math.radians(launch["toward_deg"])
    rod_dir = (math.cos(el) * math.sin(az), math.cos(el) * math.cos(az), math.sin(el))

    # state
    x = y = z = 0.0
    vx = vy = vz = 0.0
    t = 0.0
    stage = 0                 # index of the motor currently firing
    stage_t0 = 0.0            # time the current motor ignited
    attached = len(ms)        # motors still on the stack (bottom ones drop off)
    axis = rod_dir
    on_rod = True
    rod_exit_v = None
    burnout_t = None
    max_v = 0.0
    apogee = 0.0
    apogee_t = 0.0
    eject_t = None
    eject = None
    deployed = False
    booster_drops = []
    track = [(0.0, 0.0, 0.0, 0.0)]

    def stack_mass(t):
        m = upper_mass + sum(booster_mass[stage:len(boosters)])
        for i in range(stage, len(ms)):
            m += ms[i].mass(t - stage_t0) if i == stage else ms[i].total
        return m

    while True:
        dt = 0.002 if not deployed and burnout_t is None else (0.01 if not deployed else 0.05)
        m = stack_mass(t)
        thrust = 0.0
        if not deployed and burnout_t is None:
            thrust = ms[stage].thrust(t - stage_t0) * ov["thrust_scale"]

        wx, wy = wind_at(z, wind["speed"], wind["from_deg"])
        rx, ry, rz = vx - wx, vy - wy, vz
        vr = math.sqrt(rx * rx + ry * ry + rz * rz)
        rho = air_density(launch["elev_m"], z, wind["temp_c"])

        if on_rod:
            # constrained to slide along the rod; no weathercocking yet
            v_along = vx * rod_dir[0] + vy * rod_dir[1] + vz * rod_dir[2]
            drag = 0.5 * rho * cda_body * v_along * v_along
            a = (thrust - drag) / m - G * rod_dir[2]
            if v_along <= 0 and a <= 0:
                a = 0.0
            v_along += a * dt
            vx, vy, vz = (v_along * d for d in rod_dir)
            x += vx * dt
            y += vy * dt
            z += vz * dt
            t += dt
            if math.sqrt(x * x + y * y + z * z) >= launch["rod_m"]:
                on_rod = False
                rod_exit_v = v_along
            if t > 5 and z <= 0:
                return {"error": "no-liftoff"}
            continue

        if not deployed:
            if vr > 0.5:
                # fins swing the nose toward the relative wind, faster the faster it flies
                f = min(1.0, TURN_K * vr * dt)
                a3 = [a + (r / vr - a) * f for a, r in zip(axis, (rx, ry, rz))]
                an = math.sqrt(sum(c * c for c in a3))
                axis = tuple(c / an for c in a3)
            cda = cda_body
        else:
            cda = cda_body + cda_rec

        drag = 0.5 * rho * cda * vr
        ax = (thrust * axis[0] - drag * rx) / m
        ay = (thrust * axis[1] - drag * ry) / m
        az_ = (thrust * axis[2] - drag * rz) / m - G
        vx += ax * dt
        vy += ay * dt
        vz += az_ * dt
        x += vx * dt
        y += vy * dt
        z += vz * dt
        t += dt
        v = math.sqrt(vx * vx + vy * vy + vz * vz)
        max_v = max(max_v, v)

        if z > apogee:
            apogee, apogee_t = z, t

        # motor events
        if burnout_t is None and t - stage_t0 >= ms[stage].burn:
            if stage < len(boosters):
                booster_drops.append({
                    "t": t, "pos": (x, y, z), "vel": (vx, vy, vz),
                    "mass": booster_mass[stage] + ms[stage].total - ms[stage].prop,
                    "length": boosters[stage].get("length_m", 0.1),
                })
                stage += 1
                stage_t0 = t
            else:
                burnout_t = t
                burnout_alt = z
                eject_t = t + ms[stage].delay

        if not deployed and eject_t is not None and t >= eject_t:
            deployed = True
            eject = {"t": t, "alt": z, "speed": v}

        if len(track) == 0 or t - track[-1][0] >= (0.05 if not deployed else 0.5):
            track.append((t, x, y, z))

        if z <= 0 and t > 0.5:
            break
        if t > 600:
            break

    landed = {"t": t, "x": x, "y": y}
    boosters_out = [fly_booster(b, wind, launch, kit["diameter_m"]) for b in booster_drops]
    return {
        "apogee_m": apogee,
        "apogee_t": apogee_t,
        "max_speed": max_v,
        "rod_exit_v": rod_exit_v,
        "burnout_t": burnout_t,
        "burnout_alt": burnout_alt if burnout_t is not None else None,
        "eject": eject,               # None means it hit the ground before ejection
        "best_delay": apogee_t - burnout_t if burnout_t is not None else None,
        "landed": landed,
        "boosters": boosters_out,
        "track": track,
    }


def fly_booster(b, wind, launch, diameter):
    x, y, z = b["pos"]
    vx, vy, vz = b["vel"]
    cda = TUMBLE_CD * b["length"] * diameter
    m = b["mass"]
    t = b["t"]
    apogee = z
    while z > 0 and t < 600:
        dt = 0.02
        wx, wy = wind_at(z, wind["speed"], wind["from_deg"])
        rx, ry, rz = vx - wx, vy - wy, vz
        vr = math.sqrt(rx * rx + ry * ry + rz * rz)
        drag = 0.5 * air_density(launch["elev_m"], z, wind["temp_c"]) * cda * vr
        vx += (-drag * rx / m) * dt
        vy += (-drag * ry / m) * dt
        vz += (-drag * rz / m - G) * dt
        x += vx * dt
        y += vy * dt
        z += vz * dt
        t += dt
        apogee = max(apogee, z)
    return {"sep_t": b["t"], "apogee_m": apogee, "landed": {"t": t, "x": x, "y": y}}

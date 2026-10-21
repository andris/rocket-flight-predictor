// Flight simulator (3-DOF point mass). JS twin of tools/sim.py — keep the two in step;
// tools/check_sim.py runs both and fails if they disagree.
//
// Coordinates: x = east, y = north, z = up, meters. Wind "from" is meteorological
// (degrees clockwise from north that the wind blows FROM).
(function (root) {
  "use strict";

  const G = 9.80665;
  const CHUTE_CD = 0.8;     // Estes plastic chute, on the flat diameter
  const STREAMER_CD = 0.3;  // on streamer area (width x length)
  const TUMBLE_CD = 1.0;    // booster tumbling, on side area (length x diameter)
  const WIND_REF_M = 10;    // forecast wind is measured at 10 m
  const WIND_EXP = 1 / 7;   // power-law wind profile
  const TURN_K = 0.15;      // how fast fins swing the nose into the relative wind, per (m/s of airspeed) per second

  function airDensity(fieldElev, z, tempC) {
    const alt = fieldElev + z;
    const tIsa = 288.15 - 0.0065 * alt;
    const p = 101325 * Math.pow(tIsa / 288.15, 5.2559);
    const t = tempC == null ? tIsa : tempC + 273.15 - 0.0065 * z;
    return p / (287.05 * t);
  }

  function windAt(z, speed, fromDeg) {
    if (speed <= 0) return [0, 0];
    const h = Math.max(z, 1);
    const s = Math.min(speed * Math.pow(h / WIND_REF_M, WIND_EXP), speed * 2);
    const a = (fromDeg * Math.PI) / 180;
    return [-s * Math.sin(a), -s * Math.cos(a)];
  }

  function Motor(data, delay) {
    this.name = data.name;
    this.curve = data.curve;
    this.burn = this.curve[this.curve.length - 1][0];
    this.total = data.total_mass_g / 1000;
    this.prop = data.prop_mass_g / 1000;
    this.delay = delay;
    const cum = [0];
    for (let i = 1; i < this.curve.length; i++) {
      const [t0, f0] = this.curve[i - 1];
      const [t1, f1] = this.curve[i];
      cum.push(cum[i - 1] + ((t1 - t0) * (f0 + f1)) / 2);
    }
    this.cum = cum;
    this.impulse = cum[cum.length - 1];
  }

  Motor.prototype.thrust = function (t) {
    const c = this.curve;
    if (t <= 0 || t >= this.burn) return 0;
    for (let i = 1; i < c.length; i++) {
      if (t <= c[i][0]) {
        const [t0, f0] = c[i - 1];
        const [t1, f1] = c[i];
        return f0 + ((f1 - f0) * (t - t0)) / (t1 - t0);
      }
    }
    return 0;
  };

  Motor.prototype.mass = function (t) {
    if (t <= 0) return this.total;
    if (t >= this.burn) return this.total - this.prop;
    const c = this.curve;
    for (let i = 1; i < c.length; i++) {
      if (t <= c[i][0]) {
        const [t0, f0] = c[i - 1];
        const [t1, f1] = c[i];
        const f = f0 + ((f1 - f0) * (t - t0)) / (t1 - t0);
        const used = this.cum[i - 1] + ((t - t0) * (f0 + f)) / 2;
        return this.total - (this.prop * used) / this.impulse;
      }
    }
    return this.total - this.prop;
  };

  // "B6-4" -> ["B6", 4]
  function parseEngine(code) {
    const i = code.lastIndexOf("-");
    return [code.slice(0, i), parseFloat(code.slice(i + 1))];
  }

  function recoveryCdA(rec) {
    if (rec.type === "parachute") {
      const d = rec.diameter_in * 0.0254;
      return (CHUTE_CD * Math.PI * d * d) / 4;
    }
    if (rec.type === "streamer") {
      return STREAMER_CD * (rec.count || 1) * rec.width_in * rec.length_in * 0.0254 * 0.0254;
    }
    throw new Error("unknown recovery " + rec.type);
  }

  // Simulate one flight. engines: one code per stage, bottom stage first.
  // launch: {angle_deg, toward_deg, rod_m, elev_m}; wind: {speed (m/s at 10 m), from_deg, temp_c}
  // overrides: {mass_g: {rocket, booster0}, cd_scale, chute_scale, thrust_scale}
  function simulate(kit, config, engines, motors, launch, wind, overrides) {
    launch = Object.assign({ angle_deg: 90, toward_deg: 0, rod_m: 0.9, elev_m: 0 }, launch);
    wind = Object.assign({ speed: 0, from_deg: 0, temp_c: null }, wind);
    const ov = Object.assign({ mass_g: {}, cd_scale: 1, chute_scale: 1, thrust_scale: 1 }, overrides);
    const massG = ov.mass_g || {};

    const stages = config.stages;
    if (engines.length !== stages.length) throw new Error("one engine per stage");
    const ms = engines.map((e) => {
      const [name, delay] = parseEngine(e);
      return new Motor(motors[name], delay);
    });
    const boosters = stages.slice(0, -1);
    const boosterMass = boosters.map((s, i) => (massG["booster" + i] != null ? massG["booster" + i] : s.mass_g) / 1000);
    const upperMass = ((massG.rocket != null ? massG.rocket : kit.mass_g) + (config.payload_g || 0)) / 1000;

    const area = (Math.PI * kit.diameter_m * kit.diameter_m) / 4;
    const cdaBody = kit.cd * ov.cd_scale * area;
    const cdaRec = recoveryCdA(kit.recovery) * ov.chute_scale;

    const el = (launch.angle_deg * Math.PI) / 180;
    const az = (launch.toward_deg * Math.PI) / 180;
    const rodDir = [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)];

    let x = 0, y = 0, z = 0, vx = 0, vy = 0, vz = 0, t = 0;
    let stage = 0, stageT0 = 0;
    let axis = rodDir, onRod = true, rodExitV = null;
    let burnoutT = null, burnoutAlt = null, maxV = 0, apogee = 0, apogeeT = 0;
    let ejectT = null, eject = null, deployed = false;
    const boosterDrops = [];
    const track = [[0, 0, 0, 0]];

    function stackMass(t) {
      let m = upperMass;
      for (let i = stage; i < boosters.length; i++) m += boosterMass[i];
      for (let i = stage; i < ms.length; i++) m += i === stage ? ms[i].mass(t - stageT0) : ms[i].total;
      return m;
    }

    for (;;) {
      const dt = !deployed && burnoutT == null ? 0.002 : !deployed ? 0.01 : 0.05;
      const m = stackMass(t);
      let thrust = 0;
      if (!deployed && burnoutT == null) thrust = ms[stage].thrust(t - stageT0) * ov.thrust_scale;

      const [wx, wy] = windAt(z, wind.speed, wind.from_deg);
      const rx = vx - wx, ry = vy - wy, rz = vz;
      const vr = Math.sqrt(rx * rx + ry * ry + rz * rz);
      const rho = airDensity(launch.elev_m, z, wind.temp_c);

      if (onRod) {
        // constrained to slide along the rod; no weathercocking yet
        let vAlong = vx * rodDir[0] + vy * rodDir[1] + vz * rodDir[2];
        const drag = 0.5 * rho * cdaBody * vAlong * vAlong;
        let a = (thrust - drag) / m - G * rodDir[2];
        if (vAlong <= 0 && a <= 0) a = 0;
        vAlong += a * dt;
        vx = vAlong * rodDir[0]; vy = vAlong * rodDir[1]; vz = vAlong * rodDir[2];
        x += vx * dt; y += vy * dt; z += vz * dt;
        t += dt;
        if (Math.sqrt(x * x + y * y + z * z) >= launch.rod_m) {
          onRod = false;
          rodExitV = vAlong;
        }
        if (t > 5 && z <= 0) return { error: "no-liftoff" };
        continue;
      }

      let cda;
      if (!deployed) {
        if (vr > 0.5) {
          // fins swing the nose toward the relative wind, faster the faster it flies
          const f = Math.min(1, TURN_K * vr * dt);
          const ax = axis[0] + (rx / vr - axis[0]) * f, ay = axis[1] + (ry / vr - axis[1]) * f, az2 = axis[2] + (rz / vr - axis[2]) * f;
          const an = Math.sqrt(ax * ax + ay * ay + az2 * az2);
          axis = [ax / an, ay / an, az2 / an];
        }
        cda = cdaBody;
      } else {
        cda = cdaBody + cdaRec;
      }

      const drag = 0.5 * rho * cda * vr;
      vx += ((thrust * axis[0] - drag * rx) / m) * dt;
      vy += ((thrust * axis[1] - drag * ry) / m) * dt;
      vz += ((thrust * axis[2] - drag * rz) / m - G) * dt;
      x += vx * dt; y += vy * dt; z += vz * dt;
      t += dt;
      const v = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (v > maxV) maxV = v;
      if (z > apogee) { apogee = z; apogeeT = t; }

      if (burnoutT == null && t - stageT0 >= ms[stage].burn) {
        if (stage < boosters.length) {
          boosterDrops.push({
            t: t, pos: [x, y, z], vel: [vx, vy, vz],
            mass: boosterMass[stage] + ms[stage].total - ms[stage].prop,
            length: boosters[stage].length_m || 0.1,
          });
          stage += 1;
          stageT0 = t;
        } else {
          burnoutT = t;
          burnoutAlt = z;
          ejectT = t + ms[stage].delay;
        }
      }

      if (!deployed && ejectT != null && t >= ejectT) {
        deployed = true;
        eject = { t: t, alt: z, speed: v };
      }

      if (t - track[track.length - 1][0] >= (deployed ? 0.5 : 0.05)) track.push([t, x, y, z]);
      if (z <= 0 && t > 0.5) break;
      if (t > 600) break;
    }
    track.push([t, x, y, Math.max(z, 0)]);

    const boostersOut = boosterDrops.map((b) => flyBooster(b, wind, launch, kit.diameter_m));
    return {
      apogee_m: apogee,
      apogee_t: apogeeT,
      max_speed: maxV,
      rod_exit_v: rodExitV,
      burnout_t: burnoutT,
      burnout_alt: burnoutAlt,
      eject: eject, // null means it hit the ground before ejection
      best_delay: burnoutT != null ? apogeeT - burnoutT : null,
      landed: { t: t, x: x, y: y },
      boosters: boostersOut,
      track: track,
      liftoff_mass_kg: upperMass + boosterMass.reduce((a, b) => a + b, 0) + ms.reduce((a, m) => a + m.total, 0),
      first_motor_avg_thrust: ms[0].impulse / ms[0].burn,
    };
  }

  function flyBooster(b, wind, launch, diameter) {
    let [x, y, z] = b.pos;
    let [vx, vy, vz] = b.vel;
    const cda = TUMBLE_CD * b.length * diameter;
    const m = b.mass;
    let t = b.t, apogee = z;
    while (z > 0 && t < 600) {
      const dt = 0.02;
      const [wx, wy] = windAt(z, wind.speed, wind.from_deg);
      const rx = vx - wx, ry = vy - wy, rz = vz;
      const vr = Math.sqrt(rx * rx + ry * ry + rz * rz);
      const drag = 0.5 * airDensity(launch.elev_m, z, wind.temp_c) * cda * vr;
      vx += ((-drag * rx) / m) * dt;
      vy += ((-drag * ry) / m) * dt;
      vz += ((-drag * rz) / m - G) * dt;
      x += vx * dt; y += vy * dt; z += vz * dt;
      t += dt;
      if (z > apogee) apogee = z;
    }
    return { sep_t: b.t, apogee_m: apogee, landed: { t: t, x: x, y: y } };
  }

  // Deterministic PRNG so the same inputs always draw the same landing cloud.
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gauss(rand) {
    const u = Math.max(rand(), 1e-9), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // Run the nominal flight plus n perturbed ones: wind speed/direction are the
  // big unknowns, then drag, chute opening and motor variation.
  function predict(kit, config, engines, motors, launch, wind, overrides, n) {
    n = n == null ? 60 : n;
    const nominal = simulate(kit, config, engines, motors, launch, wind, overrides);
    if (nominal.error) return { nominal: nominal, runs: [] };
    const rand = mulberry32(12345);
    const runs = [];
    for (let i = 0; i < n; i++) {
      // forecast wind, off by ~25% in speed and ~15° in direction, plus an unforecast
      // light breeze from any direction (so "no wind" still shows some spread)
      const spd = Math.max(0, wind.speed * (1 + 0.25 * gauss(rand)));
      const dir = ((wind.from_deg + 15 * gauss(rand)) * Math.PI) / 180;
      const extra = 0.5 * Math.abs(gauss(rand)), extraDir = 2 * Math.PI * rand();
      const ex = spd * Math.sin(dir) + extra * Math.sin(extraDir);
      const ey = spd * Math.cos(dir) + extra * Math.cos(extraDir);
      const w = Object.assign({}, wind, {
        speed: Math.hypot(ex, ey),
        from_deg: (Math.atan2(ex, ey) * 180) / Math.PI,
      });
      const o = Object.assign({}, overrides, {
        cd_scale: (overrides && overrides.cd_scale || 1) * (1 + 0.1 * gauss(rand)),
        chute_scale: (overrides && overrides.chute_scale || 1) * Math.max(0.4, 1 + 0.2 * gauss(rand)),
        thrust_scale: (overrides && overrides.thrust_scale || 1) * (1 + 0.04 * gauss(rand)),
      });
      const r = simulate(kit, config, engines, motors, launch, w, o);
      if (!r.error) runs.push({ apogee_m: r.apogee_m, landed: r.landed, boosters: r.boosters.map((b) => b.landed) });
    }
    return { nominal: nominal, runs: runs };
  }

  root.RocketSim = { simulate: simulate, predict: predict, parseEngine: parseEngine, windAt: windAt, airDensity: airDensity };
})(typeof self !== "undefined" ? self : this);

// Rocket Flight Predictor — UI. Physics lives in sim.js; kit + motor data in catalog.js.
(function () {
  "use strict";

  const CAT = self.CATALOG;
  const SIM = self.RocketSim;
  const $ = (id) => document.getElementById(id);
  const M_PER_FT = 0.3048;
  const MS_PER_MPH = 0.44704;
  const G_PER_OZ = 28.3495;
  const DIRS16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const DIR_WORDS = { N: "north", E: "east", S: "south", W: "west" };
  const PICK8 = [["N", 0], ["NE", 45], ["E", 90], ["SE", 135], ["S", 180], ["SW", 225], ["W", 270], ["NW", 315]];

  const TERMS = {
    apogee: ["Apogee", "The highest point of the flight — the moment the rocket stops going up and starts coming down."],
    burnout: ["Burnout", "When the engine runs out of fuel. The rocket keeps coasting upward for a few seconds after this, like a ball you've thrown."],
    delay: ["Ejection delay", "The last number on the engine (the 5 in C6-5). After burnout the engine waits that many seconds, then pops the parachute out. The best delay opens the parachute right at the top, when the rocket is barely moving."],
    engine: ["Engine codes", "Take C6-5. The letter is the total power: each letter is twice as powerful as the one before (A, B, C, D…). The 6 is the average push in newtons. The 5 is the ejection delay in seconds. A -0 engine has no delay: it's a booster that lights the next stage."],
    booster: ["Booster", "The bottom stage of a two-stage rocket. When its engine burns out, it lights the top stage's engine and falls away. Boosters usually tumble back down without a parachute, close to the pad."],
    weathercock: ["Weathercocking", "Fins make a rocket turn to point into the wind, like a weathervane. So in wind, rockets tilt upwind on the way up, then the parachute drifts downwind on the way down."],
    drift: ["Drift", "How far the wind carries the rocket while it floats down under its parachute or streamer. The longer it hangs in the air, the farther it drifts."],
    weight: ["Why weight matters", "A heavier rocket goes less high. Your rocket probably weighs more than Estes says because of glue and paint. Weigh it ready to fly — parachute and nose cone in, but no engine — on a kitchen scale."],
    angle: ["Launch angle", "90° is straight up. Tilting the rod a little can steer the rocket away from trees or people. The safety code says never more than 30° from straight up, so 60° is the lowest allowed."],
    wind: ["Wind", "Use the wind about 30 feet up (that's what forecasts report). Wind is the biggest reason predictions miss, so the app tries many slightly different winds and shows where the rocket will probably land. Don't launch if the wind is over 20 mph."],
    elevation: ["Field elevation", "How high above sea level you are launching. The air is thinner up high (like here in Colorado), so rockets fly higher. Picking a launch site fills this in."],
    rod: ["Launch rod", "The metal rod that guides the rocket for its first few feet until it's going fast enough for the fins to keep it straight. Most Estes pads have a 3 ft rod."],
    descent: ["Descent rate", "How fast the rocket falls under its parachute or streamer. Slower means a softer landing but more drift."],
  };

  const LANDMARKS = [
    [18, "a giraffe"], [45, "a school bus standing on end"], [151, "the Statue of Liberty without her base"],
    [305, "the Statue of Liberty"], [555, "the Washington Monument"], [1063, "the Eiffel Tower"],
    [1454, "the Empire State Building"], [2717, "the Burj Khalifa, the world's tallest building"],
  ];

  // ---------- storage (works without it) ----------
  function load(key, dflt) {
    try { const v = localStorage.getItem("rfp." + key); return v == null ? dflt : JSON.parse(v); } catch (e) { return dflt; }
  }
  function save(key, val) {
    try { localStorage.setItem("rfp." + key, JSON.stringify(val)); } catch (e) { /* private mode etc. */ }
  }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* optional */ }

  const DEFAULTS = {
    kitId: CAT.kits[0].id, configId: null, engines: [],
    angle: 90, toward: 0, windMs: 0, windFrom: 0, elevM: 1615, tempC: null, rodM: 0.9,
    units: "imperial", siteId: null, forecastTime: null, fromForecast: null,
  };
  const S = Object.assign({}, DEFAULTS, load("state", {}));
  let weights = load("weights", {});   // {kitId: {rocket: g, booster0: g, updated: iso}}
  let sites = load("sites", []);       // [{id, name, lat, lon, elev_m, forecast}]

  function persist() { save("state", S); }

  // ---------- units + formatting ----------
  const imp = () => S.units === "imperial";
  const fmtInt = (n) => Math.round(n).toLocaleString();
  function len(m, opts) {
    if (imp()) return fmtInt(m / M_PER_FT) + (opts && opts.bare ? "" : " ft");
    return fmtInt(m) + (opts && opts.bare ? "" : " m");
  }
  const lenUnit = () => (imp() ? "ft" : "m");
  function speed(ms) { return imp() ? fmtInt(ms / MS_PER_MPH) + " mph" : fmtInt(ms * 3.6) + " km/h"; }
  function mass(g) { return imp() ? (g / G_PER_OZ).toFixed(2) + " oz" : (Math.round(g * 10) / 10) + " g"; }
  function secs(s) { return s.toFixed(1) + " s"; }
  function dir16(deg) { return DIRS16[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]; }
  function dirWords(abbr) { return abbr.split("").map((c) => DIR_WORDS[c]).join("-").replace(/^(\w+)-(\w+)-(\w+)$/, "$1-$2$3").replace(/^(\w+)-(\w+)$/, "$1$2"); }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const term = (key, text) => `<button type="button" class="tl" data-term="${key}">${text}</button>`;

  // ---------- catalog helpers ----------
  const kit = () => CAT.kits.find((k) => k.id === S.kitId) || CAT.kits[0];
  const config = () => { const k = kit(); return k.configs.find((c) => c.id === S.configId) || k.configs[0]; };
  const motorOf = (code) => CAT.motors[SIM.parseEngine(code)[0]];
  const hasBooster = (k) => k.configs.some((c) => c.stages.length > 1);
  function boosterSpecs(k) {
    // booster stages by index, taken from the first multi-stage config
    const c = k.configs.find((x) => x.stages.length > 1);
    return c ? c.stages.slice(0, -1) : [];
  }

  function fixSelection() {
    const k = kit();
    S.kitId = k.id;
    const c = config();
    S.configId = c.id;
    S.engines = c.stages.map((st, i) => (st.engines.includes(S.engines[i]) ? S.engines[i] : st.engines[Math.floor((st.engines.length - 1) / 2)]));
  }

  // ---------- rocket silhouettes ----------
  function rocketSvg(k) {
    const h = 64;
    const maxLen = Math.max.apply(null, CAT.kits.map((x) => x.length_m));
    const bodyH = 26 + (k.length_m / maxLen) * 34;
    const w = Math.max(7, Math.min(16, (k.diameter_m / k.length_m) * bodyH * 3));
    const nose = w * 1.6;
    const cx = 20, top = h - bodyH, finH = Math.min(14, bodyH * 0.28);
    const booster = hasBooster(k);
    const split = booster ? h - bodyH * 0.3 : null;
    return `<svg viewBox="0 0 40 ${h}" aria-hidden="true">
      <path d="M${cx - w / 2} ${top + nose} Q${cx - w / 2} ${top + nose * 0.3} ${cx} ${top} Q${cx + w / 2} ${top + nose * 0.3} ${cx + w / 2} ${top + nose} Z" fill="var(--accent)"/>
      <rect x="${cx - w / 2}" y="${top + nose}" width="${w}" height="${bodyH - nose}" fill="var(--ink)" rx="1"/>
      ${booster ? `<rect x="${cx - w / 2}" y="${split}" width="${w}" height="${h - split}" fill="var(--sky)"/>` : ""}
      <path d="M${cx - w / 2} ${h - finH} L${cx - w / 2 - 8} ${h} L${cx - w / 2} ${h} Z M${cx + w / 2} ${h - finH} L${cx + w / 2 + 8} ${h} L${cx + w / 2} ${h} Z" fill="var(--accent)"/>
      ${booster ? `<path d="M${cx - w / 2} ${split - finH * 0.8} L${cx - w / 2 - 5} ${split} L${cx - w / 2} ${split} Z M${cx + w / 2} ${split - finH * 0.8} L${cx + w / 2 + 5} ${split} L${cx + w / 2} ${split} Z" fill="var(--accent)"/>` : ""}
    </svg>`;
  }

  // ---------- render: setup ----------
  function renderKits() {
    $("kits").innerHTML = CAT.kits.map((k) => `
      <button type="button" class="kit${k.id === S.kitId ? " on" : ""}" data-kit="${k.id}" aria-pressed="${k.id === S.kitId}">
        ${rocketSvg(k)}
        <span class="name">${esc(k.name)}</span>
        <span class="meta">${esc(k.skill)}${hasBooster(k) ? " · 2-stage" : ""}</span>
      </button>`).join("");
  }

  function renderEngines() {
    const k = kit(), c = config();
    $("configs").innerHTML = k.configs.length > 1
      ? k.configs.map((x) => `<button type="button" data-config="${x.id}" class="${x.id === c.id ? "on" : ""}">${esc(x.name)}</button>`).join("")
      : "";
    $("engine-title").textContent = c.stages.length > 1 ? "Pick the engines" : "Pick the engine";
    $("stages").innerHTML = c.stages.map((st, i) => {
      const isBooster = i < c.stages.length - 1;
      const label = c.stages.length === 1 ? "Engine" : isBooster ? `Bottom stage — ${term("booster", "booster")}` : "Top stage";
      return `<div class="stage">
        <div class="stage-label">${label}</div>
        <div class="chips">${st.engines.map((e) => `<button type="button" class="chip${S.engines[i] === e ? " on" : ""}" data-stage="${i}" data-engine="${esc(e)}">${esc(e)}</button>`).join("")}</div>
      </div>`;
    }).join("");
    const top = S.engines[S.engines.length - 1];
    const [name, delay] = SIM.parseEngine(top);
    const m = motorOf(top);
    const letter = name.replace(/[0-9]+$/, "");
    const push = name.slice(letter.length);
    $("engine-explain").innerHTML = `${esc(top)}: ${esc(letter)} = ${m.impulse_ns.toFixed(1)} newton-seconds of total power, ${esc(push)} = about ${esc(push)} newtons of average push, ${delay} = ${term("delay", `${delay}-second delay`)} before the parachute pops. ${term("engine", "How engine codes work")}`;
  }

  function weightPart(k, key, label, kitG, estimated) {
    const w = weights[k.id] && weights[k.id][key];
    const shown = w == null ? "" : imp() ? (w / G_PER_OZ).toFixed(2) : String(Math.round(w * 10) / 10);
    let diff = "";
    if (w != null) {
      const d = w - kitG, pct = (d / kitG) * 100;
      const cls = d > 0 ? "heavy" : "light";
      const words = Math.abs(pct) < 2 ? "Right on the kit spec — nice building!"
        : d > 0 ? `${mass(d)} (${pct.toFixed(0)}%) heavier than the kit. That's glue and paint!`
        : `${mass(-d)} (${(-pct).toFixed(0)}%) lighter than the kit.`;
      diff = `<p class="diff ${cls}">${words} The prediction uses your weight.</p>`;
    }
    return `<div class="weight-row">
      <div class="label">${label}</div>
      <div class="kit-weight"><small>Estes kit${estimated ? " (our estimate)" : ""}</small><strong>${mass(kitG)}</strong></div>
      <div><small>We weighed</small>
        <div class="input-unit"><input type="number" inputmode="decimal" step="any" min="0" data-weigh="${key}" value="${shown}" placeholder="—" aria-label="${esc(label)} weighed weight"><span>${imp() ? "oz" : "g"}</span></div>
      </div>
    </div>${diff}`;
  }

  function renderWeights() {
    const k = kit();
    const multi = hasBooster(k);
    const est = (word) => (k.estimated || []).some((e) => e.indexOf(word) >= 0);
    let html = weightPart(k, "rocket", multi ? "Top stage (rocket without booster)" : k.name, k.mass_g, multi && est("split"));
    boosterSpecs(k).forEach((b, i) => { html += weightPart(k, "booster" + i, "Booster", b.mass_g, est("split")); });
    const c = config();
    if (c.payload_g) html += `<p class="small">Plus ${mass(c.payload_g)} of payload (${esc(c.name.toLowerCase())}).</p>`;
    html += `<p class="small">Weigh it ready to fly but with no engine. ${weights[k.id] && weights[k.id].updated ? "Last weighed " + new Date(weights[k.id].updated).toLocaleDateString() + "." : ""}</p>`;
    $("weights").innerHTML = html;
  }

  function renderCompass(el, value, attr) {
    el.innerHTML = PICK8.map(([lbl, deg]) => {
      const on = Math.abs(((value - deg + 540) % 360) - 180) < 22.5;
      return `<button type="button" data-${attr}="${deg}" class="${on ? "on" : ""}" aria-pressed="${on}">${lbl}</button>`;
    }).join("");
  }

  function renderLaunch() {
    $("angle").value = S.angle;
    $("angle-out").textContent = S.angle + "°";
    $("tilt-field").hidden = S.angle >= 90;
    renderCompass($("tilt"), S.toward, "toward");
    const windDisp = imp() ? S.windMs / MS_PER_MPH : S.windMs * 3.6;
    $("wind").max = imp() ? 25 : 40;
    $("wind").value = Math.round(windDisp);
    $("wind-out").textContent = speed(S.windMs);
    $("wind-dir-field").hidden = S.windMs <= 0;
    renderCompass($("wind-from"), S.windFrom, "from");
    $("elev").value = Math.round(imp() ? S.elevM / M_PER_FT : S.elevM);
    $("elev-unit").textContent = lenUnit();
    $("temp").value = S.tempC == null ? "" : Math.round(imp() ? S.tempC * 9 / 5 + 32 : S.tempC);
    $("temp-unit").textContent = imp() ? "°F" : "°C";
    $("rod").value = imp() ? +(S.rodM / M_PER_FT).toFixed(1) : +S.rodM.toFixed(2);
    $("rod-unit").textContent = lenUnit();
    document.querySelectorAll("[data-units]").forEach((b) => b.classList.toggle("on", b.dataset.units === S.units));
    renderSite();
  }

  // ---------- launch sites + forecast (Open-Meteo, cached for offline) ----------
  function site() { return sites.find((s) => s.id === S.siteId) || null; }

  function nextTenAm() {
    const d = new Date();
    if (d.getHours() >= 10) d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
    return localIso(d);
  }
  function localIso(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`;
  }

  function forecastAt(s, when) {
    const f = s && s.forecast;
    if (!f) return null;
    const hour = when.slice(0, 13) + ":00";
    const i = f.hourly.time.indexOf(hour);
    if (i < 0) return null;
    return {
      speed: f.hourly.wind_speed_10m[i], from: f.hourly.wind_direction_10m[i],
      gust: f.hourly.wind_gusts_10m[i], temp: f.hourly.temperature_2m[i],
    };
  }

  function renderSite() {
    const s = site();
    const when = S.forecastTime || nextTenAm();
    let html = `<div class="site-box"><div class="field" style="margin:0"><label>Launch site</label>`;
    html += `<div class="row"><select id="site-select" aria-label="Launch site"><option value="">No site picked</option>${sites.map((x) => `<option value="${x.id}"${x.id === S.siteId ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select>`;
    html += `<button type="button" class="btn ghost" id="site-add-toggle">Add</button></div>`;
    html += `<div id="site-add" hidden>
      <div class="row"><input type="text" id="site-q" placeholder="Town or place name" aria-label="Search places"><button type="button" class="btn" id="site-search">Search</button></div>
      <div class="row"><button type="button" class="btn ghost" id="site-here">Use where I am now</button></div>
      <div id="site-results" class="small"></div>
    </div></div>`;
    if (s) {
      const f = s.forecast;
      html += `<p class="small">${esc(s.name)} · ${len(s.elev_m)} above sea level.</p>`;
      html += `<div class="row"><button type="button" class="btn" id="fc-get">${f ? "Refresh forecast" : "Get forecast"}</button>
        <span class="small" id="fc-status">${f ? "Saved " + new Date(f.fetched).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " — works offline" : "Needs internet once, then works offline."}</span></div>`;
      if (f) {
        const first = f.hourly.time[0], last = f.hourly.time[f.hourly.time.length - 1];
        const fc = forecastAt(s, when);
        html += `<div class="row"><input type="datetime-local" id="fc-time" step="3600" min="${first}" max="${last}" value="${when}" aria-label="Launch time">
          <button type="button" class="btn" id="fc-use"${fc ? "" : " disabled"}>Use this weather</button></div>`;
        html += `<p class="small">${fc ? `${speed(fc.speed)} from the ${dir16(fc.from)} (gusts ${speed(fc.gust)}), ${Math.round(imp() ? fc.temp * 9 / 5 + 32 : fc.temp)}°${imp() ? "F" : "C"}.` : "No forecast for that hour — pick a time between " + new Date(first).toLocaleDateString() + " and " + new Date(last).toLocaleDateString() + "."}</p>`;
      }
      html += `<div class="row"><button type="button" class="btn ghost" id="site-remove">Remove this site</button></div>`;
    }
    $("site").innerHTML = html;
  }

  async function fetchJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  async function getForecast(s) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${s.lat}&longitude=${s.lon}` +
      `&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m&wind_speed_unit=ms&timezone=auto&forecast_days=16`;
    const d = await fetchJson(url);
    s.forecast = { fetched: new Date().toISOString(), hourly: d.hourly };
    if (typeof d.elevation === "number") s.elev_m = d.elevation;
    save("sites", sites);
  }

  async function addSite(name, lat, lon, elev) {
    const s = { id: "s" + Date.now(), name: name, lat: +lat.toFixed(4), lon: +lon.toFixed(4), elev_m: elev || 0, forecast: null };
    sites.push(s);
    S.siteId = s.id;
    S.elevM = s.elev_m;
    try { await getForecast(s); S.elevM = s.elev_m; } catch (e) { /* offline: forecast later */ }
    save("sites", sites);
    persist();
    renderLaunch();
    update();
  }

  // ---------- predict + render results ----------
  function overrides() {
    const w = weights[S.kitId] || {};
    const ov = { mass_g: {} };
    if (w.rocket != null) ov.mass_g.rocket = w.rocket;
    Object.keys(w).forEach((k) => { if (k.indexOf("booster") === 0 && w[k] != null) ov.mass_g[k] = w[k]; });
    return ov;
  }

  function percentile(arr, p) {
    const a = arr.slice().sort((x, y) => x - y);
    if (!a.length) return NaN;
    return a[Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))))];
  }

  function niceStep(maxM) {
    const unit = imp() ? M_PER_FT : 1;
    const v = maxM / unit;
    const steps = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
    const s = steps.find((x) => v / x <= 4) || 10000;
    return s * unit;
  }

  function mapSvg(res, landN) {
    const W = 320, C = W / 2;
    const pts = res.runs.map((r) => r.landed).concat([landN]);
    res.nominal.boosters.forEach((b) => pts.push(b.landed));
    res.runs.forEach((r) => r.boosters.forEach((b) => pts.push(b)));
    const maxR = Math.max(30, Math.max.apply(null, pts.map((p) => Math.hypot(p.x, p.y))) * 1.12);
    const k = (C - 22) / maxR;
    const P = (p) => [C + p.x * k, C - p.y * k];
    const step = niceStep(maxR);
    let rings = "";
    for (let r = step; r <= maxR; r += step) {
      rings += `<circle cx="${C}" cy="${C}" r="${r * k}" fill="none" stroke="var(--line)" stroke-width="1"/>` +
        `<text x="${C + 4}" y="${C - r * k - 3}">${len(r)}</text>`;
    }
    const cloud = res.runs.map((r) => { const [x, y] = P(r.landed); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="var(--cloud)"/>`; }).join("");
    const bcloud = res.runs.map((r) => r.boosters.map((b) => { const [x, y] = P(b); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="var(--booster)" opacity="0.35"/>`; }).join("")).join("");
    const [lx, ly] = P(landN);
    const boosters = res.nominal.boosters.map((b) => { const [x, y] = P(b.landed); return `<rect x="${x - 5}" y="${y - 5}" width="10" height="10" fill="var(--booster)" stroke="var(--card)" stroke-width="2" transform="rotate(45 ${x} ${y})"/>`; }).join("");
    let windArrow = "";
    if (S.windMs > 0) {
      const to = (S.windFrom + 180) % 360;
      windArrow = `<g transform="translate(${W - 34} 34) rotate(${to})"><circle r="22" fill="var(--card)" stroke="var(--line)"/><path d="M0 -14 L6 2 L1 0 L1 14 L-1 14 L-1 0 L-6 2 Z" fill="var(--sky)"/></g><text x="${W - 34}" y="72" text-anchor="middle">wind</text>`;
    }
    // track ground path
    const path = res.nominal.track.map((p, i) => { const [x, y] = P({ x: p[1], y: p[2] }); return (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1); }).join("");
    return `<svg viewBox="0 0 ${W} ${W}" role="img" aria-label="Top-down map of where the rocket lands">
      ${rings}
      <line x1="${C}" y1="8" x2="${C}" y2="${W - 8}" stroke="var(--line)" stroke-dasharray="3 4"/>
      <line x1="8" y1="${C}" x2="${W - 8}" y2="${C}" stroke="var(--line)" stroke-dasharray="3 4"/>
      <text x="${C}" y="16" text-anchor="middle" font-weight="700">N</text>
      <text x="${W - 12}" y="${C - 4}" text-anchor="middle">E</text><text x="${C}" y="${W - 6}" text-anchor="middle">S</text><text x="12" y="${C - 4}" text-anchor="middle">W</text>
      ${cloud}${bcloud}
      <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.8"/>
      <circle cx="${C}" cy="${C}" r="6" fill="var(--pad)"/>
      ${boosters}
      <circle cx="${lx}" cy="${ly}" r="8" fill="var(--accent)" stroke="var(--card)" stroke-width="3"/>
      ${windArrow}
    </svg>`;
  }

  function sideSvg(res, landN) {
    const W = 320, H = 220, padL = 44, padB = 26, padT = 12, padR = 12;
    const tr = res.nominal.track;
    const d = Math.hypot(landN.x, landN.y);
    let ux = 0, uy = 1;
    if (d > 1) { ux = landN.x / d; uy = landN.y / d; }
    else if (S.windMs > 0) { const a = ((S.windFrom + 180) * Math.PI) / 180; ux = Math.sin(a); uy = Math.cos(a); }
    const pts = tr.map((p) => [p[1] * ux + p[2] * uy, p[3]]);
    const xs = pts.map((p) => p[0]);
    let xmin = Math.min(0, Math.min.apply(null, xs)), xmax = Math.max(0, Math.max.apply(null, xs));
    const zmax = Math.max(10, res.nominal.apogee_m) * 1.08;
    // keep the picture readable: at least a third as wide as tall
    const minSpan = zmax * 0.6;
    if (xmax - xmin < minSpan) { const mid = (xmax + xmin) / 2; xmin = mid - minSpan / 2; xmax = mid + minSpan / 2; }
    const sx = (W - padL - padR) / (xmax - xmin), sz = (H - padT - padB) / zmax;
    const X = (x) => padL + (x - xmin) * sx, Z = (z) => H - padB - z * sz;
    const line = pts.map((p, i) => (i ? "L" : "M") + X(p[0]).toFixed(1) + " " + Z(p[1]).toFixed(1)).join("");
    const step = niceStep(zmax);
    let grid = "";
    for (let z = step; z < zmax; z += step) grid += `<line x1="${padL}" x2="${W - padR}" y1="${Z(z)}" y2="${Z(z)}" stroke="var(--line)"/><text x="${padL - 4}" y="${Z(z) + 4}" text-anchor="end">${len(z, { bare: true })}</text>`;
    const at = (t) => { let best = pts[0], bt = Infinity; tr.forEach((p, i) => { if (Math.abs(p[0] - t) < bt) { bt = Math.abs(p[0] - t); best = pts[i]; } }); return best; };
    const anchor = (x) => (x > W - 60 ? "end" : x < padL + 40 ? "start" : "middle");
    const nudge = (x) => (x < padL + 40 ? x + 8 : x > W - 60 ? x - 8 : x);
    const ap = at(res.nominal.apogee_t);
    const ej = res.nominal.eject ? at(res.nominal.eject.t) : null;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Side view of the flight path">
      ${grid}
      <line x1="${padL}" x2="${W - padR}" y1="${Z(0)}" y2="${Z(0)}" stroke="var(--ink-2)"/>
      <text x="${padL - 4}" y="${padT + 4}" text-anchor="end">${lenUnit()}</text>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5"/>
      <circle cx="${X(0)}" cy="${Z(0)}" r="5" fill="var(--pad)"/>
      <circle cx="${X(ap[0])}" cy="${Z(ap[1])}" r="5" fill="var(--sky)"/>
      <text x="${nudge(X(ap[0]))}" y="${Z(ap[1]) - 8}" text-anchor="${anchor(X(ap[0]))}">peak</text>
      ${ej ? `<circle cx="${X(ej[0])}" cy="${Z(ej[1])}" r="4" fill="var(--good)"/><text x="${nudge(X(ej[0]))}" y="${Z(ej[1]) + 18}" text-anchor="${anchor(X(ej[0]))}">${kit().recovery.type === "streamer" ? "streamer" : "parachute"} out</text>` : ""}
      <text x="${W - padR}" y="${H - 6}" text-anchor="end">→ toward landing</text>
    </svg>`;
  }

  function walkArrow(bearing) {
    return `<svg width="54" height="54" viewBox="-27 -27 54 54" aria-hidden="true"><circle r="25" fill="var(--card)" stroke="var(--line)"/>
      <text y="-15" text-anchor="middle" font-size="9" fill="var(--ink-2)">N</text>
      <g transform="rotate(${bearing})"><path d="M0 -18 L8 4 L2 1 L2 16 L-2 16 L-2 1 L-8 4 Z" fill="var(--accent)"/></g></svg>`;
  }

  function delayAdvice(res) {
    const n = res.nominal, c = config(), top = S.engines[S.engines.length - 1];
    const [name, delay] = SIM.parseEngine(top);
    if (!n.eject) return { cls: "bad", html: `<strong>Hits the ground before the ${kit().recovery.type} comes out!</strong> Pick an engine with a shorter delay.` };
    const early = n.apogee_t - n.eject.t;  // >0: opens before the peak
    const options = c.stages[c.stages.length - 1].engines.filter((e) => SIM.parseEngine(e)[0] === name);
    const best = options.reduce((a, e) => (Math.abs(SIM.parseEngine(e)[1] - n.best_delay) < Math.abs(SIM.parseEngine(a)[1] - n.best_delay) ? e : a), top);
    const better = best !== top ? ` ${esc(best)} would be closer, and it's on the recommended list.` : "";
    if (Math.abs(early) <= 1.2) return { cls: "good", html: `<strong>Good ${term("delay", "delay")}.</strong> It pops near the top while the rocket is slow (${speed(n.eject.speed)}). The perfect delay would be ${n.best_delay.toFixed(1)} s.` };
    if (early > 0) return { cls: "warn", html: `<strong>Pops ${early.toFixed(1)} s before the top</strong>, while still going up at ${speed(n.eject.speed)}. The perfect delay would be ${n.best_delay.toFixed(1)} s.${better}` };
    return { cls: "warn", html: `<strong>Pops ${(-early).toFixed(1)} s after the top</strong>, when it's falling at ${speed(n.eject.speed)}. The perfect delay would be ${n.best_delay.toFixed(1)} s.${better}` };
  }

  function update() {
    persist();
    const k = kit(), c = config();
    const launch = { angle_deg: S.angle, toward_deg: S.toward, rod_m: S.rodM, elev_m: S.elevM };
    const wind = { speed: S.windMs, from_deg: S.windFrom, temp_c: S.tempC };
    let res;
    try { res = SIM.predict(k, c, S.engines, CAT.motors, launch, wind, overrides(), 60); }
    catch (e) { $("results").innerHTML = `<h2>Prediction</h2><p class="empty">Something went wrong: ${esc(e.message)}</p>`; return; }
    const n = res.nominal;
    if (n.error) {
      $("results").innerHTML = `<h2>Prediction</h2><div class="note bad"><strong>Won't lift off.</strong> This engine can't lift this much weight. Check the weight you entered.</div>`;
      return;
    }

    const apLo = percentile(res.runs.map((r) => r.apogee_m), 10), apHi = percentile(res.runs.map((r) => r.apogee_m), 90);
    const land = n.landed;
    const dist = Math.hypot(land.x, land.y);
    const bearing = (Math.atan2(land.x, land.y) * 180 / Math.PI + 360) % 360;
    const dists = res.runs.map((r) => Math.hypot(r.landed.x, r.landed.y));
    const dLo = percentile(dists, 10), dHi = percentile(dists, 90);
    const apFt = n.apogee_m / M_PER_FT;
    const mark = LANDMARKS.filter((l) => l[0] < apFt).pop();
    const fun = mark ? `Higher than ${mark[1]}!` : "About as high as a few houses stacked up.";
    const rec = k.recovery.type === "streamer" ? "streamer" : "parachute";
    const descentRate = n.eject ? (n.eject.alt) / Math.max(1, land.t - n.eject.t) : null;
    const stageTxt = S.engines.join(" + ");
    const w = weights[k.id] || {};

    const where = dist < (imp() ? 30 * M_PER_FT : 10)
      ? `<div class="v">Near the pad</div><div class="s">Within ${len(dist + 5)}. No wind to carry it.</div>`
      : `<div class="walk">${walkArrow(bearing)}<div><div class="v">${len(dist, { bare: true })}<small> ${lenUnit()}</small></div><div class="s">to the <strong>${dirWords(dir16(bearing))}</strong> (${dir16(bearing)}) · probably ${len(dLo, { bare: true })}–${len(dHi)}</div></div></div>`;

    // timeline
    const tl = [];
    const ev = (t, html) => tl.push([t, `<li><span class="t">${t === 0 ? "0 s" : secs(t)}</span><span>${html}</span></li>`]);
    ev(0, `Liftoff! Leaves the ${term("rod", "rod")} at ${speed(n.rod_exit_v)}.`);
    if (c.stages.length > 1 && n.boosters.length) {
      const b0 = n.boosters[0];
      ev(b0.sep_t, `${term("booster", "Booster")} burns out and lights the top stage. The booster tumbles back and lands ${len(Math.hypot(b0.landed.x, b0.landed.y))} from the pad.`);
    }
    ev(n.burnout_t, `${term("burnout", "Burnout")} at ${len(n.burnout_alt)} — then it coasts. Top speed ${speed(n.max_speed)}.`);
    ev(n.apogee_t, `${term("apogee", "Apogee")}: ${len(n.apogee_m)} up.`);
    if (n.eject) ev(n.eject.t, `${rec[0].toUpperCase() + rec.slice(1)} comes out at ${len(n.eject.alt)}.`);
    ev(land.t, `Touchdown${descentRate ? `, falling at about ${speed(descentRate)} (${term("descent", "descent rate")})` : ""}.`);

    // notes
    const notes = [delayAdvice(res)];
    if (S.windMs > 20 * MS_PER_MPH) notes.push({ cls: "bad", html: `<strong>Too windy to launch.</strong> The safety code says no launches in wind over 20 mph.` });
    if (n.rod_exit_v < Math.max(9, 3 * S.windMs)) notes.push({ cls: "warn", html: `<strong>Slow off the rod (${speed(n.rod_exit_v)}).</strong> It may ${term("weathercock", "weathercock")} hard into the wind or wobble. A longer rod helps.` });
    if (n.eject && n.eject.speed > 25) notes.push({ cls: "warn", html: `<strong>The ${rec} comes out fast (${speed(n.eject.speed)}).</strong> That can rip a parachute or snap a shock cord.` });
    if (S.windMs > 0 && dist > 0) notes.push({ cls: "", html: `In wind, rockets ${term("weathercock", "tip upwind")} on the way up, then ${term("drift", "drift")} downwind under the ${rec}. The orange dots on the map are other likely landing spots.` });
    const estAlt = c.estes_max_altitude_ft || k.estes_max_altitude_ft;
    notes.push({ cls: "", html: `<strong>Estes says:</strong> ${esc(c.estes_max_altitude_ft ? `up to ${c.estes_max_altitude_ft} ft (${c.name.toLowerCase()})` : k.estes_altitude_note.replace(/^Estes: /, ""))}. That's a best case with their best engine, a light build and no wind. We predict ${len(n.apogee_m)} for ${esc(stageTxt)}${S.elevM > 300 ? ` at ${len(S.elevM)} elevation` : ""}.` });
    const usingWeighed = w.rocket != null || Object.keys(w).some((x) => x.indexOf("booster") === 0);
    notes.push({ cls: "", html: `${usingWeighed ? "Using the weight you measured." : "Using the Estes kit weight — weigh yours in step 3 for a better prediction."}${(k.estimated || []).length ? " Some numbers for this kit are our estimates (" + esc(k.estimated.join(", ")) + ")." : ""}` });

    const fc = S.fromForecast ? `<p class="small">Weather: forecast for ${esc(S.fromForecast)}.</p>` : "";
    $("results").innerHTML = `
      <h2>Prediction: ${esc(k.name)} on ${esc(stageTxt)}</h2>
      ${fc}
      <div class="big-row">
        <div class="big"><div class="k">How high ${term("apogee", "(apogee)")}</div>
          <div class="v">${len(n.apogee_m, { bare: true })}<small> ${lenUnit()}</small></div>
          <div class="s">probably ${len(apLo, { bare: true })}–${len(apHi)}</div>
          <div class="fun">${fun}</div></div>
        <div class="big"><div class="k">Where it lands</div>${where}</div>
      </div>
      <div class="views">
        <div class="view"><h3>From above (north is up)</h3>${mapSvg(res, land)}
          <div class="legend"><span><i style="background:var(--pad)"></i>pad</span><span><i style="background:var(--accent)"></i>best guess</span><span><i style="background:var(--cloud)"></i>other likely spots</span>${n.boosters.length ? `<span><i style="background:var(--booster)"></i>booster</span>` : ""}</div></div>
        <div class="view"><h3>From the side</h3>${sideSvg(res, land)}</div>
      </div>
      <ol class="timeline">${tl.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join("")}</ol>
      <div class="notes">${notes.map((x) => `<div class="note ${x.cls}">${x.html}</div>`).join("")}</div>`;
  }

  // Optional setup in the link, e.g. #kit=mongoose&config=two-stage&engines=C6-0,C6-7&wind=8&from=270
  function readHash() {
    if (!location.hash) return;
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("kit")) { S.kitId = h.get("kit"); S.configId = h.get("config"); }
    if (h.get("engines")) S.engines = h.get("engines").split(",");
    if (h.get("wind")) S.windMs = +h.get("wind") * MS_PER_MPH;
    if (h.get("from")) S.windFrom = +h.get("from");
    if (h.get("angle")) S.angle = +h.get("angle");
    if (h.get("toward")) S.toward = +h.get("toward");
  }

  function renderAll() {
    fixSelection();
    renderKits();
    renderEngines();
    renderWeights();
    renderLaunch();
    update();
  }

  // ---------- events ----------
  document.addEventListener("click", async (ev) => {
    const b = ev.target.closest("button, [data-term]");
    if (!b) return;
    const d = b.dataset;
    if (d.term) {
      const t = TERMS[d.term];
      $("pop-title").textContent = t[0];
      $("pop-text").textContent = t[1];
      $("pop").hidden = false;
      $("pop-close").focus();
      return;
    }
    if (b.id === "pop-close") { $("pop").hidden = true; return; }
    if (d.kit) { S.kitId = d.kit; S.configId = null; renderAll(); return; }
    if (d.config) { S.configId = d.config; renderAll(); return; }
    if (d.engine) { S.engines[+d.stage] = d.engine; renderEngines(); update(); return; }
    if (d.units) { S.units = d.units; renderAll(); return; }
    if (d.toward != null) { S.toward = +d.toward; renderLaunch(); update(); return; }
    if (d.from != null) { S.windFrom = +d.from; S.fromForecast = null; renderLaunch(); update(); return; }

    if (b.id === "site-add-toggle") { $("site-add").hidden = !$("site-add").hidden; if (!$("site-add").hidden) $("site-q").focus(); return; }
    if (b.id === "site-search") {
      const q = $("site-q").value.trim();
      if (!q) return;
      $("site-results").textContent = "Searching…";
      try {
        const r = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en`);
        const list = r.results || [];
        $("site-results").innerHTML = list.length
          ? list.map((p, i) => `<div class="row"><button type="button" class="btn ghost" data-place="${i}">${esc(p.name)}${p.admin1 ? ", " + esc(p.admin1) : ""}${p.country_code ? " " + esc(p.country_code) : ""}</button></div>`).join("")
          : "Nothing found.";
        $("site-results")._places = list;
      } catch (e) { $("site-results").textContent = "Couldn't search — are you online?"; }
      return;
    }
    if (d.place != null) {
      const p = $("site-results")._places[+d.place];
      const name = prompt("Name this launch site", p.name) || p.name;
      await addSite(name, p.latitude, p.longitude, p.elevation);
      return;
    }
    if (b.id === "site-here") {
      if (!navigator.geolocation) { $("site-results").textContent = "This device can't share its location."; return; }
      $("site-results").textContent = "Finding you…";
      navigator.geolocation.getCurrentPosition(async (pos) => {
        const name = prompt("Name this launch site", "Launch field") || "Launch field";
        await addSite(name, pos.coords.latitude, pos.coords.longitude, pos.coords.altitude || 0);
      }, () => { $("site-results").textContent = "Couldn't get your location. On a Wi-Fi-only iPad this only works while connected to Wi-Fi."; }, { timeout: 15000 });
      return;
    }
    if (b.id === "fc-get") {
      const s = site();
      $("fc-status").textContent = "Getting forecast…";
      try { await getForecast(s); S.elevM = s.elev_m; persist(); renderLaunch(); update(); }
      catch (e) { $("fc-status").textContent = "Couldn't get the forecast — are you online?"; }
      return;
    }
    if (b.id === "fc-use") {
      const s = site(), when = $("fc-time").value;
      const fc = forecastAt(s, when);
      if (!fc) return;
      S.forecastTime = when;
      S.windMs = fc.speed; S.windFrom = fc.from; S.tempC = fc.temp; S.elevM = s.elev_m;
      S.fromForecast = `${s.name}, ${new Date(when).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric" })} — ${speed(fc.speed)} from the ${dir16(fc.from)}, gusts ${speed(fc.gust)}`;
      renderLaunch(); update();
      return;
    }
    if (b.id === "site-remove") {
      const s = site();
      if (s && confirm(`Remove ${s.name} and its saved forecast?`)) {
        sites = sites.filter((x) => x !== s); S.siteId = null; save("sites", sites); renderLaunch(); persist();
      }
    }
  });

  $("pop").addEventListener("click", (ev) => { if (ev.target === $("pop")) $("pop").hidden = true; });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") $("pop").hidden = true; });

  document.addEventListener("change", (ev) => {
    const t = ev.target;
    if (t.id === "site-select") {
      S.siteId = t.value || null;
      const s = site();
      if (s) S.elevM = s.elev_m;
      renderLaunch(); update();
    } else if (t.id === "fc-time") {
      S.forecastTime = t.value; persist(); renderSite();
    }
  });

  document.addEventListener("input", (ev) => {
    const t = ev.target;
    if (t.id === "angle") { S.angle = +t.value; $("angle-out").textContent = S.angle + "°"; $("tilt-field").hidden = S.angle >= 90; update(); }
    else if (t.id === "wind") {
      S.windMs = imp() ? +t.value * MS_PER_MPH : +t.value / 3.6;
      S.fromForecast = null;
      $("wind-out").textContent = speed(S.windMs);
      $("wind-dir-field").hidden = S.windMs <= 0;
      update();
    } else if (t.id === "elev") { if (t.value !== "") { S.elevM = imp() ? +t.value * M_PER_FT : +t.value; update(); } }
    else if (t.id === "temp") { S.tempC = t.value === "" ? null : imp() ? (+t.value - 32) * 5 / 9 : +t.value; update(); }
    else if (t.id === "rod") { const v = +t.value; if (v > 0) { S.rodM = imp() ? v * M_PER_FT : v; update(); } }
    else if (t.dataset.weigh) {
      const key = t.dataset.weigh, v = parseFloat(t.value);
      const w = weights[S.kitId] = weights[S.kitId] || {};
      if (t.value === "" || !(v > 0)) delete w[key];
      else { w[key] = imp() ? v * G_PER_OZ : v; w.updated = new Date().toISOString(); }
      save("weights", weights);
      update();
    }
  });
  // re-render the weight comparison once typing is done, so focus isn't lost mid-entry
  document.addEventListener("focusout", (ev) => { if (ev.target.dataset && ev.target.dataset.weigh) renderWeights(); });

  // ---------- offline ----------
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").then(() => {
      $("offline-status").textContent = "Ready to work offline.";
    }).catch(() => {});
  }

  readHash();
  renderAll();
})();

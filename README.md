# Rocket Flight Predictor

Predicts how high a stock Estes rocket will fly on an Estes-recommended engine, and where it will land: distance and compass direction. It handles two-stage kits, launch angle, wind and launch-site elevation. It runs fully offline once it's installed to the home screen. Built for an iPad mini, and works on any phone.

## Using it

Open the GitHub Pages URL in Safari, tap Share → **Add to Home Screen**, and open it once from the home-screen icon. From then on it works with no internet.

- **Weights:** weigh each rocket on a kitchen scale (ready to fly, no engine) and enter the weight in step 3. The app keeps your weight next to the Estes kit spec, so you can see how much glue and paint added.
- **Forecast:** under *Launch site, forecast and more*, add a launch site while you're online and tap **Get forecast**. That saves 16 days of hourly wind and temperature on the device, and you can pick any hour later while offline. Add the site from inside the home-screen app: iOS keeps its storage separate from Safari's.
- **Preset links:** a link can carry a setup, e.g. `#kit=mongoose&config=two-stage&engines=C6-0,C6-7&wind=8&from=270` (wind in mph, from = degrees).

## How it works

- `app/`: the whole app. Plain HTML/CSS/JS with no build step and no frameworks. `sim.js` is the physics, `app.js` the UI, `catalog.js` the generated data, and `sw.js` the offline cache.
- `data/kits.json`: the hand-curated kit catalog: dimensions, weights, recovery, Estes-recommended engines per configuration, and Estes's published altitude. Every guessed value is listed in the kit's `estimated` field.
- `data/motors.json`: Estes thrust curves from ThrustCurve.org (`tools/fetch_motors.py`).
- `tools/sim.py`: a Python twin of `app/sim.js`, for checking the physics from the command line.

The physics is a 3-DOF point-mass simulation:
- **Powered flight:** the thrust curve, with mass dropping as propellant burns.
- **Launch:** the rocket rides the launch rod until it clears it.
- **Air:** drag (Cd per kit), with air density at the field's elevation and temperature.
- **Wind:** speed grows with height (power law from the 10 m forecast height), and the fins turn the rocket into the relative wind (weathercocking).
- **Staging:** at booster burnout the top stage lights and the booster tumbles down on its own.
- **Recovery:** ejection fires at burnout + delay, then the rocket descends under its parachute or streamer while drifting with the wind.
- **Uncertainty:** 60 extra runs vary the wind, drag, chute opening and motor output. They make the "probably X–Y" ranges and the cloud of landing spots.

## Changing things

```sh
python3 tools/fetch_motors.py   # only when adding motors
python3 tools/build.py          # after any edit to data/ or app/: rebuilds catalog.js, stamps the offline cache version
python3 tools/check_sim.py      # Python and JS sims must agree (runs JS via macOS osascript)
python3 tools/validate.py       # every kit/engine vs Estes's published altitude
python3 -m http.server -d app 8765   # then open http://localhost:8765
```

Always run `build.py` before pushing. Otherwise installed copies won't notice the update. Pushing to `main` publishes to GitHub Pages.

## Adding a kit

Add an entry to `data/kits.json`, copying an existing one. Take Estes's recommended engines exactly from the kit page or instructions. For a two-stage kit, list the booster first; its stage needs `mass_g` and `length_m`, and its engines must be `-0`. Run `build.py`: it rejects engines that don't exist or sit in the wrong stage.

Data credits: motor data from [ThrustCurve.org](https://www.thrustcurve.org/); weather from [Open-Meteo](https://open-meteo.com/) (free for non-commercial use). Not affiliated with Estes.

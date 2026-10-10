// Journal events -> trip-time calibration and ship identity. A port of
// journal.py without the filesystem (see tail.js) or the SCO watching.

/** The uncalibrated supercruise estimate, in minutes. */
export function estScMinutes(ls) {
  return 0.25 * Math.max(ls, 1) ** 0.3;
}

/** Journal timestamps are ISO-8601 Zulu; returns UTC epoch seconds or null. */
export function parseTs(s) {
  if (typeof s !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(s);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

const MIN_SAMPLES = 3;        // below this, one weird run would skew everything
const MAX_SAMPLES = 200;
const ARRIVAL_MIN_SPREAD = 3; // furthest/nearest sampled Ls, to fit at all

/** Measured trip timings. Every value is null until enough samples exist. */
export class Calibration {
  constructor(data = null) {
    const d = data || {};
    const last = (xs) => (Array.isArray(xs) ? xs : []).slice(-MAX_SAMPLES);
    this.jump_secs = last(d.jump_secs).map(Number);
    this.dock_secs = last(d.dock_secs).map(Number);
    this.depart_secs = last(d.depart_secs).map(Number);
    // FSDJump -> Docked: the whole arrival leg, paired with that station's Ls.
    this.approach_samples = last(d.approach_samples).map((x) => [Number(x[0]), Number(x[1])]);
  }

  add(list, value) {
    list.push(value);
    if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES);
  }

  toDict() {
    return { jump_secs: [...this.jump_secs], dock_secs: [...this.dock_secs],
             depart_secs: [...this.depart_secs],
             approach_samples: this.approach_samples.map((x) => [...x]) };
  }

  #medianMinutes(xs) {
    return xs.length < MIN_SAMPLES ? null : median(xs) / 60;
  }

  get jumpMinutes() { return this.#medianMinutes(this.jump_secs); }
  /** Collected for display only; the trip model uses a fixed turnaround. */
  get dockMinutes() { return this.#medianMinutes(this.dock_secs); }
  get departMinutes() { return this.#medianMinutes(this.depart_secs); }

  /** Median ratio of observed arrival legs to the estimate curve. */
  get scScale() {
    const pool = this.approach_samples;
    if (pool.length < MIN_SAMPLES) return null;
    const ratios = [];
    for (const [ls, secs] of pool) {
      const model = estScMinutes(ls) * 60;
      if (model > 0) ratios.push(secs / model);
    }
    return ratios.length < MIN_SAMPLES ? null : median(ratios);
  }

  /**
   * [a, b, lo, hi]: arrival seconds as a + b * Ls**0.3 over the range flown,
   * fitted on half-decade bucket medians so a farmed station can't outvote a
   * rare one. Null when the samples cannot support a fit.
   */
  get arrivalFit() {
    const pool = this.approach_samples;
    if (pool.length < MIN_SAMPLES) return null;
    const buckets = new Map();
    for (const [ls, secs] of pool) {
      const k = Math.round(Math.log10(Math.max(ls, 1)) * 2);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push([ls, secs]);
    }
    if (buckets.size < 2) return null;
    const pts = [...buckets.values()].map((g) =>
      [median(g.map(([l]) => l)) ** 0.3, median(g.map(([, s]) => s))]);
    const lo = Math.min(...pool.map(([l]) => l));
    const hi = Math.max(...pool.map(([l]) => l));
    if (lo <= 0 || hi / lo < ARRIVAL_MIN_SPREAD) return null;
    const n = pts.length;
    const mx = pts.reduce((s, [x]) => s + x, 0) / n;
    const my = pts.reduce((s, [, y]) => s + y, 0) / n;
    const vr = pts.reduce((s, [x]) => s + (x - mx) ** 2, 0);
    if (vr <= 0) return null;
    // A negative travel term is noise, not a discount for flying further.
    const b = Math.max(pts.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / vr, 0);
    const a = my - b * mx;
    return a < 0 ? null : [a, b, lo, hi];
  }

  /** Measured arrival leg in minutes, or null. Beyond the range flown the
   *  estimate curve's shape takes over rather than the fit's own slope. */
  arrivalMinutes(ls) {
    const fit = this.arrivalFit;
    if (!fit) return null;
    const [a, b, lo, hi] = fit;
    const anchor = Math.min(Math.max(ls, lo), hi);
    let secs = a + b * anchor ** 0.3;
    if (Math.abs(anchor - ls) > 1e-9) secs += (estScMinutes(ls) - estScMinutes(anchor)) * 60;
    return Math.max(secs, 0) / 60;
  }

  summary() {
    const bits = [];
    const j = this.jumpMinutes;
    bits.push(`jump ${j ? `${j.toFixed(2)} min (n=${this.jump_secs.length})` : `estimate (n=${this.jump_secs.length})`}`);
    const dep = this.departMinutes;
    bits.push(`departure ${dep ? `${dep.toFixed(1)} min (n=${this.depart_secs.length})` : `estimate (n=${this.depart_secs.length})`}`);
    const n = this.approach_samples.length;
    const fit = this.arrivalFit;
    if (fit) {
      bits.push(`arrival leg ${(fit[0] / 60).toFixed(1)} min + travel, ${fit[2].toFixed(0)}-${fit[3].toFixed(0)} Ls (n=${n})`);
    } else {
      const s = this.scScale;
      bits.push(`supercruise ${s ? `x${s.toFixed(2)} (n=${n})` : `estimate (n=${n})`}`);
    }
    return bits.join("  |  ");
  }
}

/** Laden jump range from the mass ratio, floored by the longest laden jump flown. */
export function ladenJumpRange(maxRange, unladenMass, fuel, cargo, observed = null) {
  let est = null;
  if (maxRange && unladenMass && cargo) {
    const dry = unladenMass + (fuel || 0);
    est = maxRange * dry / (dry + cargo);
  }
  if (observed && (!est || observed > est)) est = observed;
  return est;
}

/** Turns journal lines into position, ship identity and timing samples. */
export class JournalState {
  constructor(cal = null) {
    this.cal = cal || new Calibration();
    this.calAfter = 0;            // epoch secs: older events teach nothing (RESET TIMINGS)
    this.system = null;
    this.station = null;
    this.docked = false;
    this.commander = null;
    // Which game this is, for the ODYSSEY box and for EDDN, which uses them
    // to keep Live and Legacy data apart. Null until a LoadGame says.
    this.odyssey = null;
    this.horizons = null;
    this.gameversion = null;
    this.gamebuild = null;
    this.ship = null;             // internal name, e.g. "panthermkii"
    this.shipId = null;
    this.shipName = null;
    this.cargoCapacity = null;
    this.maxJumpRange = null;
    this.unladenMass = null;
    this.fuelCapacity = null;
    this.bestLadenJump = null;    // longest jump actually made with cargo
    this.cargo = null;
    this.lastFsdJump = null;
    this.arrivedAt = null;
    this.undockedAt = null;
    this.dockAt = null;
    this.dockLog = [];            // ["dock"|"undock", station, epoch secs], newest last
    this.onEvent = null;
    this.onDocked = null;
    this.onCalibration = null;
  }

  ladenRange() {
    return ladenJumpRange(this.maxJumpRange, this.unladenMass, this.fuelCapacity,
                          this.cargoCapacity, this.bestLadenJump);
  }

  /** Adopt a ship, dropping the last ship's figures if the hull changed. */
  setShip(ship, shipId, localised) {
    ship = (ship || "").toLowerCase() || null;
    if (!ship) return false;
    const changed = !!this.ship && (ship !== this.ship
      || (shipId != null && this.shipId != null && shipId !== this.shipId));
    if (changed) {
      this.shipName = this.cargoCapacity = this.maxJumpRange = null;
      this.unladenMass = this.fuelCapacity = this.bestLadenJump = this.cargo = null;
    }
    this.ship = ship;
    if (shipId != null) this.shipId = shipId;
    if (localised) this.shipName = localised;
    return changed;
  }

  #logDock(kind, station, t) {
    this.dockLog.push([kind, station, t]);
    if (this.dockLog.length > 200) this.dockLog.shift();
  }

  /** Handle one journal line. Returns true when a timing sample was learned. */
  handle(line, live) {
    if (typeof line !== "string" || !line.trim()) return false;
    let e;
    try { e = JSON.parse(line); } catch { return false; }
    if (!e || typeof e !== "object" || Array.isArray(e)) return false;
    const ev = e.event;
    const t = parseTs(e.timestamp);
    const cal = t && t <= this.calAfter ? new Calibration() : this.cal;   // scratch: discarded
    let learned = false;

    if (ev === "FSDJump") {
      this.system = e.StarSystem ?? null;
      this.station = null;
      this.docked = false;
      if (this.lastFsdJump && t && t > this.lastFsdJump) {
        const dt = t - this.lastFsdJump;
        // Only back-to-back route jumps; a long gap is a stop, not jump cost.
        if (dt >= 15 && dt <= 300) { cal.add(cal.jump_secs, dt); learned = true; }
      }
      if (this.cargo > 0 && e.JumpDist && (!this.bestLadenJump || e.JumpDist > this.bestLadenJump)) {
        this.bestLadenJump = e.JumpDist;
      }
      if (this.undockedAt && t && t > this.undockedAt) {
        const dt = t - this.undockedAt;
        if (dt >= 20 && dt <= 600) { cal.add(cal.depart_secs, dt); learned = true; }
      }
      this.undockedAt = null;
      this.lastFsdJump = t;
      this.arrivedAt = t;
    } else if (ev === "Docked") {
      this.station = e.StationName ?? null;
      this.system = e.StarSystem ?? this.system;
      this.docked = true;
      this.dockAt = t;
      if (e.DistFromStarLS && this.arrivedAt && t && t > this.arrivedAt) {
        const dt = t - this.arrivedAt;
        if (dt >= 20 && dt <= 3600) { cal.add(cal.approach_samples, [e.DistFromStarLS, dt]); learned = true; }
      }
      this.arrivedAt = null;
      if (t) this.#logDock("dock", this.station, t);
      if (live && this.onDocked) this.onDocked(this.station, this.system);
    } else if (ev === "Undocked") {
      if (this.dockAt && t && t > this.dockAt) {
        const dt = t - this.dockAt;
        if (dt >= 20 && dt <= 1800) { cal.add(cal.dock_secs, dt); learned = true; }
      }
      if (t) this.#logDock("undock", this.station, t);
      this.dockAt = null;
      this.docked = false;
      this.undockedAt = t;
    } else if (ev === "Loadout") {
      this.setShip(e.Ship || this.ship, e.ShipID, e.Ship_Localised);
      if (e.CargoCapacity != null) this.cargoCapacity = e.CargoCapacity;
      if (e.MaxJumpRange) this.maxJumpRange = e.MaxJumpRange;
      if (e.UnladenMass) this.unladenMass = e.UnladenMass;
      if (e.FuelCapacity?.Main) this.fuelCapacity = e.FuelCapacity.Main;
    } else if (ev === "ShipyardSwap" || ev === "ShipyardNew") {
      this.setShip(e.ShipType, e.ShipID ?? e.NewShipID, e.ShipType_Localised);
    } else if (ev === "LoadGame" || ev === "Fileheader") {
      this.setShip(e.Ship, e.ShipID, e.Ship_Localised);
      this.commander = e.Commander ?? this.commander;
      // Which game this commander is running: the ODYSSEY box is seeded from
      // it, and EDDN records it to keep Live and Legacy data apart.
      if (e.Odyssey != null) this.odyssey = e.Odyssey;
      if (e.Horizons != null) this.horizons = e.Horizons;
      this.gameversion = e.gameversion ?? this.gameversion;
      this.gamebuild = (e.build ?? this.gamebuild ?? "").trim() || null;
    } else if (ev === "Cargo" && e.Count != null) {
      this.cargo = e.Count;
    } else if (ev === "Location") {
      this.system = e.StarSystem ?? this.system;
      this.station = e.StationName ?? null;
      this.docked = !!e.Docked;
    }

    if (live && this.onEvent) this.onEvent(e);
    if (learned && this.onCalibration) this.onCalibration(cal);
    return learned;
  }
}

/**
 * Median run as flown: pad to pad at `station`, counting only time spent
 * flying plus `turnaround` min at each end (parked time is not piloting).
 * A run needs a stop elsewhere; over 4 h of flight is a session break.
 * Returns [minutes, runs counted] or [null, 0].
 */
export function runMinutes(log, station, minSamples = 3, window = 6, turnaround = 2) {
  const marks = log.flatMap(([k, s], i) => (k === "dock" && s === station ? [i] : []));
  const runs = [];
  for (let m = 1; m < marks.length; m++) {
    let leg = null, out = 0, elsewhere = false;
    for (const [kind, stn, t] of log.slice(marks[m - 1], marks[m] + 1)) {
      if (kind === "undock") leg = t;
      else if (kind === "dock") {
        if (stn !== station) elsewhere = true;
        if (leg !== null && t > leg) out += (t - leg) / 60;
        leg = null;
      }
    }
    if (elsewhere && out > 0 && out <= 240) runs.push(out + 2 * turnaround);
  }
  if (runs.length < minSamples) return [null, 0];
  const recent = runs.slice(-window);
  return [median(recent), recent.length];
}

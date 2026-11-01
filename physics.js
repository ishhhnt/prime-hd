// ─── REAL CAR PHYSICS ───
// Real units inside (metres, seconds, kg, Newton). SCALE converts metres → game world units.
// Model: engine torque curve + 6-speed gearbox + rear-wheel traction limit + air drag + rolling
// resistance + braking + speed-sensitive steering (bicycle model) + tyre grip / handbrake drift.

export const SCALE = 2.3;          // 1 metre = 2.3 world units (a 4.8 m car = 11 units)
const G = 9.81;

export const CAR_DEFS = {
    dodge: {          // heavy V8 muscle: huge torque, grips less, drifts easily
        name: 'SRT HELLCAT', subtitle: '6.2L SUPERCHARGED HEMI V8', badge: 'S1 820',
        mass: 2050, torque: 880, peakRpm: 4400, redline: 6200, idle: 850,
        gears: [3.2, 2.1, 1.55, 1.2, 0.97, 0.78], reverse: 3.2, final: 3.1, wheelR: 0.36,
        dragK: 0.62, grip: 1.0, wheelbase: 3.0, maxSteer: 0.52, brakeG: 1.05, rearBias: 0.55,
        targetLength: 11.0,
        stats: { speed: 92, accel: 94, handling: 74, braking: 78, armor: 82 }
    },
    colorado: {       // 4x4 Trail Boss pickup: high ground clearance, torque, steady grip
        name: 'CHEVROLET COLORADO', subtitle: '2.7L TURBO HIGH-OUTPUT 4WD', badge: 'A 710',
        mass: 2250, torque: 750, peakRpm: 3800, redline: 5800, idle: 750,
        gears: [3.5, 2.3, 1.6, 1.2, 0.95, 0.75], reverse: 3.4, final: 3.42, wheelR: 0.40,
        dragK: 0.72, grip: 1.15, wheelbase: 3.3, maxSteer: 0.49, brakeG: 1.0, rearBias: 0.5,
        targetLength: 11.4,
        stats: { speed: 78, accel: 76, handling: 72, braking: 75, armor: 90 }
    },
    colorado_z: {     // Colorado Z71: Desert Runner tuned, high revs, aggressive off-road
        name: 'COLORADO Z71 CUSTOM', subtitle: 'DESERT RUNNER V6 TWIN-TURBO', badge: 'A 760',
        mass: 2150, torque: 820, peakRpm: 4200, redline: 6400, idle: 800,
        gears: [3.4, 2.2, 1.55, 1.15, 0.92, 0.72], reverse: 3.3, final: 3.5, wheelR: 0.42,
        dragK: 0.68, grip: 1.22, wheelbase: 3.3, maxSteer: 0.51, brakeG: 1.12, rearBias: 0.52,
        targetLength: 11.4,
        stats: { speed: 85, accel: 84, handling: 78, braking: 80, armor: 92 }
    },
    custom: {         // light supercar: more grip, higher revs, sharper steering
        name: 'GT SUPERCAR', subtitle: '4.0L TWIN-TURBO FLAT-PLANE V8', badge: 'S2 950',
        mass: 1450, torque: 740, peakRpm: 5500, redline: 8000, idle: 900,
        gears: [3.4, 2.3, 1.7, 1.3, 1.05, 0.85], reverse: 3.3, final: 3.4, wheelR: 0.34,
        dragK: 0.46, grip: 1.26, wheelbase: 2.7, maxSteer: 0.55, brakeG: 1.25, rearBias: 0.5,
        targetLength: 11.0,
        stats: { speed: 98, accel: 96, handling: 92, braking: 90, armor: 65 }
    },
    police: {         // Police Interceptor SUV: heavy push bar, high ram force, sirens
        name: 'POLICE INTERCEPTOR SUV', subtitle: 'TACTICAL PURSUIT ENFORCER', badge: 'S1 850',
        mass: 2200, torque: 840, peakRpm: 4500, redline: 6500, idle: 850,
        gears: [3.3, 2.15, 1.55, 1.18, 0.95, 0.76], reverse: 3.2, final: 3.25, wheelR: 0.38,
        dragK: 0.58, grip: 1.22, wheelbase: 3.1, maxSteer: 0.52, brakeG: 1.2, rearBias: 0.5,
        targetLength: 11.2, hasSiren: true,
        stats: { speed: 90, accel: 88, handling: 85, braking: 88, armor: 95 }
    },
    truck: {          // Heavy cargo commercial truck: massive momentum, diesel power
        name: 'HEAVY FREIGHT TRUCK', subtitle: '14.8L INLINE-6 TURBO DIESEL', badge: 'B 600',
        mass: 18000, torque: 3600, peakRpm: 2100, redline: 3200, idle: 600,
        gears: [4.6, 3.2, 2.1, 1.4, 1.0, 0.72], reverse: 4.2, final: 4.1, wheelR: 1.0,
        dragK: 2.3, grip: 1.55, wheelbase: 10.5, maxSteer: 0.35, brakeG: 1.15, rearBias: 0.5,
        targetLength: 36.0, isTruck: true,
        stats: { speed: 70, accel: 65, handling: 45, braking: 72, armor: 100 }
    }
};

export function createCarState() {
    return {
        x: 0, z: 0, heading: 0,       // heading 0 = facing +z, positive = turning left
        vf: 0, vr: 0,                 // forward / sideways (right) speed, m/s
        yaw: 0, steer: 0,
        gear: 1, rpm: 850, shiftT: 0,
        pitch: 0, roll: 0,
        wheelspin: false, sliding: false,
        aLong: 0, aLat: 0
    };
}

const torqueCurve = (def, rpm) => {
    if (rpm >= def.redline) return 0;                              // rev limiter
    const x = (rpm - def.peakRpm) / (def.redline * 0.6);
    return Math.max(0.35, 1 - 0.55 * x * x);
};

const ratioOf = (def, gear) =>
    gear > 0 ? def.gears[gear - 1] * def.final : gear < 0 ? def.reverse * def.final : 0;

function autoGearbox(s, inp, def, dt) {
    const { throttle: thr, brake: brk } = inp;
    // stopped + brake pedal = reverse (like GTA); gas = forward again
    if (s.gear <= 0) {
        if (thr > 0.05 && s.vf > -1.0) s.gear = 1;
        else if (brk > 0.05 && s.vf < 0.8) s.gear = -1;
        else if (s.gear === 0) s.gear = 1;
    } else if (s.gear === 1 && brk > 0.05 && thr < 0.05 && s.vf < 0.35) {
        s.gear = -1;
    }
    if (s.gear < 1) return;
    s.shiftT = Math.max(0, s.shiftT - dt);
    if (s.shiftT > 0) return;
    const wheelRpm = Math.abs(s.vf) / def.wheelR * 9.549;
    if (s.gear < 6 && s.rpm > def.redline * 0.9) {
        s.gear++; s.shiftT = 0.28;
    } else if (s.gear > 1) {
        const lower = wheelRpm * ratioOf(def, s.gear - 1);
        if (s.rpm < def.redline * 0.36 || (thr > 0.85 && lower < def.redline * 0.82 && s.rpm < def.redline * 0.55)) {
            s.gear--; s.shiftT = 0.2;
        }
    }
}

// inp = { throttle 0..1, brake 0..1, steer -1..1 (+ = left), hand bool, manual bool }
export function stepCar(s, inp, def, dt) {
    if (!inp.manual) autoGearbox(s, inp, def, dt);
    else s.shiftT = Math.max(0, s.shiftT - dt);

    // In reverse the pedals swap: S = reverse power, W = brake
    let drive = inp.throttle, bra = inp.brake;
    if (s.gear === -1) { drive = inp.brake; bra = inp.throttle; }

    // ── Engine & drive force ──
    const ratio = ratioOf(def, s.gear);
    const dirSign = s.gear > 0 ? 1 : s.gear < 0 ? -1 : 0;
    const wheelRpm = Math.abs(s.vf) / def.wheelR * 9.549;
    const launch = Math.abs(s.vf) < 6 ? def.idle + drive * 2600 : 0;     // clutch slip at low speed
    const rpmEff = Math.max(def.idle, wheelRpm * ratio, launch);
    s.rpm += (rpmEff - s.rpm) * Math.min(1, dt * 12);

    let F = 0;
    s.wheelspin = false;
    if (ratio && s.shiftT <= 0) {
        F = drive * def.torque * torqueCurve(def, rpmEff) * ratio * 0.88 / def.wheelR * dirSign;
        const limit = def.grip * G * def.mass * def.rearBias;
        if (Math.abs(F) > limit) { F = Math.sign(F) * limit * 0.92; s.wheelspin = Math.abs(s.vf) < 25; }
    }

    // ── Longitudinal: drive, then drag / rolling / engine brake / brakes (never flip the sign) ──
    let v = s.vf + (F / def.mass) * dt;
    const drag = def.dragK * v * Math.abs(v) / def.mass;
    let resist = Math.abs(drag) + (Math.abs(v) > 0.05 ? 0.015 * G : 0);
    if (drive < 0.05 && s.gear > 0) resist += 0.5 * (s.rpm / def.redline);        // engine braking
    if (bra > 0.02) resist += bra * def.brakeG * G;
    if (inp.hand) resist += 0.35 * G;
    const before = v;
    v -= Math.sign(v) * resist * dt;
    if (Math.sign(v) !== Math.sign(before) && before !== 0 && drive < 0.05) v = 0;
    s.aLong = (v - s.vf) / Math.max(dt, 1e-4);
    s.vf = v;

    // ── Steering (bicycle model, less lock at speed) ──
    const lockLimit = def.maxSteer / (1 + Math.pow(Math.abs(s.vf) / 16, 1.5));
    const steerTarget = inp.steer * lockLimit;
    s.steer += (steerTarget - s.steer) * Math.min(1, dt * (inp.steer === 0 ? 9 : 7));

    const gripLat = def.grip * (inp.hand ? 0.38 : 1) * (s.wheelspin ? 0.7 : 1);
    let omega = s.vf * Math.tan(s.steer) / def.wheelbase;
    const omegaMax = (inp.hand || s.wheelspin ? def.grip * 1.3 : def.grip) * G / Math.max(Math.abs(s.vf), 3);
    if (inp.hand) omega *= 1.5;
    omega = Math.max(-omegaMax, Math.min(omegaMax, omega));
    s.yaw += (omega - s.yaw) * Math.min(1, dt * 10);
    s.heading += s.yaw * dt;

    // Heading turns, but momentum keeps going: rotate the velocity into the car's frame
    const vf0 = s.vf, vr0 = s.vr;
    s.vr += s.yaw * vf0 * dt;
    s.vf -= s.yaw * vr0 * dt;

    // Tyres pull the sideways slide back (this is the grip)
    const maxDv = gripLat * G * dt;
    s.vr -= Math.max(-maxDv, Math.min(maxDv, s.vr));
    s.sliding = Math.abs(s.vr) > 2.5;
    s.aLat = s.yaw * s.vf;

    // ── Move (m/s → world units) ──
    const fx = Math.sin(s.heading), fz = Math.cos(s.heading);
    s.x += (fx * s.vf - fz * s.vr) * dt * SCALE;
    s.z += (fz * s.vf + fx * s.vr) * dt * SCALE;

    // ── Body pitch / roll (visual) ──
    const pt = Math.max(-0.045, Math.min(0.045, -s.aLong * 0.004));
    const rt = Math.max(-0.06, Math.min(0.06, s.aLat * 0.0025));
    s.pitch += (pt - s.pitch) * Math.min(1, dt * 6);
    s.roll += (rt - s.roll) * Math.min(1, dt * 6);
}

export function shift(s, dir) {
    if (dir > 0 && s.gear < 6) s.gear++;
    else if (dir < 0 && s.gear > -1) s.gear--;
    s.shiftT = 0.2;
}

// ─── COLLISIONS (car = 3 circles along length, truck = 5 circles) ───
const CAR_OFFS = [-3.3, 0, 3.3];
const TRUCK_OFFS = [-13.0, -6.5, 0, 6.5, 13.0];
export const CAR_R = 2.75;

function bounce(s, nx, nz, e) {
    const fx = Math.sin(s.heading), fz = Math.cos(s.heading), rx = -fz, rz = fx;
    let vx = fx * s.vf + rx * s.vr, vz = fz * s.vf + rz * s.vr;
    const vn = vx * nx + vz * nz;
    if (vn >= 0) return 0;
    vx -= (1 + e) * vn * nx; vz -= (1 + e) * vn * nz;
    s.vf = (vx * fx + vz * fz) * 0.97;
    s.vr = vx * rx + vz * rz;
    return -vn;                                    // impact speed, m/s
}

// Car against a building box. Returns impact speed (0 = no hit).
export function resolveBox(s, bx, bz, hw, hd) {
    let impact = 0;
    const sx = Math.sin(s.heading), cz = Math.cos(s.heading);
    const offs = s.isTruck ? TRUCK_OFFS : CAR_OFFS;
    for (const o of offs) {
        const cx = s.x + sx * o, cy = s.z + cz * o;
        const px = Math.max(bx - hw, Math.min(cx, bx + hw));
        const pz = Math.max(bz - hd, Math.min(cy, bz + hd));
        const dx = cx - px, dz = cy - pz, d2 = dx * dx + dz * dz;
        if (d2 >= CAR_R * CAR_R) continue;
        let nx, nz, pen;
        if (d2 > 1e-6) { const d = Math.sqrt(d2); nx = dx / d; nz = dz / d; pen = CAR_R - d; }
        else {
            const l = cx - (bx - hw), r = (bx + hw) - cx, t = cy - (bz - hd), b = (bz + hd) - cy;
            const m = Math.min(l, r, t, b);
            if (m === l) { nx = -1; nz = 0; pen = l + CAR_R; }
            else if (m === r) { nx = 1; nz = 0; pen = r + CAR_R; }
            else if (m === t) { nx = 0; nz = -1; pen = t + CAR_R; }
            else { nx = 0; nz = 1; pen = b + CAR_R; }
        }
        s.x += nx * pen; s.z += nz * pen;
        impact = Math.max(impact, bounce(s, nx, nz, 0.15));
    }
    return impact;
}

// Player against another car. The player is pushed out by `share` of the overlap
// (the caller moves the other car by the rest). Returns null or { impact, nx, nz, pen }.
export function carVsCar(s, ox, oz, oh, share = 0.6, otherIsTruck = false) {
    const sx = Math.sin(s.heading), cz = Math.cos(s.heading);
    const ox_ = Math.sin(oh), oz_ = Math.cos(oh);
    const offsA = s.isTruck ? TRUCK_OFFS : CAR_OFFS;
    const offsB = otherIsTruck ? TRUCK_OFFS : CAR_OFFS;
    let best = null;
    for (const a of offsA) {
        const ax = s.x + sx * a, az = s.z + cz * a;
        for (const b of offsB) {
            const bx = ox + ox_ * b, bz = oz + oz_ * b;
            const dx = ax - bx, dz = az - bz, d2 = dx * dx + dz * dz, min = CAR_R * 2 - 0.4;
            if (d2 >= min * min) continue;
            const d = Math.sqrt(d2) || 0.001, pen = min - d;
            if (!best || pen > best.pen) best = { nx: dx / d, nz: dz / d, pen };
        }
    }
    if (!best) return null;
    s.x += best.nx * best.pen * share;
    s.z += best.nz * best.pen * share;
    best.impact = bounce(s, best.nx, best.nz, 0.25);
    return best;
}

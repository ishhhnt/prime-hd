import * as THREE from 'three';
import { SCALE } from './physics.js';

// ─── ROAD GRID HELPERS ───
// Heading index d: 0 = +z, 1 = +x, 2 = -z, 3 = -x.  Traffic drives on the right-hand side.
export const DIRS = [[0, 1], [1, 0], [0, -1], [-1, 0]];
export const dirAngle = (d) => Math.atan2(DIRS[d][0], DIRS[d][1]);       // car.rotation.y for that heading
export const rightOf = (d) => [-DIRS[d][1], DIRS[d][0]];
const LEFT = (d) => (d + 1) % 4;
const RIGHT = (d) => (d + 3) % 4;
const ROAD_Y = 1.5;

// ─── TRAFFIC LIGHTS (all intersections share one timetable; neighbours alternate) ───
const CYCLE = 24;
export function signalAt(ci, cj, t) {
    // each intersection is shifted 3 s from its neighbour, so a car at ~45 km/h meets a "green wave"
    const tt = (((t - (ci + cj) * 3) % CYCLE) + CYCLE) % CYCLE;
    if (tt < 9.5) return { ns: 'green', ew: 'red' };
    if (tt < 11.5) return { ns: 'yellow', ew: 'red' };
    if (tt < 12) return { ns: 'red', ew: 'red' };
    if (tt < 21.5) return { ns: 'red', ew: 'green' };
    if (tt < 23.5) return { ns: 'red', ew: 'yellow' };
    return { ns: 'red', ew: 'red' };
}

const COLORS = { green: new THREE.Color(0x25ff6a), yellow: new THREE.Color(0xffc21f), red: new THREE.Color(0xff2a2a) };

export function createTraffic(scene) {
    let net = null;
    let clock = 0;
    let target = 0;
    let makeCar = null;                    // (index) => THREE.Object3D
    let getElevation = null;               // (x, z) => { y, normal } for 3D road slopes
    const agents = [];                     // smart NPC traffic
    const statics = [];                    // parked cars
    const extras = [];                     // other moving cars managed elsewhere (race AI)

    // ─── Minimal & Sleek Signal Lamps: only at major avenue intersections ───
    const POOL_R = 2;                      // covers player's local grid
    const maxLamps = 36;
    const poleMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 9.5, 0.5),
        new THREE.MeshStandardMaterial({ color: 0x1b1c20, roughness: 0.5, metalness: 0.5 }), maxLamps);
    const armMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(5.5, 0.35, 0.35),
        new THREE.MeshStandardMaterial({ color: 0x1b1c20, roughness: 0.5, metalness: 0.5 }), maxLamps);
    const headMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 2.6, 1.2),
        new THREE.MeshBasicMaterial({ color: 0xffffff }), maxLamps);
    headMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(maxLamps * 3), 3);
    [poleMesh, armMesh, headMesh].forEach(m => { m.frustumCulled = false; m.count = 0; scene.add(m); });
    const lamps = [];                      // { ci, cj, axis }
    let lampCell = [NaN, NaN], lampTimer = 0, signalsVisible = true;
    const tmp = new THREE.Object3D();

    function rebuildLamps(px, pz) {
        const ci0 = Math.round(px / net.pitch), cj0 = Math.round(pz / net.pitch);
        lampCell = [ci0, cj0];
        lamps.length = 0;
        let n = 0;
        const H = net.roadWidth / 2;
        for (let ci = ci0 - POOL_R; ci <= ci0 + POOL_R; ci++) {
            for (let cj = cj0 - POOL_R; cj <= cj0 + POOL_R; cj++) {
                if (Math.abs(ci) > net.N || Math.abs(cj) > net.N) continue;
                // Only place on major avenue intersections (even intervals) to keep streets minimal and clean
                if (Math.abs(ci) % 2 !== 0 || Math.abs(cj) % 2 !== 0) continue;
                const cx = ci * net.pitch, cz = cj * net.pitch;
                for (let d = 0; d < 2; d++) {
                    if (n >= maxLamps) break;
                    const D = DIRS[d * 2], R = rightOf(d * 2);
                    const x = cx - D[0] * (H + 2.5) + R[0] * (H + 2.5);
                    const z = cz - D[1] * (H + 2.5) + R[1] * (H + 2.5);
                    tmp.position.set(x, ROAD_Y + 4.8, z); tmp.rotation.set(0, 0, 0); tmp.updateMatrix(); poleMesh.setMatrixAt(n, tmp.matrix);
                    tmp.position.set(x - R[0] * 2.5, ROAD_Y + 9.2, z - R[1] * 2.5); tmp.updateMatrix(); armMesh.setMatrixAt(n, tmp.matrix);
                    tmp.position.set(x - R[0] * 4.8, ROAD_Y + 8.8, z - R[1] * 4.8); tmp.updateMatrix(); headMesh.setMatrixAt(n, tmp.matrix);
                    lamps.push({ ci, cj, axis: d === 0 ? 'ns' : 'ew' });
                    n++;
                }
            }
        }
        poleMesh.count = armMesh.count = headMesh.count = n;
        poleMesh.instanceMatrix.needsUpdate = armMesh.instanceMatrix.needsUpdate = headMesh.instanceMatrix.needsUpdate = true;
        paintLamps();
    }
    function paintLamps() {
        lamps.forEach((l, i) => headMesh.setColorAt(i, COLORS[signalAt(l.ci, l.cj, clock)[l.axis]]));
        if (headMesh.instanceColor) headMesh.instanceColor.needsUpdate = true;
    }

    // ─── Spawning ───
    const rnd = (a, b) => a + Math.random() * (b - a);

    function spawnAgent(a, px, pz) {
        const { pitch, N, lane, roadWidth } = net;
        const H = roadWidth / 2, ext = net.extent;
        for (let tries = 0; tries < 14; tries++) {
            const d = Math.floor(Math.random() * 4);
            const D = DIRS[d], R = rightOf(d);
            const alongZ = D[0] === 0;
            const ang = Math.random() * Math.PI * 2, dist = rnd(180, 460);
            let line = Math.max(-N, Math.min(N, Math.round((alongZ ? px + Math.cos(ang) * dist : pz + Math.sin(ang) * dist) / pitch))) * pitch;
            let s = (alongZ ? pz : px) + (alongZ ? Math.sin(ang) : Math.cos(ang)) * dist;
            s = Math.max(-ext + 30, Math.min(ext - 30, s));
            // keep clear of intersections
            const off = s - Math.round(s / pitch) * pitch;
            if (Math.abs(off) < H + 12) s += (off >= 0 ? 1 : -1) * (H + 14 - Math.abs(off));
            if (Math.abs(s) > ext - 20) continue;
            const x = alongZ ? line + R[0] * lane : s;
            const z = alongZ ? s : line + R[1] * lane;
            if (Math.hypot(x - px, z - pz) < 160) continue;
            if (agents.some(o => o !== a && Math.hypot(o.x - x, o.z - z) < 20)) continue;
            Object.assign(a, { x, z, d, speed: rnd(6, 12), path: null, decIdx: NaN, turn: 0, hold: 0, stuck: 0, ghost: 0, yieldT: 0 });
            a.cruise = rnd(10.5, 16);
            a.heading = dirAngle(d);
            return true;
        }
        return false;
    }

    function makeAgent(i, px, pz) {
        const mesh = makeCar ? makeCar(i) : new THREE.Group();
        scene.add(mesh);
        const a = { mesh, x: 0, z: 0, d: 0, speed: 0, heading: 0, path: null, ai: false, isTruck: mesh.userData ? Boolean(mesh.userData.isTruck) : false };
        if (!spawnAgent(a, px, pz)) { a.x = 9999; a.z = 9999; }
        let y = ROAD_Y;
        if (getElevation) {
            const elev = getElevation(a.x, a.z);
            if (elev && typeof elev.y === 'number') y = elev.y;
        }
        mesh.position.set(a.x, y, a.z);
        agents.push(a);
    }

    // ─── Smart driving ───
    function forEachOther(fn) {
        for (const o of agents) fn(o);
        for (const o of statics) fn(o);
        for (const o of extras) fn(o);
    }

    function chooseTurn(a, idx, ci, cj) {
        const N = net.N;
        const opts = [];
        const ahead = (d) => {                              // does the road continue beyond this intersection in dir d?
            const D = DIRS[d];
            return Math.abs(ci + D[0]) <= N && Math.abs(cj + D[1]) <= N;
        };
        if (ahead(a.d)) opts.push([0, 0.62]);
        if (ahead(LEFT(a.d))) opts.push([1, 0.19]);
        if (ahead(RIGHT(a.d))) opts.push([2, 0.19]);
        if (!opts.length) return 1;
        let r = Math.random() * opts.reduce((s, o) => s + o[1], 0);
        for (const o of opts) { if ((r -= o[1]) <= 0) return o[0]; }
        return opts[0][0];
    }

    function startPath(a, ci, cj, turn) {
        const { pitch, roadWidth, lane } = net, H = roadWidth / 2;
        const cx = ci * pitch, cz = cj * pitch;
        const d2 = turn === 1 ? LEFT(a.d) : RIGHT(a.d);
        const D = DIRS[a.d], D2 = DIRS[d2], R = rightOf(a.d), R2 = rightOf(d2);
        const p0 = [a.x, a.z];
        const p1 = [cx + D[0] * lane * (R2[0] * D[0] + R2[1] * D[1]) + D2[0] * lane * (R[0] * D2[0] + R[1] * D2[1]),
                    cz + D[1] * lane * (R2[0] * D[0] + R2[1] * D[1]) + D2[1] * lane * (R[0] * D2[0] + R[1] * D2[1])];
        const p2 = [cx + D2[0] * (H + 1) + R2[0] * lane, cz + D2[1] * (H + 1) + R2[1] * lane];
        let len = 0, px = p0[0], pz = p0[1];
        for (let i = 1; i <= 8; i++) {
            const t = i / 8, u = 1 - t;
            const x = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0];
            const z = u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1];
            len += Math.hypot(x - px, z - pz); px = x; pz = z;
        }
        a.path = { p0, p1, p2, t: 0, len: Math.max(len, 1), d2 };
    }

    function updateAgent(a, dt, player) {
        const { pitch, roadWidth, lane } = net, H = roadWidth / 2;
        if (a.hold > 0) a.hold -= dt;
        const D = DIRS[a.d], sg = D[0] + D[1], alongZ = D[0] === 0;

        // heading vector
        let hx = D[0], hz = D[1];
        if (a.path) {
            const p = a.path, t = Math.min(p.t, 0.999), u = 1 - t;
            hx = 2 * u * (p.p1[0] - p.p0[0]) + 2 * t * (p.p2[0] - p.p1[0]);
            hz = 2 * u * (p.p1[1] - p.p0[1]) + 2 * t * (p.p2[1] - p.p1[1]);
            const l = Math.hypot(hx, hz) || 1; hx /= l; hz /= l;
        }
        const rx = -hz, rz = hx;

        let targetV = a.cruise;

        // ── next intersection on my road ──
        const s = alongZ ? a.z : a.x;
        const idx = sg > 0 ? Math.floor(s / pitch + 1e-9) + 1 : Math.ceil(s / pitch - 1e-9) - 1;
        const distC = (idx * pitch - s) * sg;
        const lineIdx = Math.round((alongZ ? a.x : a.z) / pitch);
        const ci = alongZ ? lineIdx : idx, cj = alongZ ? idx : lineIdx;

        if (!a.path) {
            if (a.decIdx !== idx && distC <= H + 6) { a.turn = chooseTurn(a, idx, ci, cj); a.decIdx = idx; a.yieldT = 0; }
            const turning = a.decIdx === idx && a.turn !== 0;
            if (turning && distC < 26) targetV = Math.min(targetV, 7);

            // traffic light / left-turn yield at the stop line
            const dL = distC - (H + 2.5);
            a.waitLight = false;
            if (dL > -3 && dL < 90 && Math.abs(idx) <= net.N + 1) {
                const sig = signalAt(ci, cj, clock)[alongZ ? 'ns' : 'ew'];
                const m = Math.max(0, dL / SCALE - 0.4);
                const vStop = Math.sqrt(2 * 4.5 * m);
                if (sig === 'red' || (sig === 'yellow' && a.speed * a.speed / 9 < dL / SCALE)) {
                    targetV = Math.min(targetV, vStop);
                    if (vStop < 0.5) a.waitLight = true;          // waiting at a red light is not "stuck"
                }
            }
            if (turning && a.turn === 1 && distC < H + 14) {
                let blocked = false;
                const opp = (a.d + 2) % 4;
                for (const o of agents) {
                    if (o === a || o.d !== opp || o.path) continue;
                    const oAlong = alongZ ? o.z : o.x, oLine = Math.round((alongZ ? o.x : o.z) / pitch);
                    if (oLine !== lineIdx) continue;
                    const od = (idx * pitch - oAlong) * (DIRS[opp][0] + DIRS[opp][1]);
                    if (od > -H && od < 55 && o.speed > 0.5) { blocked = true; break; }
                }
                a.yieldT += dt;
                if (blocked && a.yieldT < 6) targetV = Math.min(targetV, Math.sqrt(2 * 4.5 * Math.max(0, (distC - H - 3) / SCALE)));
            }
            if (turning && distC <= H) startPath(a, ci, cj, a.turn);
        } else {
            targetV = Math.min(targetV, 7);
        }

        // ── car following / obstacle ahead (cars, parked cars, player) ──
        const look = 28 + a.speed * SCALE * 1.3;
        const check = (o, isPlayer) => {
            if (o === a) return;
            const dx = o.x - a.x, dz = o.z - a.z;
            const f = dx * hx + dz * hz;
            if (f < 0.5 || f > look) return;
            const l = dx * rx + dz * rz;
            if (Math.abs(l) > (a.path ? 5.6 : 4.4)) return;
            if (a.ghost > 0 && !isPlayer && !o.static) return;
            const gapM = (f - 11) / SCALE;
            const allow = gapM <= 1.5 ? 0 : (gapM - 1.5) / 1.2;
            targetV = Math.min(targetV, allow);
        };
        for (const o of agents) check(o, false);
        for (const o of statics) check(o, false);
        for (const o of extras) check(o, false);
        check({ x: player.x, z: player.z }, true);

        if (a.hold > 0) targetV = 0;

        // stuck detection (deadlock breaker)
        if (a.speed < 0.3 && targetV < 0.5 && !a.waitLight) { a.stuck += dt; if (a.stuck > 5) { a.ghost = 3; a.stuck = 0; } } else a.stuck = 0;
        if (a.ghost > 0) a.ghost -= dt;

        // ── speed ──
        if (a.speed < targetV) a.speed = Math.min(targetV, a.speed + 4.8 * dt);
        else a.speed = Math.max(targetV, a.speed - (a.speed - targetV > 3 ? 10 : 6) * dt);
        a.speed = Math.max(0, a.speed);
        const step = a.speed * SCALE * dt;

        // ── move ──
        if (a.path) {
            const p = a.path;
            p.t += step / p.len;
            const t = Math.min(p.t, 1), u = 1 - t;
            a.x = u * u * p.p0[0] + 2 * u * t * p.p1[0] + t * t * p.p2[0];
            a.z = u * u * p.p0[1] + 2 * u * t * p.p1[1] + t * t * p.p2[1];
            a.heading = Math.atan2(hx, hz);
            if (p.t >= 1) { a.d = p.d2; a.path = null; a.decIdx = NaN; a.turn = 0; a.heading = dirAngle(a.d); }
        } else {
            const R0 = rightOf(a.d), line = lineIdx * pitch;
            if (alongZ) { a.x += (line + R0[0] * lane - a.x) * Math.min(1, dt * 4); a.z += D[1] * step; }
            else { a.z += (line + R0[1] * lane - a.z) * Math.min(1, dt * 4); a.x += D[0] * step; }
            const targetH = dirAngle(a.d);
            let dh = targetH - a.heading; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
            a.heading += dh * Math.min(1, dt * 8);
        }

        let y = ROAD_Y;
        let slopePitch = 0;
        if (getElevation) {
            const elev = getElevation(a.x, a.z);
            if (elev && typeof elev.y === 'number') {
                y = elev.y;
                if (elev.normal) {
                    const cosH = Math.cos(a.heading), sinH = Math.sin(a.heading);
                    slopePitch = -(elev.normal.x * sinH + elev.normal.z * cosH);
                }
            }
        }
        a.mesh.position.set(a.x, y, a.z);
        a.mesh.rotation.set(slopePitch, a.heading, 0);
    }

    // ─── Public API ───
    return {
        agents, statics, extras,
        get clock() { return clock; },
        setNetwork(n) { net = n; lampCell = [NaN, NaN]; },
        setCarFactory(f) { makeCar = f; },
        setElevationGetter(fn) { getElevation = fn; },
        setCount(n) { target = n; },
        setSignalsVisible(v) { signalsVisible = v; poleMesh.visible = armMesh.visible = headMesh.visible = v; },
        forEachOther,

        reset(px, pz) {                       // remove everything and respawn for the current target count
            agents.forEach(a => scene.remove(a.mesh)); agents.length = 0;
            if (!net) return;
            for (let i = 0; i < target; i++) makeAgent(i, px, pz);
        },

        clear() {
            agents.forEach(a => scene.remove(a.mesh)); agents.length = 0;
            statics.forEach(o => scene.remove(o.mesh)); statics.length = 0;
            extras.length = 0;
            poleMesh.count = headMesh.count = 0; lampCell = [NaN, NaN];
        },

        addStatic(mesh, x, z, heading) {
            mesh.position.set(x, ROAD_Y, z); mesh.rotation.y = heading; scene.add(mesh);
            const o = { mesh, x, z, heading, speed: 0, static: true };
            statics.push(o); return o;
        },
        clearStatics() { statics.forEach(o => scene.remove(o.mesh)); statics.length = 0; },

        update(dt, player) {
            if (!net) return;
            clock += dt;
            if (signalsVisible) {
                const ci = Math.round(player.x / net.pitch), cj = Math.round(player.z / net.pitch);
                if (ci !== lampCell[0] || cj !== lampCell[1]) rebuildLamps(player.x, player.z);
                lampTimer += dt;
                if (lampTimer > 0.25) { lampTimer = 0; paintLamps(); }
            }
            for (const a of agents) {
                if (Math.hypot(a.x - player.x, a.z - player.z) > 650) {          // too far: respawn near the player
                    if (spawnAgent(a, player.x, player.z)) {
                        let y = ROAD_Y;
                        if (getElevation) {
                            const el = getElevation(a.x, a.z);
                            if (el && typeof el.y === 'number') y = el.y;
                        }
                        a.mesh.position.set(a.x, y, a.z);
                        a.mesh.rotation.set(0, a.heading, 0);
                    }
                    continue;
                }
                updateAgent(a, dt, player);
            }
        }
    };
}

import * as THREE from 'three';
import { SCALE } from './physics.js';
import { DIRS, dirAngle, rightOf } from './traffic.js';
import { playMissionStart, playMissionComplete, playCrashSound, startSirenSound, stopSirenSound } from './sound.js';

// ─── GAME MODES: FREE ROAM · POLICE PURSUIT · WANTED ESCAPE · STREET RACE · PARKING · DELIVERY ───
// Every target, bay, checkpoint and spawn is generated ON the road grid (never inside a building).

const $ = (id) => document.getElementById(id);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const rnd = (a, b) => a + Math.random() * (b - a);

export const MODE_INFO = {
    free:          { name: 'FREE ROAM',       icon: '🛣️', traffic: 16, text: 'Cruise the whole city. Smart traffic obeys the lights and reacts to you. No rules, no timer.' },
    police_patrol: { name: 'POLICE PURSUIT',  icon: '🚨', traffic: 12, text: 'Take the Police Interceptor SUV! Chase down the speeding suspect car and ram them to stop their escape.' },
    police_chase:  { name: 'WANTED ESCAPE',   icon: '⭐', traffic: 14, text: 'GTA Wanted Level 3! Aggressive police squads are chasing you. Evade pursuit before your vehicle is wrecked.' },
    race:          { name: 'STREET RACE',     icon: '🏁', traffic: 0,  text: 'Beat 3 AI racers through the checkpoints. Follow the yellow beam and the minimap. Take the corners smart.' },
    parking:       { name: 'PARKING',         icon: '🅿️', traffic: 12, text: 'Park in 3 street bays squeezed between parked cars. Stop inside the green bay, straight, and hold still. Crashes cost stars.' },
    delivery:      { name: 'DELIVERY',        icon: '📦', traffic: 14, text: 'Pick up 3 packages and deliver them before time runs out. Stop in the yellow circle. Dodge traffic, avoid crashes.' }
};

export function createModes(ctx) {
    const { scene, traffic, ps } = ctx;
    let current = null, currentId = 'free';
    let objs = [];                                    // everything added to the scene by the active mode

    // ─── small helpers ───
    const add = (o) => { scene.add(o); objs.push(o); return o; };
    const cleanup = () => { objs.forEach(o => scene.remove(o)); objs = []; };
    const hud = (title, desc, sub = '') => {
        $('mission-hud').style.display = title ? 'block' : 'none';
        $('mission-title').textContent = title || '';
        $('mission-desc').innerHTML = desc || '';
        $('mission-sub').textContent = sub;
    };
    let msgTimer = 0;
    const say = (text, sec = 1.4, color = '#ffffff') => {
        const el = $('center-msg'); el.textContent = text; el.style.color = color; el.style.opacity = 1; msgTimer = sec;
    };
    const showResult = (title, lines, retry) => {
        $('result-title').textContent = title;
        $('result-body').innerHTML = lines.map(l => `<div>${l}</div>`).join('');
        $('result-panel').style.display = 'flex';
        $('result-retry').onclick = () => { $('result-panel').style.display = 'none'; retry(); };
        $('result-exit').onclick = () => { $('result-panel').style.display = 'none'; ctx.exitToGarage(); };
        ctx.lockPlayer(true);
    };
    const hideResult = () => { $('result-panel').style.display = 'none'; };

    const beam = (color, radius = 1.3, h = 110) => {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, h, 12, 1, true),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
        m.position.y = h / 2 + 1.5; return m;
    };
    const groundRing = (r, color, w = 0.8) => {
        const m = new THREE.Mesh(new THREE.RingGeometry(r - w, r, 40),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
        m.rotation.x = -Math.PI / 2; m.position.y = 1.62; return m;
    };

    // A random spot in the MIDDLE of a road block (never in an intersection), `minD..maxD` from (px,pz)
    function roadSpot(px, pz, minD, maxD) {
        const net = ctx.getNet(), { pitch, N } = net;
        let best = null;
        for (let t = 0; t < 60; t++) {
            const ang = Math.random() * Math.PI * 2, dist = rnd(minD, maxD);
            const tx = px + Math.cos(ang) * dist, tz = pz + Math.sin(ang) * dist;
            const axis = Math.random() < 0.5 ? 'z' : 'x';
            const line = Math.max(-N, Math.min(N, Math.round((axis === 'z' ? tx : tz) / pitch))) * pitch;
            const m = Math.max(-N, Math.min(N - 1, Math.floor((axis === 'z' ? tz : tx) / pitch)));
            const s = (m + 0.5) * pitch;
            const spot = { axis, x: axis === 'z' ? line : s, z: axis === 'z' ? s : line };
            const d = Math.hypot(spot.x - px, spot.z - pz);
            best = spot;
            if (d >= minD * 0.8 && d <= maxD * 1.3) return spot;
        }
        return best;
    }
    const startPose = () => { const n = ctx.getNet(); ctx.placePlayer(-n.lane, 25, 0); };

    // ═══════════════ FREE ROAM ═══════════════
    function freeMode() {
        return {
            start() { startPose(); hud(null); },
            update() {}, stop() {}, onHit() {}, markers: () => []
        };
    }

    // ═══════════════ PARKING ═══════════════
    function parkingMode() {
        const ROUNDS = 3, LEN = 16, WID = 6.5, LIMIT = 90;
        let round = 0, bay = null, t = 0, hold = 0, hits = 0, results = [], state = 'play', wait = 0, bayObjs = [];
        const holdRing = groundRing(3.2, 0xf0c030, 0.5);

        function newBay() {
            bayObjs.forEach(o => scene.remove(o)); bayObjs = [];
            traffic.clearStatics();
            const net = ctx.getNet();
            const spot = roadSpot(ps.x, ps.z, 140, 380);
            const d = spot.axis === 'z' ? (Math.random() < 0.5 ? 0 : 2) : (Math.random() < 0.5 ? 1 : 3);
            const R = rightOf(d);
            bay = { cx: spot.x + R[0] * net.parkOffset, cz: spot.z + R[1] * net.parkOffset, h: dirAngle(d) };

            const g = new THREE.Group();
            g.position.set(bay.cx, 1.6, bay.cz); g.rotation.y = bay.h;
            const fill = new THREE.Mesh(new THREE.PlaneGeometry(WID, LEN).rotateX(-Math.PI / 2),
                new THREE.MeshBasicMaterial({ color: 0xf0c030, transparent: true, opacity: 0.3, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
            g.add(fill);
            const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
            [[-WID / 2, 0, 0.3, LEN], [WID / 2, 0, 0.3, LEN], [0, -LEN / 2, WID, 0.3], [0, LEN / 2, WID, 0.3]].forEach(([x, z, w, l]) => {
                const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l).rotateX(-Math.PI / 2), lineMat);
                m.position.set(x, 0.02, z); g.add(m);
            });
            g.add(beam(0xf0c030, 1.2, 90).translateY(-1.5 - 0.1));
            scene.add(g); bayObjs.push(g);

            // parked cars in front and behind: the bay is tight
            const fx = Math.sin(bay.h), fz = Math.cos(bay.h);
            [-1, 1].forEach((k, i) => traffic.addStatic(ctx.makeCar(i), bay.cx + fx * 14.2 * k, bay.cz + fz * 14.2 * k, bay.h));
            t = 0; hold = 0; hits = 0; state = 'play';
            say(`BAY ${round + 1} / ${ROUNDS}`, 1.6, '#f0c030');
        }

        function finish(ok) {
            const stars = results.reduce((s, r) => s + r.stars, 0);
            const lines = results.map((r, i) => `Bay ${i + 1}: ${'★'.repeat(r.stars)}${'☆'.repeat(3 - r.stars)} &nbsp; ${r.time.toFixed(1)}s`);
            if (!ok) lines.push('<b style="color:#ff5a5a">Time ran out</b>');
            else lines.push(`<b>Total: ${stars} / ${ROUNDS * 3} stars</b>`);
            showResult(ok ? 'PARKING COMPLETE' : 'TIME UP', lines, () => current.start());
            state = 'done';
        }

        return {
            start() {
                hideResult(); ctx.lockPlayer(false);
                traffic.clearStatics();
                round = 0; results = []; startPose();
                holdRing.visible = false; add(holdRing);
                newBay();
            },
            update(dt) {
                if (state === 'done') return;
                if (state === 'next') { wait -= dt; if (wait <= 0) { round++; newBay(); } return; }
                t += dt;
                const dx = ps.x - bay.cx, dz = ps.z - bay.cz;
                const sh = Math.sin(bay.h), ch = Math.cos(bay.h);
                const along = dx * sh + dz * ch, lat = dx * ch - dz * sh;
                let he = wrap(ps.heading - bay.h); if (he > Math.PI / 2) he -= Math.PI; if (he < -Math.PI / 2) he += Math.PI;
                const dist = Math.hypot(dx, dz) / SCALE;
                const inside = Math.abs(along) < 2.6 && Math.abs(lat) < 1.7 && Math.abs(he) < 0.2;
                const speed = Math.abs(ps.vf) + Math.abs(ps.vr);

                if (inside && speed < 0.5) hold += dt; else hold = Math.max(0, hold - dt * 2);
                holdRing.visible = hold > 0;
                holdRing.position.set(bay.cx, 1.63, bay.cz); holdRing.scale.setScalar(0.4 + hold / 1.2 * 0.6);

                let msg;
                if (dist > 30) msg = `Drive to the green bay · <b>${Math.round(dist)} m</b>`;
                else if (!inside) msg = Math.abs(he) > 0.2 ? 'Line up straight with the bay' : 'Park in the middle of the bay';
                else msg = speed < 0.5 ? 'Hold still…' : 'Slow down and stop';
                hud(`PARKING ${round + 1}/${ROUNDS}`, msg, `Time ${Math.max(0, LIMIT - t).toFixed(0)}s · Crashes ${hits}`);

                if (hold >= 1.2) {
                    const acc = 1 - (Math.abs(lat) / 1.7 * 0.4 + Math.abs(along) / 2.6 * 0.3 + Math.abs(he) / 0.2 * 0.3);
                    let stars = acc > 0.7 ? 3 : acc > 0.4 ? 2 : 1;
                    if (hits >= 2) stars = Math.max(1, stars - 1);
                    results.push({ stars, time: t });
                    say(`PARKED  ${'★'.repeat(stars)}`, 1.8, '#ffd700');
                    holdRing.visible = false;
                    if (round + 1 >= ROUNDS) finish(true); else { state = 'next'; wait = 1.8; }
                } else if (t > LIMIT) finish(false);
            },
            onHit(impact) { if (state === 'play' && impact > 2) { hits++; say('CRASH!', 0.8, '#ff5a5a'); } },
            stop() { bayObjs.forEach(o => scene.remove(o)); bayObjs = []; traffic.clearStatics(); },
            markers: () => (bay && state !== 'done') ? [{ x: bay.cx, z: bay.cz, color: '#f0c030', r: 5 }] : []
        };
    }

    // ═══════════════ DELIVERY ═══════════════
    function deliveryMode() {
        const JOBS = 3;
        let job = 0, stage = 'pickup', target = null, t = 0, limit = 0, hits = 0, cash = 0, marker = null, ring = null, state = 'play';

        function nextTarget() {
            const net = ctx.getNet();
            const spot = roadSpot(ps.x, ps.z, 260, 520);
            const d = spot.axis === 'z' ? (Math.random() < 0.5 ? 0 : 2) : (Math.random() < 0.5 ? 1 : 3);
            const R = rightOf(d);
            target = { x: spot.x + R[0] * net.parkOffset, z: spot.z + R[1] * net.parkOffset };
            const dist = Math.hypot(target.x - ps.x, target.z - ps.z) / SCALE;
            limit = 25 + dist / 11;                       // seconds, about 40 km/h average
            t = 0;
            marker.position.set(target.x, 0, target.z); ring.position.set(target.x, 1.62, target.z);
            const col = stage === 'pickup' ? 0xffd23f : 0x3fa9ff;
            marker.children[0].material.color.setHex(col); ring.material.color.setHex(col);
        }
        function end(ok) {
            state = 'done';
            showResult(ok ? 'DELIVERIES DONE' : 'TOO SLOW', [`Packages delivered: ${ok ? JOBS : job}/${JOBS}`, `Earned: <b>$${cash}</b>`, `Crashes: ${hits}`], () => current.start());
        }
        return {
            start() {
                hideResult(); ctx.lockPlayer(false);
                job = 0; stage = 'pickup'; cash = 0; hits = 0; state = 'play'; startPose();
                marker = add(new THREE.Group()); marker.add(beam(0xffd23f, 1.6, 110).translateY(-1.5));
                ring = add(groundRing(9, 0xffd23f, 1.2));
                nextTarget();
                say('DELIVERY STARTED', 1.6, '#ffd23f');
            },
            update(dt) {
                if (state !== 'play') return;
                t += dt;
                ring.scale.setScalar(1 + Math.sin(performance.now() * 0.006) * 0.04);
                const dist = Math.hypot(target.x - ps.x, target.z - ps.z);
                const kmh = Math.abs(ps.vf) * 3.6;
                const left = limit - t;
                hud(`DELIVERY ${job + 1}/${JOBS}`,
                    dist / SCALE > 12 ? `${stage === 'pickup' ? 'Pick up the package' : 'Deliver the package'} · <b>${Math.round(dist / SCALE)} m</b>`
                        : 'Stop inside the circle',
                    `Time ${Math.max(0, left).toFixed(0)}s · $${cash} · Crashes ${hits}`);
                if (dist < 9 && kmh < 12) {
                    if (stage === 'pickup') { stage = 'dropoff'; say('PACKAGE PICKED UP', 1.5, '#ffd23f'); }
                    else {
                        const pay = Math.max(40, Math.round(100 + left * 4 - hits * 25));
                        cash += pay; job++; stage = 'pickup';
                        say(`DELIVERED  +$${pay}`, 1.8, '#3fffa0');
                        if (job >= JOBS) { end(true); return; }
                    }
                    nextTarget();
                } else if (left <= 0) end(false);
            },
            onHit(impact) { if (state === 'play' && impact > 2) { hits++; say('CRASH!', 0.8, '#ff5a5a'); } },
            stop() {},
            markers: () => (target && state === 'play') ? [{ x: target.x, z: target.z, color: stage === 'pickup' ? '#ffd23f' : '#3fa9ff', r: 5 }] : []
        };
    }

    // ═══════════════ STREET RACE ═══════════════
    function raceMode() {
        const NAMES = ['VIPER', 'GHOST', 'NOVA'];
        const CHAMFER = 12, CORNER_V = 14;
        let wp = [], legCum = [], total = 0, M = 0;
        let racers = [], cp = 1, t = 0, state = 'count', count = 3.6, playerTime = 0, finished = [];
        let beamMain = null, beamNext = null;

        function buildRoute() {
            const net = ctx.getNet(), p = net.pitch;
            const span = Math.min(net.N - 1, 6), want = net.id === 1 ? 8 : 10;
            for (let attempt = 0; attempt < 30; attempt++) {
                const cells = [[0, 0]], seen = new Set(['0,0']);
                let axis = Math.random() < 0.5 ? 0 : 1, ok = true;
                for (let n = 0; n < want && ok; n++) {
                    let placed = false;
                    for (let tries = 0; tries < 30 && !placed; tries++) {
                        const len = 2 + Math.floor(Math.random() * 3), sg = Math.random() < 0.5 ? -1 : 1;
                        const [ci, cj] = cells[cells.length - 1];
                        const ni = ci + (axis === 0 ? sg * len : 0), nj = cj + (axis === 1 ? sg * len : 0);
                        if (Math.abs(ni) > span || Math.abs(nj) > span || seen.has(`${ni},${nj}`)) continue;
                        cells.push([ni, nj]); seen.add(`${ni},${nj}`); placed = true;
                    }
                    if (!placed) ok = false;
                    axis ^= 1;
                }
                if (ok) { wp = cells.map(([i, j]) => [i * p, j * p]); return; }
            }
            wp = [[0, 0], [2 * p, 0], [2 * p, 2 * p]];             // fallback
        }
        const legDir = (k) => {
            const dx = wp[k + 1][0] - wp[k][0], dz = wp[k + 1][1] - wp[k][1], l = Math.hypot(dx, dz);
            return [dx / l, dz / l, l];
        };

        // Lane-shifted path with chamfered corners (the chamfer stays inside the intersection)
        function buildPath(off) {
            const pts = [], n = wp.length;
            for (let k = 0; k < n; k++) {
                if (k === 0 || k === n - 1) {
                    const a = legDir(k === 0 ? 0 : n - 2);
                    pts.push([wp[k][0] + -a[1] * off, wp[k][1] + a[0] * off, 0]);
                } else {
                    const a = legDir(k - 1), b = legDir(k);
                    const rab = -a[1] * b[0] + a[0] * b[1];            // r_a · b
                    const rba = -b[1] * a[0] + b[0] * a[1];            // r_b · a
                    const X = [wp[k][0] + off * rab * b[0] + off * rba * a[0], wp[k][1] + off * rab * b[1] + off * rba * a[1]];
                    pts.push([X[0] - a[0] * CHAMFER, X[1] - a[1] * CHAMFER, 1], [X[0] + b[0] * CHAMFER, X[1] + b[1] * CHAMFER, 1]);
                }
            }
            const cum = [0];
            for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
            return { pts, cum };
        }
        function pointAt(path, si, dist) {
            const { pts, cum } = path;
            let i = si;
            while (i < pts.length - 2 && cum[i + 1] < dist) i++;
            const l = cum[i + 1] - cum[i] || 1, u = Math.max(0, Math.min(1, (dist - cum[i]) / l));
            return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * u, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u];
        }
        const progressOf = (x, z, nextCp) => {
            const k = Math.min(nextCp, M), a = legDir(k - 1);
            const pr = (x - wp[k - 1][0]) * a[0] + (z - wp[k - 1][1]) * a[1];
            return legCum[k - 1] + Math.max(0, Math.min(a[2], pr));
        };

        function position() {
            const pp = progressOf(ps.x, ps.z, cp) + (cp > M ? 1e6 : 0);
            let ahead = 0;
            racers.forEach(r => { const rp = r.done ? 1e6 + (10 - r.finishT) : progressOf(r.x, r.z, r.cp); if (rp > pp) ahead++; });
            return ahead + 1;
        }

        function start() {
            hideResult(); cleanup();
            racers.forEach(r => { scene.remove(r.mesh); const i = traffic.extras.indexOf(r); if (i >= 0) traffic.extras.splice(i, 1); });
            racers = []; finished = [];
            buildRoute();
            M = wp.length - 1;
            legCum = [0]; for (let k = 0; k < M; k++) legCum.push(legCum[k] + legDir(k)[2]);
            total = legCum[M];

            // starting grid
            const a = legDir(0), h = Math.atan2(a[0], a[1]), r = [-a[1], a[0]];
            const slots = [[0, 4.5], [0, -4.5], [1, 4.5], [1, -4.5]];
            const at = (row, lat) => [wp[0][0] - a[0] * (9 + row * 17) + r[0] * lat, wp[0][1] - a[1] * (9 + row * 17) + r[1] * lat];
            const ps0 = at(slots[0][0], slots[0][1]);
            ctx.placePlayer(ps0[0], ps0[1], h);
            for (let i = 0; i < 3; i++) {
                const [row, lat] = slots[i + 1], pos = at(row, lat);
                const mesh = ctx.makeCar(i + 1); scene.add(mesh);
                const rc = { mesh, x: pos[0], z: pos[1], heading: h, speed: 0, ai: true, name: NAMES[i], cp: 1, si: 0,
                    path: buildPath(lat), top: rnd(40, 47) * (0.9 + i * 0.05), done: false, finishT: 0 };
                racers.push(rc); traffic.extras.push(rc);
                mesh.position.set(rc.x, 1.5, rc.z); mesh.rotation.y = h;
            }
            beamMain = add(beam(0xffd23f, 1.8, 130)); beamNext = add(beam(0x4aa8ff, 1.1, 80));
            beamNext.material.opacity = 0.18;
            cp = 1; t = 0; state = 'count'; count = 3.6; playerTime = 0;
            ctx.lockPlayer(true);
        }

        function updateRacers(dt) {
            const goLive = state === 'race' || state === 'done';
            const pProg = progressOf(ps.x, ps.z, Math.min(cp, M));
            racers.forEach(r => {
                const { pts, cum } = r.path;
                // progress along my own path
                while (r.si < pts.length - 2) {
                    const dx = pts[r.si + 1][0] - pts[r.si][0], dz = pts[r.si + 1][1] - pts[r.si][1], l = Math.hypot(dx, dz) || 1;
                    const pr = ((r.x - pts[r.si][0]) * dx + (r.z - pts[r.si][1]) * dz) / l;
                    if (pr > l) r.si++; else break;
                }
                const dx = pts[r.si + 1][0] - pts[r.si][0], dz = pts[r.si + 1][1] - pts[r.si][1], l = Math.hypot(dx, dz) || 1;
                const prog = cum[r.si] + Math.max(0, Math.min(l, ((r.x - pts[r.si][0]) * dx + (r.z - pts[r.si][1]) * dz) / l));

                // pass checkpoints
                if (!r.done && Math.hypot(r.x - wp[r.cp][0], r.z - wp[r.cp][1]) < 22) {
                    r.cp++;
                    if (r.cp > M) { r.done = true; r.finishT = t; finished.push(r); }
                }

                // target speed: fast on straights, brake for the next chamfered corner
                let vT = r.top;
                const rp = progressOf(r.x, r.z, r.cp);
                if (rp - pProg > 160) vT *= 0.9; else if (rp - pProg < -160) vT *= 1.08;     // rubber band
                if (pts[r.si][2] && pts[r.si + 1][2]) vT = Math.min(vT, CORNER_V);
                else {
                    for (let j = r.si + 1; j < pts.length; j++) if (pts[j][2]) {
                        const dC = Math.max(0, cum[j] - prog) / SCALE;
                        vT = Math.min(vT, Math.sqrt(CORNER_V * CORNER_V + 2 * 9 * dC));
                        break;
                    }
                }
                if (r.done || !goLive) vT = 0;

                if (r.speed < vT) r.speed = Math.min(vT, r.speed + 7.5 * dt); else r.speed = Math.max(vT, r.speed - 12 * dt);

                // pure pursuit steering
                const look = 14 + r.speed * SCALE * 0.28;
                const tp = pointAt(r.path, r.si, prog + look);
                const want = Math.atan2(tp[0] - r.x, tp[1] - r.z);
                const dh = wrap(want - r.heading);
                const turn = Math.max(-2.6, Math.min(2.6, dh * 4.5));
                r.heading += turn * dt * Math.min(1, r.speed / 6);
                r.x += Math.sin(r.heading) * r.speed * SCALE * dt;
                r.z += Math.cos(r.heading) * r.speed * SCALE * dt;
                r.mesh.position.set(r.x, 1.5, r.z); r.mesh.rotation.y = r.heading;
            });
        }

        return {
            start,
            update(dt) {
                if (state === 'count') {
                    count -= dt;
                    const n = Math.ceil(count - 0.6);
                    if (count > 0.6) { say(String(Math.max(1, n)), 0.3, '#ffffff'); }
                    else { say('GO!', 0.9, '#ffffff'); state = 'race'; ctx.lockPlayer(false); }
                    hud('STREET RACE', 'Get ready…', `${racers.length + 1} racers · ${M} checkpoints`);
                    updateRacers(dt);
                    return;
                }
                t += dt;
                if (state === 'race') {
                    if (Math.hypot(ps.x - wp[cp][0], ps.z - wp[cp][1]) < 22) {
                        cp++;
                        if (cp > M) {
                            state = 'done'; playerTime = t;
                            const pos = finished.length + 1;
                            const lines = [`Position: <b>${pos} / ${racers.length + 1}</b>`, `Your time: <b>${fmt(t)}</b>`];
                            finished.forEach((r, i) => lines.push(`${i + 1}. ${r.name} ${fmt(r.finishT)}`));
                            showResult(pos === 1 ? 'YOU WIN!' : `FINISHED ${pos}${['st', 'nd', 'rd', 'th'][Math.min(pos, 4) - 1]}`, lines, () => current.start());
                        } else say(`CHECKPOINT ${cp - 1}/${M}`, 0.9, '#ffd23f');
                    }
                    hud('STREET RACE', `Checkpoint <b>${Math.min(cp, M)}/${M}</b> · Position <b>${position()}/${racers.length + 1}</b>`, `Time ${fmt(t)}`);
                }
                updateRacers(dt);
                if (cp <= M) {
                    beamMain.position.set(wp[cp][0], beamMain.position.y, wp[cp][1]);
                    beamNext.visible = cp < M;
                    if (cp < M) beamNext.position.set(wp[cp + 1][0], beamNext.position.y, wp[cp + 1][1]);
                } else { beamMain.visible = beamNext.visible = false; }
            },
            onHit(impact) { if (state === 'race' && impact > 3) say('CRASH!', 0.7, '#ff5a5a'); },
            stop() {
                racers.forEach(r => { scene.remove(r.mesh); const i = traffic.extras.indexOf(r); if (i >= 0) traffic.extras.splice(i, 1); });
                racers = [];
            },
            markers: () => {
                const m = racers.map(r => ({ x: r.x, z: r.z, color: '#ff4d4d', r: 3.5 }));
                if (cp <= M) m.push({ x: wp[cp][0], z: wp[cp][1], color: '#ffd23f', r: 5.5 });
                if (cp < M) m.push({ x: wp[cp + 1][0], z: wp[cp + 1][1], color: '#4aa8ff', r: 4 });
                return m;
            }
        };
    }

    // ═══════════════ POLICE PURSUIT ═══════════════
    function policePatrolMode() {
        let suspect = null, suspectMesh = null, hp = 100, elapsed = 0, state = 'play';
        const startDist = 140;

        function spawnSuspect() {
            if (suspectMesh) scene.remove(suspectMesh);
            const net = ctx.getNet();
            const angle = ps.heading;
            const sx = ps.x + Math.sin(angle) * startDist;
            const sz = ps.z + Math.cos(angle) * startDist;

            suspectMesh = ctx.makeCar ? ctx.makeCar(1) : new THREE.Group();
            scene.add(suspectMesh);
            objs.push(suspectMesh);

            suspect = {
                mesh: suspectMesh,
                x: sx, z: sz, heading: angle,
                speed: 18,
                hp: 100
            };
            traffic.extras.push(suspect);
        }

        return {
            start() {
                hideResult(); ctx.lockPlayer(false);
                startPose();
                hp = 100; elapsed = 0; state = 'play';
                spawnSuspect();
                startSirenSound();
                playMissionStart();
                say('POLICE PURSUIT: DISABLE SUSPECT VEHICLE!', 2.5, '#4aa8ff');
            },
            update(dt) {
                if (state !== 'play' || !suspect) return;
                elapsed += dt;

                const net = ctx.getNet(), { extent } = net;
                suspect.speed = Math.min(30, suspect.speed + dt * 3.5);
                suspect.x += Math.sin(suspect.heading) * suspect.speed * dt * SCALE;
                suspect.z += Math.cos(suspect.heading) * suspect.speed * dt * SCALE;

                if (Math.abs(suspect.x) > extent - 40 || Math.abs(suspect.z) > extent - 40) {
                    suspect.heading += Math.PI;
                }

                suspect.mesh.position.set(suspect.x, 1.5, suspect.z);
                suspect.mesh.rotation.y = suspect.heading;

                const dist = Math.hypot(suspect.x - ps.x, suspect.z - ps.z) / SCALE;

                hud('POLICE PURSUIT 🚨',
                    `SUSPECT INTEGRITY: <b>${Math.max(0, Math.round(hp))}%</b><div style="width:100%;height:6px;background:rgba(255,255,255,0.15);margin-top:5px;border-radius:3px;overflow:hidden;"><div style="width:${Math.max(0, hp)}%;height:100%;background:#ff2a5f;transition:width 0.2s;"></div></div>`,
                    `DISTANCE: ${Math.round(dist)}m · RAM TO STOP`
                );

                if (dist > 450) {
                    state = 'lost';
                    stopSirenSound();
                    showResult('SUSPECT ESCAPED', ['Suspect outran police patrol unit', `Pursuit Duration: ${fmt(elapsed)}`], () => current.start());
                }
            },
            onHit(impact) {
                if (state !== 'play' || !suspect) return;
                const d = Math.hypot(suspect.x - ps.x, suspect.z - ps.z);
                if (d < 18) {
                    const dmg = Math.max(12, impact * 3.5);
                    hp -= dmg;
                    playCrashSound(impact);
                    say(`RAM HIT! -${Math.round(dmg)}%`, 0.8, '#ffd23f');
                    suspect.speed *= 0.65;

                    if (hp <= 0) {
                        state = 'won';
                        stopSirenSound();
                        playMissionComplete();
                        showResult('SUSPECT APPREHENDED! 🚨', [
                            'Suspect Vehicle Disabled & Arrested',
                            'Bounty Reward: $5,000',
                            `Time: ${fmt(elapsed)}`
                        ], () => current.start());
                    }
                }
            },
            stop() {
                stopSirenSound();
                if (suspect) {
                    const idx = traffic.extras.indexOf(suspect);
                    if (idx >= 0) traffic.extras.splice(idx, 1);
                    if (suspect.mesh) scene.remove(suspect.mesh);
                    suspect = null;
                }
            },
            markers: () => suspect ? [{ x: suspect.x, z: suspect.z, color: '#ff2222', r: 5.5 }] : []
        };
    }

    // ═══════════════ WANTED ESCAPE (POLICE CHASE) ═══════════════
    function policeChaseMode() {
        const ESCAPE_TIME = 75;
        let timeLeft = ESCAPE_TIME, playerHp = 100, elapsed = 0, state = 'play';
        let policeCars = [];

        function spawnPoliceSquad() {
            policeCars.forEach(p => { scene.remove(p.mesh); const idx = traffic.extras.indexOf(p); if (idx >= 0) traffic.extras.splice(idx, 1); });
            policeCars = [];
            for (let i = 0; i < 2; i++) {
                const angle = ps.heading + Math.PI + (i === 0 ? 0.35 : -0.35);
                const dist = 55 + i * 25;
                const mesh = ctx.makeCar ? ctx.makeCar(4) : new THREE.Group();
                scene.add(mesh);
                objs.push(mesh);
                const cop = {
                    mesh,
                    x: ps.x + Math.sin(angle) * dist,
                    z: ps.z + Math.cos(angle) * dist,
                    heading: ps.heading,
                    speed: 22
                };
                policeCars.push(cop);
                traffic.extras.push(cop);
            }
        }

        return {
            start() {
                hideResult(); ctx.lockPlayer(false);
                startPose();
                timeLeft = ESCAPE_TIME; playerHp = 100; elapsed = 0; state = 'play';
                spawnPoliceSquad();
                startSirenSound();
                playMissionStart();
                say('WANTED LEVEL ★★★: ESCAPE THE POLICE!', 2.5, '#ff2a5f');
            },
            update(dt) {
                if (state !== 'play') return;
                elapsed += dt;
                timeLeft = Math.max(0, timeLeft - dt);

                policeCars.forEach((cop) => {
                    const dx = ps.x - cop.x;
                    const dz = ps.z - cop.z;
                    const targetAngle = Math.atan2(dx, dz);
                    let dh = wrap(targetAngle - cop.heading);
                    cop.heading += dh * Math.min(1, dt * 4.5);

                    const dist = Math.hypot(dx, dz);
                    cop.speed = dist > 40 ? 32 : 24;
                    cop.x += Math.sin(cop.heading) * cop.speed * dt * SCALE;
                    cop.z += Math.cos(cop.heading) * cop.speed * dt * SCALE;

                    cop.mesh.position.set(cop.x, 1.5, cop.z);
                    cop.mesh.rotation.y = cop.heading;
                });

                hud('WANTED ★★★',
                    `ESCAPE TIMER: <b>${Math.ceil(timeLeft)}s</b><div style="width:100%;height:6px;background:rgba(255,255,255,0.15);margin-top:5px;border-radius:3px;overflow:hidden;"><div style="width:${Math.max(0, playerHp)}%;height:100%;background:#2ecc71;transition:width 0.2s;"></div></div>`,
                    `VEHICLE INTEGRITY: ${Math.round(playerHp)}% · EVADE PURSUIT!`
                );

                if (timeLeft <= 0) {
                    state = 'won';
                    stopSirenSound();
                    playMissionComplete();
                    showResult('WANTED LEVEL CLEARED! ⭐', [
                        'Evaded All Police Pursuit Squads',
                        'Wanted Level: CLEARED',
                        'Reward Bonus: $7,500'
                    ], () => current.start());
                }
            },
            onHit(impact) {
                if (state !== 'play') return;
                if (impact > 2) {
                    const dmg = impact * 2.8;
                    playerHp -= dmg;
                    playCrashSound(impact);
                    say('POLICE RAM!', 0.6, '#ff4d4d');

                    if (playerHp <= 0) {
                        state = 'busted';
                        stopSirenSound();
                        showResult('BUSTED / WRECKED', [
                            'Your vehicle was disabled by police',
                            `Evaded For: ${fmt(elapsed)}`,
                            'Impound Fee: -$2,500'
                        ], () => current.start());
                    }
                }
            },
            stop() {
                stopSirenSound();
                policeCars.forEach(p => {
                    const idx = traffic.extras.indexOf(p);
                    if (idx >= 0) traffic.extras.splice(idx, 1);
                    if (p.mesh) scene.remove(p.mesh);
                });
                policeCars = [];
            },
            markers: () => policeCars.map(c => ({ x: c.x, z: c.z, color: '#4aa8ff', r: 4.5 }))
        };
    }

    // ─── public ───
    function begin(id) {
        stopMode();
        currentId = MODE_INFO[id] ? id : 'free';
        current = ({
            free: freeMode,
            parking: parkingMode,
            delivery: deliveryMode,
            race: raceMode,
            police_patrol: policePatrolMode,
            police_chase: policeChaseMode
        })[currentId]();
        traffic.setCount(MODE_INFO[currentId].traffic);
        traffic.setSignalsVisible(currentId !== 'race');
        ctx.lockPlayer(false);
        current.start();
        traffic.reset(ps.x, ps.z);
    }
    function stopMode() {
        if (current) current.stop();
        cleanup(); hideResult();
        traffic.clear();
        hud(null);
        $('center-msg').style.opacity = 0;
        current = null;
    }

    return {
        start: begin,
        stop: stopMode,
        update(dt) {
            if (msgTimer > 0) { msgTimer -= dt; if (msgTimer <= 0) $('center-msg').style.opacity = 0; }
            if (current) current.update(dt);
        },
        onHit(impact) { if (current) current.onHit(impact); },
        markers: () => current ? current.markers() : [],
        get id() { return currentId; }
    };
}

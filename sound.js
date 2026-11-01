// sound.js - Modern AAA Procedural Audio Engine (Zero External Dependencies)
// Realistic layered combustion synthesis with analog distortion, exhaust formants, and mechanical rumble

let ctx = null;
let masterGain = null;
let engineGain = null;
let engineOsc1 = null;
let engineOsc2 = null;
let engineFilter = null;
let engineShaper = null;
let exhaustNoise = null;
let exhaustGain = null;
let isEngineRunning = false;
let lastAirBrakeTime = 0;

let sirenOsc = null;
let sirenLfo = null;
let sirenGain = null;
let isSirenOn = false;

export const audioState = {
    masterVol: 0.8,
    sfxVol: 0.9,
    engineVol: 0.65,
    sirenVol: 0.7,
    muted: false
};

function makeDistortionCurve(k = 18) {
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
        const x = (i * 2) / n_samples - 1;
        curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
}

export function initAudio() {
    if (ctx) return;
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        ctx = new AudioContext();
        masterGain = ctx.createGain();
        masterGain.gain.setValueAtTime(audioState.muted ? 0 : audioState.masterVol, ctx.currentTime);
        masterGain.connect(ctx.destination);
    } catch (e) {
        console.warn('Web Audio API not supported:', e);
    }
}

export function resumeAudio() {
    initAudio();
    if (ctx && ctx.state === 'suspended') {
        ctx.resume();
    }
}

// ─── MODERN AAA UI SOUNDS ───
export function playUiClick() {
    if (!ctx || audioState.muted) return;
    try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.035);
        gain.gain.setValueAtTime(0.15 * audioState.sfxVol, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.04);
        osc.connect(gain);
        gain.connect(masterGain);
        osc.start();
        osc.stop(ctx.currentTime + 0.045);
    } catch (e) {}
}

export function playUiTab() {
    if (!ctx || audioState.muted) return;
    try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(520, ctx.currentTime);
        osc.frequency.setValueAtTime(780, ctx.currentTime + 0.02);
        gain.gain.setValueAtTime(0.18 * audioState.sfxVol, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
        osc.connect(gain);
        gain.connect(masterGain);
        osc.start();
        osc.stop(ctx.currentTime + 0.055);
    } catch (e) {}
}

export function playUiSelect() {
    if (!ctx || audioState.muted) return;
    try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.06);
        gain.gain.setValueAtTime(0.2 * audioState.sfxVol, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.07);
        osc.connect(gain);
        gain.connect(masterGain);
        osc.start();
        osc.stop(ctx.currentTime + 0.075);
    } catch (e) {}
}

export function playMissionStart() {
    if (!ctx || audioState.muted) return;
    try {
        const chords = [330, 440, 554, 659];
        chords.forEach((freq, idx) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.05);
            gain.gain.setValueAtTime(0.001, ctx.currentTime);
            gain.gain.setValueAtTime(0.12 * audioState.sfxVol, ctx.currentTime + idx * 0.05);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + idx * 0.05 + 0.45);
            osc.connect(gain);
            gain.connect(masterGain);
            osc.start(ctx.currentTime + idx * 0.05);
            osc.stop(ctx.currentTime + idx * 0.05 + 0.5);
        });
    } catch (e) {}
}

export function playMissionComplete() {
    if (!ctx || audioState.muted) return;
    try {
        const notes = [440, 554, 659, 880];
        notes.forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.08);
            gain.gain.setValueAtTime(0.18 * audioState.sfxVol, ctx.currentTime + i * 0.08);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.08 + 0.5);
            osc.connect(gain);
            gain.connect(masterGain);
            osc.start(ctx.currentTime + i * 0.08);
            osc.stop(ctx.currentTime + i * 0.08 + 0.55);
        });
    } catch (e) {}
}

// ─── REALISTIC ENGINE SYNTHESIZER (WARM COMBUSTION + EXHAUST RESONANCE) ───
export function startEngineSound() {
    if (!ctx || isEngineRunning) return;
    try {
        engineOsc1 = ctx.createOscillator();
        engineOsc2 = ctx.createOscillator();
        engineFilter = ctx.createBiquadFilter();
        engineShaper = ctx.createWaveShaper();
        engineGain = ctx.createGain();

        // 1. Warm multi-cylinder combustion synthesis (triangle waves for deep bass pulse)
        engineOsc1.type = 'triangle';
        engineOsc2.type = 'sine';

        // 2. Soft analog saturation (warm tube overdrive, eliminates any digital harshness)
        engineShaper.curve = makeDistortionCurve(4);
        engineShaper.oversample = '4x';

        // 3. Resonant exhaust muffler filter (muffled bass body)
        engineFilter.type = 'lowpass';
        engineFilter.frequency.setValueAtTime(140, ctx.currentTime);
        engineFilter.Q.setValueAtTime(2.2, ctx.currentTime);

        const initialVol = audioState.muted ? 0 : audioState.engineVol * 0.24;
        engineGain.gain.setValueAtTime(initialVol, ctx.currentTime);

        // 4. Exhaust gas rush noise buffer (simulates rushing air/exhaust flow under throttle)
        const bufferSize = ctx.sampleRate * 2;
        const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        let lastOut = 0.0;
        for (let i = 0; i < bufferSize; i++) {
            const white = Math.random() * 2 - 1;
            output[i] = (lastOut + 0.02 * white) / 1.02; // Brown noise (deep rumble)
            lastOut = output[i];
            output[i] *= 3.5;
        }

        exhaustNoise = ctx.createBufferSource();
        exhaustNoise.buffer = noiseBuffer;
        exhaustNoise.loop = true;

        const exhaustFilter = ctx.createBiquadFilter();
        exhaustFilter.type = 'bandpass';
        exhaustFilter.frequency.setValueAtTime(140, ctx.currentTime);
        exhaustFilter.Q.setValueAtTime(1.5, ctx.currentTime);

        exhaustGain = ctx.createGain();
        exhaustGain.gain.setValueAtTime(0, ctx.currentTime);

        exhaustNoise.connect(exhaustFilter);
        exhaustFilter.connect(exhaustGain);
        exhaustGain.connect(masterGain);

        // Connect main combustion path: Osc -> Shaper -> Filter -> Gain -> Master
        engineOsc1.connect(engineShaper);
        engineOsc2.connect(engineShaper);
        engineShaper.connect(engineFilter);
        engineFilter.connect(engineGain);
        engineGain.connect(masterGain);

        engineOsc1.start();
        engineOsc2.start();
        exhaustNoise.start();
        isEngineRunning = true;
    } catch (e) {
        console.warn('Engine audio start error:', e);
    }
}

export function updateEngineSound(rpm, redline, throttle, speedKmh, carType = 'dodge') {
    if (!isEngineRunning || !ctx || audioState.muted) return;
    try {
        const ratio = Math.max(0.08, Math.min(1.0, rpm / (redline || 6500)));

        let baseFreq = 34 + ratio * 85;
        let subFreq = baseFreq * 0.505; // slight detune creates authentic multi-cylinder pulse
        let cutoff = 160 + ratio * 420 + throttle * 280;
        let baseVol = audioState.engineVol * (0.2 + ratio * 0.22 + throttle * 0.16);
        let exhaustVol = throttle * 0.14 * audioState.engineVol;

        switch (carType) {
            case 'dodge':
                // 6.2L Supercharged HEMI V8: Deep, thunderous, throaty bass rumble
                baseFreq = 32 + ratio * 78;
                subFreq = baseFreq * 0.495;
                cutoff = 150 + ratio * 480 + throttle * 320;
                baseVol *= 1.15;
                exhaustVol *= 1.25;
                break;

            case 'colorado':
                // 2.7L Turbo 4WD Pickup: Punchy, tight 4-cylinder turbo note
                baseFreq = 42 + ratio * 105;
                subFreq = baseFreq * 0.51;
                cutoff = 180 + ratio * 440 + throttle * 240;
                break;

            case 'colorado_z':
                // Twin-Turbo Desert Runner V6: Burly, gritty off-road rasp
                baseFreq = 46 + ratio * 115;
                subFreq = baseFreq * 0.515;
                cutoff = 210 + ratio * 520 + throttle * 300;
                exhaustVol *= 1.2;
                break;

            case 'custom':
                // GT Exotic Supercar: Screaming, smooth high-rev flat-plane V8 howl
                baseFreq = 55 + ratio * 145;
                subFreq = baseFreq * 0.502;
                cutoff = 260 + ratio * 680 + throttle * 360;
                baseVol *= 1.05;
                break;

            case 'police':
                // Police Interceptor: Tactical pursuit V8 with authoritative roar
                baseFreq = 36 + ratio * 88;
                subFreq = baseFreq * 0.498;
                cutoff = 170 + ratio * 460 + throttle * 290;
                baseVol *= 1.1;
                break;

            case 'truck':
                // 14.8L Heavy Turbo Diesel: Slow, heavy combustion chug (24-54 Hz) with massive low-end torque
                baseFreq = 24 + ratio * 32;
                subFreq = baseFreq * 0.5;
                cutoff = 130 + ratio * 240 + throttle * 160;
                baseVol *= 1.35;
                exhaustVol *= 0.8;
                break;
        }

        if (engineOsc1) engineOsc1.frequency.setTargetAtTime(baseFreq, ctx.currentTime, 0.05);
        if (engineOsc2) engineOsc2.frequency.setTargetAtTime(subFreq, ctx.currentTime, 0.05);
        if (engineFilter) engineFilter.frequency.setTargetAtTime(cutoff, ctx.currentTime, 0.06);
        if (engineGain) engineGain.gain.setTargetAtTime(baseVol, ctx.currentTime, 0.05);
        if (exhaustGain) exhaustGain.gain.setTargetAtTime(exhaustVol, ctx.currentTime, 0.06);
    } catch (e) {}
}

export function stopEngineSound() {
    if (!isEngineRunning || !ctx) return;
    try {
        if (engineGain) engineGain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
        if (exhaustGain) exhaustGain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
        setTimeout(() => {
            if (engineOsc1) { try { engineOsc1.stop(); } catch(e){} engineOsc1 = null; }
            if (engineOsc2) { try { engineOsc2.stop(); } catch(e){} engineOsc2 = null; }
            if (exhaustNoise) { try { exhaustNoise.stop(); } catch(e){} exhaustNoise = null; }
            isEngineRunning = false;
        }, 80);
    } catch (e) {
        isEngineRunning = false;
    }
}

// ─── TRUCK PNEUMATIC AIR BRAKE DISCHARGE (pshh-t!) ───
export function playAirBrakeSound() {
    if (!ctx || audioState.muted) return;
    const now = ctx.currentTime;
    if (now - lastAirBrakeTime < 1.4) return; // Prevent spamming
    lastAirBrakeTime = now;

    try {
        const bufferSize = ctx.sampleRate * 0.32;
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.09));
        }

        const noiseNode = ctx.createBufferSource();
        noiseNode.buffer = buffer;

        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(1800, now);
        filter.frequency.exponentialRampToValueAtTime(500, now + 0.28);
        filter.Q.setValueAtTime(2.0, now);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.32 * audioState.sfxVol, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

        noiseNode.connect(filter);
        filter.connect(gain);
        gain.connect(masterGain);

        noiseNode.start(now);
    } catch (e) {}
}

// ─── POLICE DUAL-TONE WAILING SIREN (STRICTLY FOR POLICE VEHICLE) ───
export function startSirenSound(carType = 'police') {
    if (!ctx || isSirenOn) return;
    if (carType !== 'police') return; // Strict lock
    try {
        sirenOsc = ctx.createOscillator();
        sirenLfo = ctx.createOscillator();
        sirenGain = ctx.createGain();
        const lfoGain = ctx.createGain();

        sirenOsc.type = 'sawtooth';
        sirenOsc.frequency.setValueAtTime(720, ctx.currentTime);

        sirenLfo.type = 'triangle';
        sirenLfo.frequency.setValueAtTime(1.6, ctx.currentTime);
        lfoGain.gain.setValueAtTime(240, ctx.currentTime);

        sirenLfo.connect(lfoGain);
        lfoGain.connect(sirenOsc.frequency);

        const sirenFilter = ctx.createBiquadFilter();
        sirenFilter.type = 'lowpass';
        sirenFilter.frequency.setValueAtTime(1400, ctx.currentTime);

        const vol = audioState.muted ? 0 : audioState.sirenVol * 0.26;
        sirenGain.gain.setValueAtTime(vol, ctx.currentTime);

        sirenOsc.connect(sirenFilter);
        sirenFilter.connect(sirenGain);
        sirenGain.connect(masterGain);

        sirenLfo.start();
        sirenOsc.start();
        isSirenOn = true;
    } catch (e) {}
}

export function stopSirenSound() {
    if (!isSirenOn || !ctx) return;
    try {
        if (sirenGain) sirenGain.gain.setTargetAtTime(0, ctx.currentTime, 0.06);
        setTimeout(() => {
            if (sirenOsc) { try { sirenOsc.stop(); } catch(e){} sirenOsc = null; }
            if (sirenLfo) { try { sirenLfo.stop(); } catch(e){} sirenLfo = null; }
            isSirenOn = false;
        }, 80);
    } catch (e) {
        isSirenOn = false;
    }
}

// ─── TIRE SCREECH (DRIFT / HARD CORNERING) ───
export function playTireScreech(intensity = 0.5) {
    if (!ctx || audioState.muted) return;
    try {
        const osc = ctx.createOscillator();
        const filter = ctx.createBiquadFilter();
        const gain = ctx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(1200 + Math.random() * 250, ctx.currentTime);
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(1500, ctx.currentTime);
        filter.Q.setValueAtTime(3.5, ctx.currentTime);

        const vol = Math.min(0.2, intensity * 0.18) * audioState.sfxVol;
        gain.gain.setValueAtTime(vol, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(masterGain);

        osc.start();
        osc.stop(ctx.currentTime + 0.16);
    } catch (e) {}
}

// ─── CRASH / IMPACT SOUND ───
export function playCrashSound(impact = 5) {
    if (!ctx || audioState.muted) return;
    try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(110, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(30, ctx.currentTime + 0.2);

        const vol = Math.min(0.45, 0.14 + (impact / 20) * 0.3) * audioState.sfxVol;
        gain.gain.setValueAtTime(vol, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);

        osc.connect(gain);
        gain.connect(masterGain);

        osc.start();
        osc.stop(ctx.currentTime + 0.24);
    } catch (e) {}
}

// ─── VOLUME CONTROLS ───
export function setMasterVolume(v) {
    audioState.masterVol = Math.max(0, Math.min(1, v));
    if (masterGain && ctx && !audioState.muted) {
        masterGain.gain.setTargetAtTime(audioState.masterVol, ctx.currentTime, 0.05);
    }
}

export function setEngineVolume(v) {
    audioState.engineVol = Math.max(0, Math.min(1, v));
}

export function setSirenVolume(v) {
    audioState.sirenVol = Math.max(0, Math.min(1, v));
    if (sirenGain && ctx && isSirenOn && !audioState.muted) {
        sirenGain.gain.setTargetAtTime(audioState.sirenVol * 0.26, ctx.currentTime, 0.05);
    }
}

export function toggleAudioMute(muted) {
    audioState.muted = muted;
    if (masterGain && ctx) {
        masterGain.gain.setTargetAtTime(muted ? 0 : audioState.masterVol, ctx.currentTime, 0.05);
    }
}

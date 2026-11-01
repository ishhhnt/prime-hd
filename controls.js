// controls.js - Game control options, settings UI, and frame rate regulator
import { playUiClick, playUiTab, setMasterVolume, setEngineVolume, setSirenVolume, toggleAudioMute, audioState } from './sound.js';

export const options = {
    fps: 60,
    showFps: false,
    gear: 'auto',
    pedal: 'hold'
};

let lastFrameTime = 0;
export function frameAllowed(now) {
    if (!options.fps || options.fps <= 0) return true;
    const interval = 1000 / options.fps;
    if (now - lastFrameTime >= interval - 1.5) {
        lastFrameTime = now;
        return true;
    }
    return false;
}

let frameCount = 0;
let lastFpsCheck = 0;
export function tickFps(now) {
    if (!options.showFps) return;
    frameCount++;
    if (now - lastFpsCheck >= 500) {
        const delta = Math.max(1, now - lastFpsCheck);
        const fps = Math.round((frameCount * 1000) / delta);
        const el = document.getElementById('fps-counter');
        if (el) el.innerText = `${fps} FPS`;
        frameCount = 0;
        lastFpsCheck = now;
    }
}

export function autoGear() {
    // Gearbox logic handled in physics.js stepCar
}

export function isLatchedPedal(prop) {
    return options.pedal === 'toggle' && (prop === 'forward' || prop === 'brake');
}

export function setupOptions() {
    // Modal Tab Switching (GRAPHICS vs AUDIO vs CONTROL)
    const tabBtns = document.querySelectorAll('.tab-btn');
    tabBtns.forEach(btn => {
        btn.onclick = () => {
            playUiTab();
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const targetId = btn.dataset.tab;
            document.querySelectorAll('.tab-panel').forEach(panel => {
                if (panel.id === targetId) {
                    panel.hidden = false;
                    panel.style.display = 'block';
                } else {
                    panel.hidden = true;
                    panel.style.display = 'none';
                }
            });
        };
    });

    // Option Chips: FPS, Gearbox, Pedal Mode
    document.querySelectorAll('.opt-chip[data-opt]').forEach(chip => {
        chip.onclick = () => {
            playUiClick();
            const opt = chip.dataset.opt;
            const val = chip.dataset.val;
            document.querySelectorAll(`.opt-chip[data-opt="${opt}"]`).forEach(c => c.classList.remove('active'));
            chip.classList.add('active');

            if (opt === 'fps') {
                options.fps = parseInt(val, 10);
            } else if (opt === 'gear') {
                options.gear = val;
            } else if (opt === 'pedal') {
                options.pedal = val;
            }
        };
    });

    // Audio Sliders & Toggles
    const masterVolSlider = document.getElementById('master-vol-slider');
    const masterVolLabel = document.getElementById('master-vol-label');
    if (masterVolSlider) {
        masterVolSlider.oninput = (e) => {
            const val = parseInt(e.target.value, 10) / 100;
            setMasterVolume(val);
            if (masterVolLabel) masterVolLabel.innerText = `${Math.round(val * 100)}%`;
        };
    }

    const engineVolSlider = document.getElementById('engine-vol-slider');
    const engineVolLabel = document.getElementById('engine-vol-label');
    if (engineVolSlider) {
        engineVolSlider.oninput = (e) => {
            const val = parseInt(e.target.value, 10) / 100;
            setEngineVolume(val);
            if (engineVolLabel) engineVolLabel.innerText = `${Math.round(val * 100)}%`;
        };
    }

    const sirenVolSlider = document.getElementById('siren-vol-slider');
    const sirenVolLabel = document.getElementById('siren-vol-label');
    if (sirenVolSlider) {
        sirenVolSlider.oninput = (e) => {
            const val = parseInt(e.target.value, 10) / 100;
            setSirenVolume(val);
            if (sirenVolLabel) sirenVolLabel.innerText = `${Math.round(val * 100)}%`;
        };
    }

    const muteToggle = document.getElementById('mute-toggle');
    if (muteToggle) {
        muteToggle.onchange = (e) => {
            playUiClick();
            toggleAudioMute(e.target.checked);
        };
    }

    // FPS Display Toggle
    const fpsToggle = document.getElementById('fps-toggle');
    if (fpsToggle) {
        fpsToggle.onchange = (e) => {
            playUiClick();
            options.showFps = e.target.checked;
            const el = document.getElementById('fps-counter');
            if (el) {
                el.style.display = options.showFps ? 'block' : 'none';
                if (!options.showFps) el.innerText = '';
            }
        };
    }
}

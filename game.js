import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'meshopt_decoder';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createCityManager, NETWORK_1, NETWORK_2 } from './city.js';
import { CAR_DEFS, SCALE, createCarState, stepCar, shift, resolveBox, carVsCar } from './physics.js';
import { createTraffic, DIRS, dirAngle, rightOf } from './traffic.js';
import { createModes, MODE_INFO } from './modes.js';
import { options, frameAllowed, tickFps, autoGear, isLatchedPedal, setupOptions } from './controls.js';
import {
    initAudio, resumeAudio, playUiClick, playUiTab, playUiSelect,
    startEngineSound, updateEngineSound, stopEngineSound,
    startSirenSound, stopSirenSound, playTireScreech, playCrashSound, playAirBrakeSound
} from './sound.js';

// Core Engine Variables
let scene, camera, renderer, car, sky, sunLight, ambientLight;
let carModels = {
    dodge: null,
    colorado: null,
    colorado_z: null,
    custom: null,
    police: null,
    truck: null
};
let npcTemplates = {
    dodge: null,
    colorado: null,
    colorado_z: null,
    custom: null,
    police: null,
    truck: null
};
let selectedCarType = 'dodge';
let activeGameMode = 'free'; // 'free' | 'police_patrol' | 'police_chase' | 'race' | 'parking' | 'delivery'
let sirenActive = false;
let policeRig = null;
let policeLightBlue = null;
let policeLightRed = null;

// Performance Settings State
let userSettings = {
    shadows: false,
    graphicsQuality: 'low'
};

let gameState = 'loading'; // 'loading' | 'lobby' | 'playing'
let moveState = { forward: false, brake: false, left: false, right: false, hand: false };
let camModes = ['chase', 'close', 'hood', 'side', 'drone'], camIdx = 0;
let orbitLat = 15, orbitLon = 180, isOrbiting = false;
let onMouseDownMouseX = 0, onMouseDownMouseY = 0, onMouseDownLon = 0, onMouseDownLat = 0;
let houses = [];
let city1Group = null;

// ─── PHYSICS STATE, TRAFFIC & GAME MODES ───
const ps = createCarState();               // the player's car (real physics)
let network = NETWORK_1;                   // road grid of the active city
let traffic = null, modes = null, cityManager = null;
let inputLocked = false;                   // countdown / result screen
let lastTime = performance.now();
let physicsAccumulator = 0;
let snapCamera = true;
let hitCooldown = 0;
const kb = { thr: 0, brk: 0 };             // smoothed pedals
// ─── VISUAL STYLE (DEFAULT / GTA V / BLACK & GRAY) ───
let visualStyle = 'default'; // 'default' | 'gta' | 'bw'
let composer = null, gradePass = null;

const GtaGradeShader = {
    uniforms: {
        tDiffuse: { value: null },
        uTime: { value: 0 },
        uContrast: { value: 1.1 },
        uSaturation: { value: 1.2 },
        uVignette: { value: 0.28 },
        uGrain: { value: 0.03 }
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float uTime;
        uniform float uContrast;
        uniform float uSaturation;
        uniform float uVignette;
        uniform float uGrain;
        varying vec2 vUv;

        float hash(vec2 p) {
            return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }

        void main() {
            vec3 c = texture2D(tDiffuse, vUv).rgb;

            // Split-tone: cool shadows, warm sunlit highlights
            float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
            c *= mix(vec3(0.92, 1.0, 1.06), vec3(1.08, 1.02, 0.9), smoothstep(0.2, 0.8, l));

            // Saturation
            float l2 = dot(c, vec3(0.2126, 0.7152, 0.0722));
            c = mix(vec3(l2), c, uSaturation);

            // Contrast around mid grey
            c = (c - 0.5) * uContrast + 0.5;

            // Vignette
            c *= 1.0 - uVignette * smoothstep(0.25, 0.75, length(vUv - 0.5));

            // Animated film grain
            c += (hash(gl_FragCoord.xy + fract(uTime) * 512.0) - 0.5) * uGrain;

            gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
        }
    `
};

// Grade presets for the GTA V and Black & Gray styles
const GRADE_PRESETS = {
    gta: { uSaturation: 1.2, uContrast: 1.1, uVignette: 0.28, uGrain: 0.03 },
    bw:  { uSaturation: 0.0, uContrast: 1.28, uVignette: 0.4, uGrain: 0.045 }
};

// Loading Tracker (6 cars + ground + 2 roads + 5 city building textures = 14 total)
let loadedModels = 0;
const totalModels = 6;
let loadedAssets = 0;
const totalAssets = 8;

let groundTexture = null;
const allSceneMaterials = [];
const shadowMeshes = [];

const targetPos = new THREE.Vector3();
const lookAtPos = new THREE.Vector3();
const camOffset = new THREE.Vector3();
const lookOffset = new THREE.Vector3();
const cameraTargetRotation = new THREE.Euler();
const FIXED_STEP = 1 / 60;
const previousCarPose = { x: 0, y: 1.5, z: 0, heading: 0, pitch: 0, roll: 0 };

function rememberCarPose() {
    previousCarPose.x = ps.x;
    previousCarPose.y = ps.y;
    previousCarPose.z = ps.z;
    previousCarPose.heading = ps.heading;
    previousCarPose.pitch = ps.pitch;
    previousCarPose.roll = ps.roll;
}

function interpolateCarPose(alpha) {
    const lerpAngle = (from, to) => {
        const delta = THREE.MathUtils.euclideanModulo(to - from + Math.PI, Math.PI * 2) - Math.PI;
        return from + delta * alpha;
    };
    car.position.set(
        THREE.MathUtils.lerp(previousCarPose.x, ps.x, alpha),
        THREE.MathUtils.lerp(previousCarPose.y, ps.y, alpha),
        THREE.MathUtils.lerp(previousCarPose.z, ps.z, alpha)
    );
    car.rotation.set(
        THREE.MathUtils.lerp(previousCarPose.pitch, ps.pitch, alpha),
        lerpAngle(previousCarPose.heading, ps.heading),
        THREE.MathUtils.lerp(previousCarPose.roll, ps.roll, alpha)
    );
}

function setLobbyView() {
    if (car) car.visible = true;
    if (camera) setLobbyBackgroundView();
}

function setLobbyBackgroundView() {
    if (car) {
        const isTruck = selectedCarType === 'truck';
        const distance = isTruck ? 46 : 27;
        camera.position.set(
            car.position.x + distance * (isTruck ? 0.6 : 0.56),
            car.position.y + distance * (isTruck ? 0.36 : 0.28),
            car.position.z + distance
        );
        camera.lookAt(car.position.x, car.position.y + (isTruck ? 4 : 1.6), car.position.z);
        camera.fov = isTruck ? 54 : 44;
    } else {
        camera.position.set(260, 190, 340);
        camera.lookAt(0, 8, 0);
        camera.fov = 60;
    }
    camera.updateProjectionMatrix();
}


function updateLoadingProgress() {
    if (gameState !== 'loading') return;
    const totalToLoad = totalAssets + totalModels;
    const totalLoaded = loadedAssets + loadedModels;
    const percentage = Math.min(100, Math.floor((totalLoaded / totalToLoad) * 100));

    const percentageEl = document.getElementById('loading-percentage');
    const barEl = document.getElementById('loading-bar');
    const statusLabel = document.getElementById('status-label');

    if (percentageEl) percentageEl.innerText = percentage + '%';
    if (barEl) barEl.style.width = percentage + '%';

    if (statusLabel) {
        if (percentage < 35) statusLabel.innerText = "BUILDING CITY DISTRICTS";
        else if (percentage < 70) statusLabel.innerText = "OPTIMIZING CAR PHYSICS";
        else if (percentage < 95) statusLabel.innerText = "SPAWNING NPC TRAFFIC";
        else statusLabel.innerText = "READY";
    }

    if (totalLoaded >= totalToLoad || percentage >= 100) {
        enterLobby();
    }
}

function enterLobby() {
    if (gameState !== 'loading') return;
    gameState = 'lobby';

    try {
        activateSelectedCar(selectedCarType);
    } catch (e) {
        console.error("Error activating car in lobby:", e);
    }

    try {
        applyCustomSettings();
    } catch (e) {
        console.error("Error applying custom settings:", e);
    }

    const loadingScreen = document.getElementById('loading-screen');
    const lobbyScreen = document.getElementById('lobby-screen');
    const lobbyBody = document.querySelector('.lobby-body');
    if (renderer) renderer.domElement.style.visibility = 'visible';
    setLobbyView();
    if (lobbyBody) lobbyBody.scrollTop = 0;
    if (lobbyScreen) {
        lobbyScreen.style.display = 'flex';
        lobbyScreen.style.opacity = '1';
    }
    if (loadingScreen) {
        loadingScreen.style.opacity = '0';
        loadingScreen.style.pointerEvents = 'none';
        setTimeout(() => {
            loadingScreen.style.display = 'none';
        }, 350);
    }

    try {
        animate();
    } catch (e) {
        console.error("Error starting animate loop:", e);
    }
}

setTimeout(() => {
    if (gameState === 'loading') {
        console.log("Loading timer fallback triggered, entering lobby...");
        enterLobby();
    }
}, 4000);

// ─── USER CUSTOM SETTINGS ───
function applyCustomSettings() {
    const highQuality = userSettings.graphicsQuality === 'high';
    userSettings.shadows = highQuality;
    renderer.setPixelRatio(highQuality ? Math.min(window.devicePixelRatio || 1, 1.8) : 1);
    if (composer) composer.setPixelRatio(renderer.getPixelRatio());

    renderer.shadowMap.enabled = highQuality;
    sunLight.castShadow = highQuality;
    scene.traverse(obj => {
        if (!obj.isMesh) return;
        obj.castShadow = highQuality;
        obj.receiveShadow = highQuality;
    });

    const maxAniso = highQuality ? Math.min(4, renderer.capabilities.getMaxAnisotropy())
        : 1;
    scene.traverse(obj => {
        if (!obj.isMesh) return;
        (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach(mat => {
            if (!mat || !mat.map) return;
            mat.map.anisotropy = maxAniso;
            mat.map.minFilter = highQuality ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
            mat.map.needsUpdate = true;
        });
    });
}

function init() {
    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0xd8e2ec, 0.00035);

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 4500);

    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(1);
    renderer.shadowMap.enabled = userSettings.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.id = 'game-canvas';
    document.body.appendChild(renderer.domElement);
    // Golden-Hour Daytime Sky
    sky = new Sky();
    sky.scale.setScalar(450000);
    scene.add(sky);

    const skyUniforms = sky.material.uniforms;
    skyUniforms['turbidity'].value = 3.5;
    skyUniforms['rayleigh'].value = 1.4;
    skyUniforms['mieCoefficient'].value = 0.005;
    skyUniforms['mieDirectionalG'].value = 0.8;
    const sunVec = new THREE.Vector3();
    sunVec.setFromSphericalCoords(1, THREE.MathUtils.degToRad(80), THREE.MathUtils.degToRad(165));
    skyUniforms['sunPosition'].value.copy(sunVec);

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(scene).texture;

    // Floor
    const floorGeo = new THREE.PlaneGeometry(12000, 12000);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x18191c, roughness: 0.4, metalness: 0.2 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    allSceneMaterials.push(floorMat);
    shadowMeshes.push(floor);

    // Sunlight
    sunLight = new THREE.DirectionalLight(0xfff4e8, 3.4);
    sunLight.position.set(120, 220, 140);
    sunLight.castShadow = userSettings.shadows;
    sunLight.shadow.mapSize.set(1024, 1024);
    sunLight.shadow.camera.near = 0.5;
    sunLight.shadow.camera.far = 550;
    sunLight.shadow.camera.left = -180;
    sunLight.shadow.camera.right = 180;
    sunLight.shadow.camera.top = 180;
    sunLight.shadow.camera.bottom = -180;
    sunLight.shadow.bias = -0.0005;
    scene.add(sunLight);

    ambientLight = new THREE.AmbientLight(0xdce8ff, 0.95);
    scene.add(ambientLight);

    const texLoader = new THREE.TextureLoader();

    // Ground texture
    groundTexture = texLoader.load('ground/ground.png', (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(2, 2);
        loadedAssets++;
        updateLoadingProgress();
    }, undefined, () => { loadedAssets++; updateLoadingProgress(); });

    // ─── CAR OPTIMIZER (Supports standard, Draco, and Meshopt compressed models) ───
    function optimizeAndScaleCar(gltfScene, targetLength = 11.0, isNPC = false, carKey = '') {
        const root = new THREE.Group();

        gltfScene.traverse(node => {
            if (node.isMesh) {
                if (isNPC) {
                    node.material = new THREE.MeshLambertMaterial({
                        color: node.material.color || 0xffffff,
                        wireframe: false
                    });
                } else if (node.material) {
                    const mats = Array.isArray(node.material) ? node.material : [node.material];
                    mats.forEach(mat => {
                        if (!mat) return;
                        mat.envMapIntensity = 2.0;
                        mat.roughness = Math.max(0.18, mat.roughness || 0.35);
                        mat.metalness = Math.min(0.85, mat.metalness || 0.6);
                        mat.needsUpdate = true;
                    });
                }
                node.castShadow = userSettings.shadows && !isNPC;
                node.receiveShadow = userSettings.shadows && !isNPC;
            }
        });

        // Compute natural bounds (all 6 models have length along Z, height along Y, width along X)
        const box = new THREE.Box3().setFromObject(gltfScene);
        const size = new THREE.Vector3();
        box.getSize(size);
        const center = new THREE.Vector3();
        box.getCenter(center);

        // Normalize scale along largest horizontal dimension (Z = length)
        const lengthDim = Math.max(size.z, size.x) || 1;
        const scaleFactor = targetLength / lengthDim;
        gltfScene.scale.setScalar(scaleFactor);

        // Center on X & Z, place lowest point of wheels on ground (Y = 0)
        gltfScene.position.x = -center.x * scaleFactor;
        gltfScene.position.z = -center.z * scaleFactor;
        gltfScene.position.y = -box.min.y * scaleFactor;

        root.add(gltfScene);
        return root;
    }

    const loader = new GLTFLoader();

    // 1. DRACOLoader for Draco compressed models (police_car_suv.glb) with local wasm decoders
    try {
        const dracoLoader = new DRACOLoader();
        dracoLoader.setDecoderPath('libs/draco/');
        loader.setDRACOLoader(dracoLoader);
    } catch (e) {
        console.warn('Draco setup warning:', e);
    }

    // ─── LOAD ALL 6 VEHICLES (DODGE, COLORADO, COLORADO Z71, GT SUPERCAR, POLICE SUV, FREIGHT TRUCK) ───
    const carLoadDefs = [
        { key: 'dodge', path: 'assets/dodge_challegner_srt_hellcat.glb', len: 11.0, color: 0xff2a5f },
        { key: 'colorado', path: 'assets/car1.glb', fallbackPath: 'assets/car.glb', len: 11.4, color: 0x3366cc },
        { key: 'colorado_z', path: 'assets/car2.glb', len: 11.4, color: 0xe07a1f },
        { key: 'custom', path: 'assets/car.glb', len: 11.0, color: 0x3a7bd5 },
        { key: 'police', path: 'assets/police_car_suv.glb', fallbackPath: 'assets/police_car_suv (1).glb', len: 11.2, color: 0x222222 },
        { key: 'truck', path: 'assets/truck.glb', len: 32.0, color: 0xd44030 }
    ];

    const initMeshoptAndLoad = async () => {
        try {
            if (MeshoptDecoder && MeshoptDecoder.ready) {
                await MeshoptDecoder.ready;
            }
            loader.setMeshoptDecoder(MeshoptDecoder);
        } catch (e) {
            console.warn('Meshopt setup warning:', e);
        }

        carLoadDefs.forEach(def => {
            const tryLoad = (url, isFallback = false) => {
                loader.load(url, (gltf) => {
                    const carGroup = optimizeAndScaleCar(gltf.scene, def.len, false, def.key);
                    carModels[def.key] = carGroup;
                    npcTemplates[def.key] = carGroup.clone();
                    loadedModels++;
                    if (selectedCarType === def.key) activateSelectedCar(def.key);
                    updateLoadingProgress();
                }, undefined, (err) => {
                    if (!isFallback && def.fallbackPath) {
                        tryLoad(def.fallbackPath, true);
                        return;
                    }
                    console.warn(`Fallback proxy for ${def.key} due to load error:`, err);
                    const isTrk = (def.key === 'truck');
                    const fallback = new THREE.Mesh(
                        new THREE.BoxGeometry(isTrk ? 8.0 : 4.8, isTrk ? 9.5 : 2.4, def.len),
                        new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.35, metalness: 0.5 })
                    );
                    carModels[def.key] = fallback;
                    npcTemplates[def.key] = fallback.clone();
                    loadedModels++;
                    if (selectedCarType === def.key) activateSelectedCar(def.key);
                    updateLoadingProgress();
                });
            };
            tryLoad(def.path);
        });
    };

    initMeshoptAndLoad();

    createRoadAndCitySystem();
    setupControls();
    setupLobbyAndUI();
    setupVisualStyleUI();
    setupOptions();
    setupGameSystems();
    activateSelectedCar('dodge');
    window.addEventListener('resize', onWindowResize, false);
}

function activateSelectedCar(type) {
    if (car) scene.remove(car);
    selectedCarType = type;
    ps.isTruck = (type === 'truck');
    const targetModel = carModels[type];

    if (targetModel) {
        car = targetModel;
    } else {
        const def = CAR_DEFS[type] || CAR_DEFS.dodge;
        const colorMap = {
            dodge: 0xff2a5f,
            colorado: 0x3366cc,
            colorado_z: 0xe07a1f,
            custom: 0x3a7bd5,
            police: 0x222222,
            truck: 0xd44030
        };
        const isTrk = (type === 'truck');
        const placeholder = new THREE.Mesh(
            new THREE.BoxGeometry(isTrk ? 7.5 : 4.8, isTrk ? 9.5 : 2.4, def.targetLength || 11.0),
            new THREE.MeshStandardMaterial({ color: colorMap[type] || 0xffffff, roughness: 0.35, metalness: 0.5 })
        );
        placeholder.castShadow = userSettings.shadows;
        car = placeholder;
    }

    if (car) {
        car.visible = true;
        car.rotation.order = 'YXZ';
        syncCar();
        scene.add(car);

        // Police emergency roof strobe lightbar
        if (type === 'police') {
            if (!policeRig) {
                policeRig = new THREE.Group();
                policeLightBlue = new THREE.PointLight(0x0066ff, 0, 40);
                policeLightBlue.position.set(-0.85, 3.4, 0.4);
                policeRig.add(policeLightBlue);

                policeLightRed = new THREE.PointLight(0xff0033, 0, 40);
                policeLightRed.position.set(0.85, 3.4, 0.4);
                policeRig.add(policeLightRed);

                const blueLens = new THREE.Mesh(
                    new THREE.BoxGeometry(0.55, 0.25, 0.45),
                    new THREE.MeshBasicMaterial({ color: 0x0077ff })
                );
                blueLens.position.set(-0.85, 3.4, 0.4);
                policeRig.add(blueLens);

                const redLens = new THREE.Mesh(
                    new THREE.BoxGeometry(0.55, 0.25, 0.45),
                    new THREE.MeshBasicMaterial({ color: 0xff1133 })
                );
                redLens.position.set(0.85, 3.4, 0.4);
                policeRig.add(redLens);
            }
            car.add(policeRig);
        } else if (policeRig && policeRig.parent) {
            policeRig.parent.remove(policeRig);
        }
    }
    if (gameState === 'lobby') setLobbyBackgroundView();
    // Toggle siren HUD button visibility for police vehicle
    const isPolice = (selectedCarType === 'police' || activeGameMode === 'police_patrol');
    const sirenBtn = document.getElementById('siren-btn');
    const sirenTouchBtn = document.getElementById('siren-touch-btn');
    if (sirenBtn) sirenBtn.style.display = isPolice ? 'inline-block' : 'none';
    if (sirenTouchBtn) sirenTouchBtn.style.display = isPolice ? 'flex' : 'none';
}

function toggleSiren() {
    const isPolice = (selectedCarType === 'police' || activeGameMode === 'police_patrol');
    if (!isPolice) return; // Strictly restricted to police vehicle!

    sirenActive = !sirenActive;
    if (sirenActive) {
        startSirenSound('police');
    } else {
        stopSirenSound();
    }
    const sirenBtn = document.getElementById('siren-btn');
    const sirenTouchBtn = document.getElementById('siren-touch-btn');
    if (sirenBtn) sirenBtn.classList.toggle('active', sirenActive);
    if (sirenTouchBtn) sirenTouchBtn.classList.toggle('active', sirenActive);
}


function setupGameSystems() {
    traffic = createTraffic(scene);
    traffic.setNetwork(network);
    traffic.setCarFactory(makeNpcCar);

    modes = createModes({
        scene, traffic, ps,
        getNet: () => network,
        makeCar: makeNpcCar,
        placePlayer,
        lockPlayer: (v) => { inputLocked = v; },
        exitToGarage
    });

    cityManager = createCityManager({
        scene, renderer, shadowMeshes, houses, groundTexture, city1Group,
        getShadows: () => userSettings.shadows,
        onCityChange: (net) => {
            network = net;
            traffic.setNetwork(net);
            traffic.setElevationGetter(null);
            traffic.reset(ps.x, ps.z);
            placePlayer(0, 0, 0);
            applyCustomSettings();
        }
    });
}

function syncCar() {
    if (!car || !ps) return;
    let groundY = 1.5;
    let slopePitch = 0;
    let slopeRoll = 0;

    ps.y = groundY;
    car.position.set(ps.x, groundY, ps.z);
    car.rotation.set(ps.pitch + slopePitch, ps.heading, ps.roll + slopeRoll);
}

function placePlayer(x, z, heading) {
    const groundY = 1.5;
    Object.assign(ps, { x, y: groundY, z, heading, vf: 0, vr: 0, yaw: 0, steer: 0, gear: 1, rpm: 850, shiftT: 0, pitch: 0, roll: 0, wheelspin: false, sliding: false });
    kb.thr = 0; kb.brk = 0;
    rememberCarPose();
    snapCamera = true;
    syncCar();
}

function exitToGarage() {
    modes.stop();
    stopEngineSound();
    stopSirenSound();
    sirenActive = false;
    const sirenBtn = document.getElementById('siren-btn');
    const sirenTouchBtn = document.getElementById('siren-touch-btn');
    if (sirenBtn) sirenBtn.classList.remove('active');
    if (sirenTouchBtn) sirenTouchBtn.classList.remove('active');
    inputLocked = false;
    placePlayer(0, 0, 0);
    document.getElementById('game-hud').style.display = 'none';
    document.getElementById('lobby-screen').style.display = 'flex';
    renderer.domElement.style.visibility = 'visible';
    setLobbyView();
    const lobbyBody = document.querySelector('.lobby-body');
    if (lobbyBody) lobbyBody.scrollTop = 0;
    gameState = 'lobby';
}

// Put the car back on the nearest road lane, facing along the road
function resetCar() {
    if (inputLocked) return;
    const { pitch, N, lane, extent } = network;
    const lx = Math.max(-N, Math.min(N, Math.round(ps.x / pitch))) * pitch;
    const lz = Math.max(-N, Math.min(N, Math.round(ps.z / pitch))) * pitch;
    const clamp = (v) => Math.max(-extent + 10, Math.min(extent - 10, v));
    if (Math.abs(ps.x - lx) <= Math.abs(ps.z - lz)) {
        const d = Math.cos(ps.heading) >= 0 ? 0 : 2, R = rightOf(d);
        placePlayer(lx + R[0] * lane, clamp(ps.z), dirAngle(d));
    } else {
        const d = Math.sin(ps.heading) >= 0 ? 1 : 3, R = rightOf(d);
        placePlayer(clamp(ps.x), lz + R[1] * lane, dirAngle(d));
    }
}

// Traffic uses the requested GLB templates, already normalized by the vehicle loader.
function makeNpcCar(i) {
    const type = Math.abs(i) % 3;
    const templateKey = type === 0 ? 'custom' : type === 1 ? 'police' : 'truck';
    const template = npcTemplates[templateKey] || carModels[templateKey];
    const npc = template ? template.clone(true) : new THREE.Group();
    npc.userData.isTruck = templateKey === 'truck';
    return npc;
}

// ─── CITY 1: 50x50 MAP WITH 15x15 MODERN SLICED-FACADE DOWNTOWN ───
function createRoadAndCitySystem() {
    city1Group = new THREE.Group();
    scene.add(city1Group);

    const textureLoader = new THREE.TextureLoader();
    const roadWidth = 48;
    const blockSize = 150;
    const gridSize = 4; // 4x4 surrounding grid
    const roadHeight = 1.5;

    const verticalTexture = textureLoader.load('road/1.png', (tex) => {
        tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        loadedAssets++; updateLoadingProgress();
    }, undefined, () => { loadedAssets++; updateLoadingProgress(); });

    const horizontalTexture = textureLoader.load('road/2.png', (tex) => {
        tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        loadedAssets++; updateLoadingProgress();
    }, undefined, () => { loadedAssets++; updateLoadingProgress(); });

    const roadLength = blockSize * gridSize * 2;
    horizontalTexture.repeat.set(roadLength / 38, 1);
    const hRoadGeo = new THREE.PlaneGeometry(roadLength, roadWidth);
    const hRoadMat = new THREE.MeshStandardMaterial({ map: horizontalTexture, roughness: 0.85, metalness: 0.08 });
    allSceneMaterials.push(hRoadMat);

    for (let i = -gridSize; i <= gridSize; i++) {
        const road = new THREE.Mesh(hRoadGeo, hRoadMat);
        road.rotation.x = -Math.PI / 2;
        road.position.set(0, roadHeight, i * blockSize);
        road.receiveShadow = userSettings.shadows;
        city1Group.add(road);
        shadowMeshes.push(road);
    }

    const segmentLength = blockSize - roadWidth;
    verticalTexture.repeat.set(1, segmentLength / 38);
    const vRoadGeo = new THREE.PlaneGeometry(roadWidth, segmentLength);
    const vRoadMat = new THREE.MeshStandardMaterial({ map: verticalTexture, roughness: 0.85, metalness: 0.08 });
    allSceneMaterials.push(vRoadMat);

    for (let i = -gridSize; i <= gridSize; i++) {
        for (let j = -gridSize; j < gridSize; j++) {
            const road = new THREE.Mesh(vRoadGeo, vRoadMat);
            road.rotation.x = -Math.PI / 2;
            road.position.set(i * blockSize, roadHeight, j * blockSize + blockSize / 2);
            road.receiveShadow = userSettings.shadows;
            city1Group.add(road);
            shadowMeshes.push(road);
        }
    }

    addCityBuildings(blockSize, gridSize, roadWidth);
}

// ─── BUILDING GENERATION WITH TRI-FACADE SLICING ───
function addCityBuildings(blockSize, gridSize, roadWidth) {
    const textureLoader = new THREE.TextureLoader();
    const existingTextures = [];
    let texturesLoaded = 0;

    // Helper: Slices an image into 3 individual column textures [Left 1/3, Center 1/3, Right 1/3]
    function createSlicedColumnTexture(baseTexture, columnIndex) {
        const tex = baseTexture.clone();
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(1 / 3, 1);
        tex.offset.set(columnIndex * (1 / 3), 0);
        tex.needsUpdate = true;
        return tex;
    }

    const modernSlicedMats = [];

    // Load original b/1..5 textures
    for (let i = 1; i <= 5; i++) {
        textureLoader.load('b/' + i + '.png', (t) => {
            t.colorSpace = THREE.SRGBColorSpace;
            existingTextures.push(t);
            if (i === 5) {
                // Sliced modern facades from b/5.png
                for (let col = 0; col < 3; col++) {
                    const colTex = createSlicedColumnTexture(t, col);
                    modernSlicedMats.push(new THREE.MeshStandardMaterial({ map: colTex, roughness: 0.45, metalness: 0.15 }));
                }
            }
            loadedAssets++; texturesLoaded++; updateLoadingProgress();
            if (texturesLoaded === 5) buildCity();
        }, undefined, () => {
            loadedAssets++; texturesLoaded++; updateLoadingProgress();
            if (texturesLoaded === 5) buildCity();
        });
    }

    function buildCity() {
        const buildingWidth = 75, buildingDepth = 75, buildingHeight = 48;
        const plotSize = blockSize - roadWidth - 2;

        const sharedGroundGeo = new THREE.PlaneGeometry(plotSize, plotSize);
        const sharedGroundMat = new THREE.MeshStandardMaterial({ map: groundTexture, roughness: 0.9, metalness: 0.05 });
        const sharedBuildingGeo = new THREE.BoxGeometry(buildingWidth, buildingHeight, buildingDepth);
        const roofMat = new THREE.MeshStandardMaterial({ color: 0x282a30, roughness: 0.7 });
        const bottomMat = new THREE.MeshStandardMaterial({ color: 0x151515 });

        const standardMats = existingTextures.map(t => new THREE.MeshStandardMaterial({ map: t, roughness: 0.55, metalness: 0.15 }));
        const fallbackMat = new THREE.MeshStandardMaterial({ color: 0x555566 });

        for (let i = -gridSize; i < gridSize; i++) {
            for (let j = -gridSize; j < gridSize; j++) {
                const x = i * blockSize + blockSize / 2;
                const z = j * blockSize + blockSize / 2;

                // Dedicated Ground Plot
                const groundMesh = new THREE.Mesh(sharedGroundGeo, sharedGroundMat);
                groundMesh.rotation.x = -Math.PI / 2;
                groundMesh.position.set(x, 1.51, z);
                groundMesh.receiveShadow = userSettings.shadows;
                city1Group.add(groundMesh);
                shadowMeshes.push(groundMesh);

                if (Math.random() > 0.7) continue;

                // Center Core: Modern Tri-Facade Sliced Towers
                const isModernDistrict = (Math.abs(i) <= 1 && Math.abs(j) <= 1 && modernSlicedMats.length >= 3);

                let materials;
                let bHeight = buildingHeight;
                let buildingMesh;

                if (isModernDistrict) {
                    bHeight = buildingHeight * 1.4; // Taller skyline
                    const colA = modernSlicedMats[Math.floor(Math.random() * modernSlicedMats.length)];
                    const colB = modernSlicedMats[Math.floor(Math.random() * modernSlicedMats.length)];
                    materials = [colA, colB, roofMat, bottomMat, colA, colB];
                    buildingMesh = new THREE.Mesh(new THREE.BoxGeometry(buildingWidth, bHeight, buildingDepth), materials);
                } else {
                    const getMat = () => standardMats.length > 0 ? standardMats[Math.floor(Math.random() * standardMats.length)] : fallbackMat;
                    materials = [getMat(), getMat(), roofMat, bottomMat, getMat(), getMat()];
                    buildingMesh = new THREE.Mesh(sharedBuildingGeo, materials);
                }

                buildingMesh.position.set(x, bHeight / 2 + 1.5, z);
                buildingMesh.userData.width = buildingWidth;
                buildingMesh.userData.depth = buildingDepth;
                buildingMesh.userData.isBuilding = true;
                buildingMesh.castShadow = userSettings.shadows;
                buildingMesh.receiveShadow = userSettings.shadows;
                city1Group.add(buildingMesh);
                houses.push(buildingMesh);
                shadowMeshes.push(buildingMesh);
            }
        }

        if (cityManager && typeof cityManager.registerCity1Houses === 'function') {
            cityManager.registerCity1Houses(houses);
        }
    }
}


// ─── LOBBY UI ───
function setupLobbyAndUI() {
    const startBtn = document.getElementById('start-drive-btn');
    const returnLobbyBtn = document.getElementById('lobby-return-btn');

    function selectCar(type) {
            if (type === selectedCarType) return;
            playUiTab();
        selectedCarType = type;
        document.querySelectorAll('.car-slot').forEach(slot => {
            slot.classList.toggle('selected', slot.dataset.car === type);
        });

        const def = CAR_DEFS[type] || CAR_DEFS.dodge;
        const badgeEl = document.getElementById('lobby-car-badge');
        const titleEl = document.getElementById('lobby-car-title');
        const subEl = document.getElementById('lobby-car-sub');

        if (badgeEl) badgeEl.innerText = def.badge;
        if (titleEl) titleEl.innerText = def.name;
        if (subEl) subEl.innerText = def.subtitle;

        const setSpec = (id, val) => {
            const bar = document.getElementById(`spec-${id}`);
            const label = document.getElementById(`spec-val-${id}`);
            if (bar) bar.style.width = `${val}%`;
            if (label) label.innerText = `${val}%`;
        };

        if (def.stats) {
            setSpec('speed', def.stats.speed);
            setSpec('accel', def.stats.accel);
            setSpec('handling', def.stats.handling);
            setSpec('braking', def.stats.braking);
            setSpec('armor', def.stats.armor);
        }

        activateSelectedCar(type);
    }

    document.querySelectorAll('.car-slot[data-car]').forEach(slot => {
        slot.onclick = () => selectCar(slot.dataset.car);
    });

    // Game mode rows
    const showMode = (id) => {
        const info = MODE_INFO[id] || MODE_INFO.free;
        const titleEl = document.getElementById('mode-info-title');
        const textEl = document.getElementById('mode-info-text');
        if (titleEl) titleEl.innerText = info.name;
        if (textEl) textEl.innerText = info.text;
    };
    document.querySelectorAll('.mode-row').forEach(row => {
        row.onclick = () => {
            playUiClick();
            document.querySelectorAll('.mode-row').forEach(r => r.classList.remove('active'));
            row.classList.add('active');
            activeGameMode = row.dataset.mode;
            showMode(activeGameMode);

            // Auto-switch to police interceptor if player chooses police pursuit
            if (activeGameMode === 'police_patrol' && selectedCarType !== 'police') {
                selectCar('police');
            }
        };
    });
    showMode(activeGameMode);

    // Settings modal
    const settingsModal = document.getElementById('settings-modal');
    const openSettings = () => { playUiClick(); settingsModal.style.display = 'flex'; };
    const closeSettings = () => { playUiClick(); settingsModal.style.display = 'none'; };
    document.getElementById('open-settings-btn').onclick = openSettings;
    document.getElementById('ingame-settings-btn').onclick = openSettings;
    document.getElementById('close-settings-btn').onclick = closeSettings;

    document.querySelectorAll('.q-btn').forEach(btn => {
        btn.onclick = () => {
            playUiClick();
            document.querySelectorAll('.q-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            userSettings.graphicsQuality = btn.dataset.quality;
            applyCustomSettings();
        };
    });
    document.getElementById('apply-settings-btn').onclick = () => {
        playUiSelect();
        applyCustomSettings();
        closeSettings();
    };

    // Start Drive
    startBtn.onclick = () => {
        resumeAudio();
        playUiSelect();
        if (cityManager && cityManager.isBusy()) return;      // city still building
        document.getElementById('lobby-screen').style.display = 'none';
        document.getElementById('game-hud').style.display = 'block';
        renderer.domElement.style.visibility = 'visible';
        gameState = 'playing';
        if (car) car.visible = true;
        snapCamera = true;
        lastTime = performance.now();
        physicsAccumulator = 0;
        startEngineSound();
        modes.start(activeGameMode);

        const isPolice = (selectedCarType === 'police' || activeGameMode === 'police_patrol');
        const sirenBtn = document.getElementById('siren-btn');
        const sirenTouchBtn = document.getElementById('siren-touch-btn');
        if (sirenBtn) sirenBtn.style.display = isPolice ? 'inline-block' : 'none';
        if (sirenTouchBtn) sirenTouchBtn.style.display = isPolice ? 'flex' : 'none';
    };

    returnLobbyBtn.onclick = exitToGarage;
    document.getElementById('reset-btn').onclick = resetCar;

    // Siren buttons in HUD
    const sirenBtn = document.getElementById('siren-btn');
    const sirenTouchBtn = document.getElementById('siren-touch-btn');
    if (sirenBtn) sirenBtn.onclick = toggleSiren;
    if (sirenTouchBtn) sirenTouchBtn.onclick = toggleSiren;
}

// ─── COLLISIONS (buildings + cars) ───
function collide() {
    let impact = 0;
    const boundaryCheck = ps.isTruck ? 15 : 9;
    for (const b of houses) {
        if (!b.userData.isBuilding) continue;
        const hw = b.userData.width / 2, hd = b.userData.depth / 2;
        if (Math.abs(ps.x - b.position.x) > hw + boundaryCheck || Math.abs(ps.z - b.position.z) > hd + boundaryCheck) continue;
        impact = Math.max(impact, resolveBox(ps, b.position.x, b.position.z, hw, hd));
    }
    const maxRange = ps.isTruck ? 28 : 18;
    traffic.forEachOther(o => {
        if (Math.abs(o.x - ps.x) > maxRange || Math.abs(o.z - ps.z) > maxRange) return;
        const playerWeightShare = o.static ? 1 : (ps.isTruck ? 0.25 : (o.isTruck ? 0.75 : 0.6));
        const r = carVsCar(ps, o.x, o.z, o.heading, playerWeightShare, o.isTruck);
        if (!r) return;
        impact = Math.max(impact, r.impact);
        if (!o.static) {
            const pushShare = ps.isTruck ? 0.75 : (o.isTruck ? 0.25 : 0.4);
            o.x -= r.nx * r.pen * pushShare; o.z -= r.nz * r.pen * pushShare;
            if (r.impact > 1) { o.speed *= o.ai ? 0.7 : 0.3; if (!o.ai) o.hold = 2.5; }
        }
    });
    if (impact > 2 && hitCooldown <= 0) {
        hitCooldown = 0.8;
        playCrashSound(impact);
        modes.onHit(impact);
    }
}

// ─── DRIVING ───
function updateDriving(dt) {
    const def = CAR_DEFS[selectedCarType] || CAR_DEFS.dodge;
    kb.thr += ((moveState.forward ? 1 : 0) - kb.thr) * Math.min(1, dt * 9);
    kb.brk += ((moveState.brake ? 1 : 0) - kb.brk) * Math.min(1, dt * 12);
    if (!moveState.forward && kb.thr < 0.02) kb.thr = 0;
    if (!moveState.brake && kb.brk < 0.02) kb.brk = 0;

    const inp = inputLocked
        ? { throttle: 0, brake: 1, steer: 0, hand: true, manual: false }
        : { throttle: kb.thr, brake: kb.brk, steer: (moveState.left ? 1 : 0) - (moveState.right ? 1 : 0), hand: moveState.hand, manual: options.gear === 'manual' };

    hitCooldown = Math.max(0, hitCooldown - dt);
    const steps = 2;
    for (let i = 0; i < steps; i++) { stepCar(ps, inp, def, dt / steps); collide(); }
    syncCar();

    // Procedural Audio Engine (Distinct profiles per vehicle)
    updateEngineSound(ps.rpm, def.redline, kb.thr, Math.abs(ps.vf * 3.6), selectedCarType);
    if (selectedCarType === 'truck' && (kb.brk > 0.4 || moveState.hand) && Math.abs(ps.vf) > 1.2) {
        playAirBrakeSound();
    }
    if (ps.sliding && Math.abs(ps.vr) > 2.0) {
        playTireScreech(Math.min(1, Math.abs(ps.vr) / 8));
    }
}

function setupControls() {
    const set = (id, prop) => {
        const el = document.getElementById(id);
        const activate = (e) => {
            if (e.type === 'touchstart' && window.PointerEvent) return; // pointer events already cover touch
            e.preventDefault(); e.stopPropagation();
            moveState[prop] = isLatchedPedal(prop) ? !moveState[prop] : true;
            el.classList.toggle('latched', isLatchedPedal(prop) && moveState[prop]);
            isOrbiting = false;
        };
        const deactivate = () => { if (!isLatchedPedal(prop)) moveState[prop] = false; };
        el.addEventListener('pointerdown', activate);
        el.addEventListener('touchstart', activate, { passive: false });
        el.addEventListener('pointerup', deactivate);
        el.addEventListener('touchend', deactivate);
        el.addEventListener('pointerleave', deactivate);
    };
    set('left', 'left'); set('right', 'right'); set('gas', 'forward'); set('brake', 'brake'); set('hand', 'hand');

    const cycleCam = () => {
        camIdx = (camIdx + 1) % camModes.length;
        document.getElementById('cam-toggle').innerText = "CAM: " + camModes[camIdx].toUpperCase();
        snapCamera = true;
    };
    const manualShift = (dir) => { if (options.gear === 'manual') shift(ps, dir); };

    window.addEventListener('keydown', (e) => {
        if (gameState !== 'playing') return;
        switch (e.key.toLowerCase()) {
            case 'w': case 'arrowup': moveState.forward = true; break;
            case 's': case 'arrowdown': moveState.brake = true; break;
            case 'a': case 'arrowleft': moveState.left = true; break;
            case 'd': case 'arrowright': moveState.right = true; break;
            case ' ': moveState.hand = true; e.preventDefault(); break;
            case 'e': manualShift(1); break;
            case 'q': manualShift(-1); break;
            case 'r': resetCar(); break;
            case 'c': cycleCam(); break;
            case 'h': toggleSiren(); break;
        }
    });
    window.addEventListener('keyup', (e) => {
        switch (e.key.toLowerCase()) {
            case 'w': case 'arrowup': moveState.forward = false; break;
            case 's': case 'arrowdown': moveState.brake = false; break;
            case 'a': case 'arrowleft': moveState.left = false; break;
            case 'd': case 'arrowright': moveState.right = false; break;
            case ' ': moveState.hand = false; break;
        }
    });

    // Resume AudioContext on first user interaction to comply with browser autoplay policy
    window.addEventListener('pointerdown', () => resumeAudio(), { once: true });
    window.addEventListener('keydown', () => resumeAudio(), { once: true });
    window.addEventListener('touchstart', () => resumeAudio(), { once: true });

    document.getElementById('gear-up').onclick = () => manualShift(1);
    document.getElementById('gear-down').onclick = () => manualShift(-1);
    document.getElementById('cam-toggle').onclick = cycleCam;

    const startOrbit = (e) => {
        if (gameState === 'playing' && !e.target.classList.contains('btn') && !e.target.classList.contains('ui-btn')) {
            isOrbiting = true;
            onMouseDownMouseX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
            onMouseDownMouseY = e.clientY || (e.touches && e.touches[0].clientY) || 0;
            onMouseDownLon = orbitLon; onMouseDownLat = orbitLat;
        }
    };
    const moveOrbit = (e) => {
        if (isOrbiting) {
            const clientX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
            const clientY = e.clientY || (e.touches && e.touches[0].clientY) || 0;
            orbitLon = (onMouseDownMouseX - clientX) * 0.3 + onMouseDownLon;
            orbitLat = (clientY - onMouseDownMouseY) * 0.3 + onMouseDownLat;
            orbitLat = Math.max(5, Math.min(75, orbitLat));
        }
    };
    const endOrbit = () => isOrbiting = false;
    window.addEventListener('pointerdown', startOrbit);
    window.addEventListener('touchstart', startOrbit);
    window.addEventListener('pointermove', moveOrbit);
    window.addEventListener('touchmove', moveOrbit);
    window.addEventListener('pointerup', endOrbit);
    window.addEventListener('touchend', endOrbit);
}

// ─── GTA V HUD: CIRCULAR SPEEDOMETER, RECTANGULAR RADAR, HEALTH & ARMOR ───
const hudCache = {};
function setHtml(id, html) {
    if (hudCache[id] === html) return;
    hudCache[id] = html;
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
}

let miniCanvas = null, miniCtx = null, miniFrame = 0;
let speedoCanvas = null, speedoCtx = null;

function drawSpeedometer(kmh, rpmPct) {
    if (!speedoCanvas) {
        speedoCanvas = document.getElementById('speedo-canvas');
        if (!speedoCanvas) return;
        speedoCtx = speedoCanvas.getContext('2d');
    }
    const c = speedoCtx;
    const cx = 90, cy = 90, r = 78;

    c.clearRect(0, 0, 180, 180);
    c.save();

    // Dark glass circular pod
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fillStyle = 'rgba(12, 16, 26, 0.85)';
    c.fill();

    // Outer subtle cyan glowing rim
    c.strokeStyle = 'rgba(0, 229, 255, 0.25)';
    c.lineWidth = 1.5;
    c.stroke();

    // Sequential Shift-Light LED dots along top curve (for authentic racing feel)
    const clampedRpm = Math.max(0, Math.min(100, rpmPct));
    for (let i = 0; i < 5; i++) {
        const angle = (-0.5 + (i - 2) * 0.12) * Math.PI;
        const x = cx + Math.cos(angle) * (r - 8);
        const y = cy + Math.sin(angle) * (r - 8);
        const threshold = 55 + i * 9;
        const active = clampedRpm >= threshold;
        let color = i < 2 ? '#00e5ff' : i < 4 ? '#ffb703' : '#ff3838';
        if (!active) color = 'rgba(255, 255, 255, 0.12)';

        c.beginPath();
        c.arc(x, y, 3, 0, Math.PI * 2);
        c.fillStyle = color;
        if (active) {
            c.shadowColor = color;
            c.shadowBlur = 6;
        } else {
            c.shadowBlur = 0;
        }
        c.fill();
    }
    c.shadowBlur = 0;

    // Inactive RPM track (270° sweep)
    c.beginPath();
    c.arc(cx, cy, r - 14, 0.75 * Math.PI, 2.25 * Math.PI);
    c.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    c.lineWidth = 5;
    c.stroke();

    // Dynamic Active RPM Arc with gradient color transition
    if (clampedRpm > 0.5) {
        const endAngle = 0.75 * Math.PI + (clampedRpm / 100) * 1.5 * Math.PI;
        c.beginPath();
        c.arc(cx, cy, r - 14, 0.75 * Math.PI, endAngle);

        if (clampedRpm > 90) {
            c.strokeStyle = '#ff3838';
            c.shadowColor = '#ff3838';
            c.shadowBlur = 10;
        } else if (clampedRpm > 75) {
            c.strokeStyle = '#ffb703';
            c.shadowColor = '#ffb703';
            c.shadowBlur = 8;
        } else {
            c.strokeStyle = '#00e5ff';
            c.shadowColor = '#00e5ff';
            c.shadowBlur = 8;
        }
        c.lineWidth = 5;
        c.lineCap = 'round';
        c.stroke();
    }
    c.restore();
}

function drawMinimap() {
    if (!miniCanvas) {
        miniCanvas = document.getElementById('minimap');
        if (!miniCanvas) return;
        miniCtx = miniCanvas.getContext('2d');
    }
    const W = miniCanvas.width, H = miniCanvas.height, c = miniCtx;
    const halfX = W / 2, halfY = H / 2;
    const k = 0.14;
    const cs = Math.cos(ps.heading), sn = Math.sin(ps.heading);
    const toMap = (x, z) => {
        const dx = x - ps.x, dz = z - ps.z;
        return [halfX + (-dx * cs + dz * sn) * k, halfY - (dx * sn + dz * cs) * k];
    };

    c.clearRect(0, 0, W, H);
    c.save();

    const mapRadius = Math.min(halfX, halfY) - 2;
    c.beginPath();
    c.arc(halfX, halfY, mapRadius, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = 'rgba(9, 13, 18, 0.72)';
    c.fillRect(0, 0, W, H);

    // Clean GTA V styled roads (Dark background with light slate road corridors)
    const { pitch, N, roadWidth, extent } = network;
    const R = Math.max(halfX, halfY) / k + pitch;

    // Road outer stroke / kerb
    c.strokeStyle = 'rgba(172, 190, 207, 0.16)';
    c.lineWidth = Math.max(3, roadWidth * k + 1);
    c.lineCap = 'butt';
    c.beginPath();
    for (let i = Math.max(-N, Math.floor((ps.x - R) / pitch)); i <= Math.min(N, Math.ceil((ps.x + R) / pitch)); i++) {
        const a = toMap(i * pitch, -extent), b = toMap(i * pitch, extent);
        c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]);
    }
    for (let j = Math.max(-N, Math.floor((ps.z - R) / pitch)); j <= Math.min(N, Math.ceil((ps.z + R) / pitch)); j++) {
        const a = toMap(-extent, j * pitch), b = toMap(extent, j * pitch);
        c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]);
    }
    c.stroke();

    // Road inner asphalt fill
    c.strokeStyle = 'rgba(203, 215, 226, 0.42)';
    c.lineWidth = Math.max(2, roadWidth * k - 1);
    c.stroke();

    // Road center dashes
    c.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    c.lineWidth = 0.7;
    c.setLineDash([2, 4]);
    c.stroke();
    c.setLineDash([]);

    // Traffic vehicles (clean blips)
    c.fillStyle = 'rgba(215, 225, 233, 0.7)';
    traffic.agents.forEach(a => {
        const [x, y] = toMap(a.x, a.z);
        if (x > 0 && x < W && y > 0 && y < H) {
            c.beginPath();
            c.arc(x, y, 1.5, 0, Math.PI * 2);
            c.fill();
        }
    });

    // Mission targets / Racers / Police suspects (clamped to radar border)
    modes.markers().forEach(m => {
        let [x, y] = toMap(m.x, m.z);
        const pad = 7;
        x = Math.max(pad, Math.min(W - pad, x));
        y = Math.max(pad, Math.min(H - pad, y));
        c.fillStyle = m.color;
        c.beginPath();
        c.arc(x, y, Math.min(4, m.r || 4), 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = '#000000';
        c.lineWidth = 1.5;
        c.stroke();
    });

    // GTA V Navigation Player Chevron (White with sharp black border)
    c.save();
    c.translate(halfX, halfY);
    c.fillStyle = '#f4f7fa';
    c.shadowColor = 'rgba(0,0,0,0.7)';
    c.shadowBlur = 3;
    c.strokeStyle = '#141a20';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(0, -10);
    c.lineTo(7.5, 7.5);
    c.lineTo(0, 3.5);
    c.lineTo(-7.5, 7.5);
    c.closePath();
    c.fill();
    c.stroke();
    c.restore();

    c.restore();
    c.save();
    c.beginPath();
    c.arc(halfX, halfY, mapRadius, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    c.lineWidth = 1;
    c.stroke();
    c.restore();

    // Update location badge in radar pod
    const districtEl = document.getElementById('radar-district');
    if (districtEl && cityManager) {
        const curCity = cityManager.activeCity;
        const distName = curCity === '2' ? 'MEGA METROPOLIS' : 'DOWNTOWN SKYLINE';
        if (districtEl.innerText !== distName) districtEl.innerText = distName;
    }

    // Update health & armor meters
    const healthBar = document.getElementById('radar-health');
    if (healthBar) {
        const hpPct = Math.max(10, Math.min(100, Math.round(100 - (ps.damage || 0) * 100)));
        healthBar.style.width = hpPct + '%';
    }
    const armorBar = document.getElementById('radar-armor');
    if (armorBar) {
        const armPct = (selectedCarType === 'police' || selectedCarType === 'truck') ? 100 : 75;
        armorBar.style.width = armPct + '%';
    }
}

function updateHud() {
    const kmh = Math.round(Math.hypot(ps.vf, ps.vr) * 3.6);
    setHtml('speed', kmh);
    const g = ps.gear === 0 ? 'N' : ps.gear === -1 ? 'R' : ps.gear;
    setHtml('gear-info', g);

    const def = CAR_DEFS[selectedCarType] || CAR_DEFS.dodge;
    const pct = Math.max(0, Math.min(100, (ps.rpm - def.idle) / (def.redline - def.idle) * 100));

    drawSpeedometer(kmh, pct);

    if ((miniFrame++ & 1) === 0) drawMinimap();
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (composer) composer.setSize(window.innerWidth, window.innerHeight);
}

// ─── VISUAL STYLE FUNCTIONS (DEFAULT / GTA V / BLACK & GRAY) ───
function initPostProcessing() {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.35, 0.55, 0.9));
    composer.addPass(new OutputPass()); // ACES tone mapping + sRGB, must come before the grade
    gradePass = new ShaderPass(GtaGradeShader);
    composer.addPass(gradePass);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(window.innerWidth, window.innerHeight);
}

function setVisualStyle(style) {
    visualStyle = style;
    if (style !== 'default') {
        if (!composer) initPostProcessing();
        Object.entries(GRADE_PRESETS[style]).forEach(([key, value]) => { gradePass.uniforms[key].value = value; });
    }
    document.querySelectorAll('.style-chip').forEach(c => c.classList.toggle('active', c.dataset.style === style));
    const gtaToggle = document.getElementById('gta-style-toggle');
    if (gtaToggle) gtaToggle.checked = style === 'gta';
}

function setupVisualStyleUI() {
    document.querySelectorAll('.style-chip').forEach(chip => {
        chip.onclick = () => setVisualStyle(chip.dataset.style);
    });
    const gtaToggle = document.getElementById('gta-style-toggle');
    if (gtaToggle) gtaToggle.onchange = () => setVisualStyle(gtaToggle.checked ? 'gta' : 'default');
}

function renderFrame() {
    const now = performance.now();
    if (!frameAllowed(now)) return;   // FPS limit: skip drawing only, physics keeps running
    tickFps(now);
    if (visualStyle !== 'default' && composer) {
        gradePass.uniforms.uTime.value = now * 0.001;
        composer.render();
    } else {
        renderer.render(scene, camera);
    }
}

function smoothCameraTo(position, lookTarget, alpha) {
    camera.position.x = THREE.MathUtils.lerp(camera.position.x, position.x, alpha);
    camera.position.y = THREE.MathUtils.lerp(camera.position.y, position.y, alpha);
    camera.position.z = THREE.MathUtils.lerp(camera.position.z, position.z, alpha);

    const currentX = camera.rotation.x;
    const currentY = camera.rotation.y;
    const currentZ = camera.rotation.z;
    camera.lookAt(lookTarget);
    cameraTargetRotation.copy(camera.rotation);

    const lerpAngle = (current, target) => {
        const delta = THREE.MathUtils.euclideanModulo(target - current + Math.PI, Math.PI * 2) - Math.PI;
        return THREE.MathUtils.lerp(current, current + delta, alpha);
    };
    camera.rotation.set(
        lerpAngle(currentX, cameraTargetRotation.x),
        lerpAngle(currentY, cameraTargetRotation.y),
        lerpAngle(currentZ, cameraTargetRotation.z)
    );
}

function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;
    if (!car) return;

    // ─── LOBBY SHOWROOM ROTATION ───
    if (gameState === 'lobby') {
        renderFrame();
        return;
    }

    // ─── GAMEPLAY: physics, traffic, game mode ───
    physicsAccumulator = Math.min(physicsAccumulator + dt, FIXED_STEP * 5);
    while (physicsAccumulator >= FIXED_STEP) {
        rememberCarPose();
        updateDriving(FIXED_STEP);
        traffic.update(FIXED_STEP, ps);
        modes.update(FIXED_STEP);
        physicsAccumulator -= FIXED_STEP;
    }
    interpolateCarPose(physicsAccumulator / FIXED_STEP);
    updateHud();

    // Alternate police strobe emergency roof lights when siren active
    if (selectedCarType === 'police' && sirenActive) {
        const flash = Math.sin(now * 0.018) > 0;
        if (policeLightBlue) policeLightBlue.intensity = flash ? 3.8 : 0;
        if (policeLightRed) policeLightRed.intensity = flash ? 0 : 3.8;
    } else {
        if (policeLightBlue) policeLightBlue.intensity = 0;
        if (policeLightRed) policeLightRed.intensity = 0;
    }

    const velocity = ps.vf * SCALE / 60;       // world units per frame (used by the cameras)
    const spd = Math.abs(velocity);
    const cameraSmoothing = snapCamera ? 1 : 1 - Math.pow(1 - 0.12, dt * 60);

    // ─── RACING CAMERA SYSTEM ───
    if (isOrbiting) {
        let phi = THREE.MathUtils.degToRad(90 - orbitLat);
        let theta = THREE.MathUtils.degToRad(orbitLon);
        const isTrk = (selectedCarType === 'truck');
        targetPos.setFromSphericalCoords(isTrk ? 54 : 34, phi, theta).add(car.position);
        lookAtPos.copy(car.position).add(lookOffset.set(0, isTrk ? 6.5 : 3.5, 0));
    } else {
        let mode = camModes[camIdx];

        if (mode === 'chase') {
            const isTrk = (selectedCarType === 'truck');
            const chaseDist = (isTrk ? 30 : 13.5) + spd * 0.45;
            const chaseHeight = (isTrk ? 9 : 5.2) + spd * 0.12;
            camOffset.set(0, chaseHeight, -chaseDist).applyQuaternion(car.quaternion);
            targetPos.copy(car.position).add(camOffset);
            lookOffset.set(0, isTrk ? 5.2 : 2.4, 4.5).applyQuaternion(car.quaternion);
            lookAtPos.copy(car.position).add(lookOffset);
        } else if (mode === 'close') {
            const isTrk = (selectedCarType === 'truck');
            // Tight close chase camera right above the bumper
            const closeDist = (isTrk ? 26.0 : 10.5) + spd * 0.5;
            const closeHeight = (isTrk ? 6.5 : 2.4) + spd * 0.15;
            camOffset.set(0, closeHeight, -closeDist).applyQuaternion(car.quaternion);
            targetPos.copy(car.position).add(camOffset);
            lookOffset.set(0, isTrk ? 4.2 : 2.0, 3.5).applyQuaternion(car.quaternion);
            lookAtPos.copy(car.position).add(lookOffset);
        } else if (mode === 'hood') {
            const isTrk = (selectedCarType === 'truck');
            camOffset.set(0, isTrk ? 7.2 : 4.3, isTrk ? 5.5 : 2.5).applyQuaternion(car.quaternion);
            targetPos.copy(car.position).add(camOffset);
            lookOffset.set(0, isTrk ? 6.5 : 3.8, 60).applyQuaternion(car.quaternion);
            lookAtPos.copy(car.position).add(lookOffset);
        } else if (mode === 'side') {
            const isTrk = (selectedCarType === 'truck');
            camOffset.set(isTrk ? 44 : 32, isTrk ? 9.5 : 6.0, -4).applyQuaternion(car.quaternion);
            targetPos.copy(car.position).add(camOffset);
            lookAtPos.copy(car.position).add(lookOffset.set(0, isTrk ? 5.0 : 3.2, 2));
        } else {
            const isTrk = (selectedCarType === 'truck');
            targetPos.set(car.position.x, isTrk ? 120 : 95, car.position.z - (isTrk ? 85 : 65));
            lookAtPos.copy(car.position);
        }
    }
    smoothCameraTo(targetPos, lookAtPos, cameraSmoothing);
    snapCamera = false;

    // speed feeling: wider view when fast
    const fovT = 60 + Math.min(8, Math.abs(ps.vf) * 0.12);
    if (Math.abs(camera.fov - fovT) > 0.05) {
        camera.fov += (fovT - camera.fov) * 0.08;
        camera.updateProjectionMatrix();
    }

    renderFrame();
}

// ─── MODULAR EXPORTS & ENGINE BOOTSTRAP ───
export function initGame() {
    if (window.__GAME_INITIALIZED__) return;
    window.__GAME_INITIALIZED__ = true;
    init();
}

export { animate };

// Auto-boot fallback if loaded directly
initGame();

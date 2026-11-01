import * as THREE from 'three';
import { playUiSelect } from './sound.js';

// city.js - Manages City 1 (Downtown) and City 2 (Mega City)

export const NETWORK_1 = {
    pitch: 150,
    N: 4,
    roadWidth: 48,
    lane: 12,
    parkOffset: 18,
    extent: 600
};

export const NETWORK_2 = {
    pitch: 150,
    N: 12,
    roadWidth: 48,
    lane: 12,
    parkOffset: 18,
    extent: 1800
};

export function createCityManager({ scene, renderer, shadowMeshes, houses, groundTexture, getShadows, onCityChange, city1Group }) {
    let activeCity = '1';
    let busy = false;
    let city1Houses = [...houses];
    
    let city2Group = null;
    let city2Houses = [];
    let city2Loaded = false;

    const statusEl = document.getElementById('city-status');
    const setStatus = (msg) => { if (statusEl) statusEl.innerText = msg; };

    function buildCity2(callback) {
        busy = true;
        setStatus('GENERATING CITY 2 (MEGA CITY)...');

        city2Group = new THREE.Group();
        scene.add(city2Group);

        const texLoader = new THREE.TextureLoader();
        const roadWidth = 48;
        const blockSize = 150;
        const gridSize = 12; // 24x24 blocks
        const roadHeight = 1.5;

        // Load Road Textures
        const vTex = texLoader.load('road/1.png', (tex) => {
            tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
            tex.colorSpace = THREE.SRGBColorSpace;
        });
        const hTex = texLoader.load('road/2.png', (tex) => {
            tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
            tex.colorSpace = THREE.SRGBColorSpace;
        });

        const roadLen = blockSize * gridSize * 2;
        hTex.repeat.set(roadLen / 38, 1);
        const hRoadGeo = new THREE.PlaneGeometry(roadLen, roadWidth);
        const hRoadMat = new THREE.MeshStandardMaterial({ map: hTex, roughness: 0.85, metalness: 0.08 });

        for (let i = -gridSize; i <= gridSize; i++) {
            const road = new THREE.Mesh(hRoadGeo, hRoadMat);
            road.rotation.x = -Math.PI / 2;
            road.position.set(0, roadHeight, i * blockSize);
            road.receiveShadow = getShadows ? getShadows() : false;
            city2Group.add(road);
            if (shadowMeshes) shadowMeshes.push(road);
        }

        const segLen = blockSize - roadWidth;
        vTex.repeat.set(1, segLen / 38);
        const vRoadGeo = new THREE.PlaneGeometry(roadWidth, segLen);
        const vRoadMat = new THREE.MeshStandardMaterial({ map: vTex, roughness: 0.85, metalness: 0.08 });

        for (let i = -gridSize; i <= gridSize; i++) {
            for (let j = -gridSize; j < gridSize; j++) {
                const road = new THREE.Mesh(vRoadGeo, vRoadMat);
                road.rotation.x = -Math.PI / 2;
                road.position.set(i * blockSize, roadHeight, j * blockSize + blockSize / 2);
                road.receiveShadow = getShadows ? getShadows() : false;
                city2Group.add(road);
                if (shadowMeshes) shadowMeshes.push(road);
            }
        }

        const city2Textures = [];
        let texLoadedCount = 0;
        for (let k = 1; k <= 5; k++) {
            texLoader.load(`city2/${k}.png`, (t) => {
                t.colorSpace = THREE.SRGBColorSpace;
                city2Textures.push(t);
                texLoadedCount++;
                if (texLoadedCount === 5) populateBuildings();
            }, undefined, () => {
                texLoadedCount++;
                if (texLoadedCount === 5) populateBuildings();
            });
        }

        function populateBuildings() {
            const buildingWidth = 72, buildingDepth = 72;
            const plotSize = blockSize - roadWidth - 2;
            const groundGeo = new THREE.PlaneGeometry(plotSize, plotSize);
            const groundMat = new THREE.MeshStandardMaterial({ map: groundTexture, roughness: 0.9, metalness: 0.05 });
            const roofMat = new THREE.MeshStandardMaterial({ color: 0x222428, roughness: 0.8 });
            const bottomMat = new THREE.MeshStandardMaterial({ color: 0x111111 });

            const mats = city2Textures.map(t => new THREE.MeshStandardMaterial({ map: t, roughness: 0.55, metalness: 0.15 }));
            const fallbackMat = new THREE.MeshStandardMaterial({ color: 0x444455 });

            for (let i = -gridSize; i < gridSize; i++) {
                for (let j = -gridSize; j < gridSize; j++) {
                    const x = i * blockSize + blockSize / 2;
                    const z = j * blockSize + blockSize / 2;

                    const groundMesh = new THREE.Mesh(groundGeo, groundMat);
                    groundMesh.rotation.x = -Math.PI / 2;
                    groundMesh.position.set(x, 1.51, z);
                    groundMesh.receiveShadow = getShadows ? getShadows() : false;
                    city2Group.add(groundMesh);

                    if (Math.random() > 0.65) continue;

                    const heightMul = 0.8 + Math.random() * 1.5;
                    const bHeight = 48 * heightMul;
                    const getMat = () => mats.length > 0 ? mats[Math.floor(Math.random() * mats.length)] : fallbackMat;
                    const bMaterials = [getMat(), getMat(), roofMat, bottomMat, getMat(), getMat()];

                    const buildingMesh = new THREE.Mesh(new THREE.BoxGeometry(buildingWidth, bHeight, buildingDepth), bMaterials);
                    buildingMesh.position.set(x, bHeight / 2 + 1.5, z);
                    buildingMesh.userData.width = buildingWidth;
                    buildingMesh.userData.depth = buildingDepth;
                    buildingMesh.userData.isBuilding = true;
                    buildingMesh.castShadow = getShadows ? getShadows() : false;
                    buildingMesh.receiveShadow = getShadows ? getShadows() : false;

                    city2Group.add(buildingMesh);
                    city2Houses.push(buildingMesh);
                    if (shadowMeshes) shadowMeshes.push(buildingMesh);
                }
            }

            city2Loaded = true;
            busy = false;
            setStatus('CITY 2 READY');
            if (callback) callback();
        }
    }

    function switchCity(cityId) {
        if (busy || (cityId !== '1' && cityId !== '2')) return;
        activeCity = cityId;
        playUiSelect();

        document.querySelectorAll('.seg-btn[data-city], .district-btn[data-city]').forEach(b => {
            b.classList.toggle('active', b.dataset.city === cityId);
        });

        if (cityId === '1') {
            if (city2Group) city2Group.visible = false;
            if (city1Group) city1Group.visible = true;
            houses.length = 0;
            houses.push(...city1Houses);
            setStatus('CITY 1 DOWNTOWN ACTIVE');
            if (onCityChange) onCityChange(NETWORK_1);
        } else if (cityId === '2') {
            if (city1Group) city1Group.visible = false;
            if (!city2Loaded) {
                buildCity2(() => {
                    city2Group.visible = true;
                    houses.length = 0;
                    houses.push(...city2Houses);
                    if (onCityChange) onCityChange(NETWORK_2);
                });
            } else {
                city2Group.visible = true;
                houses.length = 0;
                houses.push(...city2Houses);
                setStatus('CITY 2 MEGA CITY ACTIVE');
                if (onCityChange) onCityChange(NETWORK_2);
            }
        }
    }

    // Attach button events
    document.querySelectorAll('.seg-btn[data-city], .district-btn[data-city]').forEach(btn => {
        btn.onclick = () => switchCity(btn.dataset.city);
    });

    return {
        isBusy: () => busy,
        get activeCity() { return activeCity; },
        switchCity,
        registerCity1Houses: (newHouses) => {
            city1Houses = [...newHouses];
        }
    };
}

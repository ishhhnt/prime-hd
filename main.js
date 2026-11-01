/**
 * main.js - Production Entry Point for PRIME // HORIZON
 * High-performance ES6 module entry point.
 * Initializes WebGL renderer, mobile viewport sizing, asset pipelines, and game loop.
 */
import { initGame } from './game.js';

window.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 [Prime Horizon] Initializing modular 3D game engine...');
    initGame();
});

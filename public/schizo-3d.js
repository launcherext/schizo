// Schizo 3D Character Module
// Loads and displays the 3D character with gentle swaying animation

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Global state
let scene, camera, renderer, controls;
let schizoModel = null;

// Initialize the 3D scene
function initScene() {
    const container = document.getElementById('schizo-3d-canvas');
    if (!container) {
        console.log('Schizo 3D container not found');
        return;
    }

    // Scene - transparent background
    scene = new THREE.Scene();
    scene.background = null;

    // Camera - positioned for the model
    const aspect = container.clientWidth / container.clientHeight;
    camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 100);
    camera.position.set(0, 0.5, 5);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    container.appendChild(renderer.domElement);

    // Controls - disabled interaction, just for initial setup
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.enableZoom = false;
    controls.enablePan = false;
    controls.enableRotate = false;
    controls.target.set(0, 0.3, 0);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0x8cdbc7, 0.5);
    scene.add(ambientLight);

    const mainLight = new THREE.DirectionalLight(0xffffff, 1.2);
    mainLight.position.set(3, 5, 3);
    scene.add(mainLight);

    const fillLight = new THREE.DirectionalLight(0x8cdbc7, 0.5);
    fillLight.position.set(-3, 2, -2);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xff6b6b, 0.3);
    rimLight.position.set(0, 3, -5);
    scene.add(rimLight);

    // Load the model
    loadModel();

    // Handle resize
    window.addEventListener('resize', onWindowResize);

    // Start render loop
    animate();
}

// Load the GLB model
function loadModel() {
    const loader = new GLTFLoader();

    loader.load(
        'schizo_character.glb',
        function(gltf) {
            schizoModel = gltf.scene;

            // Scale and position - moved down so it fits in frame
            schizoModel.scale.set(1.8, 1.8, 1.8);
            schizoModel.position.set(0, -0.3, 0);

            scene.add(schizoModel);
            console.log('Schizo 3D model loaded');
        },
        function(progress) {
            if (progress.total > 0) {
                const percent = (progress.loaded / progress.total * 100).toFixed(0);
                console.log('Loading model: ' + percent + '%');
            }
        },
        function(error) {
            console.error('Error loading model:', error);
        }
    );
}

// Handle window resize
function onWindowResize() {
    const container = document.getElementById('schizo-3d-canvas');
    if (!container || !camera || !renderer) return;

    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
}

// Animation loop
function animate() {
    requestAnimationFrame(animate);

    // Update controls
    if (controls) controls.update();

    // Gentle idle animation - slight swaying
    if (schizoModel) {
        const time = Date.now() * 0.001;
        schizoModel.rotation.y = Math.sin(time * 0.5) * 0.15;
        schizoModel.position.y = -0.3 + Math.sin(time * 0.8) * 0.03;
    }

    // Render
    if (renderer && scene && camera) {
        renderer.render(scene, camera);
    }
}

// Initialize on page load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScene);
} else {
    initScene();
}

console.log('Schizo 3D module loaded');

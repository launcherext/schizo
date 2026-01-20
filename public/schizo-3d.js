// Schizo 3D Character Module
// Loads and displays the 3D character with mouth animation synced to audio

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Global state
let scene, camera, renderer, controls;
let schizoModel = null;
let mouthMorphIndex = -1;
let mixer = null;
let isVisible = false;
let audioContext = null;
let analyser = null;
let currentAudio = null;

// Initialize the 3D scene
function initScene() {
    const container = document.getElementById('schizo-3d-canvas');
    if (!container) {
        console.error('Container not found');
        return;
    }

    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a1414);

    // Camera - start further back for better view
    const aspect = container.clientWidth / container.clientHeight;
    camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 100);
    camera.position.set(0, 1, 7);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    container.appendChild(renderer.domElement);

    // Controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 3;
    controls.maxDistance = 12;
    controls.target.set(0, 0.5, 0);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0x8cdbc7, 0.4);
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

    updateStatus('Loading model...');

    loader.load(
        'schizo_character.glb',
        function(gltf) {
            schizoModel = gltf.scene;

            // Scale and position - centered in frame
            schizoModel.scale.set(1.2, 1.2, 1.2);
            schizoModel.position.set(0, -0.3, 0);

            // Find mesh with morph targets (mouth)
            let foundMorphMesh = null;
            schizoModel.traverse(function(child) {
                if (child.isMesh) {
                    console.log('Mesh found:', child.name, 'morphTargetInfluences:', child.morphTargetInfluences);

                    if (child.morphTargetInfluences && child.morphTargetInfluences.length > 0) {
                        console.log('Found mesh with morph targets:', child.name);
                        console.log('Morph target count:', child.morphTargetInfluences.length);
                        console.log('Morph targets dictionary:', child.morphTargetDictionary);

                        foundMorphMesh = child;

                        // Find mouth morph target index
                        if (child.morphTargetDictionary) {
                            const keys = Object.keys(child.morphTargetDictionary);
                            console.log('Morph target names:', keys);

                            if ('Mouth_Open' in child.morphTargetDictionary) {
                                mouthMorphIndex = child.morphTargetDictionary['Mouth_Open'];
                                console.log('Found Mouth_Open at index:', mouthMorphIndex);
                            } else if (keys.length > 0) {
                                // Use first morph target as fallback
                                mouthMorphIndex = child.morphTargetDictionary[keys[0]];
                                console.log('Using fallback morph target:', keys[0], 'at index:', mouthMorphIndex);
                            }
                        } else if (child.morphTargetInfluences.length > 0) {
                            // No dictionary, just use index 0
                            mouthMorphIndex = 0;
                            console.log('No dictionary, using index 0');
                        }
                    }
                }
            });

            if (!foundMorphMesh) {
                console.warn('No morph targets found in model!');
            }

            scene.add(schizoModel);

            // Setup animation mixer for any animations
            if (gltf.animations && gltf.animations.length > 0) {
                mixer = new THREE.AnimationMixer(schizoModel);
            }

            updateStatus('Ready');
            console.log('Schizo model loaded successfully');
        },
        function(progress) {
            if (progress.total > 0) {
                const percent = (progress.loaded / progress.total * 100).toFixed(0);
                updateStatus('Loading... ' + percent + '%');
            }
        },
        function(error) {
            console.error('Error loading model:', error);
            updateStatus('Error loading model');
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

    if (!isVisible) return;

    // Update controls
    if (controls) controls.update();

    // Update animation mixer
    if (mixer) mixer.update(0.016);

    // Gentle idle animation - slight rotation
    if (schizoModel) {
        schizoModel.rotation.y = Math.sin(Date.now() * 0.001) * 0.1;
    }

    // Render
    if (renderer && scene && camera) {
        renderer.render(scene, camera);
    }
}

// Set mouth open amount (0-1)
function setMouthOpen(value) {
    if (!schizoModel) {
        console.log('setMouthOpen: no model');
        return;
    }
    if (mouthMorphIndex < 0) {
        console.log('setMouthOpen: no morph index');
        return;
    }

    const clampedValue = Math.max(0, Math.min(1, value));

    schizoModel.traverse(function(child) {
        if (child.isMesh && child.morphTargetInfluences && child.morphTargetInfluences.length > mouthMorphIndex) {
            child.morphTargetInfluences[mouthMorphIndex] = clampedValue;
        }
    });
}

// Test function to manually animate mouth
window.testMouth = function() {
    console.log('Testing mouth animation...');
    let value = 0;
    let direction = 1;
    const interval = setInterval(function() {
        value += direction * 0.1;
        if (value >= 1) direction = -1;
        if (value <= 0) {
            clearInterval(interval);
            console.log('Mouth test complete');
        }
        setMouthOpen(value);
    }, 100);
};

// Analyze audio and sync mouth
let audioAnalysisActive = false;

function analyzeAudio() {
    if (!analyser || !currentAudio) {
        audioAnalysisActive = false;
        setMouthOpen(0);
        return;
    }

    if (currentAudio.paused || currentAudio.ended) {
        audioAnalysisActive = false;
        setMouthOpen(0);
        return;
    }

    audioAnalysisActive = true;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);

    // Get average volume across all frequencies for simplicity
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
    }

    const average = sum / dataArray.length;
    const normalized = average / 255;

    // Map to mouth open with threshold
    const mouthValue = normalized > 0.05 ? Math.min(1, normalized * 2) : 0;
    setMouthOpen(mouthValue);

    // Continue analyzing
    requestAnimationFrame(analyzeAudio);
}

// Play audio with mouth sync
function playAudioWithSync(base64Audio) {
    console.log('playAudioWithSync called, audio length:', base64Audio.length);

    // Create audio context if needed
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        console.log('Created audio context');
    }

    // Resume if suspended
    if (audioContext.state === 'suspended') {
        audioContext.resume();
        console.log('Resumed audio context');
    }

    // Create audio element
    const audio = new Audio('data:audio/mp3;base64,' + base64Audio);
    currentAudio = audio;

    // Connect to analyser
    const source = audioContext.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(audioContext.destination);
    console.log('Audio connected to analyser');

    // Update status
    updateStatus('Speaking...');
    const statusEl = document.getElementById('schizo-status');
    if (statusEl) statusEl.classList.add('talking');

    // Start analyzing
    analyzeAudio();
    console.log('Started audio analysis');

    // Play
    audio.play().then(function() {
        console.log('Audio playing');
    }).catch(function(err) {
        console.log('Audio autoplay blocked:', err);
        updateStatus('Click to enable audio');
    });

    // When done
    audio.onended = function() {
        console.log('Audio ended');
        setMouthOpen(0);
        updateStatus('Ready');
        if (statusEl) statusEl.classList.remove('talking');
        currentAudio = null;
    };
}

// Update status text
function updateStatus(text) {
    const statusEl = document.getElementById('schizo-status');
    if (statusEl) statusEl.textContent = text;
}

// Listen for toggle events from app.js
window.addEventListener('schizo-open', function() {
    isVisible = true;

    // Initialize scene if not done
    if (!scene) {
        initScene();
    }

    // Trigger resize to ensure correct dimensions
    setTimeout(onWindowResize, 100);
});

window.addEventListener('schizo-close', function() {
    isVisible = false;
});

// Override the playVoiceAudio function to add mouth sync
const originalPlayVoiceAudio = window.playVoiceAudio;
window.playVoiceAudio = function(data) {
    // Play with mouth sync if Schizo is visible
    if (isVisible && schizoModel) {
        playAudioWithSync(data.audio);
    } else {
        // Fall back to original
        if (originalPlayVoiceAudio) {
            originalPlayVoiceAudio(data);
        } else {
            // Simple audio play
            const audio = new Audio('data:audio/mp3;base64,' + data.audio);
            audio.play().catch(function(err) {
                console.log('Audio autoplay blocked:', err);
            });
        }
    }
};

console.log('Schizo 3D module loaded');

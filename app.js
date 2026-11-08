import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MindARThree } from 'mindar-image-three';

// ==========================================
// 1. ESTADO GLOBAL Y REFERENCIAS UI
// ==========================================
const arContainer = document.getElementById('ar-container');
const statusText = document.getElementById('status-text');
const scanGuide = document.getElementById('scan-guide');
const markerModal = document.getElementById('marker-modal');
const scoreVal = document.getElementById('score-val');
const btnPinMode = document.getElementById('btn-pin-mode');

let mindarThree = null;
let renderer, scene, camera, anchor, orbitControls;
const clock = new THREE.Clock();

// Grupo que representa el plano físico de la mesa (todo lo que está aquí arriba se inclina y mueve con la mesa)
const tableSurfaceGroup = new THREE.Group();
const characterGroup = new THREE.Group();
let restaurantTableMeshGroup = null;

let targetRing = null;
let platformGrid = null;
let mixer = null;
const actions = {};
let activeAction = null;
let previousAction = null;

// Estado de movimiento con flechitas sobre el plano de la mesa
const moveState = { up: false, down: false, left: false, right: false };
let isTurbo = false;
let isStandalone3DMode = false; // Se activa si no hay webcam o el usuario fija la mesa
let isMarkerVisible = false;

const scales = [0.16, 0.24, 0.34];
let scaleIndex = 1;
const TABLE_LIMIT = 1.15;

// Mini-juego en la mesa
let minigameActive = false;
let collectibleMesh = null;
let score = 0;

// ==========================================
// 2. VERIFICAR CÁMARA E INICIAR MOTOR ADECUADO
// ==========================================
async function startApp() {
  // Construir elementos de la mesa y cargar el personaje una sola vez
  buildTableSurfaceElements();
  await loadCharacterModel();

  // Verificar si el navegador tiene acceso a una cámara real
  const hasCamera = await checkCameraAvailability();

  if (hasCamera) {
    await initMindARCameraMode();
  } else {
    initInteractive6DoFTableSimulator(
      '🟡 No se detectó cámara web (o falta HTTPS en móvil) — Modo Mesa 3D 6DoF Activo (Arrastra para girar/inclinar la mesa)'
    );
  }
}

async function checkCameraAvailability() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return false;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    // Cerramos el stream de prueba inmediatamente para que MindAR lo pueda usar
    stream.getTracks().forEach(t => t.stop());
    return true;
  } catch (e) {
    console.warn('Cámara no disponible:', e.name, e.message);
    return false;
  }
}

// ==========================================
// 3A. MODO CÁMARA AR REAL (MINDAR 6DoF)
// ==========================================
async function initMindARCameraMode() {
  try {
    isStandalone3DMode = false;
    arContainer.innerHTML = '';

    mindarThree = new MindARThree({
      container: arContainer,
      imageTargetSrc: './models/card.mind',
      filterMinCF: 0.0001,
      filterBeta: 0.001,
      uiLoading: 'no',
      uiScanning: 'no',
      uiError: 'no' // Evita el cartel "Your device/browser is not compatible"
    });

    renderer = mindarThree.renderer;
    scene = mindarThree.scene;
    camera = mindarThree.camera;

    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    setupLights(scene);

    anchor = mindarThree.addAnchor(0);
    tableSurfaceGroup.position.set(0, 0, 0);
    tableSurfaceGroup.rotation.set(Math.PI / 2, 0, 0);
    if (restaurantTableMeshGroup) restaurantTableMeshGroup.visible = false;
    anchor.group.add(tableSurfaceGroup);

    anchor.onTargetFound = () => {
      isMarkerVisible = true;
      scanGuide.classList.add('hidden');
      statusText.textContent = '🟢 ¡Superficie AR Detectada (6DoF)! Usa las flechitas para moverte';
      statusText.style.color = '#4cd137';
      triggerOneShotAnimation('Wave');
    };

    anchor.onTargetLost = () => {
      isMarkerVisible = false;
      scanGuide.classList.remove('hidden');
      statusText.textContent = '🔍 Buscando marcador en la mesa... (o pulsa "📌 Modo Mesa 3D Sin Marcador")';
      statusText.style.color = '#48dbfb';
    };

    await mindarThree.start();
    scanGuide.classList.remove('hidden');
    btnPinMode.textContent = '📌 Modo Mesa Sin Marcador: OFF';
    btnPinMode.classList.remove('active');
    statusText.textContent = '📷 Cámara AR activa — Apunta al marcador o activa "📌 Modo Mesa Sin Marcador"';

    renderer.setAnimationLoop(() => {
      const delta = clock.getDelta();
      if (mixer) mixer.update(delta);
      updateMovementOnTable(delta);
      renderer.render(scene, camera);
    });
  } catch (err) {
    console.warn('Fallo al iniciar MindAR, cambiando a simulador 6DoF:', err);
    initInteractive6DoFTableSimulator(
      '🟡 Cámara ocupada o no compatible — Modo Mesa 3D 6DoF Activo'
    );
  }
}

// ==========================================
// 3B. MODO MESA 3D 6DoF INTERACTIVO (SIN CÁMARA / SIN MARCADOR)
// ==========================================
function initInteractive6DoFTableSimulator(customMessage) {
  isStandalone3DMode = true;
  if (mindarThree) {
    try { mindarThree.stop(); } catch (e) {}
    mindarThree = null;
  }

  arContainer.innerHTML = '';
  scanGuide.classList.add('hidden');

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x141824);

  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 2.2, 2.8);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  arContainer.appendChild(renderer.domElement);

  // OrbitControls permite mover la cámara en 6DoF alrededor de la mesa como si movieras el celular en el mundo real
  orbitControls = new OrbitControls(camera, renderer.domElement);
  orbitControls.enableDamping = true;
  orbitControls.dampingFactor = 0.06;
  orbitControls.maxPolarAngle = Math.PI / 2 - 0.05; // No bajar por debajo del suelo de la mesa
  orbitControls.minDistance = 1.0;
  orbitControls.maxDistance = 6.0;
  orbitControls.target.set(0, 0.1, 0);

  setupLights(scene);

  // Colocar el plano de la mesa horizontal en el origen
  tableSurfaceGroup.position.set(0, 0, 0);
  tableSurfaceGroup.rotation.set(0, 0, 0);
  if (restaurantTableMeshGroup) restaurantTableMeshGroup.visible = true;
  scene.add(tableSurfaceGroup);

  btnPinMode.textContent = '📌 Modo Mesa Sin Marcador: ON';
  btnPinMode.classList.add('active');
  statusText.textContent = customMessage || '🟢 Mesa 3D 6DoF Activa — Gira la cámara con el mouse y mueve con las flechas';
  statusText.style.color = '#ff9f43';

  triggerOneShotAnimation('Wave');

  renderer.setAnimationLoop(() => {
    const delta = clock.getDelta();
    if (mixer) mixer.update(delta);
    if (orbitControls) orbitControls.update();
    updateMovementOnTable(delta);
    renderer.render(scene, camera);
  });
}

function setupLights(targetScene) {
  const ambientLight = new THREE.HemisphereLight(0xffffff, 0x444444, 2.0);
  targetScene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xfff5e6, 2.8);
  dirLight.position.set(2, 5, 3);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 1024;
  dirLight.shadow.mapSize.height = 1024;
  targetScene.add(dirLight);
}

// ==========================================
// 4. CONSTRUIR LA MESA DEL RESTAURANTE Y SUPERFICIE AR
// ==========================================
function buildTableSurfaceElements() {
  // Grupo con la mesa de madera e individual (para verse increíble cuando no hay marcador)
  restaurantTableMeshGroup = new THREE.Group();

  // Tablero de madera de restaurante
  const woodGeo = new THREE.BoxGeometry(2.6, 0.12, 2.6);
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x6b4226, roughness: 0.65 });
  const woodTable = new THREE.Mesh(woodGeo, woodMat);
  woodTable.position.y = -0.065;
  woodTable.receiveShadow = true;
  restaurantTableMeshGroup.add(woodTable);

  // Individual con la textura del marcador de mesa en el centro
  const texLoader = new THREE.TextureLoader();
  const cardTexture = texLoader.load('./models/card.png');
  const cardGeo = new THREE.PlaneGeometry(1.1, 0.72);
  const cardMat = new THREE.MeshStandardMaterial({ map: cardTexture, roughness: 0.8 });
  const cardMesh = new THREE.Mesh(cardGeo, cardMat);
  cardMesh.rotation.x = -Math.PI / 2;
  cardMesh.position.y = 0.002;
  cardMesh.receiveShadow = true;
  restaurantTableMeshGroup.add(cardMesh);

  // Plato decorativo y vaso en la esquina de la mesa
  const plateGeo = new THREE.CylinderGeometry(0.32, 0.24, 0.03, 32);
  const plateMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2 });
  const plate = new THREE.Mesh(plateGeo, plateMat);
  plate.position.set(-0.78, 0.02, -0.75);
  plate.castShadow = true;
  plate.receiveShadow = true;
  restaurantTableMeshGroup.add(plate);

  tableSurfaceGroup.add(restaurantTableMeshGroup);

  // Cuadrícula holográfica AR sobre la superficie de la mesa
  platformGrid = new THREE.GridHelper(2.4, 12, 0x00d2d3, 0xffffff);
  platformGrid.material.opacity = 0.32;
  platformGrid.material.transparent = true;
  platformGrid.position.y = 0.005;
  tableSurfaceGroup.add(platformGrid);

  // Anillo indicador bajo los pies del personaje
  const ringGeo = new THREE.RingGeometry(0.14, 0.18, 32);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x00d2d3, side: THREE.DoubleSide });
  targetRing = new THREE.Mesh(ringGeo, ringMat);
  targetRing.rotation.x = -Math.PI / 2;
  targetRing.position.y = 0.012;
  tableSurfaceGroup.add(targetRing);

  // Añadir personaje al plano de la mesa
  tableSurfaceGroup.add(characterGroup);
}

// ==========================================
// 5. CARGAR PERSONAJE 3D ANIMADO (.GLB LOCAL)
// ==========================================
function loadCharacterModel() {
  return new Promise((resolve) => {
    const loader = new GLTFLoader();
    loader.load(
      './models/RobotExpressive.glb',
      (gltf) => {
        const model = gltf.scene;
        const s = scales[scaleIndex];
        model.scale.set(s, s, s);

        model.traverse((child) => {
          if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });

        characterGroup.add(model);

        mixer = new THREE.AnimationMixer(model);
        gltf.animations.forEach((clip) => {
          const action = mixer.clipAction(clip);
          actions[clip.name] = action;
          if (['Jump', 'Wave', 'ThumbsUp', 'Yes', 'No', 'Punch'].includes(clip.name)) {
            action.clampWhenFinished = true;
            action.loop = THREE.LoopOnce;
          }
        });

        mixer.addEventListener('finished', () => {
          fadeToAction(isMoving() ? (isTurbo ? 'Running' : 'Walking') : 'Idle', 0.2);
        });

        activeAction = actions['Idle'];
        activeAction.play();
        resolve();
      },
      undefined,
      (err) => {
        console.error('Error cargando GLB:', err);
        resolve();
      }
    );
  });
}

function fadeToAction(name, duration = 0.18) {
  if (!actions[name] || activeAction === actions[name]) return;
  previousAction = activeAction;
  activeAction = actions[name];
  if (previousAction) previousAction.fadeOut(duration);
  activeAction.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(duration).play();
}

function triggerOneShotAnimation(name) {
  if (!actions[name]) return;
  fadeToAction(name, 0.15);
}

// ==========================================
// 6. MOVIMIENTO CON FLECHITAS SOBRE EL PLANO DE LA MESA
// ==========================================
function isMoving() {
  return moveState.up || moveState.down || moveState.left || moveState.right;
}

function updateMovementOnTable(delta) {
  let dx = 0;
  let dz = 0;

  if (moveState.up)    dz -= 1;
  if (moveState.down)  dz += 1;
  if (moveState.left)  dx -= 1;
  if (moveState.right) dx += 1;

  if (dx !== 0 || dz !== 0) {
    const len = Math.hypot(dx, dz);
    dx /= len;
    dz /= len;

    const speed = isTurbo ? 1.4 : 0.8;
    characterGroup.position.x = THREE.MathUtils.clamp(
      characterGroup.position.x + dx * speed * delta,
      -TABLE_LIMIT,
      TABLE_LIMIT
    );
    characterGroup.position.z = THREE.MathUtils.clamp(
      characterGroup.position.z + dz * speed * delta,
      -TABLE_LIMIT,
      TABLE_LIMIT
    );

    const targetAngle = Math.atan2(dx, dz);
    let diff = targetAngle - characterGroup.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    characterGroup.rotation.y += diff * Math.min(1, delta * 12);

    const walkAnim = isTurbo ? 'Running' : 'Walking';
    if (activeAction !== actions[walkAnim] && activeAction !== actions['Jump']) {
      fadeToAction(walkAnim, 0.15);
    }
  } else {
    if (activeAction === actions['Walking'] || activeAction === actions['Running']) {
      fadeToAction('Idle', 0.2);
    }
  }

  if (targetRing) {
    targetRing.position.x = characterGroup.position.x;
    targetRing.position.z = characterGroup.position.z;
  }

  if (minigameActive && collectibleMesh) {
    collectibleMesh.rotation.y += delta * 3;
    const dist = Math.hypot(
      characterGroup.position.x - collectibleMesh.position.x,
      characterGroup.position.z - collectibleMesh.position.z
    );
    if (dist < 0.26) {
      score++;
      scoreVal.textContent = score;
      triggerOneShotAnimation('ThumbsUp');
      spawnCollectible();
    }
  }
}

// ==========================================
// 7. ALTERNAR ENTRE CÁMARA AR Y MESA 3D 6DoF
// ==========================================
async function togglePinMode() {
  if (isStandalone3DMode) {
    const hasCam = await checkCameraAvailability();
    if (hasCam) {
      await initMindARCameraMode();
    } else {
      alert('No se detectó una cámara web conectada (o abriste la página sin HTTPS en un celular). Se mantendrá el Modo Mesa 3D 6DoF.');
    }
  } else {
    initInteractive6DoFTableSimulator();
  }
}

async function startWebXRSession() {
  if (!navigator.xr) {
    alert('WebXR SLAM requiere Chrome en Android (con HTTPS) o gafas XR.');
    return;
  }
  const supported = await navigator.xr.isSessionSupported('immersive-ar');
  if (!supported) {
    alert('Este navegador/dispositivo no soporta WebXR immersive-ar sin marcador.');
    return;
  }
  try {
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: document.getElementById('ui-overlay') }
    });
    renderer.xr.enabled = true;
    await renderer.xr.setSession(session);
  } catch (e) {
    console.error(e);
  }
}

function toggleMinigame() {
  minigameActive = !minigameActive;
  const btn = document.getElementById('btn-minigame');

  if (minigameActive) {
    btn.classList.add('active');
    if (!collectibleMesh) {
      const geo = new THREE.OctahedronGeometry(0.12, 0);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xfbc531,
        emissive: 0xe1b12c,
        emissiveIntensity: 0.5,
        metalness: 0.7,
        roughness: 0.2
      });
      collectibleMesh = new THREE.Mesh(geo, mat);
      collectibleMesh.castShadow = true;
      tableSurfaceGroup.add(collectibleMesh);
    }
    collectibleMesh.visible = true;
    spawnCollectible();
  } else {
    btn.classList.remove('active');
    if (collectibleMesh) collectibleMesh.visible = false;
  }
}

function spawnCollectible() {
  if (!collectibleMesh) return;
  const rx = (Math.random() * 2 - 1) * (TABLE_LIMIT * 0.8);
  const rz = (Math.random() * 2 - 1) * (TABLE_LIMIT * 0.8);
  collectibleMesh.position.set(rx, 0.15, rz);
}

// ==========================================
// 8. CONTROLES Y EVENTOS UI
// ==========================================
function setupUIEvents() {
  document.querySelectorAll('.dpad-btn').forEach((btn) => {
    const dir = btn.dataset.dir;
    const start = (e) => { e.preventDefault(); moveState[dir] = true; btn.classList.add('pressed'); };
    const end = (e) => { e.preventDefault(); moveState[dir] = false; btn.classList.remove('pressed'); };

    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointerleave', end);
    btn.addEventListener('pointercancel', end);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp'    || e.key === 'w' || e.key === 'W') setKey('up', true);
    if (e.key === 'ArrowDown'  || e.key === 's' || e.key === 'S') setKey('down', true);
    if (e.key === 'ArrowLeft'  || e.key === 'a' || e.key === 'A') setKey('left', true);
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') setKey('right', true);
    if (e.key === ' ') triggerOneShotAnimation('Jump');
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowUp'    || e.key === 'w' || e.key === 'W') setKey('up', false);
    if (e.key === 'ArrowDown'  || e.key === 's' || e.key === 'S') setKey('down', false);
    if (e.key === 'ArrowLeft'  || e.key === 'a' || e.key === 'A') setKey('left', false);
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') setKey('right', false);
  });

  document.querySelectorAll('.action-btn[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const anim = btn.dataset.action;
      if (anim === 'Dance') fadeToAction('Dance', 0.2);
      else triggerOneShotAnimation(anim);
    });
  });

  const btnSpeed = document.getElementById('btn-speed');
  const speedLabel = document.getElementById('speed-label');
  btnSpeed.addEventListener('click', () => {
    isTurbo = !isTurbo;
    btnSpeed.classList.toggle('active-mode', isTurbo);
    speedLabel.textContent = isTurbo ? 'Correr' : 'Caminar';
  });

  document.getElementById('btn-scale').addEventListener('click', () => {
    scaleIndex = (scaleIndex + 1) % scales.length;
    const s = scales[scaleIndex];
    if (characterGroup.children[0]) {
      characterGroup.children[0].scale.set(s, s, s);
    }
  });

  document.getElementById('btn-reset-pos').addEventListener('click', () => {
    characterGroup.position.set(0, 0, 0);
    characterGroup.rotation.y = 0;
    triggerOneShotAnimation('Wave');
  });

  document.getElementById('btn-show-marker').addEventListener('click', () => {
    markerModal.classList.remove('hidden');
  });
  document.getElementById('btn-close-modal').addEventListener('click', () => {
    markerModal.classList.add('hidden');
  });
  document.getElementById('btn-force-show').addEventListener('click', () => {
    markerModal.classList.add('hidden');
    initInteractive6DoFTableSimulator();
  });

  btnPinMode.addEventListener('click', togglePinMode);
  document.getElementById('btn-webxr').addEventListener('click', startWebXRSession);
  document.getElementById('btn-minigame').addEventListener('click', toggleMinigame);

  window.addEventListener('resize', () => {
    if (isStandalone3DMode && camera && renderer) {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    }
  });
}

function setKey(dir, isDown) {
  moveState[dir] = isDown;
  const btn = document.querySelector(`.dpad-btn.${dir}`);
  if (btn) btn.classList.toggle('pressed', isDown);
}

setupUIEvents();
startApp();

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MindARThree } from 'mindar-image-three';
import { Compiler } from 'mindar-image';

// ==========================================
// 1. ESTADO GLOBAL Y REFERENCIAS UI
// ==========================================
const arContainer = document.getElementById('ar-container');
const statusText = document.getElementById('status-text');
const scanGuide = document.getElementById('scan-guide');
const markerModal = document.getElementById('marker-modal');
const scoreVal = document.getElementById('score-val');
const btnPinMode = document.getElementById('btn-pin-mode');
const scanPreviewImg = document.getElementById('scan-preview-img');
const modalMarkerImg = document.getElementById('modal-marker-img');
const linkOpenMarker = document.getElementById('link-open-marker');
const compileStatus = document.getElementById('compile-status');
const btnDownloadMind = document.getElementById('btn-download-mind');

// Ruta por defecto de la imagen que despliega el objeto 3D
let currentMindTargetUrl = './models/card.mind';
let currentMarkerImageUrl = './models/card.png';
let compiledMindBlobUrl = null;

let mindarThree = null;
let renderer, scene, camera, anchor, orbitControls;
const clock = new THREE.Clock();

const tableSurfaceGroup = new THREE.Group();
const characterGroup = new THREE.Group();
let restaurantTableMeshGroup = null;
let cardMeshOnTable = null;

let targetRing = null;
let platformGrid = null;
let mixer = null;
const actions = {};
let activeAction = null;
let previousAction = null;

const moveState = { up: false, down: false, left: false, right: false };
let isTurbo = false;
let isStandalone3DMode = false;
let isMarkerVisible = false;

// Escalas proporcionadas para que se vea completo en celulares verticales
const scales = [0.12, 0.17, 0.24];
let scaleIndex = 1;
const TABLE_LIMIT = 1.05;

let minigameActive = false;
let collectibleMesh = null;
let score = 0;

// ==========================================
// 2. INICIALIZAR APLICACIÓN (CÁMARA AR DIRECTA)
// ==========================================
async function startApp() {
  buildTableSurfaceElements();
  await loadCharacterModel();
  // Intentar abrir directamente la cámara AR con MindAR (sin bloqueo previo de getUserMedia)
  await initMindARCameraMode();
}

// ==========================================
// 3A. MODO CÁMARA AR REAL (MINDAR 6DoF)
// ==========================================
async function initMindARCameraMode() {
  try {
    if (mindarThree) {
      try { mindarThree.stop(); } catch (e) {}
      mindarThree = null;
    }

    isStandalone3DMode = false;
    arContainer.innerHTML = '';

    mindarThree = new MindARThree({
      container: arContainer,
      imageTargetSrc: currentMindTargetUrl,
      filterMinCF: 0.0001,
      filterBeta: 0.001,
      uiLoading: 'no',
      uiScanning: 'no',
      uiError: 'no'
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
      statusText.textContent = '🟢 ¡Marcador Detectado! Usa las flechitas para moverte';
      statusText.style.color = '#4cd137';
      triggerOneShotAnimation('Wave');
    };

    anchor.onTargetLost = () => {
      isMarkerVisible = false;
      scanGuide.classList.remove('hidden');
      statusText.textContent = '📷 Apunta a la imagen marcador (o toca "🪑 Mesa 3D")';
      statusText.style.color = '#48dbfb';
    };

    await mindarThree.start();
    scanGuide.classList.remove('hidden');
    btnPinMode.textContent = '🪑 Mesa 3D (Sin Cámara)';
    btnPinMode.classList.remove('active');
    statusText.textContent = '📷 Cámara AR activa — Apunta a la imagen marcador';
    statusText.style.color = '#48dbfb';

    renderer.setAnimationLoop(() => {
      const delta = clock.getDelta();
      if (mixer) mixer.update(delta);
      updateMovementOnTable(delta);
      renderer.render(scene, camera);
    });
  } catch (err) {
    console.warn('No se pudo abrir la cámara para MindAR, activando Mesa 3D:', err);
    initInteractive6DoFTableSimulator(
      '🟡 Modo Mesa 3D Activo (Toca "📷 Cámara AR" para reintentar cámara)'
    );
  }
}

// ==========================================
// 3B. MODO MESA 3D 6DoF INTERACTIVO (SIN CÁMARA)
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

  const isPortrait = window.innerWidth < window.innerHeight;
  camera = new THREE.PerspectiveCamera(isPortrait ? 55 : 48, window.innerWidth / window.innerHeight, 0.1, 100);
  // Alejar un poco más la cámara en celulares verticales para que el personaje se vea entero
  camera.position.set(0, isPortrait ? 2.6 : 2.1, isPortrait ? 3.8 : 2.8);
  camera.lookAt(0, 0.2, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  arContainer.appendChild(renderer.domElement);

  orbitControls = new OrbitControls(camera, renderer.domElement);
  orbitControls.enableDamping = true;
  orbitControls.dampingFactor = 0.06;
  orbitControls.maxPolarAngle = Math.PI / 2 - 0.05;
  orbitControls.minDistance = 1.2;
  orbitControls.maxDistance = 6.5;
  orbitControls.target.set(0, 0.25, 0);

  setupLights(scene);

  tableSurfaceGroup.position.set(0, 0, 0);
  tableSurfaceGroup.rotation.set(0, 0, 0);
  if (restaurantTableMeshGroup) restaurantTableMeshGroup.visible = true;
  scene.add(tableSurfaceGroup);

  btnPinMode.textContent = '📷 Activar Cámara AR';
  btnPinMode.classList.add('active');
  statusText.textContent = customMessage || '🟢 Mesa 3D Activa — Gira con el dedo y mueve con las flechas';
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
  restaurantTableMeshGroup = new THREE.Group();

  const woodGeo = new THREE.BoxGeometry(2.4, 0.12, 2.4);
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x6b4226, roughness: 0.65 });
  const woodTable = new THREE.Mesh(woodGeo, woodMat);
  woodTable.position.y = -0.065;
  woodTable.receiveShadow = true;
  restaurantTableMeshGroup.add(woodTable);

  const texLoader = new THREE.TextureLoader();
  const cardTexture = texLoader.load(currentMarkerImageUrl);
  const cardGeo = new THREE.PlaneGeometry(1.0, 0.68);
  const cardMat = new THREE.MeshStandardMaterial({ map: cardTexture, roughness: 0.8 });
  cardMeshOnTable = new THREE.Mesh(cardGeo, cardMat);
  cardMeshOnTable.rotation.x = -Math.PI / 2;
  cardMeshOnTable.position.y = 0.002;
  cardMeshOnTable.receiveShadow = true;
  restaurantTableMeshGroup.add(cardMeshOnTable);

  const plateGeo = new THREE.CylinderGeometry(0.28, 0.22, 0.03, 32);
  const plateMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2 });
  const plate = new THREE.Mesh(plateGeo, plateMat);
  plate.position.set(-0.72, 0.02, -0.7);
  plate.castShadow = true;
  plate.receiveShadow = true;
  restaurantTableMeshGroup.add(plate);

  tableSurfaceGroup.add(restaurantTableMeshGroup);

  platformGrid = new THREE.GridHelper(2.2, 10, 0x00d2d3, 0xffffff);
  platformGrid.material.opacity = 0.28;
  platformGrid.material.transparent = true;
  platformGrid.position.y = 0.005;
  tableSurfaceGroup.add(platformGrid);

  const ringGeo = new THREE.RingGeometry(0.12, 0.16, 32);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x00d2d3, side: THREE.DoubleSide });
  targetRing = new THREE.Mesh(ringGeo, ringMat);
  targetRing.rotation.x = -Math.PI / 2;
  targetRing.position.y = 0.012;
  tableSurfaceGroup.add(targetRing);

  tableSurfaceGroup.add(characterGroup);
}

// ==========================================
// 5. COMPILADOR EN VIVO PARA DEFINIR CUALQUIER IMAGEN COMO MARCADOR
// ==========================================
async function handleCustomMarkerUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  compileStatus.textContent = '⏳ Procesando imagen para Realidad Aumentada (3 seg)...';
  compileStatus.style.color = '#fbc531';

  try {
    const imgUrl = URL.createObjectURL(file);
    const img = new Image();
    img.src = imgUrl;
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
    });

    const compiler = new Compiler();
    await compiler.compileImageTargets([img], (progress) => {
      compileStatus.textContent = `⏳ Analizando puntos de rastreo: ${Math.round(progress)}%`;
    });

    const exportedBuffer = await compiler.exportData();
    const blob = new Blob([exportedBuffer], { type: 'application/octet-stream' });

    if (compiledMindBlobUrl) URL.revokeObjectURL(compiledMindBlobUrl);
    compiledMindBlobUrl = URL.createObjectURL(blob);
    currentMindTargetUrl = compiledMindBlobUrl;
    currentMarkerImageUrl = imgUrl;

    // Actualizar las vistas previas de la imagen marcador
    scanPreviewImg.src = imgUrl;
    modalMarkerImg.src = imgUrl;
    linkOpenMarker.href = imgUrl;

    if (cardMeshOnTable) {
      const newTex = new THREE.TextureLoader().load(imgUrl);
      cardMeshOnTable.material.map = newTex;
      cardMeshOnTable.material.needsUpdate = true;
    }

    // Habilitar botón para descargar el archivo .mind por si quiere guardarlo fijo en /models/card.mind
    btnDownloadMind.classList.remove('hidden');
    btnDownloadMind.onclick = () => {
      const a = document.createElement('a');
      a.href = compiledMindBlobUrl;
      a.download = 'card.mind';
      a.click();
    };

    compileStatus.textContent = '✅ ¡Lista! Ahora apunta la cámara a esa imagen para desplegar el objeto.';
    compileStatus.style.color = '#4cd137';

    // Reiniciar la cámara AR con el nuevo marcador
    await initMindARCameraMode();
  } catch (err) {
    console.error('Error compilando imagen:', err);
    compileStatus.textContent = '❌ No se pudo compilar la imagen. Intenta con otra foto con más detalles.';
    compileStatus.style.color = '#ff6b6b';
  }
}

// ==========================================
// 6. CARGAR PERSONAJE 3D ANIMADO (.GLB LOCAL)
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
// 7. MOVIMIENTO CON FLECHITAS SOBRE LA MESA
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

    const speed = isTurbo ? 1.35 : 0.75;
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
    if (dist < 0.24) {
      score++;
      scoreVal.textContent = score;
      triggerOneShotAnimation('ThumbsUp');
      spawnCollectible();
    }
  }
}

// ==========================================
// 8. ALTERNAR MODOS Y CONTROLES UI
// ==========================================
async function togglePinMode() {
  if (isStandalone3DMode) {
    await initMindARCameraMode();
  } else {
    initInteractive6DoFTableSimulator();
  }
}

async function startWebXRSession() {
  if (!navigator.xr) {
    alert('WebXR SLAM requiere Chrome en Android o gafas XR.');
    return;
  }
  const supported = await navigator.xr.isSessionSupported('immersive-ar');
  if (!supported) {
    alert('Este dispositivo no soporta WebXR sin marcador. Usa el modo Cámara AR con Imagen Marcador.');
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
      const geo = new THREE.OctahedronGeometry(0.11, 0);
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
  collectibleMesh.position.set(rx, 0.14, rz);
}

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

  document.getElementById('upload-marker-input').addEventListener('change', handleCustomMarkerUpload);

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

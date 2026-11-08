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
const btnTiltAxis = document.getElementById('btn-tilt-axis');
const btnRelock = document.getElementById('btn-relock');
const scanPreviewImg = document.getElementById('scan-preview-img');
const modalMarkerImg = document.getElementById('modal-marker-img');
const compileStatus = document.getElementById('compile-status');
const progressBar = document.getElementById('compile-progress-bar');
const progressFill = document.getElementById('compile-progress-fill');
const sizeSlider = document.getElementById('size-slider');

let currentMindTargetUrl = './models/card.mind';
let currentMarkerImageUrl = './models/card.png';
let compiledMindBlobUrl = null;

let mindarThree = null;
let renderer, scene, camera, anchor, orbitControls;
const clock = new THREE.Clock();

// Nodo auxiliar dentro del anchor para leer dónde apareció el marcador
const poseTracker = new THREE.Group();
const trackedPos = new THREE.Vector3();
const trackedQuat = new THREE.Quaternion();
const trackedScale = new THREE.Vector3();

// Grupo principal de la mesa y muñeco (vive directo en scene para NO desaparecer al mover la cámara)
const tableSurfaceGroup = new THREE.Group();
const characterGroup = new THREE.Group();
let restaurantTableMeshGroup = null;
let cardMeshOnTable = null;

let mixer = null;
const actions = {};
let activeAction = null;
let previousAction = null;

const moveState = { up: false, down: false, left: false, right: false };
let isTurbo = false;
let isStandalone3DMode = false;
let isMarkerVisible = false;

// Control de fijado automático una vez detectado el marcador
let hasBeenFoundOnce = false;
let isLockedOnScreen = false;
let stabilizeFrames = 0;

const arTiltPresets = [
  { angle: 0.22, label: '📐 Plano: Horizontal' },
  { angle: 0.55, label: '📐 Plano: 35°' },
  { angle: -0.25, label: '📐 Plano: Inverso' }
];
let tiltIndex = 0;

// Tamaño inicial miniatura sobre la mesa (0.06) y regulable entre 0.02 y 0.22
let currentScale = 0.06;
const TABLE_LIMIT = 0.95;

let minigameActive = false;
let collectibleMesh = null;
let score = 0;

// ==========================================
// 2. INICIALIZAR APLICACIÓN
// ==========================================
async function startApp() {
  buildTableSurfaceElements();
  await loadCharacterModel();
  await initMindARCameraMode();
}

// ==========================================
// 3A. MODO CÁMARA AR REAL CON AUTO-FIJADO AL ENCONTRAR
// ==========================================
async function initMindARCameraMode() {
  try {
    if (mindarThree) {
      try { mindarThree.stop(); } catch (e) {}
      mindarThree = null;
    }

    isStandalone3DMode = false;
    isMarkerVisible = false;
    hasBeenFoundOnce = false;
    isLockedOnScreen = false;
    stabilizeFrames = 0;
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

    // El nodo poseTracker va dentro del anchor de MindAR para saber dónde se detectó la imagen
    anchor = mindarThree.addAnchor(0);
    poseTracker.position.set(0, -0.1, 0);
    anchor.group.add(poseTracker);

    // Pero tableSurfaceGroup se agrega directo a scene para que NUNCA se apague cuando muevas la cámara
    if (restaurantTableMeshGroup) restaurantTableMeshGroup.visible = false;
    tableSurfaceGroup.visible = false;
    scene.add(tableSurfaceGroup);

    anchor.onTargetFound = () => {
      isMarkerVisible = true;
      scanGuide.classList.add('hidden');

      if (!hasBeenFoundOnce) {
        hasBeenFoundOnce = true;
        tableSurfaceGroup.visible = true;
        triggerOneShotAnimation('Wave');
      }

      statusText.textContent = '🔒 ¡Objeto Fijado! Ya puedes mover la cámara sin que se pierda';
      statusText.style.color = '#4cd137';
    };

    anchor.onTargetLost = () => {
      isMarkerVisible = false;
      // Si ya fue encontrado al menos una vez, SE QUEDA VISIBLE Y FIJO en pantalla
      if (hasBeenFoundOnce) {
        isLockedOnScreen = true;
        tableSurfaceGroup.visible = true;
        scanGuide.classList.add('hidden');
        statusText.textContent = '🔒 Muñeco Fijo en pantalla — Usa las flechas (o "🔄 Re-escanear")';
        statusText.style.color = '#4cd137';
      } else {
        scanGuide.classList.remove('hidden');
        statusText.textContent = '📷 Apunta a la imagen para desplegar el muñeco';
        statusText.style.color = '#48dbfb';
      }
    };

    await mindarThree.start();
    scanGuide.classList.remove('hidden');
    btnPinMode.textContent = '🪑 Mesa 3D';
    btnPinMode.classList.remove('active');
    statusText.textContent = '📷 Apunta a la imagen marcador para desplegar el muñeco';
    statusText.style.color = '#48dbfb';

    renderer.setAnimationLoop(() => {
      const delta = clock.getDelta();
      if (mixer) mixer.update(delta);

      // Capturar la posición del marcador durante los primeros fotogramas al encontrarlo y luego dejarlo fijo
      if (isMarkerVisible && !isLockedOnScreen) {
        anchor.group.updateMatrixWorld(true);
        poseTracker.updateWorldMatrix(true, false);
        poseTracker.matrixWorld.decompose(trackedPos, trackedQuat, trackedScale);

        tableSurfaceGroup.position.copy(trackedPos);
        tableSurfaceGroup.scale.copy(trackedScale);
        tableSurfaceGroup.rotation.set(arTiltPresets[tiltIndex].angle, 0, 0);

        stabilizeFrames++;
        // Tras ~15 fotogramas (~0.25 seg) de haber encontrado el objeto, queda anclado y fijo
        if (stabilizeFrames > 15) {
          isLockedOnScreen = true;
          statusText.textContent = '🔒 ¡Muñeco Fijado! Mueve la cámara o usa las flechas libremente';
        }
      }

      updateMovementOnTable(delta);
      renderer.render(scene, camera);
    });
  } catch (err) {
    console.warn('No se pudo abrir la cámara para MindAR, activando Mesa 3D:', err);
    initInteractive6DoFTableSimulator(
      '🟢 Mesa 3D Activa — Gira con el dedo y mueve con las flechas'
    );
  }
}

// Botón para volver a buscar el marcador si el usuario quiere re-ubicarlo
function relockToMarker() {
  if (isStandalone3DMode) return;
  hasBeenFoundOnce = false;
  isLockedOnScreen = false;
  stabilizeFrames = 0;
  characterGroup.position.set(0, 0, 0);

  if (isMarkerVisible) {
    hasBeenFoundOnce = true;
    tableSurfaceGroup.visible = true;
    statusText.textContent = '🔒 ¡Re-ubicado y Fijado!';
  } else {
    tableSurfaceGroup.visible = false;
    scanGuide.classList.remove('hidden');
    statusText.textContent = '📷 Apunta de nuevo a la imagen para fijar el muñeco';
    statusText.style.color = '#48dbfb';
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
  camera = new THREE.PerspectiveCamera(isPortrait ? 50 : 45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, isPortrait ? 1.8 : 1.5, isPortrait ? 2.6 : 2.1);
  camera.lookAt(0, 0.1, 0);

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
  orbitControls.minDistance = 0.8;
  orbitControls.maxDistance = 5.5;
  orbitControls.target.set(0, 0.1, 0);

  setupLights(scene);

  tableSurfaceGroup.visible = true;
  tableSurfaceGroup.position.set(0, 0, 0);
  tableSurfaceGroup.scale.set(1, 1, 1);
  tableSurfaceGroup.rotation.set(0, 0, 0);
  if (restaurantTableMeshGroup) restaurantTableMeshGroup.visible = true;
  scene.add(tableSurfaceGroup);

  btnPinMode.textContent = '📷 Cámara AR';
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
// 4. CONSTRUIR LA MESA (SIN RAYAS NI CUADRÍCULA DEBAJO DEL MUÑECO)
// ==========================================
function buildTableSurfaceElements() {
  const shadowGeo = new THREE.PlaneGeometry(3, 3);
  const shadowMat = new THREE.ShadowMaterial({ opacity: 0.35 });
  const shadowPlane = new THREE.Mesh(shadowGeo, shadowMat);
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.receiveShadow = true;
  tableSurfaceGroup.add(shadowPlane);

  restaurantTableMeshGroup = new THREE.Group();

  const woodGeo = new THREE.BoxGeometry(2.2, 0.12, 2.2);
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x6b4226, roughness: 0.65 });
  const woodTable = new THREE.Mesh(woodGeo, woodMat);
  woodTable.position.y = -0.065;
  woodTable.receiveShadow = true;
  restaurantTableMeshGroup.add(woodTable);

  const texLoader = new THREE.TextureLoader();
  const cardTexture = texLoader.load(currentMarkerImageUrl);
  cardTexture.colorSpace = THREE.SRGBColorSpace;
  const cardGeo = new THREE.PlaneGeometry(1.1, 0.78);
  const cardMat = new THREE.MeshStandardMaterial({ map: cardTexture, roughness: 0.7 });
  cardMeshOnTable = new THREE.Mesh(cardGeo, cardMat);
  cardMeshOnTable.rotation.x = -Math.PI / 2;
  cardMeshOnTable.position.y = 0.002;
  cardMeshOnTable.receiveShadow = true;
  restaurantTableMeshGroup.add(cardMeshOnTable);

  const plateGeo = new THREE.CylinderGeometry(0.24, 0.18, 0.025, 32);
  const plateMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2 });
  const plate = new THREE.Mesh(plateGeo, plateMat);
  plate.position.set(-0.65, 0.015, -0.6);
  plate.castShadow = true;
  plate.receiveShadow = true;
  restaurantTableMeshGroup.add(plate);

  tableSurfaceGroup.add(restaurantTableMeshGroup);

  characterGroup.scale.set(currentScale, currentScale, currentScale);
  tableSurfaceGroup.add(characterGroup);
}

function setCharacterScale(newScale) {
  currentScale = THREE.MathUtils.clamp(parseFloat(newScale), 0.02, 0.22);
  characterGroup.scale.set(currentScale, currentScale, currentScale);
  if (sizeSlider) sizeSlider.value = currentScale;
}

// ==========================================
// 5. REDIMENSIONAR FOTO Y APLICAR EN MESA 3D + COMPILAR AR
// ==========================================
async function handleCustomMarkerUpload(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  compileStatus.textContent = '⏳ Leyendo tu foto...';
  compileStatus.style.color = '#fbc531';
  progressBar.classList.remove('hidden');
  progressFill.style.width = '15%';

  try {
    const bitmapImg = await loadFileAsImage(file);
    const maxDim = 512;
    let w = bitmapImg.width;
    let h = bitmapImg.height;
    if (w > maxDim || h > maxDim) {
      if (w > h) {
        h = Math.round((h * maxDim) / w);
        w = maxDim;
      } else {
        w = Math.round((w * maxDim) / h);
        h = maxDim;
      }
    }

    const offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = w;
    offscreenCanvas.height = h;
    const ctx = offscreenCanvas.getContext('2d');
    ctx.drawImage(bitmapImg, 0, 0, w, h);

    const resizedDataUrl = offscreenCanvas.toDataURL('image/jpeg', 0.88);

    currentMarkerImageUrl = resizedDataUrl;
    modalMarkerImg.src = resizedDataUrl;
    scanPreviewImg.src = resizedDataUrl;

    if (cardMeshOnTable) {
      const canvasTex = new THREE.CanvasTexture(offscreenCanvas);
      canvasTex.colorSpace = THREE.SRGBColorSpace;
      canvasTex.needsUpdate = true;
      cardMeshOnTable.material.map = canvasTex;
      cardMeshOnTable.material.needsUpdate = true;
      const ratio = w / h;
      const baseH = 0.85;
      const baseW = THREE.MathUtils.clamp(baseH * ratio, 0.55, 1.4);
      cardMeshOnTable.geometry.dispose();
      cardMeshOnTable.geometry = new THREE.PlaneGeometry(baseW, baseH);
    }

    progressFill.style.width = '40%';
    compileStatus.textContent = '✅ ¡Foto lista! Generando puntos AR...';

    const smallImg = await loadUrlAsImage(resizedDataUrl);
    const mindModule = await import('mindar-image');
    const CompilerClass = mindModule.Compiler || (window.MINDAR && window.MINDAR.IMAGE && window.MINDAR.IMAGE.Compiler);

    if (CompilerClass) {
      const compiler = new CompilerClass();
      await compiler.compileImageTargets([smallImg], (progress) => {
        const pct = Math.round(40 + progress * 0.6);
        progressFill.style.width = `${pct}%`;
        compileStatus.textContent = `⏳ Creando marcador AR: ${Math.round(progress)}%`;
      });

      const exportedBuffer = await compiler.exportData();
      const blob = new Blob([exportedBuffer], { type: 'application/octet-stream' });
      if (compiledMindBlobUrl) URL.revokeObjectURL(compiledMindBlobUrl);
      compiledMindBlobUrl = URL.createObjectURL(blob);
      currentMindTargetUrl = compiledMindBlobUrl;
    }

    progressFill.style.width = '100%';
    compileStatus.textContent = '🟢 ¡Listo! Cerrando ventana...';
    compileStatus.style.color = '#4cd137';

    setTimeout(async () => {
      markerModal.classList.add('hidden');
      if (isStandalone3DMode) {
        triggerOneShotAnimation('Jump');
        statusText.textContent = '🟢 ¡Nueva imagen aplicada en la mesa!';
      } else {
        await initMindARCameraMode();
      }
    }, 600);

  } catch (err) {
    console.error('Error procesando foto:', err);
    progressFill.style.width = '100%';
    compileStatus.textContent = '✅ Foto aplicada en la Mesa 3D.';
    compileStatus.style.color = '#4cd137';
    setTimeout(() => {
      markerModal.classList.add('hidden');
      initInteractive6DoFTableSimulator('🟢 ¡Nueva imagen aplicada en la mesa!');
    }, 700);
  }
}

function loadFileAsImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadUrlAsImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
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

        model.traverse((child) => {
          if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });

        characterGroup.add(model);
        setCharacterScale(currentScale);

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

    const speed = isTurbo ? 1.1 : 0.55;
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

  if (minigameActive && collectibleMesh) {
    collectibleMesh.rotation.y += delta * 3;
    const dist = Math.hypot(
      characterGroup.position.x - collectibleMesh.position.x,
      characterGroup.position.z - collectibleMesh.position.z
    );
    if (dist < 0.2) {
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

function cyclePlaneTilt() {
  tiltIndex = (tiltIndex + 1) % arTiltPresets.length;
  const preset = arTiltPresets[tiltIndex];
  btnTiltAxis.textContent = preset.label;
  if (!isStandalone3DMode) {
    tableSurfaceGroup.rotation.set(preset.angle, 0, 0);
  }
}

function toggleMinigame() {
  minigameActive = !minigameActive;
  const btn = document.getElementById('btn-minigame');

  if (minigameActive) {
    btn.classList.add('active');
    if (!collectibleMesh) {
      const geo = new THREE.OctahedronGeometry(0.07, 0);
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
  const rx = (Math.random() * 2 - 1) * (TABLE_LIMIT * 0.75);
  const rz = (Math.random() * 2 - 1) * (TABLE_LIMIT * 0.75);
  collectibleMesh.position.set(rx, 0.08, rz);
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

  sizeSlider.addEventListener('input', (e) => {
    setCharacterScale(e.target.value);
  });
  document.getElementById('btn-size-down').addEventListener('click', () => {
    setCharacterScale(currentScale - 0.015);
  });
  document.getElementById('btn-size-up').addEventListener('click', () => {
    setCharacterScale(currentScale + 0.015);
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
  document.getElementById('btn-use-in-camera').addEventListener('click', async () => {
    markerModal.classList.add('hidden');
    await initMindARCameraMode();
  });

  document.getElementById('upload-marker-input').addEventListener('change', handleCustomMarkerUpload);

  btnPinMode.addEventListener('click', togglePinMode);
  btnTiltAxis.addEventListener('click', cyclePlaneTilt);
  btnRelock.addEventListener('click', relockToMarker);
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

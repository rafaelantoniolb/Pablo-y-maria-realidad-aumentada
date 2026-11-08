import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
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
const btnToggleMenu = document.getElementById('btn-toggle-menu');
const topDrawer = document.getElementById('top-drawer');
const drawerArrow = document.getElementById('drawer-arrow');
const scanPreviewImg = document.getElementById('scan-preview-img');
const modalMarkerImg = document.getElementById('modal-marker-img');
const compileStatus = document.getElementById('compile-status');
const progressBar = document.getElementById('compile-progress-bar');
const progressFill = document.getElementById('compile-progress-fill');
const sizeSlider = document.getElementById('size-slider');
const joystickZone = document.getElementById('joystick-zone');
const joystickKnob = document.getElementById('joystick-knob');

let currentMindTargetUrl = './models/card.mind';
let currentMarkerImageUrl = './models/card.png';
let compiledMindBlobUrl = null;

let mindarThree = null;
let renderer, scene, camera, anchor, orbitControls;
const clock = new THREE.Clock();

const poseTracker = new THREE.Group();
const trackedPos = new THREE.Vector3();
const trackedQuat = new THREE.Quaternion();
const trackedScale = new THREE.Vector3();

const tableSurfaceGroup = new THREE.Group();
const characterGroup = new THREE.Group();
let restaurantTableMeshGroup = null;
let cardMeshOnTable = null;

// Jerarquía articulada completa del Chef Maestro 3D + Estación de Parrilla Pro
const chefParts = {
  root: new THREE.Group(),
  hips: new THREE.Group(),
  torso: new THREE.Group(),
  head: new THREE.Group(),
  hat: new THREE.Group(),
  eyelids: [],
  leftShoulder: new THREE.Group(),
  leftElbow: new THREE.Group(),
  rightShoulder: new THREE.Group(),
  rightElbow: new THREE.Group(),
  leftHip: new THREE.Group(),
  leftKnee: new THREE.Group(),
  rightHip: new THREE.Group(),
  rightKnee: new THREE.Group(),
  burgerOnSpatula: new THREE.Group(),
  grillStation: new THREE.Group(),
  grillBurger: new THREE.Group(),
  emberLight: null
};

// Sistema de partículas 3D para el Show de Parrilla (Fuego, Chispas y Humo Gourmet)
const grillParticles = [];

let currentAnimState = 'Idle';
let animTimer = 0;
let oneShotTimer = 0;
let blinkTimer = 0;

// Vector analógico 360° del Joystick (-1 a +1) + Velocidad con inercia suave
const joyVector = { x: 0, y: 0 };
const keyState = { up: false, down: false, left: false, right: false };
const smoothVelocity = { x: 0, z: 0 };

let isTurbo = false;
let isStandalone3DMode = false;
let isMarkerVisible = false;

let hasBeenFoundOnce = false;
let isLockedOnScreen = false;
let stabilizeFrames = 0;

const arTiltPresets = [
  { angle: 0.22, label: '📐 Plano: Horizontal' },
  { angle: 0.55, label: '📐 Plano: 35°' },
  { angle: -0.25, label: '📐 Plano: Inverso' }
];
let tiltIndex = 0;

let currentScale = 0.18;
const TABLE_LIMIT = 0.85;

let minigameActive = false;
let collectibleMesh = null;
let score = 0;

function getDepthPerspectiveMultiplier(zPos) {
  const normalizedDepth = THREE.MathUtils.clamp(zPos / TABLE_LIMIT, -1, 1);
  return Math.pow(2.0, normalizedDepth);
}

function applyCharacterPerspectiveScale() {
  const depthMult = getDepthPerspectiveMultiplier(characterGroup.position.z);
  const effectiveScale = currentScale * depthMult;
  characterGroup.scale.set(effectiveScale, effectiveScale, effectiveScale);
}

// ==========================================
// 2. INICIALIZAR APLICACIÓN
// ==========================================
async function startApp() {
  buildTableSurfaceElements();
  buildProChefCharacter();
  await initMindARCameraMode();
}

// Configuración PBR Cinematográfica (RoomEnvironment + ACESFilmicToneMapping)
function enhanceRendererAndLighting(targetRenderer, targetScene) {
  targetRenderer.shadowMap.enabled = true;
  targetRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
  targetRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  targetRenderer.toneMappingExposure = 1.12;

  try {
    const pmremGenerator = new THREE.PMREMGenerator(targetRenderer);
    pmremGenerator.compileEquirectangularShader();
    const envTexture = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    targetScene.environment = envTexture;
  } catch (e) {
    console.warn('Environment map fallback:', e);
  }

  const hemiLight = new THREE.HemisphereLight(0xfff8f0, 0x3b2219, 1.4);
  targetScene.add(hemiLight);

  const keyLight = new THREE.DirectionalLight(0xfff2db, 2.4);
  keyLight.position.set(2.2, 5.5, 3.2);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.width = 1024;
  keyLight.shadow.mapSize.height = 1024;
  keyLight.shadow.bias = -0.0005;
  targetScene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0xffb800, 1.1);
  rimLight.position.set(-2.5, 3.0, -2.0);
  targetScene.add(rimLight);
}

// ==========================================
// 3A. MODO CÁMARA AR REAL CON AUTO-FIJADO
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

    enhanceRendererAndLighting(renderer, scene);

    anchor = mindarThree.addAnchor(0);
    poseTracker.position.set(0, -0.1, 0);
    anchor.group.add(poseTracker);

    if (restaurantTableMeshGroup) restaurantTableMeshGroup.visible = false;
    tableSurfaceGroup.visible = false;
    scene.add(tableSurfaceGroup);

    anchor.onTargetFound = () => {
      isMarkerVisible = true;
      scanGuide.classList.add('hidden');

      if (!hasBeenFoundOnce) {
        hasBeenFoundOnce = true;
        tableSurfaceGroup.visible = true;
        triggerChefAction('Wave');
      }

      statusText.textContent = '🔒 ¡Pablito el Chef Fijado! Usa el Joystick o toca 🔥 Parrilla';
    };

    anchor.onTargetLost = () => {
      isMarkerVisible = false;
      if (hasBeenFoundOnce) {
        isLockedOnScreen = true;
        tableSurfaceGroup.visible = true;
        scanGuide.classList.add('hidden');
        statusText.textContent = '👨‍🍳 Pablito el Chef está fijo en tu mesa — Usa el Joystick';
      } else {
        scanGuide.classList.remove('hidden');
        statusText.textContent = '📷 Apunta al marcador de tu mesa para llamar a Pablito';
      }
    };

    await mindarThree.start();
    scanGuide.classList.remove('hidden');
    btnPinMode.textContent = '🪑 Mesa 3D';
    btnPinMode.classList.remove('active');
    statusText.textContent = '📷 Apunta a tu mesa para desplegar a Pablito el Chef';

    renderer.setAnimationLoop(() => {
      const delta = Math.min(clock.getDelta(), 0.1);

      if (isMarkerVisible && !isLockedOnScreen) {
        anchor.group.updateMatrixWorld(true);
        poseTracker.updateWorldMatrix(true, false);
        poseTracker.matrixWorld.decompose(trackedPos, trackedQuat, trackedScale);

        tableSurfaceGroup.position.copy(trackedPos);
        tableSurfaceGroup.scale.copy(trackedScale);
        tableSurfaceGroup.rotation.set(arTiltPresets[tiltIndex].angle, 0, 0);

        stabilizeFrames++;
        if (stabilizeFrames > 15) {
          isLockedOnScreen = true;
          statusText.textContent = '🔒 ¡Pablito Fijado! Ya no se pierde al mover la cámara';
        }
      }

      updateMovementOnTable(delta);
      updateChefAnimation(delta);
      renderer.render(scene, camera);
    });
  } catch (err) {
    console.warn('No se pudo abrir la cámara para MindAR, activando Mesa 3D:', err);
    initInteractive6DoFTableSimulator(
      '👨‍🍳 Pablito el Chef en tu Mesa 3D — Usa el Joystick o toca 🔥 Parrilla'
    );
  }
}

function relockToMarker() {
  if (isStandalone3DMode) return;
  hasBeenFoundOnce = false;
  isLockedOnScreen = false;
  stabilizeFrames = 0;
  characterGroup.position.set(0, 0, 0);
  applyCharacterPerspectiveScale();

  if (isMarkerVisible) {
    hasBeenFoundOnce = true;
    tableSurfaceGroup.visible = true;
    statusText.textContent = '🔒 ¡Chef Re-ubicado y Fijado!';
  } else {
    tableSurfaceGroup.visible = false;
    scanGuide.classList.remove('hidden');
    statusText.textContent = '📷 Apunta de nuevo a la imagen para fijar al Chef';
  }
}

// ==========================================
// 3B. MODO MESA 3D 6DoF INTERACTIVO
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
  scene.background = new THREE.Color(0x12100e);

  const isPortrait = window.innerWidth < window.innerHeight;
  camera = new THREE.PerspectiveCamera(isPortrait ? 50 : 45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, isPortrait ? 1.75 : 1.45, isPortrait ? 2.5 : 2.0);
  camera.lookAt(0, 0.15, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  arContainer.appendChild(renderer.domElement);

  enhanceRendererAndLighting(renderer, scene);

  orbitControls = new OrbitControls(camera, renderer.domElement);
  orbitControls.enableDamping = true;
  orbitControls.dampingFactor = 0.06;
  orbitControls.maxPolarAngle = Math.PI / 2 - 0.05;
  orbitControls.minDistance = 0.8;
  orbitControls.maxDistance = 5.5;
  orbitControls.target.set(0, 0.15, 0);

  tableSurfaceGroup.visible = true;
  tableSurfaceGroup.position.set(0, 0, 0);
  tableSurfaceGroup.scale.set(1, 1, 1);
  tableSurfaceGroup.rotation.set(0, 0, 0);
  if (restaurantTableMeshGroup) restaurantTableMeshGroup.visible = true;
  scene.add(tableSurfaceGroup);

  btnPinMode.textContent = '📷 Cámara AR';
  btnPinMode.classList.add('active');
  statusText.textContent = customMessage || '👨‍🍳 Mesa 3D Activa — Usa el Joystick 360° o toca 🔥 Parrilla';

  triggerChefAction('Wave');

  renderer.setAnimationLoop(() => {
    const delta = Math.min(clock.getDelta(), 0.1);
    if (orbitControls) orbitControls.update();
    updateMovementOnTable(delta);
    updateChefAnimation(delta);
    renderer.render(scene, camera);
  });
}

// ==========================================
// 4. CONSTRUIR LA MESA
// ==========================================
function buildTableSurfaceElements() {
  const shadowGeo = new THREE.PlaneGeometry(3, 3);
  const shadowMat = new THREE.ShadowMaterial({ opacity: 0.42 });
  const shadowPlane = new THREE.Mesh(shadowGeo, shadowMat);
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.receiveShadow = true;
  tableSurfaceGroup.add(shadowPlane);

  restaurantTableMeshGroup = new THREE.Group();

  const woodGeo = new THREE.BoxGeometry(2.2, 0.12, 2.2);
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x3b2314, roughness: 0.6 });
  const woodTable = new THREE.Mesh(woodGeo, woodMat);
  woodTable.position.y = -0.065;
  woodTable.receiveShadow = true;
  restaurantTableMeshGroup.add(woodTable);

  const texLoader = new THREE.TextureLoader();
  const cardTexture = texLoader.load(currentMarkerImageUrl);
  cardTexture.colorSpace = THREE.SRGBColorSpace;
  const cardGeo = new THREE.PlaneGeometry(1.1, 0.78);
  const cardMat = new THREE.MeshStandardMaterial({ map: cardTexture, roughness: 0.65 });
  cardMeshOnTable = new THREE.Mesh(cardGeo, cardMat);
  cardMeshOnTable.rotation.x = -Math.PI / 2;
  cardMeshOnTable.position.y = 0.002;
  cardMeshOnTable.receiveShadow = true;
  restaurantTableMeshGroup.add(cardMeshOnTable);

  tableSurfaceGroup.add(restaurantTableMeshGroup);

  applyCharacterPerspectiveScale();
  tableSurfaceGroup.add(characterGroup);
}

function setCharacterScale(newScale) {
  currentScale = THREE.MathUtils.clamp(parseFloat(newScale), 0.08, 0.55);
  if (sizeSlider) sizeSlider.value = currentScale;
  applyCharacterPerspectiveScale();
}

// ==========================================
// 5. TEXTURAS PROCEDURALES Y MODELO PRO DEL CHEF + ESTACIÓN DE PARRILLA
// ==========================================
function createHatPleatsTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 256, 128);
  for (let x = 0; x < 256; x += 8) {
    const grad = ctx.createLinearGradient(x, 0, x + 8, 0);
    grad.addColorStop(0, '#f2f4f8');
    grad.addColorStop(0.5, '#ffffff');
    grad.addColorStop(1, '#e1e5ec');
    ctx.fillStyle = grad;
    ctx.fillRect(x, 0, 8, 128);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createBadgeTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#12100e';
  ctx.beginPath();
  ctx.arc(128, 128, 120, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 14;
  ctx.strokeStyle = '#ffb800';
  ctx.stroke();
  ctx.fillStyle = '#ffb800';
  ctx.font = 'bold 64px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('P&M', 128, 102);
  ctx.fillStyle = '#fff8f0';
  ctx.font = 'bold 36px sans-serif';
  ctx.fillText('PABLITO', 128, 162);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createFloatingNameBanner(text = '👨‍🍳 Pablito el Chef') {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');

  // Fondo redondeado estilo Pablo & María
  ctx.fillStyle = 'rgba(18, 16, 14, 0.86)';
  ctx.strokeStyle = '#ffb800';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.roundRect(12, 16, 488, 96, 48);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#ffb800';
  ctx.font = 'bold 42px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 66);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.95, 0.24, 1);
  sprite.position.set(0, 0.56, 0);
  return { sprite, canvas, ctx, tex };
}

let pablitoBanner = null;
function updatePablitoBannerText(text) {
  if (!pablitoBanner) return;
  const { ctx, tex } = pablitoBanner;
  ctx.clearRect(0, 0, 512, 128);
  ctx.fillStyle = 'rgba(18, 16, 14, 0.88)';
  ctx.strokeStyle = '#ffb800';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.roundRect(12, 16, 488, 96, 48);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ffb800';
  ctx.font = 'bold 40px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 66);
  tex.needsUpdate = true;
}

function createSmashBurgerMesh(scale = 1) {
  const burger = new THREE.Group();
  const bunMat = new THREE.MeshStandardMaterial({ color: 0xd97f26, roughness: 0.35, metalness: 0.05 });
  const meatMat = new THREE.MeshStandardMaterial({ color: 0x3d1c0a, roughness: 0.75 });
  const cheeseMat = new THREE.MeshStandardMaterial({ color: 0xffb800, roughness: 0.2, metalness: 0.1 });
  const baconMat = new THREE.MeshStandardMaterial({ color: 0xa62626, roughness: 0.45 });
  const lettuceMat = new THREE.MeshStandardMaterial({ color: 0x44bd32, roughness: 0.5 });
  const sesameMat = new THREE.MeshStandardMaterial({ color: 0xfff3d1, roughness: 0.4 });

  // Pan brioche inferior
  const bottomBun = new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.13, 0.045, 24), bunMat);
  bottomBun.position.y = 0.022;
  burger.add(bottomBun);

  // Primera carne Smash crujiente + Queso Cheddar fundido
  const patty1 = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.155, 0.032, 24), meatMat);
  patty1.position.y = 0.055;
  burger.add(patty1);

  const cheese1 = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.012, 0.24), cheeseMat);
  cheese1.position.y = 0.075;
  cheese1.rotation.y = Math.PI / 4;
  burger.add(cheese1);

  // Segunda carne Smash + Doble Cheddar + Tocineta
  const patty2 = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.032, 24), meatMat);
  patty2.position.y = 0.095;
  burger.add(patty2);

  const cheese2 = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.012, 0.23), cheeseMat);
  cheese2.position.y = 0.115;
  cheese2.rotation.y = Math.PI / 8;
  burger.add(cheese2);

  const bacon = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.014, 0.09), baconMat);
  bacon.position.y = 0.125;
  bacon.rotation.y = -0.3;
  burger.add(bacon);

  const lettuce = new THREE.Mesh(new THREE.CylinderGeometry(0.158, 0.15, 0.018, 20), lettuceMat);
  lettuce.position.y = 0.135;
  burger.add(lettuce);

  // Pan brioche superior brillante con semillas de ajonjolí
  const topBun = new THREE.Mesh(new THREE.SphereGeometry(0.148, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.48), bunMat);
  topBun.position.y = 0.135;
  burger.add(topBun);

  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const r = i % 2 === 0 ? 0.065 : 0.1;
    const seed = new THREE.Mesh(new THREE.SphereGeometry(0.01, 8, 8), sesameMat);
    seed.scale.set(1, 0.5, 1.6);
    seed.position.set(Math.cos(a) * r, 0.245 - r * 0.35, Math.sin(a) * r);
    seed.rotation.y = a;
    burger.add(seed);
  }

  burger.scale.set(scale, scale, scale);
  burger.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
  return burger;
}

function buildProChefCharacter() {
  const pleatTex = createHatPleatsTexture();
  const badgeTex = createBadgeTexture();

  const whiteCoatMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.42, metalness: 0.02 });
  const pleatedHatMat = new THREE.MeshStandardMaterial({ map: pleatTex, roughness: 0.4 });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xffc69e, roughness: 0.48, metalness: 0.02 });
  const blushMat = new THREE.MeshStandardMaterial({ color: 0xff8a7a, roughness: 0.6, transparent: true, opacity: 0.45 });
  const darkPantsMat = new THREE.MeshStandardMaterial({ color: 0x1b1917, roughness: 0.65 });
  const apronMat = new THREE.MeshStandardMaterial({ color: 0x141210, roughness: 0.55 });
  const shoeMat = new THREE.MeshStandardMaterial({ color: 0x0f0e0d, roughness: 0.25, metalness: 0.2 });
  const redMat = new THREE.MeshStandardMaterial({ color: 0xe63946, roughness: 0.38 });
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xffb800, metalness: 0.65, roughness: 0.22 });
  const hairMat = new THREE.MeshStandardMaterial({ color: 0x331b11, roughness: 0.55 });
  const irisMat = new THREE.MeshStandardMaterial({ color: 0x4a2a12, roughness: 0.2 });
  const pupilMat = new THREE.MeshBasicMaterial({ color: 0x050505 });
  const catchlightMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, metalness: 0.88, roughness: 0.15 });
  const castIronMat = new THREE.MeshStandardMaterial({ color: 0x1e2022, metalness: 0.6, roughness: 0.45 });

  // 1) CADERA Y TORSO ARTICULADO
  chefParts.hips.position.y = 0.42;
  chefParts.root.add(chefParts.hips);

  const pelvis = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.25, 0.16, 24), darkPantsMat);
  chefParts.hips.add(pelvis);

  chefParts.torso.position.y = 0.06;
  chefParts.hips.add(chefParts.torso);

  // Chaquetilla esculpida de Chef
  const chest = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.31, 0.62, 28), whiteCoatMat);
  chest.position.y = 0.31;
  chefParts.torso.add(chest);

  // Hombros redondeados
  const shoulders = new THREE.Mesh(new THREE.CapsuleGeometry(0.14, 0.38, 12, 20), whiteCoatMat);
  shoulders.rotation.z = Math.PI / 2;
  shoulders.position.y = 0.52;
  chefParts.torso.add(shoulders);

  // Delantal negro gourmet con ribetes dorados y bolsillo
  const apronSkirt = new THREE.Mesh(
    new THREE.CylinderGeometry(0.282, 0.325, 0.46, 28, 1, false, -Math.PI * 0.52, Math.PI * 1.04),
    apronMat
  );
  apronSkirt.position.y = 0.18;
  chefParts.torso.add(apronSkirt);

  const apronBib = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.26, 0.04), apronMat);
  apronBib.position.set(0, 0.42, 0.275);
  chefParts.torso.add(apronBib);

  // Medallón P&M en el pecho del delantal
  const chestBadge = new THREE.Mesh(
    new THREE.CircleGeometry(0.085, 24),
    new THREE.MeshBasicMaterial({ map: badgeTex })
  );
  chestBadge.position.set(0, 0.43, 0.298);
  chefParts.torso.add(chestBadge);

  // Pañuelo rojo de cocina en la cintura
  const kitchenTowel = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.24, 0.03), redMat);
  kitchenTowel.position.set(0.26, 0.18, 0.14);
  kitchenTowel.rotation.z = -0.1;
  chefParts.torso.add(kitchenTowel);

  // Pañuelo rojo de Chef en el cuello con nudo
  const neckScarf = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.052, 14, 28), redMat);
  neckScarf.rotation.x = Math.PI / 2;
  neckScarf.position.y = 0.62;
  chefParts.torso.add(neckScarf);

  const scarfKnot = new THREE.Mesh(new THREE.SphereGeometry(0.062, 14, 14), goldMat);
  scarfKnot.position.set(0, 0.59, 0.22);
  chefParts.torso.add(scarfKnot);

  // Botones dorados en doble fila
  for (let r = 0; r < 3; r++) {
    [-0.11, 0.11].forEach((xPos) => {
      const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.015, 14), goldMat);
      btn.rotation.x = Math.PI / 2;
      btn.position.set(xPos, 0.5 - r * 0.09, 0.285);
      chefParts.torso.add(btn);
    });
  }

  // 2) CUELLO, CABEZA EXPRESIVA Y GORRO PLISADO
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.12, 18), skinMat);
  neck.position.y = 0.66;
  chefParts.torso.add(neck);

  chefParts.head.position.set(0, 0.9, 0);
  chefParts.torso.add(chefParts.head);

  const cranium = new THREE.Mesh(new THREE.SphereGeometry(0.27, 32, 32), skinMat);
  cranium.scale.set(1.02, 0.98, 0.98);
  chefParts.head.add(cranium);

  // Orejas
  [-0.26, 0.26].forEach((xPos) => {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.06, 14, 14), skinMat);
    ear.scale.set(0.55, 1.1, 0.8);
    ear.position.set(xPos, -0.01, 0);
    chefParts.head.add(ear);
  });

  // Mejillas sonrojadas
  [-0.14, 0.14].forEach((xPos) => {
    const cheek = new THREE.Mesh(new THREE.SphereGeometry(0.055, 14, 14), blushMat);
    cheek.scale.set(1.2, 0.7, 0.5);
    cheek.position.set(xPos, -0.03, 0.23);
    chefParts.head.add(cheek);
  });

  // Ojos multicapa con iris, pupila, reflejo corneal blanco y párpados que parpadean
  chefParts.eyelids = [];
  [-0.095, 0.095].forEach((xPos) => {
    const eyeGroup = new THREE.Group();
    eyeGroup.position.set(xPos, 0.045, 0.225);

    const sclera = new THREE.Mesh(new THREE.SphereGeometry(0.052, 18, 18), whiteCoatMat);
    sclera.scale.set(1, 1.1, 0.7);
    eyeGroup.add(sclera);

    const iris = new THREE.Mesh(new THREE.SphereGeometry(0.033, 16, 16), irisMat);
    iris.scale.set(1, 1.05, 0.5);
    iris.position.z = 0.025;
    eyeGroup.add(iris);

    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.02, 14, 14), pupilMat);
    pupil.scale.set(1, 1.05, 0.4);
    pupil.position.z = 0.036;
    eyeGroup.add(pupil);

    // Brillo vivo en los ojos (catchlight)
    const catchlight = new THREE.Mesh(new THREE.SphereGeometry(0.009, 10, 10), catchlightMat);
    catchlight.position.set(0.012, 0.014, 0.044);
    eyeGroup.add(catchlight);

    // Párpado para parpadeo natural
    const eyelid = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55),
      skinMat
    );
    eyelid.rotation.x = -Math.PI * 0.45;
    eyeGroup.add(eyelid);
    chefParts.eyelids.push(eyelid);

    chefParts.head.add(eyeGroup);
  });

  // Cejas gruesas expresivas
  [-0.095, 0.095].forEach((xPos, idx) => {
    const brow = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.065, 8, 12), hairMat);
    brow.position.set(xPos, 0.125, 0.24);
    brow.rotation.z = Math.PI / 2 + (idx === 0 ? 0.14 : -0.14);
    chefParts.head.add(brow);
  });

  // Nariz esculpida
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.052, 18, 18), skinMat);
  nose.scale.set(1.05, 0.9, 1.1);
  nose.position.set(0, -0.005, 0.27);
  chefParts.head.add(nose);

  // Bigote Imperial de Chef (esculpido en 4 segmentos curvos)
  const mustacheGroup = new THREE.Group();
  mustacheGroup.position.set(0, -0.068, 0.255);
  [-1, 1].forEach((dir) => {
    const innerM = new THREE.Mesh(new THREE.CapsuleGeometry(0.032, 0.065, 10, 14), hairMat);
    innerM.position.set(dir * 0.045, 0, 0.01);
    innerM.rotation.z = Math.PI / 2 - dir * 0.22;
    mustacheGroup.add(innerM);

    const tipM = new THREE.Mesh(new THREE.ConeGeometry(0.028, 0.075, 12), hairMat);
    tipM.position.set(dir * 0.11, 0.008, -0.005);
    tipM.rotation.z = -dir * 1.15;
    mustacheGroup.add(tipM);
  });
  chefParts.head.add(mustacheGroup);

  // Sonrisa alegre bajo el bigote
  const smile = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.012, 10, 20, Math.PI), redMat);
  smile.rotation.x = Math.PI;
  smile.position.set(0, -0.105, 0.242);
  chefParts.head.add(smile);

  // Gorro de Chef Toque Blanche con pliegues y medallón P&M
  chefParts.hat.position.set(0, 0.19, -0.01);
  chefParts.head.add(chefParts.hat);

  const hatBase = new THREE.Mesh(new THREE.CylinderGeometry(0.245, 0.235, 0.14, 28), whiteCoatMat);
  hatBase.position.y = 0.06;
  chefParts.hat.add(hatBase);

  const hatBandRed = new THREE.Mesh(new THREE.CylinderGeometry(0.248, 0.24, 0.038, 28), redMat);
  hatBandRed.position.y = 0.015;
  chefParts.hat.add(hatBandRed);

  const hatPleatedColumn = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.24, 0.24, 32), pleatedHatMat);
  hatPleatedColumn.position.y = 0.22;
  chefParts.hat.add(hatPleatedColumn);

  const hatCrown = new THREE.Mesh(new THREE.SphereGeometry(0.29, 28, 20), pleatedHatMat);
  hatCrown.position.y = 0.34;
  hatCrown.scale.set(1.08, 0.72, 1.08);
  chefParts.hat.add(hatCrown);

  // Etiqueta 3D flotante sobre el gorro de Pablito el Chef
  pablitoBanner = createFloatingNameBanner('👨‍🍳 Pablito el Chef');
  chefParts.hat.add(pablitoBanner.sprite);

  // 3) BRAZOS CON ARTICULACIÓN DE HOMBRO + CODO + MANO CON PULGAR
  // Brazo Izquierdo (Lleva el salero/sazonador de oro en el show de cocina)
  chefParts.leftShoulder.position.set(-0.33, 0.52, 0);
  chefParts.torso.add(chefParts.leftShoulder);

  const lUpperArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.072, 0.16, 10, 14), whiteCoatMat);
  lUpperArm.position.y = -0.1;
  chefParts.leftShoulder.add(lUpperArm);

  chefParts.leftElbow.position.set(0, -0.2, 0);
  chefParts.leftShoulder.add(chefParts.leftElbow);

  const lForearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.14, 10, 14), whiteCoatMat);
  lForearm.position.y = -0.09;
  chefParts.leftElbow.add(lForearm);

  const lHand = new THREE.Mesh(new THREE.SphereGeometry(0.068, 14, 14), skinMat);
  lHand.position.y = -0.2;
  chefParts.leftElbow.add(lHand);

  const lThumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.022, 0.04, 6, 8), skinMat);
  lThumb.position.set(0.05, -0.19, 0.03);
  lThumb.rotation.z = -0.6;
  chefParts.leftElbow.add(lThumb);

  // Brazo Derecho + Espátula Profesional + Smash Burger
  chefParts.rightShoulder.position.set(0.33, 0.52, 0);
  chefParts.torso.add(chefParts.rightShoulder);

  const rUpperArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.072, 0.16, 10, 14), whiteCoatMat);
  rUpperArm.position.y = -0.1;
  chefParts.rightShoulder.add(rUpperArm);

  chefParts.rightElbow.position.set(0, -0.2, 0);
  chefParts.rightShoulder.add(chefParts.rightElbow);

  const rForearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.14, 10, 14), whiteCoatMat);
  rForearm.position.y = -0.09;
  chefParts.rightElbow.add(rForearm);

  const rHand = new THREE.Mesh(new THREE.SphereGeometry(0.068, 14, 14), skinMat);
  rHand.position.y = -0.2;
  chefParts.rightElbow.add(rHand);

  // Espátula de acero inoxidable en la mano derecha
  const spatulaGroup = new THREE.Group();
  spatulaGroup.position.set(0, -0.2, 0.06);
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.022, 0.16, 12), redMat);
  handle.rotation.x = Math.PI / 2;
  handle.position.z = 0.07;
  spatulaGroup.add(handle);

  const neckBlade = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.012, 0.08), steelMat);
  neckBlade.position.set(0, 0.01, 0.16);
  spatulaGroup.add(neckBlade);

  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.012, 0.21), steelMat);
  blade.position.set(0, 0.015, 0.27);
  spatulaGroup.add(blade);

  const heldBurger = createSmashBurgerMesh(0.58);
  heldBurger.position.set(0, 0.02, 0.27);
  chefParts.burgerOnSpatula.add(heldBurger);
  spatulaGroup.add(chefParts.burgerOnSpatula);

  chefParts.rightElbow.add(spatulaGroup);

  // 4) PIERNAS CON MUSLO + RODILLA + ZAPATOS DE CHEF CON SUELA
  chefParts.leftHip.position.set(-0.13, -0.04, 0);
  chefParts.hips.add(chefParts.leftHip);

  const lThigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.088, 0.14, 10, 14), darkPantsMat);
  lThigh.position.y = -0.1;
  chefParts.leftHip.add(lThigh);

  chefParts.leftKnee.position.set(0, -0.2, 0);
  chefParts.leftHip.add(chefParts.leftKnee);

  const lCalf = new THREE.Mesh(new THREE.CapsuleGeometry(0.078, 0.12, 10, 14), darkPantsMat);
  lCalf.position.y = -0.08;
  chefParts.leftKnee.add(lCalf);

  const lShoe = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.11, 10, 14), shoeMat);
  lShoe.rotation.x = Math.PI / 2;
  lShoe.position.set(0, -0.16, 0.045);
  chefParts.leftKnee.add(lShoe);

  chefParts.rightHip.position.set(0.13, -0.04, 0);
  chefParts.hips.add(chefParts.rightHip);

  const rThigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.088, 0.14, 10, 14), darkPantsMat);
  rThigh.position.y = -0.1;
  chefParts.rightHip.add(rThigh);

  chefParts.rightKnee.position.set(0, -0.2, 0);
  chefParts.rightHip.add(chefParts.rightKnee);

  const rCalf = new THREE.Mesh(new THREE.CapsuleGeometry(0.078, 0.12, 10, 14), darkPantsMat);
  rCalf.position.y = -0.08;
  chefParts.rightKnee.add(rCalf);

  const rShoe = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.11, 10, 14), shoeMat);
  rShoe.rotation.x = Math.PI / 2;
  rShoe.position.set(0, -0.16, 0.045);
  chefParts.rightKnee.add(rShoe);

  // 5) ESTACIÓN DE PARRILLA SMASH PRO (Aparece al tocar 🔥 Parrilla)
  buildProGrillStation(castIronMat, steelMat, goldMat);

  chefParts.root.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  characterGroup.add(chefParts.root);
}

function buildProGrillStation(castIronMat, steelMat, goldMat) {
  chefParts.grillStation.position.set(0, 0, 0.62);
  chefParts.grillStation.visible = false;
  chefParts.grillStation.scale.set(0.01, 0.01, 0.01);

  // Mesa de acero de la parrilla
  const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 0.56, 24), castIronMat);
  stand.position.y = 0.28;
  chefParts.grillStation.add(stand);

  const goldTrim = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.04, 24), goldMat);
  goldTrim.position.y = 0.5;
  chefParts.grillStation.add(goldTrim);

  // Plancha de hierro fundido con bordes
  const griddlePlate = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.05, 0.48), castIronMat);
  griddlePlate.position.y = 0.58;
  chefParts.grillStation.add(griddlePlate);

  // Brasas incandescentes encendidas sobre la parrilla
  const emberMat = new THREE.MeshBasicMaterial({ color: 0xff4500 });
  const emberGlow = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.36), emberMat);
  emberGlow.rotation.x = -Math.PI / 2;
  emberGlow.position.y = 0.607;
  chefParts.grillStation.add(emberGlow);

  // Luz cálida real de fuego que ilumina la cara y delantal del Chef cuando cocina
  chefParts.emberLight = new THREE.PointLight(0xff6b00, 0, 2.2);
  chefParts.emberLight.position.set(0, 0.78, 0);
  chefParts.grillStation.add(chefParts.emberLight);

  // Hamburguesa cocinándose en la plancha
  const grillBurger = createSmashBurgerMesh(0.75);
  chefParts.grillBurger.position.set(0, 0.61, 0);
  chefParts.grillBurger.add(grillBurger);
  chefParts.grillStation.add(chefParts.grillBurger);

  // Crear pool de 28 partículas 3D de fuego, chispas cheddar y humo
  for (let i = 0; i < 28; i++) {
    const isSmoke = i >= 18;
    const pGeo = isSmoke
      ? new THREE.SphereGeometry(0.055, 10, 10)
      : new THREE.OctahedronGeometry(0.025, 0);
    const pMat = new THREE.MeshBasicMaterial({
      color: isSmoke ? 0xfff8f0 : (i % 2 === 0 ? 0xffb800 : 0xff3838),
      transparent: true,
      opacity: 0.85
    });
    const pMesh = new THREE.Mesh(pGeo, pMat);
    resetParticle(pMesh, isSmoke);
    chefParts.grillStation.add(pMesh);
    grillParticles.push({ mesh: pMesh, isSmoke, speedY: 0.4 + Math.random() * 0.7, phase: Math.random() * 6.28 });
  }

  chefParts.root.add(chefParts.grillStation);
}

function resetParticle(mesh, isSmoke) {
  mesh.position.set(
    (Math.random() - 0.5) * 0.44,
    0.62 + Math.random() * 0.1,
    (Math.random() - 0.5) * 0.28
  );
  const s = isSmoke ? 0.5 : 0.8;
  mesh.scale.set(s, s, s);
}

// ==========================================
// 6. ANIMACIÓN FLUIDA CON INTERPOLACIÓN DAMP (60 FPS)
// ==========================================
function triggerChefAction(actionName) {
  currentAnimState = actionName;
  if (actionName === 'Cook') {
    oneShotTimer = 3.2;
    chefParts.grillStation.visible = true;
    updatePablitoBannerText('🔥 ¡Smash Burger P&M!');
  } else if (actionName === 'Wave') {
    oneShotTimer = 1.8;
    updatePablitoBannerText('👋 ¡Hola! Soy Pablito');
  } else if (actionName === 'Dance') {
    oneShotTimer = 999;
    updatePablitoBannerText('💃 ¡Pablito con sabor!');
  } else if (actionName === 'Jump') {
    oneShotTimer = 1.7;
    updatePablitoBannerText('🎉 ¡Arriba Pablo & María!');
  } else {
    oneShotTimer = 1.7;
  }
}

function dampAngle(current, target, lambda, delta) {
  return THREE.MathUtils.damp(current, target, lambda, delta);
}

function updateChefAnimation(delta) {
  animTimer += delta;
  blinkTimer += delta;

  // Parpadeo natural de los ojos cada ~3.4 segundos
  const isBlinking = (blinkTimer % 3.4) > 3.25;
  const targetLidRot = isBlinking ? 0.05 : -Math.PI * 0.45;
  chefParts.eyelids.forEach((lid) => {
    lid.rotation.x = dampAngle(lid.rotation.x, targetLidRot, 22, delta);
  });

  const speedMag = Math.hypot(smoothVelocity.x, smoothVelocity.z);
  const moving = speedMag > 0.015;

  if (oneShotTimer > 0) {
    oneShotTimer -= delta;
    if (oneShotTimer <= 0) {
      currentAnimState = moving ? (isTurbo ? 'Running' : 'Walking') : 'Idle';
      updatePablitoBannerText('👨‍🍳 Pablito el Chef');
    }
  } else {
    if (moving && currentAnimState !== 'Dance') {
      currentAnimState = isTurbo ? 'Running' : 'Walking';
    } else if (!moving && (currentAnimState === 'Walking' || currentAnimState === 'Running')) {
      currentAnimState = 'Idle';
    }
  }

  // Mostrar/ocultar suavemente la estación de parrilla Pro
  const showGrill = currentAnimState === 'Cook';
  const targetGrillScale = showGrill ? 1 : 0.001;
  const gs = dampAngle(chefParts.grillStation.scale.x, targetGrillScale, 12, delta);
  chefParts.grillStation.scale.set(gs, gs, gs);
  if (gs < 0.02 && !showGrill) chefParts.grillStation.visible = false;
  if (chefParts.emberLight) {
    chefParts.emberLight.intensity = showGrill ? 2.2 + Math.sin(animTimer * 18) * 0.6 : 0;
  }

  // Ocultar la burger de la mano cuando está cocinando en la plancha grande
  chefParts.burgerOnSpatula.visible = !showGrill;

  // Valores objetivo de las articulaciones para interpolar con suavidad
  let targetRootY = 0;
  let targetTorsoRotX = 0, targetTorsoRotY = 0, targetTorsoRotZ = 0;
  let targetHeadRotX = 0, targetHeadRotY = 0, targetHeadRotZ = 0;
  let targetLShoulderX = 0, targetLShoulderZ = 0.14, targetLElbowX = -0.25;
  let targetRShoulderX = -0.35, targetRShoulderZ = -0.12, targetRElbowX = -0.45;
  let targetLHipX = 0, targetLKneeX = 0;
  let targetRHipX = 0, targetRKneeX = 0;

  if (currentAnimState === 'Idle') {
    const t = animTimer * 2.4;
    targetRootY = Math.sin(t) * 0.012;
    targetHeadRotY = Math.sin(t * 0.55) * 0.14;
    targetHeadRotZ = Math.cos(t * 0.55) * 0.04;
    targetLShoulderZ = 0.14 + Math.sin(t) * 0.04;
    targetRShoulderX = -0.32 + Math.cos(t) * 0.04;
  } else if (currentAnimState === 'Walking' || currentAnimState === 'Running') {
    // El ritmo y amplitud de la zancada se adaptan proporcionalmente a qué tanto empujes el Joystick
    const joyRatio = THREE.MathUtils.clamp(speedMag / (isTurbo ? 0.34 : 0.18), 0.35, 1.3);
    const freq = (isTurbo ? 12 : 8.5) * Math.max(0.7, joyRatio);
    const amp = (isTurbo ? 0.68 : 0.46) * joyRatio;
    const t = animTimer * freq;

    const lCycle = Math.sin(t);
    const rCycle = Math.sin(t + Math.PI);

    targetRootY = Math.abs(Math.cos(t)) * 0.045 * joyRatio;
    targetTorsoRotX = 0.08 * joyRatio; // Inclinación natural al caminar
    targetTorsoRotY = Math.sin(t) * 0.12 * joyRatio;
    targetTorsoRotZ = Math.cos(t) * 0.05 * joyRatio;

    targetLHipX = lCycle * amp;
    targetLKneeX = Math.max(0, -lCycle * amp * 1.15); // La rodilla se flexiona al levantar el pie
    targetRHipX = rCycle * amp;
    targetRKneeX = Math.max(0, -rCycle * amp * 1.15);

    targetLShoulderX = rCycle * amp * 0.85;
    targetLElbowX = -0.35 - Math.max(0, rCycle) * 0.35;
    targetRShoulderX = -0.3 + lCycle * amp * 0.45;
    targetRElbowX = -0.5;
    targetHeadRotY = -targetTorsoRotY * 0.6;
  } else if (currentAnimState === 'Cook') {
    // Show de Parrilla Pro: Sazonar con mano izquierda + Voltear Smash Burger en el aire con fuego
    const t = animTimer * 7.5;
    const flipPhase = (animTimer * 2.2) % 1;
    const burgerArc = Math.sin(flipPhase * Math.PI);

    targetTorsoRotX = 0.12;
    targetTorsoRotY = Math.sin(t * 0.5) * 0.18;
    targetHeadRotX = 0.18 - burgerArc * 0.42; // El Chef sigue con la mirada la hamburguesa en el aire

    // Mano izquierda sazonando sobre la parrilla
    targetLShoulderX = -0.95 + Math.sin(t * 1.8) * 0.25;
    targetLShoulderZ = 0.25;
    targetLElbowX = -0.65 + Math.cos(t * 1.8) * 0.25;

    // Mano derecha con la espátula impulsando la Smash Burger
    targetRShoulderX = -0.85 - burgerArc * 0.45;
    targetRElbowX = -0.55 - burgerArc * 0.35;

    // Animar la hamburguesa en la plancha dando doble giro en el aire
    chefParts.grillBurger.position.y = 0.61 + Math.max(0, burgerArc) * 0.52;
    chefParts.grillBurger.rotation.x = flipPhase * Math.PI * 4;
    chefParts.grillBurger.rotation.y = animTimer * 3;

    // Animar partículas 3D de fuego, chispas y humo
    grillParticles.forEach((p) => {
      p.mesh.position.y += p.speedY * delta;
      p.mesh.position.x += Math.sin(animTimer * 5 + p.phase) * 0.12 * delta;
      p.mesh.rotation.y += delta * 4;
      if (p.isSmoke) {
        const s = p.mesh.scale.x + delta * 0.8;
        p.mesh.scale.set(s, s, s);
      }
      if (p.mesh.position.y > (p.isSmoke ? 1.35 : 1.05)) {
        resetParticle(p.mesh, p.isSmoke);
      }
    });
  } else if (currentAnimState === 'Wave') {
    const t = animTimer * 10;
    targetLShoulderX = -0.4;
    targetLShoulderZ = 2.35 + Math.sin(t) * 0.32;
    targetLElbowX = -0.4 + Math.cos(t) * 0.2;
    targetHeadRotZ = 0.12;
  } else if (currentAnimState === 'Dance') {
    const t = animTimer * 8.5;
    targetRootY = Math.abs(Math.sin(t)) * 0.08;
    targetTorsoRotY = Math.sin(t * 0.5) * 0.45;
    targetTorsoRotZ = Math.cos(t) * 0.14;
    targetLShoulderZ = 2.1 + Math.sin(t) * 0.45;
    targetRShoulderX = -0.9 + Math.cos(t) * 0.4;
    targetLHipX = Math.sin(t) * 0.4;
    targetLKneeX = Math.max(0, Math.cos(t) * 0.5);
    targetRHipX = -Math.sin(t) * 0.4;
    targetRKneeX = Math.max(0, -Math.cos(t) * 0.5);
  } else if (currentAnimState === 'Jump') {
    const progress = 1 - Math.max(0, oneShotTimer / 1.7);
    targetRootY = Math.max(0, Math.sin(progress * Math.PI) * 0.42);
    targetLShoulderZ = 2.3;
    targetRShoulderX = -1.3;
    targetLKneeX = 0.45;
    targetRKneeX = 0.45;
  }

  // Aplicar interpolación DAMP ultra fluida a todas las articulaciones
  const smoothFactor = 14;
  chefParts.root.position.y = dampAngle(chefParts.root.position.y, targetRootY, smoothFactor, delta);
  chefParts.torso.rotation.x = dampAngle(chefParts.torso.rotation.x, targetTorsoRotX, smoothFactor, delta);
  chefParts.torso.rotation.y = dampAngle(chefParts.torso.rotation.y, targetTorsoRotY, smoothFactor, delta);
  chefParts.torso.rotation.z = dampAngle(chefParts.torso.rotation.z, targetTorsoRotZ, smoothFactor, delta);

  chefParts.head.rotation.x = dampAngle(chefParts.head.rotation.x, targetHeadRotX, smoothFactor, delta);
  chefParts.head.rotation.y = dampAngle(chefParts.head.rotation.y, targetHeadRotY, smoothFactor, delta);
  chefParts.head.rotation.z = dampAngle(chefParts.head.rotation.z, targetHeadRotZ, smoothFactor, delta);

  chefParts.leftShoulder.rotation.x = dampAngle(chefParts.leftShoulder.rotation.x, targetLShoulderX, smoothFactor, delta);
  chefParts.leftShoulder.rotation.z = dampAngle(chefParts.leftShoulder.rotation.z, targetLShoulderZ, smoothFactor, delta);
  chefParts.leftElbow.rotation.x = dampAngle(chefParts.leftElbow.rotation.x, targetLElbowX, smoothFactor, delta);

  chefParts.rightShoulder.rotation.x = dampAngle(chefParts.rightShoulder.rotation.x, targetRShoulderX, smoothFactor, delta);
  chefParts.rightShoulder.rotation.z = dampAngle(chefParts.rightShoulder.rotation.z, targetRShoulderZ, smoothFactor, delta);
  chefParts.rightElbow.rotation.x = dampAngle(chefParts.rightElbow.rotation.x, targetRElbowX, smoothFactor, delta);

  chefParts.leftHip.rotation.x = dampAngle(chefParts.leftHip.rotation.x, targetLHipX, smoothFactor, delta);
  chefParts.leftKnee.rotation.x = dampAngle(chefParts.leftKnee.rotation.x, targetLKneeX, smoothFactor, delta);
  chefParts.rightHip.rotation.x = dampAngle(chefParts.rightHip.rotation.x, targetRHipX, smoothFactor, delta);
  chefParts.rightKnee.rotation.x = dampAngle(chefParts.rightKnee.rotation.x, targetRKneeX, smoothFactor, delta);
}

// ==========================================
// 7. MOVIMIENTO FLUIDO 360° CON INERCIA Y PERSPECTIVA
// ==========================================
function updateMovementOnTable(delta) {
  // Combinar entrada del Joystick Analógico 360° con teclado (si se usa en PC)
  let inputX = joyVector.x;
  let inputZ = joyVector.y;

  if (keyState.up)    inputZ -= 1;
  if (keyState.down)  inputZ += 1;
  if (keyState.left)  inputX -= 1;
  if (keyState.right) inputX += 1;

  const inputMag = Math.hypot(inputX, inputZ);
  if (inputMag > 1) {
    inputX /= inputMag;
    inputZ /= inputMag;
  }

  const depthMult = getDepthPerspectiveMultiplier(characterGroup.position.z);
  const scaleRatio = THREE.MathUtils.clamp(currentScale / 0.2, 0.5, 1.4);
  const maxSpeed = (isTurbo ? 0.34 : 0.17) * scaleRatio * THREE.MathUtils.clamp(depthMult, 0.55, 1.35);

  const targetVelX = inputX * maxSpeed;
  const targetVelZ = inputZ * maxSpeed;

  // Inercia física suave (aceleración y frenado progresivo)
  smoothVelocity.x = THREE.MathUtils.damp(smoothVelocity.x, targetVelX, 10, delta);
  smoothVelocity.z = THREE.MathUtils.damp(smoothVelocity.z, targetVelZ, 10, delta);

  const currentSpeed = Math.hypot(smoothVelocity.x, smoothVelocity.z);

  if (currentSpeed > 0.003) {
    const aspect = Math.min(1, window.innerWidth / window.innerHeight);
    const limitX = TABLE_LIMIT * Math.max(0.62, aspect);
    const limitZ = TABLE_LIMIT;

    characterGroup.position.x = THREE.MathUtils.clamp(
      characterGroup.position.x + smoothVelocity.x * delta,
      -limitX,
      limitX
    );
    characterGroup.position.z = THREE.MathUtils.clamp(
      characterGroup.position.z + smoothVelocity.z * delta,
      -limitZ,
      limitZ
    );

    applyCharacterPerspectiveScale();

    if (inputMag > 0.05) {
      const targetAngle = Math.atan2(inputX, inputZ);
      let diff = targetAngle - characterGroup.rotation.y;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      characterGroup.rotation.y += diff * Math.min(1, delta * 11);
    }
  }

  if (minigameActive && collectibleMesh) {
    collectibleMesh.rotation.y += delta * 2.5;
    const dist = Math.hypot(
      characterGroup.position.x - collectibleMesh.position.x,
      characterGroup.position.z - collectibleMesh.position.z
    );
    if (dist < 0.22) {
      score++;
      scoreVal.textContent = score;
      triggerChefAction('Cook');
      spawnCollectible();
    }
  }
}

// ==========================================
// 8. SUBIR FOTO Y COMPILAR MARCADOR AR
// ==========================================
async function handleCustomMarkerUpload(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  compileStatus.textContent = '⏳ Leyendo tu foto...';
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

    setTimeout(async () => {
      markerModal.classList.add('hidden');
      if (isStandalone3DMode) {
        triggerChefAction('Cook');
        statusText.textContent = '👨‍🍳 ¡Nueva imagen aplicada en la mesa!';
      } else {
        await initMindARCameraMode();
      }
    }, 600);

  } catch (err) {
    console.error('Error procesando foto:', err);
    progressFill.style.width = '100%';
    compileStatus.textContent = '✅ Foto aplicada en la Mesa 3D.';
    setTimeout(() => {
      markerModal.classList.add('hidden');
      initInteractive6DoFTableSimulator('👨‍🍳 ¡Nueva imagen aplicada en la mesa!');
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
// 9. JOYSTICK ANALÓGICO 360° Y EVENTOS UI
// ==========================================
function setupAnalogJoystick() {
  let activePointerId = null;

  const updateStick = (clientX, clientY) => {
    const rect = joystickZone.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const maxRadius = rect.width * 0.36;

    let dx = clientX - centerX;
    let dy = clientY - centerY;
    const dist = Math.hypot(dx, dy);

    if (dist > maxRadius) {
      dx = (dx / dist) * maxRadius;
      dy = (dy / dist) * maxRadius;
    }

    joystickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    joyVector.x = dx / maxRadius;
    joyVector.y = dy / maxRadius;
  };

  const resetStick = () => {
    activePointerId = null;
    joystickZone.classList.remove('active');
    joystickKnob.style.transform = 'translate(0px, 0px)';
    joyVector.x = 0;
    joyVector.y = 0;
  };

  joystickZone.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    activePointerId = e.pointerId;
    joystickZone.setPointerCapture(e.pointerId);
    joystickZone.classList.add('active');
    updateStick(e.clientX, e.clientY);
  });

  joystickZone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== activePointerId) return;
    e.preventDefault();
    updateStick(e.clientX, e.clientY);
  });

  joystickZone.addEventListener('pointerup', (e) => {
    if (e.pointerId !== activePointerId) return;
    resetStick();
  });

  joystickZone.addEventListener('pointercancel', (e) => {
    if (e.pointerId !== activePointerId) return;
    resetStick();
  });
}

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
      collectibleMesh = createSmashBurgerMesh(0.45);
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
  const dMult = getDepthPerspectiveMultiplier(rz);
  collectibleMesh.position.set(rx, 0.04 * dMult, rz);
  const s = 0.42 * dMult;
  collectibleMesh.scale.set(s, s, s);
}

function setupUIEvents() {
  setupAnalogJoystick();

  btnToggleMenu.addEventListener('click', () => {
    const isCollapsed = topDrawer.classList.toggle('collapsed');
    btnToggleMenu.classList.toggle('open', !isCollapsed);
    drawerArrow.textContent = isCollapsed ? '▾' : '▴';
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp'    || e.key === 'w' || e.key === 'W') keyState.up = true;
    if (e.key === 'ArrowDown'  || e.key === 's' || e.key === 'S') keyState.down = true;
    if (e.key === 'ArrowLeft'  || e.key === 'a' || e.key === 'A') keyState.left = true;
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keyState.right = true;
    if (e.key === ' ') triggerChefAction('Cook');
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowUp'    || e.key === 'w' || e.key === 'W') keyState.up = false;
    if (e.key === 'ArrowDown'  || e.key === 's' || e.key === 'S') keyState.down = false;
    if (e.key === 'ArrowLeft'  || e.key === 'a' || e.key === 'A') keyState.left = false;
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') keyState.right = false;
  });

  document.querySelectorAll('.action-btn[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      triggerChefAction(btn.dataset.action);
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
    setCharacterScale(currentScale - 0.03);
  });
  document.getElementById('btn-size-up').addEventListener('click', () => {
    setCharacterScale(currentScale + 0.03);
  });

  document.getElementById('btn-reset-pos').addEventListener('click', () => {
    characterGroup.position.set(0, 0, 0);
    characterGroup.rotation.y = 0;
    smoothVelocity.x = 0;
    smoothVelocity.z = 0;
    applyCharacterPerspectiveScale();
    triggerChefAction('Wave');
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

setupUIEvents();
startApp();

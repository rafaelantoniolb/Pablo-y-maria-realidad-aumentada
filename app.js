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

// Articulaciones anatómicas naturales para Pablito el Chef Chibi
const rig = {
  root: null,
  pelvis: null,
  torso: null,
  neck: null,
  head: null,
  hat: null,
  eyelidL: null,
  eyelidR: null,
  armL: null,
  forearmL: null,
  handL: null,
  armR: null,
  forearmR: null,
  handR: null,
  legL: null,
  shinL: null,
  footL: null,
  legR: null,
  shinR: null,
  footR: null,
  spatula: null,
  trayBurger: null,
  grillStation: null,
  grillBurger: null,
  emberLight: null,
  grillParticles: []
};

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

let currentScale = 0.34;
const TABLE_LIMIT = 0.85;

let minigameActive = false;
let collectibleMesh = null;
let score = 0;

let currentAction = 'Idle';
let actionTimer = 0;
let animClock = 0;
let walkCycle = 0;
let blinkTimer = 0;
let pablitoBanner = null;

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
  buildChibiPablitoChef();
  await initMindARCameraMode();
}

function enhanceRendererAndLighting(targetRenderer, targetScene) {
  targetRenderer.shadowMap.enabled = true;
  targetRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
  targetRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  targetRenderer.toneMappingExposure = 1.25;

  try {
    const pmremGenerator = new THREE.PMREMGenerator(targetRenderer);
    pmremGenerator.compileEquirectangularShader();
    const envTexture = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    targetScene.environment = envTexture;
  } catch (e) {
    console.warn('Environment map fallback:', e);
  }

  const hemiLight = new THREE.HemisphereLight(0xfffcf8, 0xc9a892, 1.9);
  targetScene.add(hemiLight);

  const keyLight = new THREE.DirectionalLight(0xfff7eb, 2.2);
  keyLight.position.set(1.8, 4.2, 4.5);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.width = 1024;
  keyLight.shadow.mapSize.height = 1024;
  targetScene.add(keyLight);

  // Luz frontal suave para que el gorro nunca oscurezca la carita de Pablito
  const faceFillLight = new THREE.DirectionalLight(0xffefe0, 1.15);
  faceFillLight.position.set(0, 1.2, 4.0);
  targetScene.add(faceFillLight);

  const rimLight = new THREE.DirectionalLight(0xffb800, 1.0);
  rimLight.position.set(-2.5, 3.0, -2.2);
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
      updateNaturalChefAnimations(delta);
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
    statusText.textContent = '🔒 ¡Pablito Re-ubicado y Fijado!';
  } else {
    tableSurfaceGroup.visible = false;
    scanGuide.classList.remove('hidden');
    statusText.textContent = '📷 Apunta de nuevo a la imagen para fijar a Pablito';
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
  statusText.textContent = customMessage || '👨‍🍳 Pablito el Chef en tu Mesa 3D — Usa el Joystick';

  triggerChefAction('Wave');

  renderer.setAnimationLoop(() => {
    const delta = Math.min(clock.getDelta(), 0.1);
    if (orbitControls) orbitControls.update();
    updateMovementOnTable(delta);
    updateNaturalChefAnimations(delta);
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
  currentScale = THREE.MathUtils.clamp(parseFloat(newScale), 0.12, 1.15);
  if (sizeSlider) sizeSlider.value = currentScale;
  applyCharacterPerspectiveScale();
}

// ==========================================
// 5. CONSTRUIR A "PABLITO EL CHEF" (PLANTILLA CHIBI OFICIAL)
// ==========================================
function createFloatingNameBanner(text = '👨‍🍳 Pablito el Chef') {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = 'rgba(18, 16, 14, 0.88)';
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
  sprite.scale.set(0.82, 0.205, 1);
  sprite.position.set(0, 1.62, 0);
  return { sprite, canvas, ctx, tex };
}

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

  const bottomBun = new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.13, 0.045, 24), bunMat);
  bottomBun.position.y = 0.022;
  burger.add(bottomBun);

  const patty1 = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.155, 0.032, 24), meatMat);
  patty1.position.y = 0.055;
  burger.add(patty1);

  const cheese1 = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.012, 0.24), cheeseMat);
  cheese1.position.y = 0.075;
  cheese1.rotation.y = Math.PI / 4;
  burger.add(cheese1);

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

  const topBun = new THREE.Mesh(new THREE.SphereGeometry(0.148, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.48), bunMat);
  topBun.position.y = 0.135;
  burger.add(topBun);

  burger.scale.set(scale, scale, scale);
  burger.traverse((c) => {
    if (c.isMesh) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
  });
  return burger;
}

function buildChibiPablitoChef() {
  // Materiales idénticos a la plantilla subida (Niño Chef Chibi "Pablito")
  // Piel durazno clara y luminosa con ligera auto-iluminación cálida para que nunca se vea oscura
  const skinMat = new THREE.MeshStandardMaterial({
    color: 0xffd6bd,
    emissive: 0xffbfa0,
    emissiveIntensity: 0.18,
    roughness: 0.42,
    metalness: 0.01
  });
  const blushMat = new THREE.MeshStandardMaterial({
    color: 0xf79486,
    emissive: 0xf79486,
    emissiveIntensity: 0.12,
    roughness: 0.5
  });
  const hairMat = new THREE.MeshStandardMaterial({ color: 0x3b2214, roughness: 0.55, metalness: 0.05 });
  const coatMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.04 });
  const coatShadeMat = new THREE.MeshStandardMaterial({ color: 0xdce8f5, roughness: 0.38 });
  const redPipingMat = new THREE.MeshStandardMaterial({ color: 0xb91c1c, roughness: 0.35, metalness: 0.08 });
  const shoeRedMat = new THREE.MeshStandardMaterial({ color: 0xd61f1f, roughness: 0.35, metalness: 0.1 });
  const pantsMat = new THREE.MeshStandardMaterial({ color: 0x36363b, roughness: 0.65 });
  const eyeWhiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.15, roughness: 0.15 });
  const irisBrownMat = new THREE.MeshStandardMaterial({ color: 0x4a2612, roughness: 0.15 });
  const pupilBlackMat = new THREE.MeshStandardMaterial({ color: 0x120a06, roughness: 0.1 });
  const teethMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.15, roughness: 0.2 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0xdde3ea, metalness: 0.85, roughness: 0.2 });
  const castIronMat = new THREE.MeshStandardMaterial({ color: 0x1e2022, metalness: 0.65, roughness: 0.4 });
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xffb800, metalness: 0.65, roughness: 0.25 });

  rig.root = new THREE.Group();
  pablitoBanner = createFloatingNameBanner('👨‍🍳 Pablito el Chef');
  rig.root.add(pablitoBanner.sprite);

  // ==========================================
  // 1) PELVIS Y CHAQUETILLA CON RIBETE ROJO + 8 BOTONES ROJOS (4x2)
  // ==========================================
  rig.pelvis = new THREE.Group();
  rig.pelvis.position.y = 0.32;
  rig.root.add(rig.pelvis);

  rig.torso = new THREE.Group();
  rig.pelvis.add(rig.torso);

  // Cuerpo de la chaquetilla blanca (ligeramente acampanada abajo como en la plantilla)
  const jacketGeo = new THREE.CylinderGeometry(0.145, 0.172, 0.32, 32);
  jacketGeo.scale(1.08, 1, 0.82);
  const jacketMesh = new THREE.Mesh(jacketGeo, coatMat);
  jacketMesh.position.y = 0.15;
  rig.torso.add(jacketMesh);

  // Hombros redondeados suaves
  const upperChestGeo = new THREE.SphereGeometry(0.156, 28, 20);
  upperChestGeo.scale(1.08, 0.6, 0.82);
  const upperChest = new THREE.Mesh(upperChestGeo, coatMat);
  upperChest.position.y = 0.285;
  rig.torso.add(upperChest);

  // Cuello Mandarin de Chef con borde rojo (idéntico a la plantilla)
  const collarWhite = new THREE.Mesh(new THREE.CylinderGeometry(0.088, 0.098, 0.055, 28), coatMat);
  collarWhite.position.y = 0.335;
  rig.torso.add(collarWhite);

  const collarRedTrim = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.008, 12, 28), redPipingMat);
  collarRedTrim.rotation.x = Math.PI / 2;
  collarRedTrim.position.y = 0.36;
  rig.torso.add(collarRedTrim);

  // Solapa frontal cruzada con ribete rojo y 2 columnas de 4 botones rojos (8 botones en total)
  const frontPanelGeo = new THREE.BoxGeometry(0.15, 0.305, 0.022);
  const frontPanel = new THREE.Mesh(frontPanelGeo, coatMat);
  frontPanel.position.set(0.006, 0.15, 0.13);
  rig.torso.add(frontPanel);

  // Líneas de ribete rojo de la solapa (izquierda, derecha y superior)
  const pipingLeft = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0055, 0.308, 12), redPipingMat);
  pipingLeft.position.set(-0.068, 0.15, 0.141);
  rig.torso.add(pipingLeft);

  const pipingRight = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0055, 0.308, 12), redPipingMat);
  pipingRight.position.set(0.08, 0.15, 0.141);
  rig.torso.add(pipingRight);

  const pipingTop = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0055, 0.15, 12), redPipingMat);
  pipingTop.rotation.z = Math.PI / 2;
  pipingTop.position.set(0.006, 0.302, 0.141);
  rig.torso.add(pipingTop);

  // 8 Botones Rojos (4 filas x 2 columnas) como en la imagen
  const btnGeo = new THREE.SphereGeometry(0.012, 14, 14);
  btnGeo.scale(1, 1, 0.6);
  const buttonYPositions = [0.265, 0.20, 0.135, 0.07];
  buttonYPositions.forEach((by) => {
    const btnL = new THREE.Mesh(btnGeo, redPipingMat);
    btnL.position.set(-0.042, by, 0.143);
    rig.torso.add(btnL);

    const btnR = new THREE.Mesh(btnGeo, redPipingMat);
    btnR.position.set(0.054, by, 0.143);
    rig.torso.add(btnR);
  });

  // ==========================================
  // 2) CUELLO Y CABEZA CHIBI GRANDE Y EXPRESIVA
  // ==========================================
  rig.neck = new THREE.Group();
  rig.neck.position.y = 0.36;
  rig.torso.add(rig.neck);

  const neckSkin = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.068, 0.06, 20), skinMat);
  neckSkin.position.y = 0.02;
  rig.neck.add(neckSkin);

  rig.head = new THREE.Group();
  rig.head.position.y = 0.245;
  rig.neck.add(rig.head);

  // Cabeza Chibi (proporción tierna y mejillas redondeadas)
  const headSphereGeo = new THREE.SphereGeometry(0.245, 36, 32);
  headSphereGeo.scale(1.08, 0.96, 0.95);
  const headMesh = new THREE.Mesh(headSphereGeo, skinMat);
  rig.head.add(headMesh);

  // Orejitas redondeadas a los lados
  const earGeo = new THREE.SphereGeometry(0.055, 20, 20);
  earGeo.scale(0.55, 0.95, 0.7);
  const earL = new THREE.Mesh(earGeo, skinMat);
  earL.position.set(-0.262, -0.02, 0.01);
  const earR = earL.clone();
  earR.position.x = 0.262;
  rig.head.add(earL, earR);

  const innerEarGeo = new THREE.SphereGeometry(0.032, 14, 14);
  innerEarGeo.scale(0.5, 0.85, 0.6);
  const innerEarL = new THREE.Mesh(innerEarGeo, blushMat);
  innerEarL.position.set(-0.272, -0.02, 0.02);
  const innerEarR = innerEarL.clone();
  innerEarR.position.x = 0.272;
  rig.head.add(innerEarL, innerEarR);

  // Ojos Grandes Chibi Marrones con doble brillo blanco (como la plantilla)
  function createChibiEye(sign) {
    const eyeGroup = new THREE.Group();
    eyeGroup.position.set(sign * 0.098, -0.01, 0.212);
    eyeGroup.rotation.y = sign * 0.16;

    // Esclerótica blanca
    const scleraGeo = new THREE.SphereGeometry(0.056, 24, 24);
    scleraGeo.scale(0.95, 1.08, 0.42);
    const sclera = new THREE.Mesh(scleraGeo, eyeWhiteMat);
    eyeGroup.add(sclera);

    // Iris marrón cálido grande
    const irisGeo = new THREE.SphereGeometry(0.043, 24, 24);
    irisGeo.scale(0.92, 1.05, 0.42);
    const iris = new THREE.Mesh(irisGeo, irisBrownMat);
    iris.position.set(-sign * 0.004, 0, 0.008);
    eyeGroup.add(iris);

    // Pupila negra profunda
    const pupilGeo = new THREE.SphereGeometry(0.028, 20, 20);
    pupilGeo.scale(0.92, 1.05, 0.42);
    const pupil = new THREE.Mesh(pupilGeo, pupilBlackMat);
    pupil.position.set(-sign * 0.004, 0, 0.014);
    eyeGroup.add(pupil);

    // Brillo especular grande arriba-izquierda + brillo pequeño abajo-derecha
    const shineBig = new THREE.Mesh(new THREE.SphereGeometry(0.013, 12, 12), eyeWhiteMat);
    shineBig.position.set(-0.014, 0.018, 0.026);
    eyeGroup.add(shineBig);

    const shineSmall = new THREE.Mesh(new THREE.SphereGeometry(0.0065, 10, 10), eyeWhiteMat);
    shineSmall.position.set(0.012, -0.014, 0.025);
    eyeGroup.add(shineSmall);

    // Pestaña superior gruesa oscura (estilo cartoon)
    const lashGeo = new THREE.TorusGeometry(0.052, 0.0075, 10, 24, Math.PI * 0.85);
    const lash = new THREE.Mesh(lashGeo, hairMat);
    lash.rotation.z = Math.PI * 0.08;
    lash.position.set(0, 0.006, 0.012);
    eyeGroup.add(lash);

    // Párpado para parpadeo natural
    const eyelidGeo = new THREE.SphereGeometry(0.058, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.55);
    eyelidGeo.scale(0.96, 1.08, 0.46);
    const eyelid = new THREE.Mesh(eyelidGeo, skinMat);
    eyelid.rotation.x = -Math.PI * 0.55;
    eyeGroup.add(eyelid);

    return { eyeGroup, eyelid };
  }

  const leftEyeObj = createChibiEye(-1);
  const rightEyeObj = createChibiEye(1);
  rig.head.add(leftEyeObj.eyeGroup, rightEyeObj.eyeGroup);
  rig.eyelidL = leftEyeObj.eyelid;
  rig.eyelidR = rightEyeObj.eyelid;

  // Cejas expresivas marrón oscuro arqueadas
  const browGeo = new THREE.CapsuleGeometry(0.012, 0.068, 10, 14);
  const browL = new THREE.Mesh(browGeo, hairMat);
  browL.position.set(-0.098, 0.075, 0.22);
  browL.rotation.z = Math.PI / 2 + 0.14;
  browL.rotation.y = -0.15;

  const browR = new THREE.Mesh(browGeo, hairMat);
  browR.position.set(0.098, 0.075, 0.22);
  browR.rotation.z = Math.PI / 2 - 0.14;
  browR.rotation.y = 0.15;
  rig.head.add(browL, browR);

  // Nariz pequeñita y redondeada de niño
  const noseGeo = new THREE.SphereGeometry(0.024, 18, 18);
  noseGeo.scale(1.25, 0.85, 0.9);
  const nose = new THREE.Mesh(noseGeo, skinMat);
  nose.position.set(0, -0.042, 0.238);
  rig.head.add(nose);

  // Mejillas sonrojadas rosadas ovaladas
  const cheekGeo = new THREE.SphereGeometry(0.038, 16, 16);
  cheekGeo.scale(1.35, 0.65, 0.35);
  const cheekL = new THREE.Mesh(cheekGeo, blushMat);
  cheekL.position.set(-0.145, -0.058, 0.205);
  cheekL.rotation.y = -0.35;
  const cheekR = cheekL.clone();
  cheekR.position.x = 0.145;
  cheekR.rotation.y = 0.35;
  rig.head.add(cheekL, cheekR);

  // Sonrisa grande y alegre con dientes blancos (SIN bigote, como en la plantilla)
  const smileGroup = new THREE.Group();
  smileGroup.position.set(0, -0.095, 0.224);

  const smileTeethGeo = new THREE.CylinderGeometry(0.062, 0.048, 0.032, 24, 1, false, -Math.PI * 0.38, Math.PI * 0.76);
  smileTeethGeo.scale(1, 1, 0.35);
  const smileTeeth = new THREE.Mesh(smileTeethGeo, teethMat);
  smileGroup.add(smileTeeth);

  const smileOutlineGeo = new THREE.TorusGeometry(0.056, 0.0045, 10, 24, Math.PI * 0.85);
  const smileOutline = new THREE.Mesh(smileOutlineGeo, hairMat);
  smileOutline.rotation.z = Math.PI * 1.075;
  smileOutline.position.set(0, 0.012, 0.012);
  smileGroup.add(smileOutline);
  rig.head.add(smileGroup);

  // ==========================================
  // 3) CABELLO CASTAÑO CON FLEQUILLO PEINADO DE LADO Y PUNTAS LATERALES
  // (Sin tapar la frente ni los ojos — despejado como en la plantilla)
  // ==========================================
  const hairGroup = new THREE.Group();
  rig.head.add(hairGroup);

  // Casco capilar que cubre SOLO la coronilla y la nuca (inclinado hacia atrás para dejar toda la cara limpia)
  const backHairGeo = new THREE.SphereGeometry(0.252, 32, 24, 0, Math.PI * 2, 0, Math.PI * 0.44);
  backHairGeo.scale(1.08, 0.96, 0.96);
  const backHair = new THREE.Mesh(backHairGeo, hairMat);
  backHair.rotation.x = -0.58;
  backHair.position.set(0, 0.03, -0.02);
  hairGroup.add(backHair);

  // Flequillo superior peinado de lado (bien arriba en la frente, por encima de las cejas)
  const bangMainGeo = new THREE.CapsuleGeometry(0.044, 0.19, 14, 20);
  bangMainGeo.scale(1, 0.85, 0.55);
  const bangMain = new THREE.Mesh(bangMainGeo, hairMat);
  bangMain.position.set(-0.015, 0.155, 0.178);
  bangMain.rotation.z = Math.PI / 2 - 0.14;
  bangMain.rotation.y = -0.08;
  hairGroup.add(bangMain);

  const bangSideGeo = new THREE.CapsuleGeometry(0.036, 0.12, 12, 16);
  bangSideGeo.scale(1, 0.85, 0.5);
  const bangSide = new THREE.Mesh(bangSideGeo, hairMat);
  bangSide.position.set(-0.115, 0.142, 0.165);
  bangSide.rotation.z = Math.PI / 2 - 0.28;
  bangSide.rotation.y = -0.32;
  hairGroup.add(bangSide);

  // Mechones puntiagudos que salen a la derecha bajo el gorro (rasgo icónico de la plantilla)
  const spike1Geo = new THREE.ConeGeometry(0.045, 0.135, 16);
  spike1Geo.scale(1, 1, 0.55);
  const spike1 = new THREE.Mesh(spike1Geo, hairMat);
  spike1.position.set(0.24, 0.14, 0.07);
  spike1.rotation.z = -1.25;
  spike1.rotation.y = -0.25;
  hairGroup.add(spike1);

  const spike2 = new THREE.Mesh(spike1Geo, hairMat);
  spike2.scale.set(0.82, 0.82, 0.5);
  spike2.position.set(0.22, 0.10, 0.10);
  spike2.rotation.z = -1.4;
  hairGroup.add(spike2);

  // Patillas cortas junto a las orejas (sin invadir las mejillas)
  const sideburnGeo = new THREE.CapsuleGeometry(0.018, 0.065, 10, 12);
  const sideburnL = new THREE.Mesh(sideburnGeo, hairMat);
  sideburnL.position.set(-0.242, 0.055, 0.06);
  sideburnL.rotation.z = 0.12;
  const sideburnR = sideburnL.clone();
  sideburnR.position.x = 0.242;
  sideburnR.rotation.z = -0.12;
  hairGroup.add(sideburnL, sideburnR);

  // ==========================================
  // 4) GORRO DE CHEF ABOMBADO EN NUBE (TOQUE BLANCHE DE LA PLANTILLA)
  // ==========================================
  rig.hat = new THREE.Group();
  rig.hat.position.set(0, 0.185, -0.01);
  rig.hat.rotation.z = -0.03; // Ligera inclinación simpática como el dibujo
  rig.head.add(rig.hat);

  // Banda cilíndrica blanca alta y limpia sobre la frente
  const hatBandGeo = new THREE.CylinderGeometry(0.235, 0.222, 0.145, 32);
  hatBandGeo.scale(1.06, 1, 0.92);
  const hatBand = new THREE.Mesh(hatBandGeo, coatMat);
  hatBand.position.y = 0.07;
  rig.hat.add(hatBand);

  // Corona tipo nube esponjosa con gajos redondeados (8 lóbulos blancos + centro)
  const puffCloudGroup = new THREE.Group();
  puffCloudGroup.position.y = 0.20;
  rig.hat.add(puffCloudGroup);

  const centerPuff = new THREE.Mesh(new THREE.SphereGeometry(0.22, 28, 22), coatMat);
  centerPuff.scale.set(1.35, 0.68, 1.12);
  centerPuff.position.y = 0.02;
  puffCloudGroup.add(centerPuff);

  const numLobes = 8;
  for (let i = 0; i < numLobes; i++) {
    const angle = (i / numLobes) * Math.PI * 2;
    const lobe = new THREE.Mesh(new THREE.SphereGeometry(0.125, 22, 18), i % 2 === 0 ? coatMat : coatShadeMat);
    lobe.scale.set(1.15, 0.95, 1.15);
    lobe.position.set(
      Math.cos(angle) * 0.185,
      0.01,
      Math.sin(angle) * 0.145
    );
    puffCloudGroup.add(lobe);
  }

  // ==========================================
  // 5) BRAZOS ARTICULADOS VISIBLES CON MANGAS ARREMANGADAS Y MANOS NATURALES
  // ==========================================
  function createChefArm(sign) {
    const shoulder = new THREE.Group();
    // Hombros más separados del torso para que los brazos se vean completos y definidos
    shoulder.position.set(sign * 0.188, 0.275, 0.015);

    const shoulderBall = new THREE.Mesh(new THREE.SphereGeometry(0.056, 20, 20), coatMat);
    shoulder.add(shoulderBall);

    const upperArm = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.047, 0.145, 20), coatMat);
    upperArm.position.y = -0.072;
    shoulder.add(upperArm);

    const elbow = new THREE.Group();
    elbow.position.y = -0.145;
    shoulder.add(elbow);

    const elbowJoint = new THREE.Mesh(new THREE.SphereGeometry(0.046, 18, 18), coatMat);
    elbow.add(elbowJoint);

    const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.043, 0.125, 20), coatMat);
    forearm.position.y = -0.062;
    elbow.add(forearm);

    // Puño blanco doblado (arremangado con borde azulado suave como en la plantilla)
    const rolledCuff = new THREE.Mesh(new THREE.TorusGeometry(0.046, 0.015, 14, 22), coatShadeMat);
    rolledCuff.rotation.x = Math.PI / 2;
    rolledCuff.position.y = -0.118;
    elbow.add(rolledCuff);

    const hand = new THREE.Group();
    hand.position.y = -0.15;
    elbow.add(hand);

    const palmGeo = new THREE.SphereGeometry(0.045, 20, 20);
    palmGeo.scale(1.05, 1.08, 0.85);
    const palm = new THREE.Mesh(palmGeo, skinMat);
    hand.add(palm);

    const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.013, 0.024, 8, 8), skinMat);
    thumb.position.set(-sign * 0.036, 0.006, 0.02);
    thumb.rotation.z = sign * 0.6;
    hand.add(thumb);

    return { shoulder, elbow, hand };
  }

  const leftArmObj = createChefArm(-1);
  const rightArmObj = createChefArm(1);
  rig.torso.add(leftArmObj.shoulder, rightArmObj.shoulder);
  rig.armL = leftArmObj.shoulder;
  rig.forearmL = leftArmObj.elbow;
  rig.handL = leftArmObj.hand;
  rig.armR = rightArmObj.shoulder;
  rig.forearmR = rightArmObj.elbow;
  rig.handR = rightArmObj.hand;

  // Espátula en la mano derecha (visible al cocinar)
  rig.spatula = new THREE.Group();
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.11, 12), hairMat);
  handle.rotation.x = Math.PI / 2;
  handle.position.z = 0.04;
  rig.spatula.add(handle);

  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.068, 0.004, 0.085), steelMat);
  blade.position.z = 0.13;
  rig.spatula.add(blade);
  rig.spatula.visible = false;
  rig.handR.add(rig.spatula);

  // Bandeja con burger en la mano izquierda (visible en Súper/Fin del show)
  rig.trayBurger = new THREE.Group();
  const miniBurger = createSmashBurgerMesh(0.45);
  miniBurger.position.set(0, 0.02, 0.04);
  rig.trayBurger.add(miniBurger);
  rig.trayBurger.visible = false;
  rig.handL.add(rig.trayBurger);

  // ==========================================
  // 6) PIERNAS GRIS CARBÓN CON DOBLADILLO Y ZAPATILLAS ROJAS (DE LA PLANTILLA)
  // ==========================================
  function createChefLeg(sign) {
    const hip = new THREE.Group();
    hip.position.set(sign * 0.068, 0.02, 0);

    const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.056, 0.048, 0.15, 20), pantsMat);
    thigh.position.y = -0.075;
    hip.add(thigh);

    const knee = new THREE.Group();
    knee.position.y = -0.15;
    hip.add(knee);

    const kneeJoint = new THREE.Mesh(new THREE.SphereGeometry(0.047, 16, 16), pantsMat);
    knee.add(kneeJoint);

    const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.052, 0.14, 20), pantsMat);
    shin.position.y = -0.07;
    knee.add(shin);

    // Dobladillo inferior del pantalón
    const pantCuff = new THREE.Mesh(new THREE.TorusGeometry(0.049, 0.010, 10, 20), pantsMat);
    pantCuff.rotation.x = Math.PI / 2;
    pantCuff.position.y = -0.135;
    knee.add(pantCuff);

    const ankle = new THREE.Group();
    ankle.position.y = -0.145;
    knee.add(ankle);

    // Zapatilla Roja Brillante como en la imagen de Pablito
    const shoeGeo = new THREE.SphereGeometry(0.056, 20, 16);
    shoeGeo.scale(1.02, 0.62, 1.48);
    const shoe = new THREE.Mesh(shoeGeo, shoeRedMat);
    shoe.position.set(0, -0.012, 0.028);
    ankle.add(shoe);

    // Suela inferior oscura/blanca
    const soleGeo = new THREE.CylinderGeometry(0.056, 0.058, 0.014, 20);
    soleGeo.scale(1.0, 1, 1.45);
    const sole = new THREE.Mesh(soleGeo, coatMat);
    sole.position.set(0, -0.036, 0.028);
    ankle.add(sole);

    return { hip, knee, ankle };
  }

  const leftLegObj = createChefLeg(-1);
  const rightLegObj = createChefLeg(1);
  rig.pelvis.add(leftLegObj.hip, rightLegObj.hip);
  rig.legL = leftLegObj.hip;
  rig.shinL = leftLegObj.knee;
  rig.footL = leftLegObj.ankle;
  rig.legR = rightLegObj.hip;
  rig.shinR = rightLegObj.knee;
  rig.footR = rightLegObj.ankle;

  // ==========================================
  // 7) ESTACIÓN DE PARRILLA SMASH PRO (CON FUEGO Y HUMO)
  // ==========================================
  rig.grillStation = new THREE.Group();
  rig.grillStation.position.set(0, 0, 0.42);
  rig.grillStation.visible = false;
  rig.grillStation.scale.set(0.01, 0.01, 0.01);

  const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.23, 0.34, 24), castIronMat);
  stand.position.y = 0.17;
  rig.grillStation.add(stand);

  const standGold = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.025, 24), goldMat);
  standGold.position.y = 0.30;
  rig.grillStation.add(standGold);

  const griddlePlate = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.035, 0.3), castIronMat);
  griddlePlate.position.y = 0.35;
  rig.grillStation.add(griddlePlate);

  const emberMat = new THREE.MeshBasicMaterial({ color: 0xff4500 });
  const emberGlow = new THREE.Mesh(new THREE.PlaneGeometry(0.35, 0.23), emberMat);
  emberGlow.rotation.x = -Math.PI / 2;
  emberGlow.position.y = 0.369;
  rig.grillStation.add(emberGlow);

  rig.emberLight = new THREE.PointLight(0xff6b00, 0, 1.8);
  rig.emberLight.position.set(0, 0.5, 0);
  rig.grillStation.add(rig.emberLight);

  rig.grillBurger = createSmashBurgerMesh(0.55);
  rig.grillBurger.position.set(0, 0.37, 0);
  rig.grillStation.add(rig.grillBurger);

  for (let i = 0; i < 24; i++) {
    const isSmoke = i >= 15;
    const pGeo = isSmoke
      ? new THREE.SphereGeometry(0.032, 10, 10)
      : new THREE.OctahedronGeometry(0.016, 0);
    const pMat = new THREE.MeshBasicMaterial({
      color: isSmoke ? 0xfff8f0 : (i % 2 === 0 ? 0xffb800 : 0xff3838),
      transparent: true,
      opacity: 0.85
    });
    const pMesh = new THREE.Mesh(pGeo, pMat);
    resetGrillParticle(pMesh, isSmoke);
    rig.grillStation.add(pMesh);
    rig.grillParticles.push({ mesh: pMesh, isSmoke, speedY: 0.32 + Math.random() * 0.42, phase: Math.random() * 6.28 });
  }

  rig.root.add(rig.grillStation);

  rig.root.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });

  characterGroup.add(rig.root);
}

function resetGrillParticle(mesh, isSmoke) {
  mesh.position.set(
    (Math.random() - 0.5) * 0.28,
    0.38 + Math.random() * 0.05,
    (Math.random() - 0.5) * 0.18
  );
  const s = isSmoke ? 0.5 : 0.85;
  mesh.scale.set(s, s, s);
}

// ==========================================
// 6. SISTEMA DE ANIMACIÓN HUMANOIDE FLUIDA Y NATURAL
// ==========================================
// Convención anatómica verificada:
// - arm.rotation.x NEGATIVO = levanta el brazo hacia ADELANTE (frente al pecho/cara).
// - arm.rotation.x POSITIVO = lleva el brazo ligeramente hacia atrás.
// - armL.rotation.z POSITIVO = separa el brazo izquierdo del cuerpo hacia afuera.
// - armR.rotation.z NEGATIVO = separa el brazo derecho del cuerpo hacia afuera.
// - shin.rotation.x POSITIVO = dobla la rodilla naturalmente hacia atrás.

function triggerChefAction(actionName) {
  currentAction = actionName;
  if (actionName === 'Cook') {
    actionTimer = 3.5;
    rig.grillStation.visible = true;
    updatePablitoBannerText('🔥 ¡Smash Burger P&M!');
  } else if (actionName === 'Wave') {
    actionTimer = 2.4;
    updatePablitoBannerText('👋 ¡Hola! Soy Pablito');
  } else if (actionName === 'Dance') {
    actionTimer = 3.2;
    updatePablitoBannerText('💃 ¡Pablito con sabor!');
  } else if (actionName === 'Jump') {
    actionTimer = 1.15;
    updatePablitoBannerText('🎉 ¡Arriba Pablo & María!');
  } else {
    actionTimer = 0;
    updatePablitoBannerText('👨‍🍳 Pablito el Chef');
  }
}

function dampRot(joint, tx, ty, tz, lambda, delta) {
  joint.rotation.x = THREE.MathUtils.damp(joint.rotation.x, tx, lambda, delta);
  joint.rotation.y = THREE.MathUtils.damp(joint.rotation.y, ty, lambda, delta);
  joint.rotation.z = THREE.MathUtils.damp(joint.rotation.z, tz, lambda, delta);
}

function updateNaturalChefAnimations(delta) {
  if (!rig.root) return;
  animClock += delta;
  blinkTimer += delta;

  if (actionTimer > 0) {
    actionTimer -= delta;
    if (actionTimer <= 0) {
      const speed = Math.hypot(smoothVelocity.x, smoothVelocity.z);
      currentAction = speed > 0.015 ? (isTurbo ? 'Running' : 'Walking') : 'Idle';
      updatePablitoBannerText('👨‍🍳 Pablito el Chef');
    }
  }

  // Parpadeo natural cada 3.6 segundos
  const isBlinking = (blinkTimer % 3.6) > 3.46;
  const targetLidRot = isBlinking ? -0.05 : -Math.PI * 0.55;
  if (rig.eyelidL && rig.eyelidR) {
    rig.eyelidL.rotation.x = THREE.MathUtils.damp(rig.eyelidL.rotation.x, targetLidRot, 28, delta);
    rig.eyelidR.rotation.x = THREE.MathUtils.damp(rig.eyelidR.rotation.x, targetLidRot, 28, delta);
  }

  const isCooking = currentAction === 'Cook';
  rig.spatula.visible = isCooking;
  rig.trayBurger.visible = false;

  const targetGrillScale = isCooking ? 1 : 0.001;
  const gs = THREE.MathUtils.damp(rig.grillStation.scale.x, targetGrillScale, 12, delta);
  rig.grillStation.scale.set(gs, gs, gs);
  if (gs < 0.02 && !isCooking) rig.grillStation.visible = false;

  if (rig.emberLight) {
    rig.emberLight.intensity = isCooking ? 2.4 + Math.sin(animClock * 18) * 0.7 : 0;
  }

  if (isCooking) {
    const flipPhase = (animClock * 2.2) % 1;
    const burgerArc = Math.sin(flipPhase * Math.PI);
    rig.grillBurger.position.y = 0.37 + Math.max(0, burgerArc) * 0.28;
    rig.grillBurger.rotation.x = flipPhase * Math.PI * 2;
    rig.grillBurger.rotation.y = animClock * 2.5;

    rig.grillParticles.forEach((p) => {
      p.mesh.position.y += p.speedY * delta;
      p.mesh.position.x += Math.sin(animClock * 5 + p.phase) * 0.08 * delta;
      p.mesh.rotation.y += delta * 4;
      if (p.isSmoke) {
        const s = p.mesh.scale.x + delta * 0.6;
        p.mesh.scale.set(s, s, s);
      }
      if (p.mesh.position.y > (p.isSmoke ? 0.78 : 0.62)) {
        resetGrillParticle(p.mesh, p.isSmoke);
      }
    });
  }

  // Poses objetivo por articulación (todas dentro de límites anatómicos humanos)
  const sm = 14;
  let pelvisY = 0.32;
  let pelvisRot = [0, 0, 0];
  let torsoRot = [0, 0, 0];
  let headRot = [0, 0, 0];
  let armLRot = [0, 0, 0];
  let forearmLRot = [0, 0, 0];
  let armRRot = [0, 0, 0];
  let forearmRRot = [0, 0, 0];
  let legLRot = [0, 0, 0];
  let shinLRot = [0, 0, 0];
  let footLRot = [0, 0, 0];
  let legRRot = [0, 0, 0];
  let shinRRot = [0, 0, 0];
  let footRRot = [0, 0, 0];

  if (currentAction === 'Walking' || currentAction === 'Running') {
    const isRun = currentAction === 'Running';
    const speedFactor = isRun ? 11.5 : 7.5;
    walkCycle += delta * speedFactor;

    const stride = isRun ? 0.58 : 0.38;
    const bounce = Math.abs(Math.sin(walkCycle)) * (isRun ? 0.038 : 0.018);
    pelvisY = 0.32 + bounce;

    // Balanceo natural de cadera y contrarrotación de torso
    pelvisRot = [0, Math.sin(walkCycle) * 0.08, Math.cos(walkCycle) * 0.03];
    torsoRot = [isRun ? 0.10 : 0.04, -Math.sin(walkCycle) * 0.10, 0];
    headRot = [Math.sin(walkCycle * 2) * 0.03, Math.sin(walkCycle) * 0.05, 0];

    // Piernas: cuando una va adelante (negativo X), la otra va atrás (positivo X)
    // Rodillas (shin): SOLO doblan hacia atrás (positivo X) cuando el pie se levanta
    const swingL = Math.sin(walkCycle) * stride;
    const swingR = -Math.sin(walkCycle) * stride;
    const kneeBendL = Math.max(0, -Math.cos(walkCycle)) * (isRun ? 0.78 : 0.48) + 0.06;
    const kneeBendR = Math.max(0, Math.cos(walkCycle)) * (isRun ? 0.78 : 0.48) + 0.06;

    legLRot = [swingL, 0, -0.02];
    shinLRot = [kneeBendL, 0, 0];
    footLRot = [-swingL * 0.35, 0, 0];

    legRRot = [swingR, 0, 0.02];
    shinRRot = [kneeBendR, 0, 0];
    footRRot = [-swingR * 0.35, 0, 0];

    // Brazos: balanceo natural opuesto a las piernas (nunca giran hacia atrás de forma antinatural)
    // Codos siempre ligeramente flexionados hacia adelante (-0.35 rad) y separados del cuerpo
    const armSwingL = -Math.sin(walkCycle) * (isRun ? 0.45 : 0.28);
    const armSwingR = Math.sin(walkCycle) * (isRun ? 0.45 : 0.28);

    armLRot = [armSwingL - 0.08, 0, -0.28];
    forearmLRot = [isRun ? -0.65 : -0.35, 0, 0.12];

    armRRot = [armSwingR - 0.08, 0, 0.28];
    forearmRRot = [isRun ? -0.65 : -0.35, 0, -0.12];

  } else if (currentAction === 'Wave') {
    // 👋 SALUDAR NATURAL:
    // Mano derecha se levanta AL FRENTE y ARRIBA (nunca hacia atrás) y saluda de lado a lado.
    // Mano izquierda en la cintura con el codo hacia afuera (como en la plantilla).
    const waveOsc = Math.sin(animClock * 11);
    pelvisY = 0.32 + Math.sin(animClock * 3) * 0.006;
    torsoRot = [0, -0.08, 0.03];
    headRot = [0.02, 0.08, -0.06];

    // Brazo izquierdo en jarra (codo hacia afuera -Z, antebrazo hacia la cintura +Z)
    armLRot = [-0.12, 0, -0.68];
    forearmLRot = [-0.35, 0, 1.05];

    // Brazo derecho levantado hacia adelante y hacia afuera (+Z), antebrazo arriba saludando
    armRRot = [-0.65, 0.15, 0.85];
    forearmRRot = [-1.10, 0, 0.55 + waveOsc * 0.32];

    legLRot = [0, 0, -0.04];
    legRRot = [0, 0, 0.04];

  } else if (currentAction === 'Cook') {
    // 🔥 COCINAR EN LA PARRILLA SMASH:
    // Ambos brazos al frente sobre la plancha; la mano derecha voltea la burger con la espátula
    const flipCycle = animClock * 8.5;
    pelvisY = 0.315 + Math.abs(Math.sin(flipCycle)) * 0.012;
    torsoRot = [0.12, Math.sin(flipCycle * 0.5) * 0.08, 0];
    headRot = [0.14, Math.sin(flipCycle * 0.5) * 0.08, 0];

    // Brazo izquierdo al frente sazonando
    armLRot = [-0.65 + Math.sin(flipCycle) * 0.12, -0.15, -0.32];
    forearmLRot = [-0.68, 0, 0.25];

    // Brazo derecho al frente manejando la espátula sobre la parrilla
    armRRot = [-0.75 - Math.abs(Math.sin(flipCycle)) * 0.25, 0.12, 0.32];
    forearmRRot = [-0.72 + Math.cos(flipCycle) * 0.28, 0, -0.25];

    legLRot = [0, 0, -0.05];
    legRRot = [0, 0, 0.05];

  } else if (currentAction === 'Dance') {
    // 💃 BAILE DIVERTIDO Y NATURAL:
    const beat = animClock * 7.5;
    pelvisY = 0.305 + Math.abs(Math.sin(beat * 2)) * 0.032;
    pelvisRot = [0, Math.sin(beat) * 0.18, Math.sin(beat) * 0.08];
    torsoRot = [0.04, -Math.sin(beat) * 0.15, -Math.sin(beat) * 0.06];
    headRot = [Math.abs(Math.sin(beat * 2)) * 0.06, Math.sin(beat) * 0.14, Math.sin(beat) * 0.08];

    // Brazos abiertos hacia afuera y adelante llevando el ritmo
    armLRot = [-0.55 + Math.sin(beat) * 0.35, 0, -0.55 - Math.cos(beat) * 0.18];
    forearmLRot = [-0.85, 0, 0.25];

    armRRot = [-0.55 - Math.sin(beat) * 0.35, 0, 0.55 - Math.cos(beat) * 0.18];
    forearmRRot = [-0.85, 0, -0.25];

    legLRot = [-Math.max(0, Math.sin(beat)) * 0.32, 0, -0.05];
    shinLRot = [Math.max(0, Math.sin(beat)) * 0.55, 0, 0];

    legRRot = [-Math.max(0, -Math.sin(beat)) * 0.32, 0, 0.05];
    shinRRot = [Math.max(0, -Math.sin(beat)) * 0.55, 0, 0];

  } else if (currentAction === 'Jump') {
    // 🦘 SALTO DE ALEGRÍA:
    const progress = 1 - Math.max(0, actionTimer / 1.15);
    const jumpArc = Math.sin(progress * Math.PI);
    pelvisY = 0.32 + jumpArc * 0.24;
    torsoRot = [-0.06 * jumpArc, 0, 0];
    headRot = [-0.08 * jumpArc, 0, 0];

    // Brazos abiertos hacia afuera y arriba celebrando
    armLRot = [-1.15 * jumpArc, 0, -0.65 * jumpArc - 0.25];
    forearmLRot = [-0.45, 0, 0];

    armRRot = [-1.15 * jumpArc, 0, 0.65 * jumpArc + 0.25];
    forearmRRot = [-0.45, 0, 0];

    legLRot = [-0.25 * jumpArc, 0, -0.06];
    shinLRot = [0.55 * jumpArc, 0, 0];
    legRRot = [-0.25 * jumpArc, 0, 0.06];
    shinRRot = [0.55 * jumpArc, 0, 0];

  } else {
    // 👨‍🍳 POSE IDLE (REPOSO):
    // Pose con manos en la cintura y codos BIEN ABIERTOS hacia afuera como la plantilla de Pablito
    const breath = Math.sin(animClock * 2.4);
    const lookCycle = Math.sin(animClock * 1.1);

    pelvisY = 0.32 + breath * 0.005;
    torsoRot = [breath * 0.015, lookCycle * 0.04, 0];
    headRot = [breath * 0.02, lookCycle * 0.09, Math.sin(animClock * 0.8) * 0.03];

    // Brazos en jarra: hombro abre el codo hacia afuera (-Z en izq, +Z en der)
    // y el antebrazo dobla hacia adentro (+Z en izq, -Z en der) apoyando las manos en la cintura
    armLRot = [-0.14, 0, -0.68 - breath * 0.03];
    forearmLRot = [-0.35, 0, 1.08];

    armRRot = [-0.14, 0, 0.68 + breath * 0.03];
    forearmRRot = [-0.35, 0, -1.08];

    legLRot = [0, 0, -0.035];
    shinLRot = [0.03, 0, 0];
    legRRot = [0, 0, 0.035];
    shinRRot = [0.03, 0, 0];
  }

  // Aplicar interpolación exponencial amortiguada (sin tirones ni cortes bruscos)
  rig.pelvis.position.y = THREE.MathUtils.damp(rig.pelvis.position.y, pelvisY, sm, delta);
  dampRot(rig.pelvis, pelvisRot[0], pelvisRot[1], pelvisRot[2], sm, delta);
  dampRot(rig.torso, torsoRot[0], torsoRot[1], torsoRot[2], sm, delta);
  dampRot(rig.head, headRot[0], headRot[1], headRot[2], sm, delta);

  dampRot(rig.armL, armLRot[0], armLRot[1], armLRot[2], sm, delta);
  dampRot(rig.forearmL, forearmLRot[0], forearmLRot[1], forearmLRot[2], sm, delta);

  dampRot(rig.armR, armRRot[0], armRRot[1], armRRot[2], sm, delta);
  dampRot(rig.forearmR, forearmRRot[0], forearmRRot[1], forearmRRot[2], sm, delta);

  dampRot(rig.legL, legLRot[0], legLRot[1], legLRot[2], sm, delta);
  dampRot(rig.shinL, shinLRot[0], shinLRot[1], shinLRot[2], sm, delta);
  dampRot(rig.footL, footLRot[0], footLRot[1], footLRot[2], sm, delta);

  dampRot(rig.legR, legRRot[0], legRRot[1], legRRot[2], sm, delta);
  dampRot(rig.shinR, shinRRot[0], shinRRot[1], shinRRot[2], sm, delta);
  dampRot(rig.footR, footRRot[0], footRRot[1], footRRot[2], sm, delta);
}

// ==========================================
// 7. MOVIMIENTO FLUIDO 360° CON JOYSTICK E INERCIA
// ==========================================
function updateMovementOnTable(delta) {
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
  const scaleRatio = THREE.MathUtils.clamp(currentScale / 0.34, 0.5, 1.5);
  const maxSpeed = (isTurbo ? 0.34 : 0.17) * scaleRatio * THREE.MathUtils.clamp(depthMult, 0.55, 1.35);

  const targetVelX = inputX * maxSpeed;
  const targetVelZ = inputZ * maxSpeed;

  smoothVelocity.x = THREE.MathUtils.damp(smoothVelocity.x, targetVelX, 10, delta);
  smoothVelocity.z = THREE.MathUtils.damp(smoothVelocity.z, targetVelZ, 10, delta);

  const currentSpeed = Math.hypot(smoothVelocity.x, smoothVelocity.z);

  if (currentSpeed > 0.004 && inputMag > 0.04) {
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

    const targetAngle = Math.atan2(inputX, inputZ);
    let diff = targetAngle - characterGroup.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    characterGroup.rotation.y += diff * Math.min(1, delta * 11);

    if (actionTimer <= 0) {
      currentAction = isTurbo || inputMag > 0.88 ? 'Running' : 'Walking';
    }
  } else {
    if ((currentAction === 'Walking' || currentAction === 'Running') && actionTimer <= 0) {
      currentAction = 'Idle';
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
    setCharacterScale(currentScale - 0.05);
  });
  document.getElementById('btn-size-up').addEventListener('click', () => {
    setCharacterScale(currentScale + 0.05);
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

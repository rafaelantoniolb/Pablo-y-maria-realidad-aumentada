import * as THREE from 'three';
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
const btnToggleMenu = document.getElementById('btn-toggle-menu');
const topDrawer = document.getElementById('top-drawer');
const drawerArrow = document.getElementById('drawer-arrow');
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

const poseTracker = new THREE.Group();
const trackedPos = new THREE.Vector3();
const trackedQuat = new THREE.Quaternion();
const trackedScale = new THREE.Vector3();

const tableSurfaceGroup = new THREE.Group();
const characterGroup = new THREE.Group();
let restaurantTableMeshGroup = null;
let cardMeshOnTable = null;

// Articulaciones del Chef 3D de Pablo & María
const chefParts = {
  root: new THREE.Group(),
  torso: new THREE.Group(),
  head: new THREE.Group(),
  hat: new THREE.Group(),
  leftArm: new THREE.Group(),
  rightArm: new THREE.Group(),
  leftLeg: new THREE.Group(),
  rightLeg: new THREE.Group(),
  burgerOnSpatula: new THREE.Group()
};

let currentAnimState = 'Idle';
let animTimer = 0;
let oneShotTimer = 0;

const moveState = { up: false, down: false, left: false, right: false };
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

// Escala base del Chef (0.18 ideal para pantalla de celular) regulable entre 0.08 y 0.55
let currentScale = 0.18;
const TABLE_LIMIT = 0.85;

let minigameActive = false;
let collectibleMesh = null;
let score = 0;

// Calcula el multiplicador de perspectiva según qué tan lejos (z negativo) o cerca (z positivo) esté en la mesa
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
  buildChefCharacter();
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

      statusText.textContent = '🔒 ¡Chef Fijado! Mueve las flechas en tu mesa';
      statusText.style.color = '#ffb800';
    };

    anchor.onTargetLost = () => {
      isMarkerVisible = false;
      if (hasBeenFoundOnce) {
        isLockedOnScreen = true;
        tableSurfaceGroup.visible = true;
        scanGuide.classList.add('hidden');
        statusText.textContent = '👨‍🍳 Chef Fijo en tu mesa — Usa las flechas';
        statusText.style.color = '#ffb800';
      } else {
        scanGuide.classList.remove('hidden');
        statusText.textContent = '📷 Apunta al marcador de tu mesa';
        statusText.style.color = '#ffb800';
      }
    };

    await mindarThree.start();
    scanGuide.classList.remove('hidden');
    btnPinMode.textContent = '🪑 Mesa 3D';
    btnPinMode.classList.remove('active');
    statusText.textContent = '📷 Apunta a tu mesa para desplegar al Chef';

    renderer.setAnimationLoop(() => {
      const delta = clock.getDelta();

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
          statusText.textContent = '🔒 ¡Chef Fijado! Ya no se pierde al mover la cámara';
        }
      }

      updateMovementOnTable(delta);
      updateChefAnimation(delta);
      renderer.render(scene, camera);
    });
  } catch (err) {
    console.warn('No se pudo abrir la cámara para MindAR, activando Mesa 3D:', err);
    initInteractive6DoFTableSimulator(
      '👨‍🍳 Mesa 3D Pablo & María — Mueve al Chef con las flechas'
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
  scene.background = new THREE.Color(0x12100e);

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
  statusText.textContent = customMessage || '👨‍🍳 Mesa 3D Activa — Gira con el dedo y mueve con las flechas';

  triggerChefAction('Wave');

  renderer.setAnimationLoop(() => {
    const delta = clock.getDelta();
    if (orbitControls) orbitControls.update();
    updateMovementOnTable(delta);
    updateChefAnimation(delta);
    renderer.render(scene, camera);
  });
}

function setupLights(targetScene) {
  const ambientLight = new THREE.HemisphereLight(0xfff8f0, 0x3d2b1f, 2.1);
  targetScene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xfff0d4, 2.8);
  dirLight.position.set(2, 5, 3);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 1024;
  dirLight.shadow.mapSize.height = 1024;
  targetScene.add(dirLight);
}

// ==========================================
// 4. CONSTRUIR LA MESA (LIMPIA, SIN RAYAS DEBAJO DEL CHEF)
// ==========================================
function buildTableSurfaceElements() {
  const shadowGeo = new THREE.PlaneGeometry(3, 3);
  const shadowMat = new THREE.ShadowMaterial({ opacity: 0.38 });
  const shadowPlane = new THREE.Mesh(shadowGeo, shadowMat);
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.receiveShadow = true;
  tableSurfaceGroup.add(shadowPlane);

  restaurantTableMeshGroup = new THREE.Group();

  const woodGeo = new THREE.BoxGeometry(2.2, 0.12, 2.2);
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x3b2314, roughness: 0.65 });
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
// 5. CONSTRUIR EL CHEF 3D ARTICULADO DE PABLO & MARÍA
// ==========================================
function createSmashBurgerMesh(scale = 1) {
  const burger = new THREE.Group();
  const bunMat = new THREE.MeshStandardMaterial({ color: 0xd9822b, roughness: 0.5 });
  const meatMat = new THREE.MeshStandardMaterial({ color: 0x4a2511, roughness: 0.85 });
  const cheeseMat = new THREE.MeshStandardMaterial({ color: 0xffb800, roughness: 0.3 });
  const lettuceMat = new THREE.MeshStandardMaterial({ color: 0x4cd137, roughness: 0.6 });

  const bottomBun = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.13, 0.05, 20), bunMat);
  bottomBun.position.y = 0.025;
  burger.add(bottomBun);

  const patty1 = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.04, 20), meatMat);
  patty1.position.y = 0.065;
  burger.add(patty1);

  const cheese = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.015, 0.24), cheeseMat);
  cheese.position.y = 0.09;
  cheese.rotation.y = Math.PI / 4;
  burger.add(cheese);

  const lettuce = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.15, 0.02, 16), lettuceMat);
  lettuce.position.y = 0.105;
  burger.add(lettuce);

  const topBun = new THREE.Mesh(new THREE.SphereGeometry(0.145, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2), bunMat);
  topBun.position.y = 0.11;
  burger.add(topBun);

  burger.scale.set(scale, scale, scale);
  burger.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
  return burger;
}

function buildChefCharacter() {
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45 });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xffcba4, roughness: 0.55 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1e1b18, roughness: 0.7 });
  const redMat = new THREE.MeshStandardMaterial({ color: 0xe63946, roughness: 0.4 });
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xffb800, metalness: 0.4, roughness: 0.3 });
  const mustacheMat = new THREE.MeshStandardMaterial({ color: 0x3b2219, roughness: 0.6 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0xd1d8e0, metalness: 0.8, roughness: 0.2 });

  // 1) TORSO (Chaquetilla blanca cruzada de Chef + Delantal + Pañuelo rojo)
  const jacket = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.33, 0.68, 24), whiteMat);
  jacket.position.y = 0.72;
  chefParts.torso.add(jacket);

  // Delantal oscuro estilo gastropub Pablo & María
  const apron = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.34, 0.42, 24, 1, false, -Math.PI * 0.45, Math.PI * 0.9), darkMat);
  apron.position.y = 0.58;
  chefParts.torso.add(apron);

  // Cinta dorada en el delantal
  const apronBand = new THREE.Mesh(new THREE.CylinderGeometry(0.295, 0.3, 0.04, 24, 1, false, -Math.PI * 0.45, Math.PI * 0.9), goldMat);
  apronBand.position.y = 0.76;
  chefParts.torso.add(apronBand);

  // Pañuelo rojo de Chef en el cuello
  const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.055, 12, 24), redMat);
  scarf.rotation.x = Math.PI / 2;
  scarf.position.y = 1.05;
  chefParts.torso.add(scarf);

  const scarfKnot = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.16, 12), redMat);
  scarfKnot.position.set(0, 0.98, 0.25);
  scarfKnot.rotation.x = Math.PI;
  chefParts.torso.add(scarfKnot);

  // Doble fila de botones negros de chef en el pecho
  for (let row = 0; row < 3; row++) {
    [-0.08, 0.08].forEach((xOff) => {
      const btn = new THREE.Mesh(new THREE.SphereGeometry(0.025, 10, 10), darkMat);
      btn.position.set(xOff, 0.82 - row * 0.11, 0.29);
      chefParts.torso.add(btn);
    });
  }

  // 2) CABEZA Y GORRO DE CHEF (Toque Blanche)
  chefParts.head.position.set(0, 1.32, 0);

  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.26, 24, 24), skinMat);
  chefParts.head.add(headMesh);

  // Ojos expresivos
  [-0.09, 0.09].forEach((xPos) => {
    const eyeWhite = new THREE.Mesh(new THREE.SphereGeometry(0.042, 12, 12), whiteMat);
    eyeWhite.position.set(xPos, 0.04, 0.22);
    chefParts.head.add(eyeWhite);

    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.024, 10, 10), darkMat);
    pupil.position.set(xPos, 0.04, 0.25);
    chefParts.head.add(pupil);
  });

  // Cejas
  [-0.09, 0.09].forEach((xPos, i) => {
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.02, 0.02), mustacheMat);
    brow.position.set(xPos, 0.11, 0.23);
    brow.rotation.z = i === 0 ? 0.12 : -0.12;
    chefParts.head.add(brow);
  });

  // Nariz de chef
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.048, 14, 14), skinMat);
  nose.position.set(0, -0.01, 0.26);
  chefParts.head.add(nose);

  // Bigote clásico de Chef (2 lados curvados)
  [-0.065, 0.065].forEach((xPos, i) => {
    const mPart = new THREE.Mesh(new THREE.CapsuleGeometry(0.028, 0.08, 8, 12), mustacheMat);
    mPart.position.set(xPos, -0.075, 0.24);
    mPart.rotation.z = Math.PI / 2 + (i === 0 ? 0.25 : -0.25);
    chefParts.head.add(mPart);
  });

  // Gorro de Chef (Toque Blanche alto tradicional)
  chefParts.hat.position.set(0, 0.2, 0);
  const hatBand = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.22, 0.14, 24), whiteMat);
  hatBand.position.y = 0.06;
  chefParts.hat.add(hatBand);

  const hatGoldStripe = new THREE.Mesh(new THREE.CylinderGeometry(0.233, 0.225, 0.035, 24), goldMat);
  hatGoldStripe.position.y = 0.01;
  chefParts.hat.add(hatGoldStripe);

  // Corona abullonada del gorro de chef
  const hatPuffMain = new THREE.Mesh(new THREE.SphereGeometry(0.28, 24, 20), whiteMat);
  hatPuffMain.position.y = 0.26;
  hatPuffMain.scale.set(1.05, 0.9, 1.05);
  chefParts.hat.add(hatPuffMain);

  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const puff = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 14), whiteMat);
    puff.position.set(Math.cos(angle) * 0.14, 0.28, Math.sin(angle) * 0.14);
    chefParts.hat.add(puff);
  }

  chefParts.head.add(chefParts.hat);
  chefParts.torso.add(chefParts.head);

  // 3) BRAZO IZQUIERDO (Para saludar y bailar)
  chefParts.leftArm.position.set(-0.34, 0.96, 0);
  const lSleeve = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.26, 8, 12), whiteMat);
  lSleeve.position.y = -0.14;
  chefParts.leftArm.add(lSleeve);

  const lHand = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 12), skinMat);
  lHand.position.y = -0.32;
  chefParts.leftArm.add(lHand);
  chefParts.torso.add(chefParts.leftArm);

  // 4) BRAZO DERECHO + ESPÁTULA + SMASH BURGER DE PABLO & MARÍA
  chefParts.rightArm.position.set(0.34, 0.96, 0);
  const rSleeve = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.26, 8, 12), whiteMat);
  rSleeve.position.y = -0.14;
  chefParts.rightArm.add(rSleeve);

  const rHand = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 12), skinMat);
  rHand.position.y = -0.32;
  chefParts.rightArm.add(rHand);

  // Espátula de parrilla en la mano derecha
  const spatulaGroup = new THREE.Group();
  spatulaGroup.position.set(0, -0.32, 0.08);
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.18, 10), darkMat);
  handle.rotation.x = Math.PI / 2;
  handle.position.z = 0.08;
  spatulaGroup.add(handle);

  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.01, 0.2), steelMat);
  blade.position.z = 0.24;
  spatulaGroup.add(blade);

  // Hamburguesa Smash sobre la espátula
  const smashBurger = createSmashBurgerMesh(0.55);
  smashBurger.position.set(0, 0.01, 0.24);
  chefParts.burgerOnSpatula.add(smashBurger);
  spatulaGroup.add(chefParts.burgerOnSpatula);

  chefParts.rightArm.add(spatulaGroup);
  chefParts.torso.add(chefParts.rightArm);

  // 5) PIERNAS Y ZAPATOS DE COCINA
  chefParts.leftLeg.position.set(-0.13, 0.38, 0);
  const lPant = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.22, 8, 12), darkMat);
  lPant.position.y = -0.15;
  chefParts.leftLeg.add(lPant);
  const lShoe = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.08, 0.22), darkMat);
  lShoe.position.set(0, -0.33, 0.04);
  chefParts.leftLeg.add(lShoe);

  chefParts.rightLeg.position.set(0.13, 0.38, 0);
  const rPant = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.22, 8, 12), darkMat);
  rPant.position.y = -0.15;
  chefParts.rightLeg.add(rPant);
  const rShoe = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.08, 0.22), darkMat);
  rShoe.position.set(0, -0.33, 0.04);
  chefParts.rightLeg.add(rShoe);

  chefParts.root.add(chefParts.torso);
  chefParts.root.add(chefParts.leftLeg);
  chefParts.root.add(chefParts.rightLeg);

  chefParts.root.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  characterGroup.add(chefParts.root);
}

// ==========================================
// 6. SISTEMA DE ANIMACIÓN DEL CHEF (60 FPS)
// ==========================================
function triggerChefAction(actionName) {
  currentAnimState = actionName;
  oneShotTimer = actionName === 'Dance' ? 999 : 1.6;
}

function updateChefAnimation(delta) {
  animTimer += delta;

  const moving = isMoving();
  if (oneShotTimer > 0) {
    oneShotTimer -= delta;
    if (oneShotTimer <= 0) {
      currentAnimState = moving ? (isTurbo ? 'Running' : 'Walking') : 'Idle';
    }
  } else {
    if (moving && currentAnimState !== 'Dance') {
      currentAnimState = isTurbo ? 'Running' : 'Walking';
    } else if (!moving && (currentAnimState === 'Walking' || currentAnimState === 'Running')) {
      currentAnimState = 'Idle';
    }
  }

  // Reset base suave
  chefParts.root.position.y = 0;
  chefParts.torso.rotation.set(0, 0, 0);
  chefParts.head.rotation.set(0, 0, 0);
  chefParts.burgerOnSpatula.position.y = 0;
  chefParts.burgerOnSpatula.rotation.set(0, 0, 0);

  if (currentAnimState === 'Idle') {
    const t = animTimer * 2.5;
    chefParts.torso.position.y = Math.sin(t) * 0.02;
    chefParts.head.rotation.y = Math.sin(t * 0.6) * 0.12;
    chefParts.leftArm.rotation.set(0, 0, 0.12 + Math.sin(t) * 0.04);
    chefParts.rightArm.rotation.set(-0.35, 0, -0.1);
    chefParts.leftLeg.rotation.set(0, 0, 0);
    chefParts.rightLeg.rotation.set(0, 0, 0);
  } else if (currentAnimState === 'Walking' || currentAnimState === 'Running') {
    const freq = currentAnimState === 'Running' ? 13 : 8;
    const amp = currentAnimState === 'Running' ? 0.65 : 0.42;
    const t = animTimer * freq;

    chefParts.root.position.y = Math.abs(Math.sin(t)) * 0.06;
    chefParts.leftLeg.rotation.x = Math.sin(t) * amp;
    chefParts.rightLeg.rotation.x = -Math.sin(t) * amp;
    chefParts.leftArm.rotation.x = -Math.sin(t) * amp * 0.9;
    chefParts.rightArm.rotation.x = -0.35 + Math.sin(t) * amp * 0.4;
    chefParts.torso.rotation.z = Math.cos(t) * 0.05;
  } else if (currentAnimState === 'Wave') {
    const t = animTimer * 10;
    chefParts.leftArm.rotation.z = 2.4 + Math.sin(t) * 0.35;
    chefParts.leftArm.rotation.x = 0;
    chefParts.head.rotation.z = 0.12;
    chefParts.rightArm.rotation.x = -0.4;
  } else if (currentAnimState === 'Cook') {
    // El Chef lanza la Smash Burger al aire con la espátula y le da vuelta
    const t = animTimer * 9;
    chefParts.rightArm.rotation.x = -0.7 + Math.sin(t) * 0.45;
    const flipArc = Math.abs(Math.sin(t));
    chefParts.burgerOnSpatula.position.y = flipArc * 0.42;
    chefParts.burgerOnSpatula.rotation.x = t * 2;
    chefParts.head.rotation.x = -flipArc * 0.25;
  } else if (currentAnimState === 'Dance') {
    const t = animTimer * 8;
    chefParts.root.position.y = Math.abs(Math.sin(t)) * 0.1;
    chefParts.torso.rotation.y = Math.sin(t * 0.5) * 0.45;
    chefParts.torso.rotation.z = Math.cos(t) * 0.14;
    chefParts.leftArm.rotation.z = 1.9 + Math.sin(t) * 0.5;
    chefParts.rightArm.rotation.x = -0.8 + Math.cos(t) * 0.4;
    chefParts.leftLeg.rotation.x = Math.sin(t) * 0.35;
    chefParts.rightLeg.rotation.x = -Math.sin(t) * 0.35;
  } else if (currentAnimState === 'Jump') {
    const progress = 1 - Math.max(0, oneShotTimer / 1.6);
    const jumpHeight = Math.sin(progress * Math.PI) * 0.45;
    chefParts.root.position.y = Math.max(0, jumpHeight);
    chefParts.leftArm.rotation.z = 2.2;
    chefParts.rightArm.rotation.x = -1.2;
  } else if (currentAnimState === 'ThumbsUp') {
    const t = animTimer * 8;
    chefParts.root.position.y = Math.abs(Math.sin(t)) * 0.08;
    chefParts.leftArm.rotation.x = -1.3;
    chefParts.rightArm.rotation.x = -1.1;
    chefParts.head.rotation.y = Math.sin(t) * 0.2;
  }
}

// ==========================================
// 7. MOVIMIENTO CON FLECHITAS Y PERSPECTIVA DE PROFUNDIDAD
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

    // Pasitos cortos adaptados al tamaño del Chef y al ancho de la pantalla del celular
    const depthMult = getDepthPerspectiveMultiplier(characterGroup.position.z);
    const scaleRatio = THREE.MathUtils.clamp(currentScale / 0.2, 0.5, 1.4);
    const baseSpeed = isTurbo ? 0.34 : 0.17;
    const speed = baseSpeed * scaleRatio * THREE.MathUtils.clamp(depthMult, 0.55, 1.35);

    // Ajustar límite horizontal según proporción de pantalla móvil para que no se salga a los lados
    const aspect = Math.min(1, window.innerWidth / window.innerHeight);
    const limitX = TABLE_LIMIT * Math.max(0.62, aspect);
    const limitZ = TABLE_LIMIT;

    characterGroup.position.x = THREE.MathUtils.clamp(
      characterGroup.position.x + dx * speed * delta,
      -limitX,
      limitX
    );
    characterGroup.position.z = THREE.MathUtils.clamp(
      characterGroup.position.z + dz * speed * delta,
      -limitZ,
      limitZ
    );

    applyCharacterPerspectiveScale();

    const targetAngle = Math.atan2(dx, dz);
    let diff = targetAngle - characterGroup.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    characterGroup.rotation.y += diff * Math.min(1, delta * 10);
  }

  if (minigameActive && collectibleMesh) {
    collectibleMesh.rotation.y += delta * 2.5;
    const dist = Math.hypot(
      characterGroup.position.x - collectibleMesh.position.x,
      characterGroup.position.z - collectibleMesh.position.z
    );
    if (dist < 0.24) {
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
// 9. CONTROLES UI Y CAJÓN DESPLEGABLE SUPERIOR
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
      // El premio en la mesa es una Smash Burger 3D de Pablo & María
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
  // Flechita para desplegar / ocultar las opciones superiores
  btnToggleMenu.addEventListener('click', () => {
    const isCollapsed = topDrawer.classList.toggle('collapsed');
    btnToggleMenu.classList.toggle('open', !isCollapsed);
    drawerArrow.textContent = isCollapsed ? '▾' : '▴';
  });

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
    if (e.key === ' ') triggerChefAction('Jump');
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowUp'    || e.key === 'w' || e.key === 'W') setKey('up', false);
    if (e.key === 'ArrowDown'  || e.key === 's' || e.key === 'S') setKey('down', false);
    if (e.key === 'ArrowLeft'  || e.key === 'a' || e.key === 'A') setKey('left', false);
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') setKey('right', false);
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

function setKey(dir, isDown) {
  moveState[dir] = isDown;
  const btn = document.querySelector(`.dpad-btn.${dir}`);
  if (btn) btn.classList.toggle('pressed', isDown);
}

setupUIEvents();
startApp();

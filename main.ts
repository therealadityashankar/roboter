
import * as THREE from 'three';
import { AmmoPhysics, PhysicsLoader } from '@enable3d/ammo-physics';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SO101, LeKiwi } from './src';
import { Robot } from './src/robots/Robot';
import type { RobotKey, MainSceneHandle, MainSceneProgress, MainSceneStage, GrippableObject } from './src/types/scene';
import { createGrassGrid } from './src/utils/createGrassGrid';
import { loadAsset } from './src/utils/loadAsset';
import { createTree } from './src/utils/createTree';
import { createTable } from './src/utils/createTable';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { TextureLoader } from 'three';

export interface MainSceneOptions {
  canvas: HTMLCanvasElement;
  container: HTMLElement;
  initialRobot?: RobotKey;
  onActiveRobotChange?: (key: RobotKey) => void;
  onProgress?: (progress: MainSceneProgress) => void;
  debugHoldLoading?: boolean;
}

export type { RobotKey, MainSceneHandle, GrippableObject } from './src/types/scene';

let physicsLoaderPromise: Promise<void> | null = null;

function loadPhysicsLibrary(): Promise<void> {
  if (!physicsLoaderPromise) {
    const ammoPath = new URL('ammo/kripken', window.location.origin).toString();
    physicsLoaderPromise = new Promise((resolve) => {
      PhysicsLoader(ammoPath, () => resolve());
    });
  }
  return physicsLoaderPromise;
}

export const createMainScene = async ({
  canvas,
  container,
  initialRobot = 'lekiwi',
  onActiveRobotChange,
  onProgress,
  debugHoldLoading = false,
}: MainSceneOptions): Promise<MainSceneHandle> => {
  const baseAssetNames = [
    'Physics engine',
    'Dining table',
    'Burger bun',
    'Burger patty',
    'Burger bun (clone)',
    'Grass patch A',
    'Grass patch B',
    'Grass patch C',
    'Mango tree',
    'LeKiwi robot',
  ] as const;

  const debugSentinelName = 'Debug hold: loading overlay';
  const baseAssetCount = baseAssetNames.length;
  const remainingAssets = new Set<string>(baseAssetNames);
  if (debugHoldLoading) {
    remainingAssets.add(debugSentinelName);
  }

  const totalAssets = baseAssetCount + (debugHoldLoading ? 1 : 0);
  let loadedAssets = 0;
  let currentAsset: string | undefined;
  let currentAssetPercent: number | undefined;

  const emitProgress = (
    defaultMessage?: string,
    overrides?: {
      stage?: MainSceneStage;
      percent?: number;
      currentAsset?: string;
      currentAssetPercent?: number;
      remainingAssets?: string[];
      message?: string;
    }
  ) => {
    if (!onProgress) return;

    const stage = overrides?.stage ?? (loadedAssets >= totalAssets ? 'complete' : 'loading');
    let percent = overrides?.percent ?? (totalAssets === 0 ? 100 : (loadedAssets / totalAssets) * 100);
    if (debugHoldLoading && loadedAssets >= baseAssetCount) {
      percent = Math.min(percent, 99);
    }
    const remaining = overrides?.remainingAssets ?? Array.from(remainingAssets);
    const resolvedMessage = (() => {
      if (overrides?.message !== undefined) return overrides.message;
      if (debugHoldLoading && remaining.includes(debugSentinelName)) {
        return 'Debug mode active: remove ?debugLoading to dismiss overlay.';
      }
      return defaultMessage;
    })();

    const payload: MainSceneProgress = {
      stage,
      totalAssets,
      loadedAssets,
      percent,
      currentAsset: overrides?.currentAsset ?? currentAsset,
      currentAssetPercent: overrides?.currentAssetPercent ?? currentAssetPercent,
      remainingAssets: remaining,
      message: resolvedMessage,
    };

    onProgress(payload);
  };

  const startAsset = (name: string, message?: string) => {
    currentAsset = name;
    currentAssetPercent = 0;
    emitProgress(message ?? `Loading ${name}...`, {
      stage: 'loading',
      currentAsset,
      currentAssetPercent,
    });
  };

  const updateAsset = (name: string, percent?: number, message?: string) => {
    currentAsset = name;
    if (typeof percent === 'number' && Number.isFinite(percent)) {
      const clamped = Math.max(0, Math.min(100, percent));
      currentAssetPercent = clamped;
    }
    emitProgress(message ?? `Loading ${name}...`, {
      stage: 'loading',
      currentAsset,
      currentAssetPercent,
    });
  };

  const completeAsset = (name: string, message?: string) => {
    loadedAssets = Math.min(loadedAssets + 1, totalAssets);
    remainingAssets.delete(name);
    if (currentAsset === name) {
      currentAsset = undefined;
      currentAssetPercent = undefined;
    }
    const isComplete = loadedAssets >= totalAssets;
    const overrides = isComplete
      ? {
          stage: 'complete' as MainSceneStage,
          percent: debugHoldLoading ? 99 : 100,
          currentAsset: undefined,
          currentAssetPercent: undefined,
          remainingAssets: debugHoldLoading ? [debugSentinelName] : [],
        }
      : {
          stage: 'loading' as MainSceneStage,
        };
    emitProgress(message ?? `${name} loaded`, overrides);
  };

  const trackAsset = <T>(name: string, loadFn: () => Promise<T>): Promise<T> => {
    startAsset(name);
    return loadFn()
      .then((result) => {
        completeAsset(name);
        return result;
      })
      .catch((error) => {
        if (currentAsset === name) {
          currentAssetPercent = undefined;
        }
        emitProgress(`Failed to load ${name}`, { stage: 'loading' });
        throw error;
      });
  };

  emitProgress('Preparing scene...', {
    stage: 'initializing',
    percent: 0,
    currentAsset: undefined,
    currentAssetPercent: undefined,
  });

  await trackAsset('Physics engine', () => loadPhysicsLibrary());

  let disposed = false;
  let animationFrameId: number | null = null;

  let so101Robot: SO101 | null = null;
  let leKiwiRobot: LeKiwi | null = null;
  let activeRobotKey: RobotKey = initialRobot;
  // scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf3f4f6);

  // physics
  // @ts-expect-error
  const physics = new AmmoPhysics(scene, { parent: container.id || undefined });
  // @ts-expect-error
  physics.debug.enable(true)


  // renderer
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  const resizeRenderer = () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    renderer.setSize(width, height, false);
  };
  resizeRenderer();

  const loader = new GLTFLoader();
  const fbxLoader = new FBXLoader();
  const textureLoader = new TextureLoader();
  const mtlLoader = new MTLLoader();
  const objLoader = new OBJLoader();

  const tablePromise = trackAsset('Dining table', () =>
    createTable({
      mtlLoader,
      objLoader,
      physics,
      scene,
      type: 'dining',
      position: new THREE.Vector3(-5, 0.5, -6),
      rotation: new THREE.Vector3(0, Math.PI / 2, 0),
      scale: 0.025,
      onProgress: (phase, percent) => {
        updateAsset('Dining table', percent, `Loading dining table (${phase})...`);
      },
    })
  );

  const bunPromise = trackAsset('Burger bun', () =>
    loadAsset({
      loader,
      scene,
      path: 'burger-bun-bread/source/bun.glb',
      position: { x: -3, y: 3, z: -8 },
      userData: { grippable: true },
      addToScene: true,
      onProgress: (percent) => {
        updateAsset('Burger bun', percent, 'Loading burger bun...');
      },
    })
  );

  const pattyPromise = trackAsset('Burger patty', () =>
    loadAsset({
      loader,
      scene,
      path: 'cooked-burger-patty-meatball/source/cooked.glb',
      position: { x: -3, y: 3, z: -4 },
      userData: { grippable: true },
      onProgress: (percent) => {
        updateAsset('Burger patty', percent, 'Loading burger patty...');
      },
    })
  );

  const bunClonePromise = trackAsset('Burger bun (clone)', () =>
    loadAsset({
      loader,
      scene,
      path: 'burger-bun-bread/source/bun.glb',
      position: { x: -7, y: 3, z: -8 },
      friction: 5,
      userData: { grippable: true },
      onProgress: (percent) => {
        updateAsset('Burger bun (clone)', percent, 'Loading burger bun (clone)...');
      },
    })
  );

  const mangoTreePromise = trackAsset('Mango tree', () =>
    createTree({
      loader: fbxLoader,
      textureLoader,
      type: 'mango',
      position: new THREE.Vector3(8, 0, -5),
      scale: 0.02,
    })
  );

  const grassPromises = [
    trackAsset('Grass patch A', () =>
      createGrassGrid({
        loader,
        scene,
        path: 'grass/sketch.gltf',
        gridX: 2,
        gridZ: 2,
        spacing: 4,
        basePosition: new THREE.Vector3(4, 0.5, -12),
        scale: 8,
        color: 0x00aa00,
        roughness: 0.8,
        metalness: 0,
        randomizeRotation: true,
        showAxesHelper: false,
        onProgress: (percent) => {
          updateAsset('Grass patch A', percent, 'Loading grass patch A...');
        },
      })
    ),
    trackAsset('Grass patch B', () =>
      createGrassGrid({
        loader,
        scene,
        path: 'grass/sketch.gltf',
        gridX: 2,
        gridZ: 3,
        spacing: 4,
        basePosition: new THREE.Vector3(5, 0.5, -3),
        scale: 8,
        color: 0x00aa00,
        roughness: 0.8,
        metalness: 0,
        randomizeRotation: true,
        showAxesHelper: false,
        onProgress: (percent) => {
          updateAsset('Grass patch B', percent, 'Loading grass patch B...');
        },
      })
    ),
    trackAsset('Grass patch C', () =>
      createGrassGrid({
        loader,
        scene,
        path: 'grass/sketch.gltf',
        gridX: 5,
        gridZ: 3,
        spacing: 4,
        basePosition: new THREE.Vector3(-5, 0.5, -3),
        scale: 8,
        color: 0x00aa00,
        roughness: 0.8,
        metalness: 0,
        randomizeRotation: true,
        showAxesHelper: false,
        onProgress: (percent) => {
          updateAsset('Grass patch C', percent, 'Loading grass patch C...');
        },
      })
    ),
  ] as const;

  const [table, bun, patty, bunClone] = await Promise.all([
    tablePromise,
    bunPromise,
    pattyPromise,
    bunClonePromise,
  ]);

  // Track grippable objects with their names
  const grippableObjects = [
    { name: 'Burger bun', mesh: bun },
    { name: 'Burger patty', mesh: patty },
    { name: 'Burger bun (clone)', mesh: bunClone },
  ];

  table.addObjectAbove(bun, {
    deltaY: 5,
    physicsOptions: { shape: 'box' }
  });

  table.addObjectAbove(bunClone, {
    deltaY: 5,
    physicsOptions: { shape: 'box' }
  });

  table.addObjectAbove(patty, {
    deltaY: 5,
    physicsOptions: { shape: 'box' }
  });

  await Promise.all(grassPromises);

  const mangoTree = await mangoTreePromise;
  if (mangoTree) {
    scene.add(mangoTree);
  }


  // dpr
  const DPR = window.devicePixelRatio;
  renderer.setPixelRatio(Math.min(2, DPR));


  // camera
  const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);

  // Default camera position
  const DEFAULT_CAMERA_POSITION = { x: -32.539, y: 23.815, z: 4.334 };
  const DEFAULT_CONTROLS_TARGET = { x: 1.952, y: -3.623, z: -1.269 };

  // Load camera position from localStorage if enabled
  const storeCameraEnabled = localStorage.getItem('store-camera-position') === 'true';
  if (storeCameraEnabled) {
    const savedCamera = localStorage.getItem('camera-position');
    const savedTarget = localStorage.getItem('camera-target');
    if (savedCamera && savedTarget) {
      try {
        const cameraPos = JSON.parse(savedCamera);
        const targetPos = JSON.parse(savedTarget);
        camera.position.set(cameraPos.x, cameraPos.y, cameraPos.z);
        controls.target.set(targetPos.x, targetPos.y, targetPos.z);
        camera.lookAt(targetPos.x, targetPos.y, targetPos.z);
      } catch (e) {
        console.log('Failed to load saved camera position', e);
        // Fall back to defaults
        camera.position.set(DEFAULT_CAMERA_POSITION.x, DEFAULT_CAMERA_POSITION.y, DEFAULT_CAMERA_POSITION.z);
        controls.target.set(DEFAULT_CONTROLS_TARGET.x, DEFAULT_CONTROLS_TARGET.y, DEFAULT_CONTROLS_TARGET.z);
        camera.lookAt(DEFAULT_CONTROLS_TARGET.x, DEFAULT_CONTROLS_TARGET.y, DEFAULT_CONTROLS_TARGET.z);
      }
    } else {
      // No saved position, use defaults
      camera.position.set(DEFAULT_CAMERA_POSITION.x, DEFAULT_CAMERA_POSITION.y, DEFAULT_CAMERA_POSITION.z);
      controls.target.set(DEFAULT_CONTROLS_TARGET.x, DEFAULT_CONTROLS_TARGET.y, DEFAULT_CONTROLS_TARGET.z);
      camera.lookAt(DEFAULT_CONTROLS_TARGET.x, DEFAULT_CONTROLS_TARGET.y, DEFAULT_CONTROLS_TARGET.z);
    }
  } else {
    // Use defaults when storage is disabled
    camera.position.set(DEFAULT_CAMERA_POSITION.x, DEFAULT_CAMERA_POSITION.y, DEFAULT_CAMERA_POSITION.z);
    controls.target.set(DEFAULT_CONTROLS_TARGET.x, DEFAULT_CONTROLS_TARGET.y, DEFAULT_CONTROLS_TARGET.z);
    camera.lookAt(DEFAULT_CONTROLS_TARGET.x, DEFAULT_CONTROLS_TARGET.y, DEFAULT_CONTROLS_TARGET.z);
  }
  controls.update();

  // Save camera position when it changes (if enabled)
  controls.addEventListener('change', () => {
    const p = camera.position;
    const t = controls.target;

    // Save to localStorage if enabled
    const enabled = localStorage.getItem('store-camera-position') === 'true';
    if (enabled) {
      localStorage.setItem('camera-position', JSON.stringify({ x: p.x, y: p.y, z: p.z }));
      localStorage.setItem('camera-target', JSON.stringify({ x: t.x, y: t.y, z: t.z }));
    }
  });


  // light
  scene.add(new THREE.HemisphereLight(0xffffff, 0x000000, 1))
  scene.add(new THREE.AmbientLight(0xffffff, 1))
  const light = new THREE.DirectionalLight(0xffffff, 1)
  light.position.set(50, 200, 100)
  light.position.multiplyScalar(1.3)

  // static ground
  physics.add.ground({ width: 20, height: 20, name: "ground" })

  // Helper to clear and rebuild sliders for the active robot
  const DEFAULT_POSES: Record<'lekiwi' | 'so101', { position: { x: number; y: number; z: number }; rotationDegrees: number }> = {
    lekiwi: {
      position: { x: -1.23, y: 1, z: -2.23 },
      rotationDegrees: -115.5,
    },
    so101: {
      position: { x: 0, y: 0.5, z: 0 },
      rotationDegrees: 0,
    },
  }

  const applyDefaultPose = (robot: SO101 | LeKiwi, key: 'lekiwi' | 'so101') => {
    if (!robot.robot) return
    const pose = DEFAULT_POSES[key]
    robot.robot.position.set(pose.position.x, pose.position.y, pose.position.z)
    robot.robot.rotation.z = THREE.MathUtils.degToRad(pose.rotationDegrees)
    Robot.markLinksAsNeedingPhysicsUpdate(robot.robot)
    robot.updateGrippedObjectPositions()
  }

  // Apply default joint values to robot
  const applyDefaultJointValues = (robot: SO101 | LeKiwi) => {
    const defaults = {
      gripper: 7.26,
      shoulder_pan: 2.58,
      shoulder_lift: -21.94,
      elbow_flex: -25,
      wrist_flex: -79.35,
      wrist_roll: 59,
    };

    Object.entries(defaults).forEach(([key, value]) => {
      const pivot = robot.pivotMap[key];
      if (pivot) {
        robot.setPivotValue(pivot.name, value);
      }
    });
  };

  // Load LeKiwi by default
  leKiwiRobot = new LeKiwi();
  await trackAsset('LeKiwi robot', () =>
    leKiwiRobot!.load({ scene, enable3dPhysicsObject: physics, position: new THREE.Vector3(0, 1, 0) })
  );
  applyDefaultPose(leKiwiRobot, 'lekiwi');
  applyDefaultJointValues(leKiwiRobot);
  activeRobotKey = 'lekiwi';
  onActiveRobotChange?.(activeRobotKey);

  // clock
  const clock = new THREE.Clock();

  const removeRobotFromScene = (robot: SO101 | LeKiwi | null) => {
    if (!robot || !robot.robot) return;
    // Remove URDF root from scene; physics bodies are attached to links and will be GC'ed with meshes
    scene.remove(robot.robot);
  };

  const getRobotXZ = (robot: SO101 | LeKiwi | null): { x: number, z: number } => {
    if (!robot || !robot.robot) return { x: 0, z: 0 };
    const pos = robot.robot.position;
    return { x: pos.x, z: pos.z };
  };

  const switchRobot = async (target: RobotKey) => {
    if (activeRobotKey === target) return;
    // Capture current XZ of the active robot
    const { x, z } = target === 'so101' ? getRobotXZ(leKiwiRobot) : getRobotXZ(so101Robot);

    // Remove current
    if (activeRobotKey === 'lekiwi') {
      removeRobotFromScene(leKiwiRobot);
    } else {
      removeRobotFromScene(so101Robot);
    }

    // Load target at same XZ; use preferred Y per robot
    if (target === 'so101') {
      const isFirstLoad = !so101Robot;
      if (!so101Robot) so101Robot = new SO101();
      await so101Robot.load({ scene, enable3dPhysicsObject: physics, position: new THREE.Vector3(x, 0.5, z) });
      if (isFirstLoad) {
        applyDefaultPose(so101Robot, 'so101');
        applyDefaultJointValues(so101Robot);
      }
    } else {
      const isFirstLoad = !leKiwiRobot;
      if (!leKiwiRobot) leKiwiRobot = new LeKiwi();
      await leKiwiRobot.load({ scene, enable3dPhysicsObject: physics, position: new THREE.Vector3(x, 1, z) });
      if (isFirstLoad) {
        applyDefaultPose(leKiwiRobot, 'lekiwi');
        applyDefaultJointValues(leKiwiRobot);
      }
    }

    activeRobotKey = target;
    onActiveRobotChange?.(activeRobotKey);
  };

  // loop
  const animate = () => {
    if (disposed) return;
    physics.update(clock.getDelta() * 1000);
    if (typeof physics.updateDebugger === 'function') {
      physics.updateDebugger();
    }
    renderer.render(scene, camera);
    animationFrameId = requestAnimationFrame(animate);
  };
  animationFrameId = requestAnimationFrame(animate);

  const onWindowResize = () => {
    if (disposed) return;
    resizeRenderer();
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
  };

  window.addEventListener('resize', onWindowResize);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId);
    }
    window.removeEventListener('resize', onWindowResize);
    controls.dispose();
    renderer.dispose();
  };

  const getActiveRobot = () => {
    return activeRobotKey === 'lekiwi' ? leKiwiRobot : so101Robot;
  };

  const getActiveRobotKey = () => activeRobotKey;

  const getGrippableObjects = () => {
    return grippableObjects.map(obj => ({
      name: obj.name,
      position: {
        x: obj.mesh.position.x,
        y: obj.mesh.position.y,
        z: obj.mesh.position.z,
      },
      mesh: obj.mesh,
    }));
  };

  return {
    switchRobot,
    dispose,
    getActiveRobot,
    getActiveRobotKey,
    getGrippableObjects,
    camera,
    controls,
  };
};


import type { SO101 } from '../robots/SO101';
import type { LeKiwi } from '../robots/LeKiwi';
import type * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type RobotKey = 'lekiwi' | 'so101';

export type MainSceneStage = 'initializing' | 'loading' | 'complete';

export interface MainSceneProgress {
  stage: MainSceneStage;
  totalAssets: number;
  loadedAssets: number;
  percent: number;
  currentAsset?: string;
  currentAssetPercent?: number;
  remainingAssets: string[];
  message?: string;
}

export interface GrippableObject {
  name: string;
  position: { x: number; y: number; z: number };
  mesh: THREE.Object3D;
}

export interface MainSceneHandle {
  switchRobot: (key: RobotKey) => Promise<void>;
  dispose: () => void;
  getActiveRobot: () => SO101 | LeKiwi | null;
  getActiveRobotKey: () => RobotKey;
  getGrippableObjects: () => GrippableObject[];
  camera: THREE.Camera;
  controls: OrbitControls;
}

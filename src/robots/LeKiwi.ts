import { ExtendedMesh } from 'enable3d';
import { Robot, UnmappedPivotMap } from './Robot';
import { SO101 } from './SO101';
import * as THREE from 'three';

/**
 * SO101 Robot Implementation
 * The first robot in the Die Roboter series
 * 
 * taken from here : https://github.com/huggingface/lerobot/blob/945e1ff2669bb7b31cb7fe6033fe9679767c2442/src/lerobot/teleoperators/so100_leader/so100_leader.py#L47
 */
export class LeKiwi extends Robot {
  // Static method to create a cube mesh for physics representation
  static createCubeMesh(
    dimensions: number[], 
    position?: [number, number, number], 
    rotation?: [number, number, number]
  ): ExtendedMesh {
    const geometry = new THREE.BoxGeometry(dimensions[0], dimensions[1], dimensions[2]);
    const material = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true });
    const mesh = new ExtendedMesh(geometry, material);
    
    // Apply position if provided
    if (position) {
      mesh.position.set(position[0], position[1], position[2]);
    }
    
    // Apply rotation if provided
    if (rotation) {
      mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
    }
    
    return mesh;
  }
  constructor(){
    // Create a base physics representation for the robot
    const basePhysicsRepresentation = LeKiwi.createCubeMesh([1, 1, 1], [0, 1, 0], [0, 0, 0]);

    // SO101 has the same joints as LeKiwi, but with different names
    const unmappedPivotMap: UnmappedPivotMap = {
      'gripper': { // done - works
        name: 'gripper',
        jointName: 'STS3215_03a-v1-4_Revolute-57',
        value: 0,
        lower: 0,
        upper: 100,
        physicsRepresentation: {}
      },
      'shoulder_pan': { // done - works, angle corrected
        name: 'shoulder_pan',
        jointName: 'STS3215_03a-v1_Revolute-45',
        value: 0,
        lower: -100,
        upper: 100,
        physicsRepresentation: {}
      },
      'shoulder_lift': { // done - works, angle corrected
        name: 'shoulder_lift',
        jointName: 'STS3215_03a-v1-1_Revolute-49',
        value: 0,
        lower: -100,
        upper: 100,
        physicsRepresentation: {}
      },
      'elbow_flex': { // done - works, angle corrected
        name: 'elbow_flex',
        jointName: 'STS3215_03a-v1-2_Revolute-51',
        value: 0,
        lower: -100,
        upper: 100,
        physicsRepresentation: {},
      },
      'wrist_flex': { // done - works, angle corrected
        name: 'wrist_flex',
        jointName: 'STS3215_03a-v1-3_Revolute-53',
        value: 0,
        lower: -100,
        upper: 100,
        physicsRepresentation: {}
      },
      'wrist_roll': { // done - works, angle corrected
        name: 'wrist_roll',
        jointName: 'STS3215_03a_Wrist_Roll-v1_Revolute-55',
        value: 0,
        lower: -100,
        upper: 100,
        physicsRepresentation: {},
      },
    }; 

    // @ts-expect-error
    const jawParam = SO101.jawMesh.geometry.parameters
    const clonedJaw = LeKiwi.createCubeMesh([jawParam.width, jawParam.depth, jawParam.height], [SO101.jawMesh.position.x, SO101.jawMesh.position.y + 0.08, SO101.jawMesh.position.z - 0.05], [0, 0, 0]);

    // @ts-expect-error
    const clonedWristMeshParams = SO101.wristMesh.geometry.parameters
    const clonedWristMesh = LeKiwi.createCubeMesh([clonedWristMeshParams.depth, clonedWristMeshParams.width, clonedWristMeshParams.height], [SO101.wristMesh.position.x - 0.04, SO101.wristMesh.position.y, SO101.wristMesh.position.z -0.05], [0, 0, 0]);

    // @ts-expect-error
    const lowerArmParam = SO101.lowerArmMesh.geometry.parameters
    const clonedLowerArmMesh = LeKiwi.createCubeMesh([lowerArmParam.depth, lowerArmParam.width, lowerArmParam.height], [SO101.lowerArmMesh.position.x + 0.015, SO101.lowerArmMesh.position.y - 0.05, SO101.lowerArmMesh.position.z - 0.015], [0, 0, 0]);

    // @ts-expect-error
    const upperArmParam = SO101.upperArmMesh.geometry.parameters
    const clonedUpperArmMesh = LeKiwi.createCubeMesh([upperArmParam.depth, upperArmParam.width, upperArmParam.height], [SO101.upperArmMesh.position.x + 0.015, SO101.upperArmMesh.position.y + 0.05, SO101.upperArmMesh.position.z - 0.015], [0, 0, 0]);
    
    // @ts-expect-error
    const gripperParam = SO101.gripperMesh.geometry.parameters
    const clonedGripperMesh = LeKiwi.createCubeMesh([gripperParam.width, gripperParam.depth, gripperParam.height], [SO101.gripperMesh.position.x + 0.015, SO101.gripperMesh.position.y + 0.04, SO101.gripperMesh.position.z + 0.025], [0, 0, 0]);
    
    // @ts-expect-error
    const shoulderParam = SO101.shoulderMesh.geometry.parameters
    const clonedShoulderMesh = LeKiwi.createCubeMesh([shoulderParam.width, shoulderParam.height, shoulderParam.depth], [SO101.shoulderMesh.position.x + 0.03, SO101.shoulderMesh.position.y - 0.03, SO101.shoulderMesh.position.z], [0, 0, 0]);
    // SO101 has the same links as LeKiwi, but with different names
    const linkPhysicsMap = {
      'Moving_Jaw_08d-v1': {
        physicsMesh: clonedJaw,
        gripper_part_a: true,
        color: new THREE.Color(0x00ff00)
      },
      'SO_ARM100_08k_116_Square-v1': {
        physicsMesh: clonedLowerArmMesh,
        color: new THREE.Color(0x0000ff)
      },
      'Rotation_Pitch_08i-v1': {
        physicsMesh: clonedShoulderMesh,
        color: new THREE.Color(0x00ff00)
      },
      'Wrist_Roll_Pitch_08i-v1': {
        physicsMesh: clonedWristMesh,
        color: new THREE.Color(0x00ff00)
      },
      'SO_ARM100_08k_Mirror-v1': {
        physicsMesh: clonedUpperArmMesh,
        color: new THREE.Color(0x00ff00)
      },
      'Wrist_Roll_08c-v1': {
        gripper_part_b: true,
        physicsMesh: clonedGripperMesh,
        color: new THREE.Color(0x00ee00)
      }
    }
    // Call super with options object
    super({
      name: "LeKiwi",
      // temporary change, needs to be reverted to https://cdn.jsdelivr.net/gh/therealadityashankar/die-roboter/urdf/
      // before pushing
      modelPath: window.location.origin + "/urdf/lekiwi/LeKiwi.urdf", 
      unmappedPivotMap,
      basePhysicsRepresentation,
      linkPhysicsMap
    });
  }
}
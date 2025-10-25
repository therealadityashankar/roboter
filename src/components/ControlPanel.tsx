import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Tab, TabGroup, TabList, TabPanels, TabPanel } from '@headlessui/react';
import { Settings } from 'lucide-react';
import { Chat } from './Chat';
import { PlanarControl, MIN_GRIPPER_ANGLE_PHYSICAL, MAX_GRIPPER_ANGLE_PHYSICAL, MIN_WRIST_FLEX_ANGLE, MAX_WRIST_FLEX_ANGLE } from '../planar';
import { MovementControl, RotationControl, RemoteControl } from './index';
import { RobotConnection } from './RobotConnection';
import { Robot } from '../robots/Robot';
import type { RobotKey, MainSceneHandle } from '../types/scene';
import { inverseKinematics2Link } from '../utils/inverseKinematics';

interface ControlPanelProps {
  activeRobot: RobotKey;
  onRobotChange: (key: RobotKey) => void;
  isPanelOpen: boolean;
  onTogglePanel: () => void;
  sceneHandle: MainSceneHandle | null;
}

const robotButtonBase =
  'px-3 py-1 text-xs bg-transparent text-gray-800 border rounded cursor-pointer ml-2 transition-colors';

const getRobotButtonClasses = (activeRobot: RobotKey, key: RobotKey) =>
  `${robotButtonBase} ${activeRobot === key ? 'border-gray-800' : 'border-gray-300'}`;

interface PlanarControlSectionProps {
  sceneHandle: MainSceneHandle | null;
  robotConnection?: RobotConnection;
}

const PlanarControlSection: React.FC<PlanarControlSectionProps> = ({ sceneHandle, robotConnection }) => {
  const syncToPhysicalRobotRef = useRef<() => Promise<void>>(async () => {});

  // Helper function to sync virtual robot state to physical robot
  const syncToPhysicalRobot = async () => {
    //if (currentlySyncing) return;
    //currentlySyncing = true;

    const teleoperator = robotConnection?.getRobotTeleoperator();
    if (!teleoperator) return;
    
    const robot = sceneHandle?.getActiveRobot();
    if (!robot) return;
    
    const motorPositions: { [key: string]: number } = {};
    
    // Map each joint to its corresponding motor
    const jointNames = ['shoulder_pan', 'shoulder_lift']//, 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper'];

    const shoulderPanMotorConfig = teleoperator.motorConfigs.find((config : any) => config.name === 'shoulder_pan');
    const minPosition = shoulderPanMotorConfig?.minPosition;
    const maxPosition = shoulderPanMotorConfig?.maxPosition;
    
    jointNames.forEach(jointName => {
      if (robot.pivotMap[jointName]) {
        const pivot = robot.pivotMap[jointName];
        const value = pivot.value || 0;

        // value normalized between 0 and 1
        const normalizedValue = (value - pivot.lower) / (pivot.upper - pivot.lower);
        
        motorPositions[jointName] = minPosition + normalizedValue * (maxPosition - minPosition);
        console.log("syncing ", jointName, value, pivot.lower, pivot.upper)
      }
    });
    
    await teleoperator.setMotorPositions(motorPositions);
    console.log('Sent to physical robot:', motorPositions);
  }

  syncToPhysicalRobotRef.current = syncToPhysicalRobot;

  const planarControl = useMemo(() => {
    const control = new PlanarControl({
      onChange: (position, theta, circleSize) => {
        const robot = sceneHandle?.getActiveRobot();
        if (!robot) return;
        
        // Map X position (-1 to 1) to shoulder_pan (base rotation)
        const shoulderPanPivot = robot.pivotMap['shoulder_pan'];
        if (shoulderPanPivot) {
          const lower = shoulderPanPivot.lower;
          const upper = shoulderPanPivot.upper;

          // map theta.radians (which goes from 0 to PI), to lower and upper
          const value = lower + (theta.radians/Math.PI)*(upper-lower)
          robot.setPivotValue('shoulder_pan', value);
        }
        
        // Use inverse kinematics for Y position (Z in world) and circleSize (reach)
        // Map position.y (-1 to 1) to Z coordinate
        // Map circleSize to reach distance
        const shoulderLiftPivot = robot.pivotMap['shoulder_lift'];
        const elbowPivot = robot.pivotMap['elbow_flex'];
        
        if (shoulderLiftPivot && elbowPivot) {
          // Map position.y to world Z coordinate (height)
          // Assume range of -1 to 1 maps to 0 to 2 units in world space
          const targetY = (-position.y + 1); // 0 to 2
          
          // Map circleSize to reach distance X (horizontal distance from base)
          // Using configured Z range
          const zMin = control.zRangeMin ?? 0;
          const zMax = control.zRangeMax ?? 10;
          const normalizedReach = (circleSize - zMin) / (zMax - zMin);
          const targetZ = normalizedReach * 2; // 0 to 2 units reach
          
          // Link lengths (both 1 for now, can be adjusted later)
          const L1 = 1;
          const L2 = 1;
          
          // Calculate IK
          const ikResult = inverseKinematics2Link(targetZ, targetY, L1, L2);
          
          if (ikResult) {
            // theta1 = shoulder_lift, theta2 = elbow_flex
            const shoulderLiftPivot = robot.pivotMap['shoulder_lift'];
            const elbowFlexPivot = robot.pivotMap['elbow_flex'];


            // workaround, for the time being that i hope works
            let elbowTheta = 2*Math.PI - ikResult.theta2
            while (elbowTheta < elbowFlexPivot.mappedLower) {
              elbowTheta += 2*Math.PI;
            }

            while (elbowTheta > elbowFlexPivot.mappedUpper) {
              elbowTheta -= 2*Math.PI;
            }

            let shoulderLiftTheta = 2*Math.PI - ikResult.theta1
            while (shoulderLiftTheta < shoulderLiftPivot.mappedLower) {
              shoulderLiftTheta += 2*Math.PI;
            }

            while (shoulderLiftTheta > shoulderLiftPivot.mappedUpper) {
              shoulderLiftTheta -= 2*Math.PI;
            }

            // map between 0 to 1 corresponding to mappedLower to mappedUpper
            const shoulderLiftValueNormalized = (shoulderLiftTheta - shoulderLiftPivot.mappedLower) / (shoulderLiftPivot.mappedUpper - shoulderLiftPivot.mappedLower);
            const elbowFlexValueNormalized = (elbowTheta - elbowFlexPivot.mappedLower) / (elbowFlexPivot.mappedUpper - elbowFlexPivot.mappedLower);

            // map between joint.lower to joint.upper
            const shoulderLiftValue = -(shoulderLiftPivot.lower + shoulderLiftValueNormalized * (shoulderLiftPivot.upper - shoulderLiftPivot.lower))
            const elbowFlexValue = -(elbowFlexPivot.lower + elbowFlexValueNormalized * (elbowFlexPivot.upper - elbowFlexPivot.lower))
            
            robot.setPivotValue('shoulder_lift', shoulderLiftValue);
            robot.setPivotValue('elbow_flex', elbowFlexValue);
          }
        }
        
        syncToPhysicalRobotRef.current();
      },
      onGripperAngleChange: (angle) => {
        const robot = sceneHandle?.getActiveRobot();
        if (!robot) return;
        
        const wristRollPivot = robot.pivotMap['wrist_roll'];
        if (wristRollPivot) {
          let usedAngle = angle;

          if(angle < MIN_GRIPPER_ANGLE_PHYSICAL){
            usedAngle = MIN_GRIPPER_ANGLE_PHYSICAL;
          }

          if(angle > MAX_GRIPPER_ANGLE_PHYSICAL){
            usedAngle = MAX_GRIPPER_ANGLE_PHYSICAL;
          }

          let normalizedAngle = (usedAngle - MIN_GRIPPER_ANGLE_PHYSICAL)/(MAX_GRIPPER_ANGLE_PHYSICAL-MIN_GRIPPER_ANGLE_PHYSICAL);
          let pivotValue = wristRollPivot.lower + normalizedAngle * (wristRollPivot.upper - wristRollPivot.lower);
          robot.setPivotValue('wrist_roll', pivotValue);
        }
        
        syncToPhysicalRobotRef.current();
      },
      onGripperMouthAngleChange: (angle) => {
        const robot = sceneHandle?.getActiveRobot();
        if (!robot) return;
        
        const gripperPivot = robot.pivotMap['gripper'];
        if (gripperPivot) {
          // Map 0-120° to gripper range
          const normalized = angle / 120;
          const gripperValue = gripperPivot.upper - (gripperPivot.lower + normalized * (gripperPivot.upper - gripperPivot.lower));
          robot.setPivotValue('gripper', gripperValue);
        }
        
        syncToPhysicalRobotRef.current();
      },
      onWristFlexChange: (angleDegrees) => {
        const robot = sceneHandle?.getActiveRobot();
        if (!robot) return;
        
        const wristFlexPivot = robot.pivotMap['wrist_flex'];
        if (wristFlexPivot) {
          let usedAngle = angleDegrees;
          let normalizedAngle = 1 - ((usedAngle - MIN_WRIST_FLEX_ANGLE)/(MAX_WRIST_FLEX_ANGLE - MIN_WRIST_FLEX_ANGLE));
          let pivotValue = wristFlexPivot.lower + normalizedAngle * (wristFlexPivot.upper - wristFlexPivot.lower);
          robot.setPivotValue('wrist_flex', pivotValue);
        }
        
        syncToPhysicalRobotRef.current();
      },
    });
    
    return control;
  }, [sceneHandle]);

  const lastSyncedPosition = useRef<{ x: number; y: number; z: number } | null>(null);
  const [objectDistances, setObjectDistances] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!sceneHandle) {
      lastSyncedPosition.current = null;
      setObjectDistances({});
      return;
    }

    const intervalId = window.setInterval(() => {
      const robot = sceneHandle.getActiveRobot();
      const position = robot?.robot?.position;

      if (!position) {
        return;
      }

      console.log("position", position)

      if (sceneHandle?.getGrippableObjects) {
        const objects = sceneHandle.getGrippableObjects();
        const newDistances: Record<string, number> = {};

        objects.forEach(obj => {
          const distance = Math.sqrt(
            (obj.position.x - position.x) ** 2 +
            (obj.position.y - position.y) ** 2 +
            (obj.position.z - position.z) ** 2
          );
          newDistances[obj.name] = distance;
        });

        setObjectDistances(prev => {
          const prevKeys = Object.keys(prev);
          const newKeys = Object.keys(newDistances);
          if (prevKeys.length === newKeys.length && prevKeys.every(key => newDistances.hasOwnProperty(key))) {
            let changed = false;
            for (const key of newKeys) {
              if (Math.abs((prev[key] ?? Infinity) - newDistances[key]) > 1e-4) {
                changed = true;
                break;
              }
            }
            if (!changed) {
              return prev;
            }
          }
          return newDistances;
        });
      }

      const current = { x: position.x, y: position.y, z: position.z };
      const previous = lastSyncedPosition.current;

      const hasChanged = !previous || previous.x !== current.x || previous.y !== current.y || previous.z !== current.z;

      if (hasChanged) {
        lastSyncedPosition.current = current;
        syncToPhysicalRobot();
      }
    }, 2000);

    return () => {
      window.clearInterval(intervalId);
      lastSyncedPosition.current = null;
      setObjectDistances({});
    };
  }, [sceneHandle, robotConnection]);

  const PlanarControls = useMemo(() => planarControl.renderControls(), [planarControl]);

  const handleMoveAboveObject = (objectName: string) => {
    if (!sceneHandle) return;
    
    const robot = sceneHandle.getActiveRobot();
    if (!robot || !robot.robot) return;
    
    const objects = sceneHandle.getGrippableObjects();
    const targetObject = objects.find(obj => obj.name === objectName);
    if (!targetObject) return;
    
    // Get robot base position
    const robotPos = robot.robot.position;
    
    // Calculate relative position from robot to object
    const dx = targetObject.position.x - robotPos.x;
    const dz = targetObject.position.z - robotPos.z;
    const dy = targetObject.position.y - robotPos.y;
    
    // Calculate horizontal distance (reach)
    const horizontalDistance = Math.sqrt(dx * dx + dz * dz);
    
    // Calculate angle for shoulder_pan (base rotation)
    // atan2(dz, dx) gives us the angle in robot's local XZ plane
    const angleToObject = Math.atan2(dz, dx);
    
    // Convert to planar control coordinates
    // X maps to theta (0 to PI becomes -1 to 1)
    const theta = angleToObject + Math.PI / 2; // Adjust based on robot orientation
    const normalizedX = 1 - (theta / Math.PI); // Map 0 to PI -> 1 to -1
    
    // Y maps to height (-1 to 1)
    // Assuming a reasonable height range of 0 to 2 units
    const normalizedY = (dy - 1) / 1; // Adjust based on testing
    
    // Z maps to reach distance
    // Use the planar control's Z range
    const zMin = planarControl.zRangeMin;
    const zMax = planarControl.zRangeMax;
    const normalizedZ = zMin + (horizontalDistance / 2) * (zMax - zMin);
    
    // Check if reachable (simple bounds check)
    const maxReach = 2; // Approximate max reach in units
    if (horizontalDistance > maxReach) {
      console.log(`Object "${objectName}" is too far away (${horizontalDistance.toFixed(2)}m). Max reach: ${maxReach}m`);
      return;
    }
    
    // Set the target
    planarControl.setTarget(normalizedX, normalizedY, normalizedZ);
    console.log(`Moving arm above "${objectName}"`, {
      objectPosition: targetObject.position,
      robotPosition: { x: robotPos.x, y: robotPos.y, z: robotPos.z },
      relative: { dx, dy, dz },
      horizontalDistance,
      target: { x: normalizedX, y: normalizedY, z: normalizedZ }
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <PlanarControls />
      
      {/* Move Above Object Section */}
      <div className="border-t border-gray-300 pt-3">
        <h4 className="text-sm font-semibold mb-2">Move Above Object</h4>
        <div className="flex flex-col gap-1">
          {sceneHandle?.getGrippableObjects().map(obj => {
            const activeRobot = sceneHandle?.getActiveRobot();
            const robotPosition = activeRobot?.robot?.position;
            const distance = objectDistances[obj.name];
            let distanceLabel = "";

            if (distance !== undefined) {
              distanceLabel = ` (${distance.toFixed(2)}m)`;
            } else if (robotPosition) {
              const dx = obj.position.x - robotPosition.x;
              const dz = obj.position.z - robotPosition.z;
              const horizontalDistance = Math.sqrt(dx * dx + dz * dz);
              distanceLabel = ` (${horizontalDistance.toFixed(2)}m)`;
            }

            return (
              <button
                key={obj.name}
                onClick={() => handleMoveAboveObject(obj.name)}
                className="px-3 py-1.5 text-xs bg-blue-100 hover:bg-blue-200 rounded transition-colors text-left"
              >
                {obj.name}{distanceLabel}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export const ControlPanel : React.FC<ControlPanelProps> = ({
  activeRobot,
  onRobotChange,
  isPanelOpen,
  onTogglePanel,
  sceneHandle,
}) => {
  // Default rotation offset applied during WASD movement (in radians)
  const DEFAULT_MOVEMENT_ROTATION = -1.5; // Modify this value as needed

  // Camera position storage state
  const [storeCameraPosition, setStoreCameraPosition] = React.useState(() => {
    return localStorage.getItem('store-camera-position') === 'true';
  });
  const [showCameraSettings, setShowCameraSettings] = React.useState(false);

  // Physical robot connection instance
  const robotConnection = useMemo(() => new RobotConnection(), []);

  const handleStoreCameraChange = (enabled: boolean) => {
    setStoreCameraPosition(enabled);
    localStorage.setItem('store-camera-position', String(enabled));
    if (enabled && sceneHandle) {
      // Save current camera position
      const p = sceneHandle.camera.position;
      const t = sceneHandle.controls.target;
      localStorage.setItem('camera-position', JSON.stringify({ x: p.x, y: p.y, z: p.z }));
      localStorage.setItem('camera-target', JSON.stringify({ x: t.x, y: t.y, z: t.z }));
    }
  };

  const handleResetCamera = () => {
    if (!sceneHandle) return;
    
    // Default camera position (from main.ts)
    const DEFAULT_CAMERA_POSITION = { x: -32.539, y: 23.815, z: 4.334 };
    const DEFAULT_CONTROLS_TARGET = { x: 1.952, y: -3.623, z: -1.269 };
    
    sceneHandle.camera.position.set(DEFAULT_CAMERA_POSITION.x, DEFAULT_CAMERA_POSITION.y, DEFAULT_CAMERA_POSITION.z);
    sceneHandle.controls.target.set(DEFAULT_CONTROLS_TARGET.x, DEFAULT_CONTROLS_TARGET.y, DEFAULT_CONTROLS_TARGET.z);
    sceneHandle.camera.lookAt(DEFAULT_CONTROLS_TARGET.x, DEFAULT_CONTROLS_TARGET.y, DEFAULT_CONTROLS_TARGET.z);
    sceneHandle.controls.update();
    
    if (storeCameraPosition) {
      localStorage.setItem('camera-position', JSON.stringify(DEFAULT_CAMERA_POSITION));
      localStorage.setItem('camera-target', JSON.stringify(DEFAULT_CONTROLS_TARGET));
    }
  };

  const handleMove = (dx: number, dz: number) => {
    const robot = sceneHandle?.getActiveRobot();
    if (!robot || !robot.robot) return;

    // Get current rotation angle (yaw around Z-axis) plus default offset
    const rotationAngle = (robot.robot.rotation.z + DEFAULT_MOVEMENT_ROTATION) % (2 * Math.PI);
        
    // Rotate the movement vector by the robot's current rotation
    // Using 2D rotation matrix:
    // x' = x * cos(θ) - z * sin(θ)
    // z' = x * sin(θ) + z * cos(θ)
    const cos = Math.cos(rotationAngle);
    const sin = Math.sin(rotationAngle);
    const rotatedDz = dx * cos - dz * sin;
    const rotatedDx = dx * sin + dz * cos;

    const anyRobot = robot as any;
    if (typeof anyRobot.moveByXZ === 'function') {
      anyRobot.moveByXZ(rotatedDx, rotatedDz);
    } else {
      robot.robot.position.x += rotatedDx;
      robot.robot.position.z += rotatedDz;
      Robot.markLinksAsNeedingPhysicsUpdate(robot.robot);
      Robot.markVisualsAsNeedingPhysicsUpdate(robot.robot);
      robot.updateGrippedObjectPositions();
    }
  };

  const handleRotate = (delta: number) => {
    const robot = sceneHandle?.getActiveRobot();
    if (!robot || !robot.robot) return;

    const anyRobot = robot as any;
    if (typeof anyRobot.rotateByYaw === 'function') {
      anyRobot.rotateByYaw(delta);
    } else {
      robot.robot.rotation.z += delta;
      // Clamp rotation to 0 to 2π
      robot.robot.rotation.z = ((robot.robot.rotation.z % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI);
      Robot.markLinksAsNeedingPhysicsUpdate(robot.robot);
      Robot.markVisualsAsNeedingPhysicsUpdate(robot.robot);
      robot.updateGrippedObjectPositions();
    }
  };

  return (
    <div
      className={`absolute bottom-0 right-0 w-96 transition-transform duration-300 ease-in-out transform bg-gray-100 flex flex-col ${
        isPanelOpen ? 'h-full' : ''
      }`}
    >
      <div
        className={`flex-1 p-4 overflow-y-auto bg-gray-100 border border-[var(--color-gray-300)] border-b-0 ${
          isPanelOpen ? '' : 'hidden'
        }`}
      >
        <TabGroup>
          {/* Header with title and settings */}
          <div className="flex items-center justify-between mb-2 relative">
            <h3 className="text-lg font-semibold">Robot Control</h3>
            <div className="flex items-center gap-2">
              {/* Settings Icon */}
              <button
                type="button"
                onClick={() => setShowCameraSettings(!showCameraSettings)}
                className="w-8 h-8 flex items-center justify-center rounded bg-gray-200 hover:bg-gray-300 transition-colors cursor-pointer"
                title="Settings"
              >
                <Settings size={16} />
              </button>
            </div>
          </div>

          {/* Tabs on separate line */}
          <div className="mb-4">
            <TabList className="flex space-x-1 rounded-lg bg-gray-200 p-1">
              <Tab
                className={({ selected }) =>
                  `rounded-md px-3 py-1 text-sm font-medium leading-5 quicksand cursor-pointer
                  ${
                    selected
                      ? 'bg-white text-gray-900 shadow'
                      : 'text-gray-700 hover:bg-white/[0.12] hover:text-gray-900'
                  }
                  focus:outline-none`
                }
              >
                Manual
              </Tab>
              <Tab
                className={({ selected }) =>
                  `rounded-md px-3 py-1 text-sm font-medium leading-5 quicksand cursor-pointer
                  ${
                    selected
                      ? 'bg-white text-gray-900 shadow'
                      : 'text-gray-700 hover:bg-white/[0.12] hover:text-gray-900'
                  }
                  focus:outline-none`
                }
              >
                Code-based
              </Tab>
              <Tab
                className={({ selected }) =>
                  `rounded-md px-3 py-1 text-sm font-medium leading-5 quicksand cursor-pointer
                  ${
                    selected
                      ? 'bg-white text-gray-900 shadow'
                      : 'text-gray-700 hover:bg-white/[0.12] hover:text-gray-900'
                  }
                  focus:outline-none`
                }
              >
                Chat
              </Tab>
            </TabList>
          </div>

          {/* Settings Popup */}
          {showCameraSettings && (
              <div className="absolute top-10 right-0 w-64 bg-white border border-gray-300 rounded p-4 z-50 shadow-lg">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold">Settings</h4>
                  <button
                    onClick={() => setShowCameraSettings(false)}
                    className="text-gray-500 hover:text-gray-700 cursor-pointer"
                  >
                    ✕
                  </button>
                </div>
                
                <div className="space-y-3 text-xs">
                  {/* Robot Selection */}
                  <div className="pb-3 border-b border-gray-200">
                    <h5 className="font-medium text-gray-700 mb-2">Robot</h5>
                    <div className="flex gap-2" aria-label="robot-switch">
                      <button
                        className={getRobotButtonClasses(activeRobot, 'lekiwi')}
                        onClick={() => onRobotChange('lekiwi')}
                        type="button"
                      >
                        LeKiwi
                      </button>
                      <button
                        className={getRobotButtonClasses(activeRobot, 'so101')}
                        onClick={() => onRobotChange('so101')}
                        type="button"
                      >
                        SO101
                      </button>
                    </div>
                  </div>

                  {/* Camera Settings */}
                  <div>
                    <h5 className="font-medium text-gray-700 mb-2">Camera</h5>
                    <div className="flex flex-col gap-2">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={storeCameraPosition}
                          onChange={(e) => handleStoreCameraChange(e.target.checked)}
                          className="rounded"
                        />
                        <span className="text-gray-700">Remember position</span>
                      </label>
                      
                      <button
                        onClick={handleResetCamera}
                        className="w-full px-3 py-1.5 text-xs bg-gray-200 hover:bg-gray-300 rounded transition-colors"
                      >
                        Reset Camera
                      </button>
                      
                      <div className="text-[10px] text-gray-500 mt-1 pt-2 border-t">
                        When enabled, camera position will be saved and restored on page reload.
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          
          <TabPanels>
            <TabPanel className="flex flex-col gap-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2">
                  <MovementControl onMove={handleMove} />
                  <RotationControl onRotate={handleRotate} />
                </div>
                {robotConnection.render()}
              </div>
              
              <PlanarControlSection sceneHandle={sceneHandle} robotConnection={robotConnection} />
            </TabPanel>
            <TabPanel>
              <RemoteControl sceneHandle={sceneHandle} />
            </TabPanel>
            <TabPanel>
              <Chat className="h-[calc(100vh-250px)]" />
            </TabPanel>
          </TabPanels>
        </TabGroup>

        <div className="text-xs text-gray-600 mt-4 leading-normal border-t border-gray-200 pt-4" aria-label="attribution">
          Burger bun 3D model:
          <a
            href="https://sketchfab.com/3d-models/burger-bun-bread-1eb53bef512a48e5b61e934748201d4e"
            target="_blank"
            rel="noopener noreferrer"
            className="text-green-600 no-underline hover:underline"
          >
            Burger bun bread (Sketchfab)
          </a>
          <br />
          Burger patty 3D model:
          <a
            href="https://sketchfab.com/3d-models/cooked-burger-patty-meatball-fdeae6bf467f4ec2a42147cf877365c3"
            target="_blank"
            rel="noopener noreferrer"
            className="text-green-600 no-underline hover:underline"
          >
            Cooked burger patty / meatball (Sketchfab)
          </a>
          <br />
          Grass 3D model by MauroGonzalezA:
          <a
            href="https://sketchfab.com/3d-models/grass-4b800e07ea3543e3870ad5e53b39d825"
            target="_blank"
            rel="noopener noreferrer"
            className="text-green-600 no-underline hover:underline"
          >
            Grass (Sketchfab)
          </a>
          <br />
          Mango tree 3D model by stealth86:
          <a
            href="https://sketchfab.com/3d-models/mango-tree-4b186052228d43d8b3fbb63213677de8"
            target="_blank"
            rel="noopener noreferrer"
            className="text-green-600 no-underline hover:underline"
          >
            Mango tree (Sketchfab)
          </a>
          <br />
          Table 3D model by Silver10211:
          <a
            href="https://sketchfab.com/3d-models/table-a28843f21d784fe98cc220ef0d1df478"
            target="_blank"
            rel="noopener noreferrer"
            className="text-green-600 no-underline hover:underline"
          >
            Table (Sketchfab)
          </a>
        </div>
      </div>

      <button
        id="panel-toggle"
        className="btn btn-outline btn-sm rounded-none rounded-br-sm border-[var(--color-gray-300)] w-96 cursor-pointer flex items-center justify-between bg-transparent"
        type="button"
        onClick={onTogglePanel}
      >
        <h2>Controls</h2>
        <svg
          id="chevron-icon"
          className={`w-4 h-4 text-black transition-transform duration-300 ${isPanelOpen ? '' : 'rotate-180'}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
    </div>
  );
};
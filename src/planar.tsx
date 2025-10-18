import React, { useEffect, useRef, useState } from 'react';
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-webgl';
import * as handPoseDetection from '@tensorflow-models/hand-pose-detection';
import { Settings } from 'lucide-react';
import { IKVisualization } from './components/IKVisualization';
import { inverseKinematics2Link } from './utils/inverseKinematics';
import { SmoothedHandDetector } from './utils/SmoothedHandDetector';

type PlanarPosition = {
  x: number;
  y: number;
};

type PlanarControlOptions = {
  initialPosition?: PlanarPosition;
  onChange?: (position: PlanarPosition, theta: { radians: number; degrees: number }, circleSize: number) => void;
  initialCircleSize?: number;
  initialGripperAngle?: number;
  initialGripperMouthAngle?: number;
  onGripperAngleChange?: (angleDegrees: number) => void;
  onGripperMouthAngleChange?: (angleDegrees: number) => void;
  onWristRollChange?: (angleDegrees: number) => void;
  onWristFlexChange?: (angleDegrees: number) => void;
};

type InteractionAxis = 'x' | 'y' | 'both';

export const clampRange = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);
const clampUnitRange = (value: number) => clampRange(value, -1, 1);

export const MIN_CIRCLE_REM = 0.4;
export const MAX_CIRCLE_REM = 2.4;

// Scale factor for camera-to-control mapping when hand tracking is active
// Lower value = more camera buffer (e.g., 0.7 means only center 70% of camera maps to full range)
const CAMERA_TO_CONTROL_SCALE_WITH_TRACKING = 0.7;
const CAMERA_TO_CONTROL_SCALE_WITHOUT_TRACKING = 1.0;

const INDEX_FINGER_KEYPOINT = 'index_finger_tip';
const THUMB_TIP_KEYPOINT = 'thumb_tip';
const RING_FINGER_KEYPOINT = 'ring_finger_tip';
const WRIST_KEYPOINT = 'wrist';
const MIDDLE_FINGER_MCP_KEYPOINT = 'middle_finger_mcp';
const RING_FINGER_TIP_KEYPOINT = 'ring_finger_tip';
const GRIPPER_STEP_DEGREES = 1;

// Physical comfort range for gripper angle mapping
export const MIN_GRIPPER_ANGLE_PHYSICAL = -121;
export const MAX_GRIPPER_ANGLE_PHYSICAL = -60;

const MIN_GRIPPER_MOUTH_DEGREES = 0;
const MAX_GRIPPER_MOUTH_DEGREES = 120;
const GRIPPER_MOUTH_STEP_DEGREES = 1;
const WRIST_FLEX_STEP_DEGREES = 1;

// Physical comfort range for wrist flex angle (y-z plane)
// Angle is normalized to 0-360° range to avoid discontinuity
export const MIN_WRIST_FLEX_ANGLE = 130;
export const MAX_WRIST_FLEX_ANGLE = 230;

/**
 * PlanarControl class - manages planar position control with optional hand tracking
 */
export class PlanarControl {
  private position: PlanarPosition;
  private z: number; // Depth/circle size
  private gripperAngleDegrees: number;
  private gripperMouthAngleDegrees: number;
  private wristFlexAngleDegrees: number;
  private options: PlanarControlOptions;

  // Hand tracking state
  private detector: SmoothedHandDetector | null = null;
  private mediaStream: MediaStream | null = null;
  private handTrackingActive: boolean = false;
  private detectionFrameId: number | null = null;
  private videoElement: HTMLVideoElement | null = null;
  
  // Hand keypoints for visualization
  public handKeypoints: { thumb?: any; index?: any; ring?: any; thumbTip?: any; wrist?: any; middleFingerMcp?: any; ringFingerTip?: any } = {};
  
  // Raw hand tracking position for display
  public handTrackedPosition: { x: number; y: number; z: number } | null = null;
  
  // Z range configuration for robot mapping
  public zRangeMin: number = MIN_CIRCLE_REM;
  public zRangeMax: number = MAX_CIRCLE_REM;
  
  // Dynamic camera-to-control scale (updated by component based on hand tracking state)
  public cameraToControlScale: number = CAMERA_TO_CONTROL_SCALE_WITHOUT_TRACKING;

  constructor(options: PlanarControlOptions = {}) {
    this.options = options;
    this.position = {
      x: clampUnitRange(options.initialPosition?.x ?? 0),
      y: clampUnitRange(options.initialPosition?.y ?? 0),
    };
    this.z = clampRange(
      options.initialCircleSize ?? 1,
      MIN_CIRCLE_REM,
      MAX_CIRCLE_REM
    );
    this.gripperAngleDegrees = clampRange(
      options.initialGripperAngle ?? MIN_GRIPPER_ANGLE_PHYSICAL,
      MIN_GRIPPER_ANGLE_PHYSICAL,
      MAX_GRIPPER_ANGLE_PHYSICAL
    );
    this.gripperMouthAngleDegrees = clampRange(
      options.initialGripperMouthAngle ?? 30,
      MIN_GRIPPER_MOUTH_DEGREES,
      MAX_GRIPPER_MOUTH_DEGREES
    );
    this.wristFlexAngleDegrees = 0; // Initialize to 0 degrees
  }

  // Public API methods
  getNormalizedPosition(): PlanarPosition {
    return { ...this.position };
  }

  setNormalizedPosition(next: PlanarPosition) {
    this.position.x = clampUnitRange(next.x);
    this.position.y = clampUnitRange(next.y);
    this.emitChange();
  }

  getCircleSize(): number {
    return this.z;
  }

  setCircleSize(sizeRem: number) {
    this.z = clampRange(sizeRem, MIN_CIRCLE_REM, MAX_CIRCLE_REM);
    this.emitChange();
  }

  getZ(): number {
    return this.z;
  }

  setZ(z: number) {
    this.z = clampRange(z, MIN_CIRCLE_REM, MAX_CIRCLE_REM);
    this.emitChange();
  }

  /**
   * Set target position for inverse kinematics (X, Y, Z all at once)
   * @param x Normalized X position (-1 to 1)
   * @param y Normalized Y position (-1 to 1)
   * @param z Circle size / reach distance (MIN_CIRCLE_REM to MAX_CIRCLE_REM)
   */
  setTarget(x: number, y: number, z: number) {
    this.position.x = clampUnitRange(x);
    this.position.y = clampUnitRange(y);
    this.z = clampRange(z, MIN_CIRCLE_REM, MAX_CIRCLE_REM);
    this.emitChange();
  }

  /**
   * Get current target position (X, Y, Z)
   * @returns {x: number, y: number, z: number} where x,y are -1 to 1, z is MIN_CIRCLE_REM to MAX_CIRCLE_REM
   */
  getTarget() {
    return {
      x: this.position.x,
      y: this.position.y,
      z: this.z
    };
  }

  getGripperAngle(): number {
    return this.gripperAngleDegrees;
  }

  setGripperAngle(angleDegrees: number) {
    this.gripperAngleDegrees = clampRange(
      angleDegrees,
      MIN_GRIPPER_ANGLE_PHYSICAL,
      MAX_GRIPPER_ANGLE_PHYSICAL
    );
    this.options.onGripperAngleChange?.(this.gripperAngleDegrees);
  }

  getGripperMouthAngle(): number {
    return this.gripperMouthAngleDegrees;
  }

  setGripperMouthAngle(angleDegrees: number) {
    this.gripperMouthAngleDegrees = clampRange(
      angleDegrees,
      MIN_GRIPPER_MOUTH_DEGREES,
      MAX_GRIPPER_MOUTH_DEGREES
    );
    this.options.onGripperMouthAngleChange?.(this.gripperMouthAngleDegrees);
  }

  getWristFlexAngle(): number {
    return this.wristFlexAngleDegrees;
  }

  setWristFlexAngle(angleDegrees: number) {
    this.wristFlexAngleDegrees = clampRange(
      angleDegrees,
      MIN_WRIST_FLEX_ANGLE,
      MAX_WRIST_FLEX_ANGLE
    );
    this.options.onWristFlexChange?.(this.wristFlexAngleDegrees);
  }

  // Helper methods
  private computeThetaRadians(): number {
    const clampedX = clampRange(this.position.x, -1, 1);
    return Math.PI - Math.acos(clampedX); // this goes between pi to 0
  }

  private emitChange() {
    const thetaRadians = this.computeThetaRadians();
    const thetaDegrees = thetaRadians * (180 / Math.PI);
    this.options.onChange?.(
      { ...this.position },
      { radians: thetaRadians, degrees: thetaDegrees },
      this.z
    );
  }

  private mapDepthToCircleSize(depth: number): number {
    const normalized = clampRange(depth, -1, 1);
    return MIN_CIRCLE_REM + ((normalized + 1) / 2) * (MAX_CIRCLE_REM - MIN_CIRCLE_REM);
  }

  // Hand tracking methods
  private async ensureDetector(): Promise<SmoothedHandDetector> {
    if (this.detector) return this.detector;

    await tf.ready();
    if (tf.getBackend() !== 'webgl') {
      await tf.setBackend('webgl');
      await tf.ready();
    }

    const rawDetector = await handPoseDetection.createDetector(
      handPoseDetection.SupportedModels.MediaPipeHands,
      {
        runtime: 'mediapipe',
        solutionPath: 'https://cdn.jsdelivr.net/npm/@mediapipe/hands',
        modelType: 'full',
        maxHands: 1,
      }
    );

    // Wrap with smoothing (buffer size of 5 frames, adjust as needed)
    this.detector = new SmoothedHandDetector(rawDetector, 30);

    return this.detector;
  }

  private async runDetectionFrame() {
    if (!this.handTrackingActive || !this.detector || !this.videoElement) {
      return;
    }

    try {
      if (this.videoElement.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) {
        this.detectionFrameId = requestAnimationFrame(() => this.runDetectionFrame());
        return;
      }

      const hands = await this.detector.estimateHands(this.videoElement, {
        flipHorizontal: true,
      });

      if (hands.length > 0) {
        const hand = hands[0];
        const indexFinger2D = hand.keypoints?.find(
          (keypoint) => keypoint.name === INDEX_FINGER_KEYPOINT
        );
        const thumbTip2D = hand.keypoints?.find(
          (keypoint) => keypoint.name === THUMB_TIP_KEYPOINT
        );
        const ringFinger2D = hand.keypoints?.find(
          (keypoint) => keypoint.name === RING_FINGER_KEYPOINT
        );
        const wrist2D = hand.keypoints?.find(
          (keypoint) => keypoint.name === WRIST_KEYPOINT
        );
        const middleFingerMcp2D = hand.keypoints?.find(
          (keypoint) => keypoint.name === MIDDLE_FINGER_MCP_KEYPOINT
        );
        const ringFingerTip2D = hand.keypoints?.find(
          (keypoint) => keypoint.name === RING_FINGER_TIP_KEYPOINT
        );

        // Invert x coordinates for index, thumb and wrist (they're mirrored)
        const indexFingerCorrected = indexFinger2D && this.videoElement ? {
          ...indexFinger2D,
          x: this.videoElement.videoWidth - indexFinger2D.x
        } : indexFinger2D;

        const thumbTipCorrected = thumbTip2D && this.videoElement ? {
          ...thumbTip2D,
          x: this.videoElement.videoWidth - thumbTip2D.x
        } : thumbTip2D;

        const wristCorrected = wrist2D && this.videoElement ? {
          ...wrist2D,
          x: this.videoElement.videoWidth - wrist2D.x
        } : wrist2D;

        const middleFingerMcpCorrected = middleFingerMcp2D && this.videoElement ? {
          ...middleFingerMcp2D,
          x: this.videoElement.videoWidth - middleFingerMcp2D.x
        } : middleFingerMcp2D;

        const ringFingerTipCorrected = ringFingerTip2D && this.videoElement ? {
          ...ringFingerTip2D,
          x: this.videoElement.videoWidth - ringFingerTip2D.x
        } : ringFingerTip2D;

        // Extract 3D keypoints for z-coordinate information
        const wrist3D = hand.keypoints3D?.find(
          (keypoint) => keypoint.name === WRIST_KEYPOINT
        );
        const middleFingerMcp3D = hand.keypoints3D?.find(
          (keypoint) => keypoint.name === MIDDLE_FINGER_MCP_KEYPOINT
        );

        // Calculate wrist roll angle (angle between wrist and middle finger MCP across Z-axis)
        let wristRollAngle = 0;
        if (wristCorrected && middleFingerMcpCorrected) {
          const dx = middleFingerMcpCorrected.x - wristCorrected.x;
          const dy = middleFingerMcpCorrected.y - wristCorrected.y;
          wristRollAngle = Math.atan2(dy, dx) * (180 / Math.PI); // Convert to degrees
        }

        // Calculate wrist flex angle (y-z angle between wrist and middle finger MCP using 3D keypoints)
        // Note: Using only 3D keypoints which are in metric space, NOT mixing with 2D pixel coordinates
        if (wrist3D && middleFingerMcp3D && wrist3D.y !== undefined && wrist3D.z !== undefined && middleFingerMcp3D.y !== undefined && middleFingerMcp3D.z !== undefined) {          
          const dy = middleFingerMcp3D.y - wrist3D.y;
          const dz = middleFingerMcp3D.z - wrist3D.z;
          const wristFlexYZAngle = Math.atan2(dz, dy) * (180 / Math.PI); // Convert to degrees (-180 to 180)
          
          // Normalize to 0-360 range to avoid discontinuity at -180/180 boundary
          const normalizedAngle = (wristFlexYZAngle + 360) % 360;

          // Clamp and emit wrist flex angle
          const clampedAngle = clampRange(normalizedAngle, MIN_WRIST_FLEX_ANGLE, MAX_WRIST_FLEX_ANGLE);
          this.setWristFlexAngle(clampedAngle)
        }

        // Store keypoints for visualization
        this.handKeypoints = {
          thumb: thumbTip2D,
          index: indexFingerCorrected,
          ring: ringFinger2D,
          thumbTip: thumbTipCorrected,
          wrist: wristCorrected,
          middleFingerMcp: middleFingerMcpCorrected,
          ringFingerTip: ringFingerTipCorrected,
        };

        // Emit wrist roll angle change
        this.options.onWristRollChange?.(wristRollAngle);

        // Position tracking using index finger
        if (
          indexFinger2D &&
          this.videoElement.videoWidth &&
          this.videoElement.videoHeight
        ) {
          // Normalize camera coordinates to 0-1 range
          const cameraX = indexFinger2D.x / this.videoElement.videoWidth;
          const cameraY = indexFinger2D.y / this.videoElement.videoHeight;

          const topCutoff = (1 - this.cameraToControlScale) * 0.5
          const bottomCutoff = 1 - topCutoff

          let rawX = 0
          let rawY = 0

          if(cameraX < topCutoff) {
            rawX = 1
          } else if(cameraX > bottomCutoff) {
            rawX = -1
          } else {
            rawX = 1 - 2 * ((cameraX - topCutoff) / (bottomCutoff - topCutoff))
          }

          if(cameraY < topCutoff) {
            rawY = -1
          } else if(cameraY > bottomCutoff) {
            rawY = 1
          } else {
            rawY = -1 + 2 * ((cameraY - topCutoff) / (bottomCutoff - topCutoff))
          }
          
          
          // Update raw hand tracked position (unclamped)
          if (!this.handTrackedPosition) {
            this.handTrackedPosition = { x: rawX, y: rawY, z: 0 };
          } else {
            this.handTrackedPosition.x = rawX;
            this.handTrackedPosition.y = rawY;
          }
          
          // Set position (will be clamped inside setNormalizedPosition)
          this.setNormalizedPosition({ x: rawX, y: rawY });
        }

        // Circle size from wrist-to-middle-finger-MCP distance
        if (wristCorrected && middleFingerMcpCorrected) {
          const dx = middleFingerMcpCorrected.x - wristCorrected.x;
          const dy = middleFingerMcpCorrected.y - wristCorrected.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          
          // Map distance to circle size
          // Larger distance = hand is closer to camera = larger circle size
          // Smaller distance = hand is farther from camera = smaller circle size
          // Typical distance range might be 50-170 pixels (adjust based on testing)
          const minDistance = 50;  // Hand far away
          const maxDistance = 150; // Hand close
          const normalizedDistance = clampRange((distance - minDistance) / (maxDistance - minDistance), 0, 1);
          const circleSize = MIN_CIRCLE_REM + normalizedDistance * (MAX_CIRCLE_REM - MIN_CIRCLE_REM);
          console.log("normalized distance", normalizedDistance);
          this.setCircleSize(circleSize);
          
          // Update raw hand tracked position (Z as normalized distance)
          if (!this.handTrackedPosition) {
            this.handTrackedPosition = { x: 0, y: 0, z: normalizedDistance * 2 - 1 }; // -1 to 1
          } else {
            this.handTrackedPosition.z = normalizedDistance * 2 - 1;
          }
        }

        // Gripper mouth angle from thumb-index distance
        if (thumbTip2D && indexFinger2D) {
          const dx = thumbTip2D.x - indexFinger2D.x;
          const dy = thumbTip2D.y - indexFinger2D.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          
          // Normalize distance to 0-1 range (assuming max distance of ~100 pixels)
          const normalizedDistance = clampRange(distance / 100, 0, 1);
          const gripperMouthAngle = normalizedDistance * MAX_GRIPPER_MOUTH_DEGREES;
          this.setGripperMouthAngle(gripperMouthAngle);
        }

        // Gripper angle from thumb-index finger line angle
        if (thumbTip2D && indexFinger2D) {
          const dx = indexFinger2D.x - thumbTip2D.x;
          const dy = indexFinger2D.y - thumbTip2D.y;
          const angleRadians = Math.atan2(dy, dx);
          const angleDegrees = angleRadians * 180 / Math.PI;
          
          // Map to gripper angle physical range
          const normalizedAngle = ((angleDegrees + 180) % 360 - 180);
          const gripperAngle = clampRange(normalizedAngle, MIN_GRIPPER_ANGLE_PHYSICAL, MAX_GRIPPER_ANGLE_PHYSICAL);
          this.setGripperAngle(gripperAngle);
        }
      }
    } catch (error) {
      console.error('Hand pose detection error', error);
    }

    this.detectionFrameId = requestAnimationFrame(() => this.runDetectionFrame());
  }

  /**
   * Optional method to connect camera for hand tracking
   */
  async connectCamera(videoElement: HTMLVideoElement): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('MediaDevices API unsupported in this browser');
    }

    this.videoElement = videoElement;

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
      });
      this.videoElement.srcObject = this.mediaStream;
      await this.videoElement.play();

      await this.ensureDetector();

      this.handTrackingActive = true;
      this.detectionFrameId = requestAnimationFrame(() => this.runDetectionFrame());

      // Listen for track ended events
      this.mediaStream.getVideoTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          if (this.handTrackingActive) {
            this.disconnectCamera();
          }
        });
      });
    } catch (error) {
      console.error('Unable to start hand tracking', error);
      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach((track) => track.stop());
        this.mediaStream = null;
      }
      throw error;
    }
  }

  disconnectCamera(): void {
    this.handTrackingActive = false;
    if (this.detectionFrameId !== null) {
      cancelAnimationFrame(this.detectionFrameId);
      this.detectionFrameId = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.videoElement) {
      this.videoElement.srcObject = null;
      this.videoElement = null;
    }
  }

  isHandTrackingActive(): boolean {
    return this.handTrackingActive;
  }

  /**
   * Returns a React functional component that renders the controls
   */
  renderControls() {
    const control = this;

    return function PlanarControls() {
      const [position, setPosition] = useState<PlanarPosition>(
        control.getNormalizedPosition()
      );
      const [circleSize, setCircleSize] = useState(control.getCircleSize());
      const [gripperAngle, setGripperAngle] = useState(control.getGripperAngle());
      const [gripperMouthAngle, setGripperMouthAngle] = useState(
        control.getGripperMouthAngle()
      );
      const [wristFlexAngle, setWristFlexAngle] = useState(control.getWristFlexAngle());
      const [isDraggingCircleSize, setIsDraggingCircleSize] = useState(false);
      const [isDraggingPosition, setIsDraggingPosition] = useState(false);
      const [handTracking, setHandTracking] = useState(false);
      const [cameraButtonText, setCameraButtonText] = useState('Enable Hand Tracking');
      const [cameraButtonDisabled, setCameraButtonDisabled] = useState(false);
      const [handKeypoints, setHandKeypoints] = useState<{ thumb?: any; index?: any; ring?: any; thumbTip?: any; wrist?: any; middleFingerMcp?: any; ringFingerTip?: any }>({});
      const [showSettings, setShowSettings] = useState(false);
      const [showIKViz, setShowIKViz] = useState(false);
      
      // Dynamic scale factor: use buffer zone only when hand tracking is active
      const cameraToControlScale = handTracking ? CAMERA_TO_CONTROL_SCALE_WITH_TRACKING : CAMERA_TO_CONTROL_SCALE_WITHOUT_TRACKING;
      const [zRangeMin, setZRangeMin] = useState(() => {
        const saved = localStorage.getItem('planar-z-range-min');
        return saved ? parseFloat(saved) : MIN_CIRCLE_REM;
      });
      const [zRangeMax, setZRangeMax] = useState(() => {
        const saved = localStorage.getItem('planar-z-range-max');
        return saved ? parseFloat(saved) : MAX_CIRCLE_REM;
      });
      const [storePosition, setStorePosition] = useState(() => {
        const saved = localStorage.getItem('planar-store-position');
        return saved === 'true';
      });

      const videoRef = useRef<HTMLVideoElement>(null);
      const padRef = useRef<HTMLDivElement>(null);
      const canvasRef = useRef<HTMLCanvasElement>(null);
      const activeInteractionRef = useRef<{
        id: number;
        axis: InteractionAxis;
        target: HTMLElement;
      } | null>(null);

      const thetaRadians = gripperAngle * (Math.PI / 180);
      const thetaDegrees = gripperAngle;

      // Z range handlers
      const handleZRangeMinChange = (value: number) => {
        const clamped = clampRange(value, MIN_CIRCLE_REM, MAX_CIRCLE_REM);
        setZRangeMin(clamped);
        localStorage.setItem('planar-z-range-min', clamped.toString());
      };

      const handleZRangeMaxChange = (value: number) => {
        const clamped = clampRange(value, MIN_CIRCLE_REM, MAX_CIRCLE_REM);
        setZRangeMax(clamped);
        localStorage.setItem('planar-z-range-max', clamped.toString());
      };

      const handleResetZRange = () => {
        setZRangeMin(MIN_CIRCLE_REM);
        setZRangeMax(MAX_CIRCLE_REM);
        localStorage.removeItem('planar-z-range-min');
        localStorage.removeItem('planar-z-range-max');
      };

      const handleStorePositionChange = (enabled: boolean) => {
        setStorePosition(enabled);
        localStorage.setItem('planar-store-position', String(enabled));
        if (enabled) {
          // Save current position
          localStorage.setItem('planar-position', JSON.stringify(position));
        }
      };

      const handleResetPosition = () => {
        const defaultPos = { x: 0, y: 0 };
        setPosition(defaultPos);
        control.setNormalizedPosition(defaultPos);
        if (storePosition) {
          localStorage.setItem('planar-position', JSON.stringify(defaultPos));
        }
      };

      // Update position from pointer
      const updateFromPointer = (event: React.PointerEvent, axis: InteractionAxis) => {
        if (!padRef.current) return;

        const rect = padRef.current.getBoundingClientRect();
        const offsetX = clampRange((event.clientX - rect.left) / rect.width, 0, 1);
        const offsetY = clampRange((event.clientY - rect.top) / rect.height, 0, 1);

        const newPosition = { ...position };
        
        // Direct mapping: click position (0-1) → control position (-1 to +1)
        // No buffer zone logic needed - that's only for hand tracking camera boundaries
        if (axis === 'both' || axis === 'x') {
          newPosition.x = 2*offsetX - 1;
        }
        if (axis === 'both' || axis === 'y') {
          newPosition.y = 2*offsetY - 1;
        }

        setPosition(newPosition);
        control.setNormalizedPosition(newPosition);
      };

      // Pointer event handlers
      const handlePointerDown = (
        event: React.PointerEvent<HTMLDivElement>,
        axis: InteractionAxis
      ) => {
        event.preventDefault();
        activeInteractionRef.current = {
          id: event.pointerId,
          axis,
          target: event.currentTarget,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        if (axis === 'both') setIsDraggingPosition(true);
        updateFromPointer(event, axis);
      };

      const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        if (
          !activeInteractionRef.current ||
          activeInteractionRef.current.id !== event.pointerId
        )
          return;
        updateFromPointer(event, activeInteractionRef.current.axis);
      };

      const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
        if (
          !activeInteractionRef.current ||
          activeInteractionRef.current.id !== event.pointerId
        )
          return;
        if (activeInteractionRef.current.target.hasPointerCapture(event.pointerId)) {
          activeInteractionRef.current.target.releasePointerCapture(event.pointerId);
        }
        if (activeInteractionRef.current.axis === 'both') setIsDraggingPosition(false);
        activeInteractionRef.current = null;
      };

      // Hand tracking toggle
      const toggleHandTracking = async () => {
        if (handTracking) {
          control.disconnectCamera();
          setHandTracking(false);
          setCameraButtonText('Enable Hand Tracking');
        } else {
          if (!videoRef.current) return;

          setCameraButtonDisabled(true);
          setCameraButtonText('Starting…');

          try {
            await control.connectCamera(videoRef.current);
            setHandTracking(true);
            setCameraButtonText('Stop Hand Tracking');
          } catch (error) {
            console.error('Failed to start hand tracking', error);
            setCameraButtonText('Enable Hand Tracking');
          } finally {
            setCameraButtonDisabled(false);
          }
        }
      };

      // Load stored position on mount
      useEffect(() => {
        if (storePosition) {
          const saved = localStorage.getItem('planar-position');
          if (saved) {
            try {
              const savedPos = JSON.parse(saved);
              setPosition(savedPos);
              control.setNormalizedPosition(savedPos);
            } catch (e) {
              console.error('Failed to load saved position', e);
            }
          }
        }
      }, []);

      // Save position when it changes (if storing is enabled)
      useEffect(() => {
        if (storePosition) {
          localStorage.setItem('planar-position', JSON.stringify(position));
        }
      }, [position, storePosition]);

      // Sync Z range to control object
      useEffect(() => {
        control.zRangeMin = zRangeMin;
        control.zRangeMax = zRangeMax;
      }, [zRangeMin, zRangeMax]);

      // Sync camera-to-control scale based on hand tracking state
      useEffect(() => {
        control.cameraToControlScale = cameraToControlScale;
      }, [cameraToControlScale]);

      // Sync position when hand tracking updates it
      useEffect(() => {
        const interval = setInterval(() => {
          if (control.isHandTrackingActive()) {
            setPosition(control.getNormalizedPosition());
            setCircleSize(control.getCircleSize());
            setGripperAngle(control.getGripperAngle());
            setGripperMouthAngle(control.getGripperMouthAngle());
            setWristFlexAngle(control.getWristFlexAngle());
            setHandKeypoints(control.handKeypoints);
          }
        }, 50);

        return () => clearInterval(interval);
      }, []);

      // Draw hand keypoints on canvas
      useEffect(() => {
        if (!canvasRef.current || !videoRef.current) return;
        
        const canvas = canvasRef.current;
        const video = videoRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Set canvas internal resolution to match display size (220x220) for proper aspect ratio
        canvas.width = 348;
        canvas.height = 348;

        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Scale coordinates from video dimensions to canvas dimensions
        const scaleX = canvas.width / (video.videoWidth || 348);
        const scaleY = canvas.height / (video.videoHeight || 348);

        // Draw control range boundary box
        if (handTracking) {
          const centerX = canvas.width / 2;
          const centerY = canvas.height / 2;
          const boxWidth = canvas.width * cameraToControlScale;
          const boxHeight = canvas.height * cameraToControlScale;
          const boxX = centerX - boxWidth / 2;
          const boxY = centerY - boxHeight / 2;
          
          ctx.strokeStyle = '#10b981'; // green
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]); // dashed line
          ctx.strokeRect(boxX, boxY, boxWidth, boxHeight);
          ctx.setLineDash([]); // reset to solid line
        }

        if (!handTracking || !handKeypoints.thumb || !handKeypoints.index || !handKeypoints.ring) {
          return;
        }

        // Draw line from index (blue) to thumbTip (orange)
        if (handKeypoints.index && handKeypoints.thumbTip) {
          ctx.strokeStyle = '#3b82f6'; // blue
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(handKeypoints.index.x * scaleX, handKeypoints.index.y * scaleY);
          ctx.lineTo(handKeypoints.thumbTip.x * scaleX, handKeypoints.thumbTip.y * scaleY);
          ctx.stroke();
        }

        // Draw index finger dot (existing position marker)
        ctx.fillStyle = '#3b82f6'; // blue
        ctx.beginPath();
        ctx.arc(handKeypoints.index.x * scaleX, handKeypoints.index.y * scaleY, 6, 0, 2 * Math.PI);
        ctx.fill();

        // Draw THUMB_TIP dot
        if (handKeypoints.thumbTip) {
          ctx.fillStyle = '#f59e0b'; // orange
          ctx.beginPath();
          ctx.arc(handKeypoints.thumbTip.x * scaleX, handKeypoints.thumbTip.y * scaleY, 6, 0, 2 * Math.PI);
          ctx.fill();
        }

        // Draw theta value on canvas when hand tracking is active
        if (handTracking) {
          const thetaRadians = gripperAngle * (Math.PI / 180);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(10, 10, 150, 30);
          ctx.strokeStyle = '#3b82f6';
          ctx.lineWidth = 2;
          ctx.strokeRect(10, 10, 150, 30);
          ctx.fillStyle = '#000000';
          ctx.font = '14px monospace';
          ctx.fillText(`θ = ${thetaRadians.toFixed(3)} rad`, 15, 30);
        }

      }, [handTracking, handKeypoints, gripperAngle]);

      // Calculate position percentages for display
      // position.x and position.y are already in -1 to +1 range representing full control area
      const xPercent = ((position.x + 1) / 2) * 100;
      const yPercent = ((position.y + 1) / 2) * 100;


      // Linear slider handlers for circle size
      const sliderRef = useRef<HTMLDivElement>(null);

      const updateCircleSizeFromSlider = (clientX: number) => {
        if (!sliderRef.current) return;
        
        const rect = sliderRef.current.getBoundingClientRect();
        const offsetX = clampRange((clientX - rect.left) / rect.width, 0, 1);
        
        const newSize = MIN_CIRCLE_REM + offsetX * (MAX_CIRCLE_REM - MIN_CIRCLE_REM);
        setCircleSize(newSize);
        control.setCircleSize(newSize);
      };

      const handleCircleSizePointerDown = (e: React.PointerEvent) => {
        e.stopPropagation();
        setIsDraggingCircleSize(true);
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        updateCircleSizeFromSlider(e.clientX);
      };

      const handleCircleSizePointerMove = (e: React.PointerEvent) => {
        if (!isDraggingCircleSize) return;
        updateCircleSizeFromSlider(e.clientX);
      };

      const handleCircleSizePointerEnd = (e: React.PointerEvent) => {
        if (!isDraggingCircleSize) return;
        setIsDraggingCircleSize(false);
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      };

      // Calculate handle position for linear slider
      const sliderPercent = ((circleSize - MIN_CIRCLE_REM) / (MAX_CIRCLE_REM - MIN_CIRCLE_REM)) * 100;

      return (
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-600">
            Inverse Kinematics based control
          </h3>

          <div className="flex flex-col items-stretch gap-4">
            {/* Pad Area with Settings Button */}
            <div className="flex gap-2 items-start">
              {/* Main Pad */}
              <div className="relative w-full" style={{ aspectRatio: '1/1', maxWidth: '400px' }}>
              <div
                ref={padRef}
                className={`relative border border-gray-300 rounded overflow-hidden w-full h-full ${
                  handTracking ? '' : 'bg-white'
                }`}
                style={{
                  minWidth: '50px',
                  minHeight: '50px',
                  touchAction: 'none',
                }}
                onPointerDown={(e) => handlePointerDown(e, 'both')}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerEnd}
                onPointerCancel={handlePointerEnd}
              >
              {/* Video Element */}
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="absolute inset-0 h-full w-full object-cover pointer-events-none"
                style={{ display: handTracking ? 'block' : 'none' }}
                aria-hidden="true"
              />

              {/* Canvas overlay for hand keypoints */}
              <canvas
                ref={canvasRef}
                className="absolute inset-0 h-full w-full pointer-events-none"
                style={{ display: handTracking ? 'block' : 'none', zIndex: 3 }}
                aria-hidden="true"
              />

              {/* Horizontal Line */}
              <div
                className="absolute left-0 w-full border-t-2 border-dashed border-blue-400 pointer-events-auto"
                style={{
                  zIndex: 1,
                  top: `${yPercent}%`,
                  transform: 'translateY(-50%)',
                }}
                onPointerDown={(e) => handlePointerDown(e, 'y')}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerEnd}
                onPointerCancel={handlePointerEnd}
              />

              {/* Y Position Label - right side of horizontal line */}
              <div
                className="absolute pointer-events-none text-xs font-mono bg-white px-1 rounded border border-gray-300"
                style={{
                  zIndex: 4,
                  right: '8px',
                  top: `${yPercent}%`,
                  transform: 'translateY(-50%)',
                }}
              >
                Y: {position.y.toFixed(2)}
              </div>

              {/* Vertical Line */}
              <div
                className="absolute top-0 h-full border-l-2 border-dashed border-blue-400 pointer-events-auto"
                style={{
                  zIndex: 1,
                  left: `${xPercent}%`,
                  transform: 'translateX(-50%)',
                }}
                onPointerDown={(e) => handlePointerDown(e, 'x')}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerEnd}
                onPointerCancel={handlePointerEnd}
              />

              {/* X Position Label - bottom of vertical line */}
              <div
                className="absolute pointer-events-none text-xs font-mono bg-white px-1 rounded border border-gray-300"
                style={{
                  zIndex: 4,
                  left: `${xPercent}%`,
                  bottom: '8px',
                  transform: 'translateX(-50%)',
                }}
              >
                X: {position.x.toFixed(2)}
              </div>

              {/* Target Circle (variable size) */}
              <div
                className={`absolute rounded-full border-2 border-blue-500 bg-white pointer-events-auto ${
                  isDraggingPosition ? 'cursor-grabbing' : 'cursor-grab'
                }`}
                style={{
                  zIndex: 2,
                  left: `${xPercent}%`,
                  top: `${yPercent}%`,
                  width: `${circleSize}rem`,
                  height: `${circleSize}rem`,
                  transform: 'translate(-50%, -50%)',
                }}
                onPointerDown={(e) => handlePointerDown(e, 'both')}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerEnd}
                onPointerCancel={handlePointerEnd}
              />

                {/* Linear Slider for Circle Size - positioned below or above the circle based on y position */}
              <div
                className={`absolute pointer-events-auto flex items-center gap-1 ${position.y < 0 ? 'flex-col-reverse' : 'flex-col'}`}
                style={{
                  zIndex: 3,
                  left: `${xPercent}%`,
                  top: `${yPercent}%`,
                  transform: position.y > 0 
                    ? `translate(-50%, calc(-${circleSize / 2}rem - 16px - 100%))` // Above circle
                    : `translate(-50%, calc(${circleSize / 2}rem + 16px))`, // Below circle
                  width: '3.2rem', // Fixed width, slightly longer than max circle size
                }}
              >
                {/* Screen reader labels */}
                <span className="sr-only">Reach (Z-axis): {circleSize.toFixed(2)} rem</span>
                <div
                  ref={sliderRef}
                  className="relative w-full h-2 bg-blue-200 rounded-full cursor-pointer"
                  style={{ touchAction: 'none' }}
                  role="slider"
                  aria-label="Reach Z-axis"
                  aria-valuemin={MIN_CIRCLE_REM}
                  aria-valuemax={MAX_CIRCLE_REM}
                  aria-valuenow={circleSize}
                  aria-valuetext={`${circleSize.toFixed(2)} rem`}
                  onPointerDown={handleCircleSizePointerDown}
                  onPointerMove={handleCircleSizePointerMove}
                  onPointerUp={handleCircleSizePointerEnd}
                  onPointerCancel={handleCircleSizePointerEnd}
                >
                  {/* Track fill */}
                  <div
                    className="absolute top-0 left-0 h-full bg-blue-500 rounded-full pointer-events-none"
                    style={{ width: `${sliderPercent}%` }}
                  />
                  {/* Handle */}
                  <div
                    className="absolute top-1/2 w-3 h-3 bg-white border-2 border-blue-500 rounded-full cursor-grab active:cursor-grabbing pointer-events-none"
                    style={{
                      left: `${sliderPercent}%`,
                      transform: 'translate(-50%, -50%)',
                    }}
                  />
                </div>
                {/* Z Position Label - below the slider */}
                <div className="text-xs font-mono bg-white px-1 rounded border border-gray-300">
                  Z: {((circleSize - MIN_CIRCLE_REM) / (MAX_CIRCLE_REM - MIN_CIRCLE_REM) * 2 - 1).toFixed(2)}
                </div>
              </div>

            </div>

              {/* Settings Button */}
              <button
                type="button"
                onClick={() => setShowSettings(!showSettings)}
                className="absolute top-2 right-2 w-8 h-8 flex items-center justify-center rounded bg-gray-200 hover:bg-gray-300 transition-colors cursor-pointer"
                style={{ zIndex: 20 }}
                title="Z-Range Settings"
              >
                <Settings size={16} />
              </button>

              {/* Settings Modal */}
              {showSettings && (
                <div className="absolute top-0 right-0 mt-12 w-60 bg-white border border-gray-300 rounded p-4 z-30">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-semibold">Settings</h4>
                    <button
                      onClick={() => setShowSettings(false)}
                      className="text-gray-500 hover:text-gray-700 cursor-pointer"
                    >
                      ✕
                    </button>
                  </div>
                  
                  <div className="space-y-3 text-xs">
                    <div className="pb-3 border-b border-gray-200">
                      <h5 className="font-medium text-gray-700 mb-2">Z-Axis Range</h5>
                      <div className="space-y-2">
                        <div>
                          <label className="block text-gray-700 mb-1">
                            Min Z: {zRangeMin.toFixed(2)}
                          </label>
                          <input
                            type="range"
                            min={MIN_CIRCLE_REM}
                            max={MAX_CIRCLE_REM}
                            step="0.1"
                            value={zRangeMin}
                            onChange={(e) => handleZRangeMinChange(Number(e.target.value))}
                            className="w-full"
                          />
                        </div>
                        
                        <div>
                          <label className="block text-gray-700 mb-1">
                            Max Z: {zRangeMax.toFixed(2)}
                          </label>
                          <input
                            type="range"
                            min={MIN_CIRCLE_REM}
                            max={MAX_CIRCLE_REM}
                            step="0.1"
                            value={zRangeMax}
                            onChange={(e) => handleZRangeMaxChange(Number(e.target.value))}
                            className="w-full"
                          />
                        </div>
                        
                        <button
                          onClick={handleResetZRange}
                          className="w-full mt-1 px-3 py-1.5 text-xs bg-gray-200 hover:bg-gray-300 rounded transition-colors"
                        >
                          Reset Z Range
                        </button>
                      </div>
                    </div>

                    <div>
                      <h5 className="font-medium text-gray-700 mb-2">Position Storage</h5>
                      <div className="space-y-2">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={storePosition}
                            onChange={(e) => handleStorePositionChange(e.target.checked)}
                            className="rounded"
                          />
                          <span className="text-gray-700">Remember position</span>
                        </label>
                        
                        <button
                          onClick={handleResetPosition}
                          className="w-full px-3 py-1.5 text-xs bg-gray-200 hover:bg-gray-300 rounded transition-colors"
                        >
                          Reset Position
                        </button>
                        
                        <div className="text-[10px] text-gray-500 mt-2 pt-2 border-t">
                          When enabled, your crosshair position will be saved and restored on page reload.
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              </div>
            </div>
            
            {/* Hand Tracking Button */}
            <button
              type="button"
              className="self-start rounded bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              onClick={toggleHandTracking}
              disabled={cameraButtonDisabled}
            >
              {cameraButtonText}
            </button>

            {/* Sliders */}
            <div className="flex flex-col">
              <style>{`
                .custom-range {
                  -webkit-appearance: none;
                  appearance: none;
                  width: 100%;
                  height: 8px;
                  border-radius: 9999px;
                  border: none;
                  outline: none;
                  background: #bfdbfe;
                }
                .custom-range::-webkit-slider-thumb {
                  -webkit-appearance: none;
                  appearance: none;
                  width: 12px;
                  height: 12px;
                  border-radius: 9999px;
                  background: #3b82f6;
                  cursor: pointer;
                  border: none;
                }
                .custom-range::-moz-range-thumb {
                  width: 12px;
                  height: 12px;
                  border-radius: 9999px;
                  background: #3b82f6;
                  cursor: pointer;
                  border: none; 
                }
              `}</style>
              <div className="flex flex-col items-stretch gap-2 w-full">
                {/* Gripper Angle Slider */}
                <div className="flex flex-col items-stretch gap-1">
                  <span className="text-[10px] font-medium text-gray-600 text-left">
                    Gripper Angle: {(((gripperAngle - MIN_GRIPPER_ANGLE_PHYSICAL) / (MAX_GRIPPER_ANGLE_PHYSICAL - MIN_GRIPPER_ANGLE_PHYSICAL)) * 100).toFixed(2)}
                  </span>
                  <input
                    type="range"
                    min={MIN_GRIPPER_ANGLE_PHYSICAL}
                    max={MAX_GRIPPER_ANGLE_PHYSICAL}
                    step={GRIPPER_STEP_DEGREES}
                    value={gripperAngle}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      setGripperAngle(value);
                      control.setGripperAngle(value);
                    }}
                    className="custom-range"
                  />
                </div>

                {/* Gripper Mouth Angle Slider */}
                <div className="flex flex-col items-stretch gap-1">
                  <span className="text-[10px] font-medium text-gray-600 text-left">
                    Gripper Mouth: {gripperMouthAngle.toFixed(2)}°
                  </span>
                  <input
                    type="range"
                    min={MIN_GRIPPER_MOUTH_DEGREES}
                    max={MAX_GRIPPER_MOUTH_DEGREES}
                    step={GRIPPER_MOUTH_STEP_DEGREES}
                    value={gripperMouthAngle}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      setGripperMouthAngle(value);
                      control.setGripperMouthAngle(value);
                    }}
                    className="custom-range"
                  />
                </div>

                {/* Wrist Flex Slider */}
                <div className="flex flex-col items-stretch gap-1">
                  <span className="text-[10px] font-medium text-gray-600 text-left">
                    Wrist Flex: {(((wristFlexAngle - MIN_WRIST_FLEX_ANGLE) / (MAX_WRIST_FLEX_ANGLE - MIN_WRIST_FLEX_ANGLE)) * 100).toFixed(2)}
                  </span>
                  <input
                    type="range"
                    min={MIN_WRIST_FLEX_ANGLE}
                    max={MAX_WRIST_FLEX_ANGLE}
                    step={WRIST_FLEX_STEP_DEGREES}
                    value={wristFlexAngle}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      setWristFlexAngle(value);
                      control.setWristFlexAngle(value);
                    }}
                    className="custom-range"
                  />
                </div>
              </div>
            </div>

            {/* IK Visualization (Minimizable) */}
            <div className="flex flex-col gap-2 items-start">
              <button
                onClick={() => setShowIKViz(!showIKViz)}
                className="flex items-center justify-between px-2 py-1 text-xs font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded cursor-pointer w-full"
              >
                <span>IK Visualization (Y-Z)</span>
                <span className="text-lg leading-none">{showIKViz ? '−' : '+'}</span>
              </button>
              {showIKViz && (
                <IKVisualization
                  positionY={-position.y}
                  circleSize={circleSize}
                  zRangeMin={zRangeMin}
                  zRangeMax={zRangeMax}
                  calculateIK={inverseKinematics2Link}
                  width={80}
                  height={80}
                />
              )}
            </div>
          </div>
        </div>
      );
    };
  }
}

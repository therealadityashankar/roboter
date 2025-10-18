import * as handPoseDetection from '@tensorflow-models/hand-pose-detection';

interface KeypointBuffer {
  x: number[];
  y: number[];
  z?: number[];
  name?: string;
}

interface SmoothedKeypoint {
  x: number;
  y: number;
  z?: number;
  name?: string;
}

/**
 * Wrapper around hand pose detector that smooths keypoint values using rolling averages
 */
export class SmoothedHandDetector {
  private detector: handPoseDetection.HandDetector;
  private bufferSize: number;
  private keypointBuffers: Map<string, KeypointBuffer>;

  /**
   * @param detector The underlying hand pose detector
   * @param bufferSize Number of frames to average (default: 5)
   */
  constructor(detector: handPoseDetection.HandDetector, bufferSize: number = 5) {
    this.detector = detector;
    this.bufferSize = bufferSize;
    this.keypointBuffers = new Map();
  }

  /**
   * Detect hands and return smoothed keypoints
   */
  async estimateHands(
    input: handPoseDetection.HandDetectorInput,
    estimationConfig?: any
  ): Promise<handPoseDetection.Hand[]> {
    // Get raw detection results
    const hands = await this.detector.estimateHands(input, estimationConfig);

    if (hands.length === 0) {
      return hands;
    }

    // Process first hand (assuming single hand tracking)
    const hand = hands[0];
    const smoothedHand = { ...hand };

    // Smooth 2D keypoints
    // Note: keypoints (2D) represent x, y positions in image pixel space
    if (hand.keypoints) {
      smoothedHand.keypoints = hand.keypoints.map((keypoint) => {
        const bufferId = `2d_${keypoint.name}`;
        const smoothed = this.addAndSmooth(bufferId, keypoint);
        return {
          ...keypoint,
          x: smoothed.x,
          y: smoothed.y,
        };
      });
    }

    // Smooth 3D keypoints
    // Note: keypoints3D represent x, y, z in metric space (absolute distance)
    // The origin is formed as an average between the first knuckles of index, middle, ring and pinky fingers
    // These coordinates CANNOT be mixed with 2D pixel coordinates
    if (hand.keypoints3D) {
      smoothedHand.keypoints3D = hand.keypoints3D.map((keypoint) => {
        const bufferId = `3d_${keypoint.name}`;
        const smoothed = this.addAndSmooth(bufferId, keypoint);
        return {
          ...keypoint,
          x: smoothed.x,
          y: smoothed.y,
          z: smoothed.z,
        };
      });
    }

    return [smoothedHand, ...hands.slice(1)];
  }

  /**
   * Add keypoint to buffer and return smoothed value
   */
  private addAndSmooth(bufferId: string, keypoint: any): SmoothedKeypoint {
    // Get or create buffer for this keypoint
    if (!this.keypointBuffers.has(bufferId)) {
      this.keypointBuffers.set(bufferId, {
        x: [],
        y: [],
        z: keypoint.z !== undefined ? [] : undefined,
        name: keypoint.name,
      });
    }

    const buffer = this.keypointBuffers.get(bufferId)!;

    // Add new values to buffer
    buffer.x.push(keypoint.x);
    buffer.y.push(keypoint.y);
    if (buffer.z !== undefined && keypoint.z !== undefined) {
      buffer.z.push(keypoint.z);
    }

    // Keep buffer size limited
    if (buffer.x.length > this.bufferSize) {
      buffer.x.shift();
      buffer.y.shift();
      if (buffer.z) {
        buffer.z.shift();
      }
    }

    // Calculate averages
    const smoothed: SmoothedKeypoint = {
      x: this.average(buffer.x),
      y: this.average(buffer.y),
      name: keypoint.name,
    };

    if (buffer.z && buffer.z.length > 0) {
      smoothed.z = this.average(buffer.z);
    }

    return smoothed;
  }

  /**
   * Calculate average of an array of numbers
   */
  private average(values: number[]): number {
    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }

  /**
   * Clear all buffers (useful when restarting tracking)
   */
  public clearBuffers(): void {
    this.keypointBuffers.clear();
  }

  /**
   * Update buffer size
   */
  public setBufferSize(size: number): void {
    this.bufferSize = size;
    // Clear buffers to apply new size immediately
    this.clearBuffers();
  }

  /**
   * Get the underlying detector
   */
  public getDetector(): handPoseDetection.HandDetector {
    return this.detector;
  }

  /**
   * Reset the detector
   */
  async reset(): Promise<void> {
    this.clearBuffers();
    await this.detector.reset();
  }

  /**
   * Dispose of the detector
   */
  dispose(): void {
    this.clearBuffers();
    this.detector.dispose();
  }
}

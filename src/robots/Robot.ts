import URDFLoader, { URDFRobot, URDFLink } from 'urdf-loader';
import { ExtendedMesh, ExtendedObject3D, THREE } from 'enable3d';
import { Object3D } from 'three';

// Define the base structure for a pivot without mapped values
export interface UnmappedPivot {
  name: string      // Display name for the pivot
  jointName: string  // Name of the corresponding joint in the URDF
  objectName?: string // name of the object whose physics representation will be added
  value: number      // Current value
  jointValue?: number      // Current value
  lower: number;      // Lower limit
  upper: number;      // Upper limit
  physicsRepresentation?: {};
}

// Define the structure for a fully mapped pivot (extends UnmappedPivot with mapping properties)
interface Pivot extends UnmappedPivot {
  mappedLower: number; // Mapped lower limit for UI/external use
  mappedUpper: number; // Mapped upper limit for UI/external use
  physicsRepresentation?: {
    currentRotation : number
  }
}

// Define the PivotMap interface
interface PivotMap {
  [key: string]: Pivot;
}

// Define the UnmappedPivotMap interface for initialization
export interface UnmappedPivotMap {
  [key: string]: UnmappedPivot;
}

type RobotLoaderOptions = { 
  urdfLoaderOptions?: {
    manager : any
  }, 
  scene : THREE.Scene, 
  enable3dPhysicsObject : any,
  scale? : number,
  position? : THREE.Vector3,
  rotation? : THREE.Euler
};

export interface LinkPhysics{
  physicsMesh?: THREE.Mesh
  color?: THREE.Color
  gripper_part_a?: boolean
  gripper_part_b?: boolean
  physicsOffset?: { x?: number; y?: number; z?: number }
}

export interface LinkPhysicsMap{
  [key: string]: LinkPhysics;
}

export type VisualIKAxis = 'x' | 'y' | 'z';

export type VisualIKSegmentType = 'ik1' | 'ik2';

export interface VisualPhysicsIKConfig {
  jointName: string
  segment: VisualIKSegmentType
  axis: VisualIKAxis
  direction?: 1 | -1
}

export interface VisualIKSegmentInfo extends VisualPhysicsIKConfig {
  length: number
}

export interface VisualPhysics{
  physicsMesh?: THREE.Mesh
  color?: THREE.Color
  ikSegment?: VisualPhysicsIKConfig
  physicsOffset?: { x?: number; y?: number; z?: number }
}

export interface VisualPhysicsMap{
  [key: string]: VisualPhysics;
}

/**
 * Options for creating a Robot instance
 */
interface RobotOptions {
  name: string;           // Name of the robot
  modelPath: string;      // Path to the URDF model
  unmappedPivotMap?: UnmappedPivotMap; // Map of pivots
  basePhysicsRepresentation?: THREE.Mesh; // Base physics representation (not part of unmappedPivotMap)
  linkPhysicsMap: LinkPhysicsMap
  visualPhysicsMap?: VisualPhysicsMap
}

/**
 * Interface for all robot implementations
 */
export abstract class Robot extends THREE.Object3D {
  /**
   * Rotates a point around another point in space
   * @param pointToRotate - the point to be rotated (THREE.Vector3)
   * @param centerPoint - the point to rotate around (THREE.Vector3)
   * @param axis - the axis of rotation (normalized THREE.Vector3)
   * @param theta - radian value of rotation
   * @returns - a new Vector3 representing the rotated point
   */
  static rotatePointAroundPoint(pointToRotate: THREE.Vector3, centerPoint: THREE.Vector3, axis: THREE.Vector3, theta: number): THREE.Vector3 {
    // Create a new vector to avoid modifying the original
    const result = pointToRotate.clone();
    
    // Remove the offset
    result.sub(centerPoint);
    
    // Rotate the position
    result.applyAxisAngle(axis, theta);
    
    // Re-add the offset
    result.add(centerPoint);
    
    return result;
  }

  /**
   * Rotates an object around a specific point in space
   * @param obj - your object (THREE.Object3D or derived)
   * @param point - the point of rotation (THREE.Vector3)
   * @param axis - the axis of rotation (normalized THREE.Vector3)
   * @param theta - radian value of rotation
   * @param pointIsWorld - boolean indicating the point is in world coordinates (default = false)
   */
  static rotateMeshAboutPoint(obj: THREE.Object3D, point: THREE.Vector3, axis: THREE.Vector3, theta: number, pointIsWorld = false): void {
    if(pointIsWorld){
      obj.parent?.localToWorld(obj.position); // compensate for world coordinate
    }
    
    obj.position.sub(point); // remove the offset
    obj.position.applyAxisAngle(axis, theta); // rotate the POSITION
    obj.position.add(point); // re-add the offset
    
    if(pointIsWorld){
      obj.parent?.worldToLocal(obj.position); // undo world coordinates compensation
    }
    
    obj.rotateOnAxis(axis, theta); // rotate the OBJECT
  }
  
  public name: string;
  public modelPath: string;
  public robot : URDFRobot | null;
  private _initializationStatus : string;
  public pivotMap : PivotMap
  public loader : URDFLoader | null;
  public basePhysicsRepresentation : any;
  public linkPhysicsMap : LinkPhysicsMap
  public visualPhysicsMap : VisualPhysicsMap

  // all the objects "touched" by the grippers
  // if an object is simultaniously touched by both grippers, it can be lifted
  // by the gripper - obviously, this doesn't match how it works IRL
  // but it's the best workaround i could think of
  public gripper_a_touched_objects : Set<string>
  public gripper_b_touched_objects : Set<string>
  public gripped_objects : Map<string, any>
  public gripper_a : any

  constructor(options: RobotOptions) {
    super()
    this.name = options.name
    this.modelPath = options.modelPath
    this.robot = null;
    this.loader = null;
    this.linkPhysicsMap = options.linkPhysicsMap
    this.visualPhysicsMap = options.visualPhysicsMap || {}
    this.gripper_a_touched_objects = new Set()
    this.gripper_b_touched_objects = new Set()
    this.gripper_a = null
    this.gripped_objects = new Map()
    
    // Store the base physics representation if provided
    if (options.basePhysicsRepresentation) {
      this.basePhysicsRepresentation = options.basePhysicsRepresentation;
    } else {
      // Create a default compound object if none provided
      const geometry = new THREE.BoxGeometry()
      const material = new THREE.MeshLambertMaterial({ color: 0x00ff00 })
      this.basePhysicsRepresentation = new THREE.Mesh(geometry, material)
      this.basePhysicsRepresentation.position.set(0, 2, 0)
    }
    
    // Convert UnmappedPivotMap to PivotMap by adding default mappedLower and mappedUpper
    this.pivotMap = {};
    const unmappedPivotMap = options.unmappedPivotMap || {};
    Object.entries(unmappedPivotMap).forEach(([key, unmappedPivot]) => {
      let physicsRepresentation = unmappedPivot.physicsRepresentation

      this.pivotMap[key] = {
        ...unmappedPivot,
        // Default to using the same range for mapped values
        mappedLower: unmappedPivot.lower,
        mappedUpper: unmappedPivot.upper,
        physicsRepresentation: physicsRepresentation as Pivot['physicsRepresentation'] // because it's type is set either way
      };
    });

    this._initializationStatus = "uninitialized"
  }

  get initializationStatus() : string{
    return this._initializationStatus
  }

  async load(options: RobotLoaderOptions){
    const model = this.loadModel(options)
    await Robot.waitTillAllMeshesLoaded(this.robot, this.modelPath)

    if(this.robot){
      this.addPhysicsAndColorDefinitionsForObject(this.robot, options.enable3dPhysicsObject, this.linkPhysicsMap)
      this.addPhysicsAndColorDefinitionsForVisuals(this.robot, options.enable3dPhysicsObject, this.visualPhysicsMap)
    }
    return model
  }

   
  async loadModel(options: RobotLoaderOptions){
    this._initializationStatus = "loading"
    const urdfLoaderOptions = options?.urdfLoaderOptions || {manager : undefined}
    const manager = urdfLoaderOptions?.manager
    const loader = new URDFLoader(manager);
    const robot : any  = await loader.loadAsync(this.modelPath)
    const scale = options?.scale || 15
    robot.scale.set(scale, scale, scale);
    robot.position.set(0, 0, 0)
    robot.rotation.set(Math.PI/2, Math.PI, 0)

    if(options.position){
      robot.position.add(options.position)
    }

    if(options.rotation){
      robot.rotation.x += options.rotation.x
      robot.rotation.y += options.rotation.y
      robot.rotation.z += options.rotation.z
    }
    
    this.robot = robot;

    // Update the mapped joint limits in the pivots based on the loaded robot model
    if (robot.joints) {
      console.log("robot.joints", robot.joints)
      console.log("robot.links", robot.links)
      console.log("robot", robot)
      Object.values(this.pivotMap).forEach(pivot => {
        const joint = robot.joints?.[pivot.jointName];
        if (joint) {
          // Get the actual joint limits from the URDF model and update mappedLower/mappedUpper
          // These are the values that the user's input will be mapped TO
          if (joint.limit?.lower === undefined) {
            console.warn(`Joint '${pivot.jointName}' has no lower limit defined in URDF. Using default value of -3.14.`);
            pivot.mappedLower = -3.14;
          } else {
            // joint lower limit, normalized to 0 to 2PI
            pivot.mappedLower = joint.limit.lower;
          }
          
          if (joint.limit?.upper === undefined) {
            console.warn(`Joint '${pivot.jointName}' has no upper limit defined in URDF. Using default value of 3.14.`);
            pivot.mappedUpper = 3.14;
          } else {
            // joint upper limit, normalized to 0 to 2PI
            pivot.mappedUpper = joint.limit.upper;
          }          
          // The lower/upper values are kept as is - these are what the user specified
          // and are used in the UI (e.g., -100 to 100)
        } else {
          console.warn(`Joint '${pivot.jointName}' not found for pivot '${pivot.name}'. This pivot will not function correctly.`);
        }
      });
    }

    Object.keys(this.pivotMap).forEach(name => this.setPivotValue(name, this.pivotMap[name].value))

    this._initializationStatus = "initialized"
    options.scene.add(robot)
    return robot
  }

  // recursively set the color of all meshes in the object
  static setMeshColor(object : any, color : THREE.Color){
    for(let child of object.children){
      if(child.isMesh){
        child.material.color.set(color)
      }
      Robot.setMeshColor(child, color)
    }
  }

  /**
   * Waits until all meshes from URDF are loaded into the robot
   * @param robot - The URDFRobot instance
   * @param urdfPath - Path to the URDF file
   * @param maxWait - Maximum time to wait in milliseconds
   * @param interval - Interval between checks in milliseconds
   * @returns Promise<boolean> - true if all meshes loaded, false if timeout
   */
  static async waitTillAllMeshesLoaded(
    robot: URDFRobot | null,
    urdfPath: string,
    maxWait: number = 3000,
    interval: number = 100
  ): Promise<boolean> {
    const start = Date.now();
    
    while (Date.now() - start < maxWait) {
      const allMeshesLoaded = await Robot.checkAllMeshesLoaded(robot, urdfPath);
      if (allMeshesLoaded) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    
    return false;
  }

  /**
   * Parses URDF XML to find all mesh filenames referenced in the file
   * @param urdfPath - Path to the URDF file
   * @returns Array of mesh filenames (without path, just filename)
   */
  static async getMeshFilenamesFromURDF(urdfPath: string): Promise<string[]> {
    const response = await fetch(urdfPath);
    const urdfXml = await response.text();
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(urdfXml, 'text/xml');
    
    const meshElements = xmlDoc.querySelectorAll('mesh');
    const meshFilenames: Set<string> = new Set();
    
    meshElements.forEach(meshElement => {
      const filename = meshElement.getAttribute('filename');
      if (filename) {
        // Extract just the filename from paths like "package://robot/meshes/file.dae"
        // or "meshes/file.dae" or just "file.dae"
        const parts = filename.split('/');
        const file = parts[parts.length - 1];
        meshFilenames.add(file);
      }
    });
    
    return [...meshFilenames];
  }

  /**
   * Recursively counts all loaded meshes in the robot object tree
   * @param object - The object to traverse
   * @returns Total number of meshes
   */
  static collectTotalMeshes(object: any): number {
    if (!object) return 0;
    
    let count = 0;
    
    if (object.isMesh) {
      count++;
    }
    
    for (const child of object.children ?? []) {
      count += Robot.collectTotalMeshes(child);
    }
    
    return count;
  }

  static computeObjectAxisLength(object: any, axis: VisualIKAxis): number {
    if (!object) {
      return 0;
    }

    const bbox = new THREE.Box3().setFromObject(object);
    const size = new THREE.Vector3();
    bbox.getSize(size);

    if (axis === 'x') return size.x;
    if (axis === 'y') return size.y;
    return size.z;
  }

  static buildIKSegmentInfo(mesh: any, configs: VisualPhysicsIKConfig[]): VisualIKSegmentInfo[] {
    const segments: VisualIKSegmentInfo[] = [];

    for (const config of configs) {
      const length = Robot.computeObjectAxisLength(mesh, config.axis);
      console.log(`Visual IK axis length`, {
        visual: mesh?.name,
        jointName: config.jointName,
        segment: config.segment,
        axis: config.axis,
        length
      });
      if (length > 0) {
        segments.push({
          ...config,
          length: length * (config.direction ?? 1)
        });
      }
    }

    return segments;
  }

  static calculatePlanarIKEndPosition(
    basePosition: THREE.Vector3,
    segments: { length: number; angleRadians: number }[]
  ): THREE.Vector3 {
    let accumulatedAngle = 0;
    const endPosition = basePosition.clone();

    for (const segment of segments) {
      accumulatedAngle += segment.angleRadians;
      endPosition.x += segment.length * Math.cos(accumulatedAngle);
      endPosition.y += segment.length * Math.sin(accumulatedAngle);
    }

    return endPosition;
  }

  static calculateIKEndEffectorPositionFromSegments(
    basePosition: THREE.Vector3,
    segmentInfos: VisualIKSegmentInfo[],
    jointAngles: Record<string, number>
  ): THREE.Vector3 {
    const orderedSegments = [...segmentInfos].sort((a, b) => a.segment.localeCompare(b.segment));
    const planarSegments = orderedSegments.map(info => ({
      length: info.length,
      angleRadians: jointAngles[info.jointName] ?? 0
    }));

    return Robot.calculatePlanarIKEndPosition(basePosition, planarSegments);
  }

  calculateVisualIKEndEffectorPosition(
    visualName: string,
    jointAngles: Record<string, number>,
    basePosition: THREE.Vector3 = new THREE.Vector3()
  ): THREE.Vector3 | null {
    if (!this.robot || !this.robot.visual) {
      return null;
    }

    const visual = this.robot.visual[visualName];
    if (!visual) {
      return null;
    }

    const mesh = Robot.findFirstMesh(visual);
    const segmentInfos = mesh?.userData?.ikSegmentsInfo as VisualIKSegmentInfo[] | undefined;

    if (!mesh || !segmentInfos || segmentInfos.length === 0) {
      return null;
    }

    return Robot.calculateIKEndEffectorPositionFromSegments(basePosition, segmentInfos, jointAngles);
  }

  /**
   * Checks if all meshes defined in the URDF have been loaded into the robot
   * @param robot - The URDFRobot instance
   * @param urdfPath - Path to the URDF file
   * @returns Promise<boolean> - true if all meshes are loaded, false otherwise
   */
  static async checkAllMeshesLoaded(robot: URDFRobot | null, urdfPath: string): Promise<boolean> {
    if (!robot) return false;
    
    const expectedMeshes = await Robot.getMeshFilenamesFromURDF(urdfPath);
    const expectedMeshCount = expectedMeshes.length;
    
    const loadedMeshCount = Robot.collectTotalMeshes(robot);
    
    const allLoaded = loadedMeshCount >= expectedMeshCount;
    return allLoaded;
  }

  /**
   * Legacy function - checks if at least one mesh exists (kept for backwards compatibility)
   */
  static checkLinkHasMeshesRecursive(object: any): boolean {
    if (!object) return false;
  
    for (const child of object.children ?? []) {
      if (child.isMesh) {
        return true;
      }
      if (Robot.checkLinkHasMeshesRecursive(child)) {
        return true;
      }
    }
    return false;
  }


  // keep traversing the parent....the parents parent, recursively, until a URDFLink
  // is reached, then return that link
  static getURDFLinkForObject(object : any) : URDFLink | null{
    if(object.isURDFLink){
      return object
    }

    if(object.parent){ 
      return this.getURDFLinkForObject(object.parent)
    }

    return null
  }

  /**
   * Traverses links, for links that have appropriate physics definitions
   * It adds appropriate physics bodies for them for the robot
   */
  addPhysicsAndColorDefinitionsForObject(robot : URDFRobot, enable3dObj : any, linkPhysicsMap : LinkPhysicsMap){
    for(let [linkName, link] of Object.entries(robot.links)){
      if(linkPhysicsMap[linkName]){
        let physicsAndColor = linkPhysicsMap[linkName]
        let compoundBox = { shape: 'box', width: 0.01, height: 0.01, depth: 0.01, x:0, y:0, z:0 }

        if(physicsAndColor.physicsMesh){
          // @ts-expect-error because parameters does exist for...cubes, not sure why it isn't properly typed
          compoundBox.width = physicsAndColor.physicsMesh.geometry.parameters.width
          // @ts-expect-error because parameters does exist for...cubes, not sure why it isn't properly typed
          compoundBox.height = physicsAndColor.physicsMesh.geometry.parameters.height
          // @ts-expect-error because parameters does exist for...cubes, not sure why it isn't properly typed
          compoundBox.depth = physicsAndColor.physicsMesh.geometry.parameters.depth
          const offset = physicsAndColor.physicsOffset || {};
          compoundBox.x = physicsAndColor.physicsMesh.position.x + (offset.x ?? 0)
          compoundBox.y = physicsAndColor.physicsMesh.position.y + (offset.y ?? 0)
          compoundBox.z = physicsAndColor.physicsMesh.position.z + (offset.z ?? 0)
        }

        if(physicsAndColor.color){
          // Attempts to set mesh colors with retry + timeout logic.
          // Checks if all meshes from URDF are loaded before applying the color.
          // Retries every 100ms (up to 3s by default) to handle async loading of meshes.
          // Falls back gracefully with a warning if meshes never appear.
          Robot.setMeshColor(link, physicsAndColor.color as THREE.Color);
        }

        enable3dObj.add.existing(link, {compound : [compoundBox]})

        // typecasted as enable3dObj.add.existing adds the body property to the object
        const body = (link as unknown as ExtendedMesh).body
        body.setCollisionFlags(2)

        
        if(physicsAndColor.gripper_part_a){
          this.gripper_a = link;

          body.on.collision((otherObject : any, event : any) => {
            if (otherObject.name !== 'ground' && otherObject.userData.grippable === true) {
              if(event == "start"){
                this.gripper_a_touched_objects.add(otherObject)

                // if its being touched by both grippers, constraint
                // it to gripper a, to simulate it being "attached"
                // it's hard to do this otherwise
                if(this.gripper_b_touched_objects.has(otherObject.name)){
                  console.log("gripped", otherObject.name)
                  this.markObjectAsGripped(otherObject.name, otherObject)
                }
                
              } else if(event == "end"){
                console.log("ungripped", otherObject.name)
                this.gripper_a_touched_objects.delete(otherObject.name)
                this.markObjectAsUngripped(otherObject.name)
              }
            } 
          })
        }
        
        if(physicsAndColor.gripper_part_b){
          body.on.collision((otherObject : any, event : any) => {
            if (otherObject.name !== 'ground' && otherObject.userData.grippable === true) {              if(event == "start"){
                this.gripper_b_touched_objects.add(otherObject.name)

                // if its being touched by both grippers, constraint
                // it to gripper a, to simulate it being "attached"
                // it's hard to do this otherwise
                if(this.gripper_a_touched_objects.has(otherObject.name)){
                  console.log("gripped", otherObject.name)
                  this.markObjectAsGripped(otherObject.name, otherObject.body)
                }

              } else if(event == "end"){
                console.log("ungripped", otherObject.name)
                this.gripper_b_touched_objects.delete(otherObject.name)
                this.markObjectAsUngripped(otherObject.name)
              }
            }
          })
        }
      }
    }
  }

  /**
   * Gets the first child mesh of an object
   * @param object - The object to check
   * @returns The first child mesh, or null
   */
  static findFirstMesh(object: any): THREE.Mesh | null {
    if (!object || !object.children || object.children.length === 0) return null;
    
    const firstChild = object.children[0];
    return firstChild?.isMesh ? firstChild : null;
  }

  /**
   * Traverses visuals and adds physics and color definitions
   * Works with URDFVisual elements instead of URDFLink elements
   */
  addPhysicsAndColorDefinitionsForVisuals(robot : URDFRobot, enable3dObj : any, visualPhysicsMap : VisualPhysicsMap){
    if (!robot.visual) return;
    
    for(const [visualName, visual] of Object.entries(robot.visual)){
      if(visualPhysicsMap[visualName]){
        const physicsAndColor = visualPhysicsMap[visualName];

        console.log("visual found", visual)
        
        // Find the first mesh in the visual's children
        const mesh = Robot.findFirstMesh(visual);
        if (!mesh) {
          console.warn(`No mesh found for visual: ${visualName}`);
          continue;
        }
        
        // Set color if specified
        if(physicsAndColor.color){
          Robot.setMeshColor(mesh, physicsAndColor.color as THREE.Color, this.robot, this.modelPath);
        }

        if(physicsAndColor.ikSegment){
          const ikSegmentInfos = Robot.buildIKSegmentInfo(mesh, [physicsAndColor.ikSegment]);
          mesh.userData = mesh.userData || {};
          mesh.userData.ikSegmentsInfo = ikSegmentInfos;
        }
        
        // Add physics
        // Clone the mesh, translate it, and apply physics to the clone
        const meshClone = mesh.clone();
        const offset = physicsAndColor.physicsOffset || {};
        
        if(physicsAndColor.physicsMesh){
          // Use compound box with specified physics mesh
          const physicsMesh = physicsAndColor.physicsMesh;
          
          // @ts-expect-error because parameters does exist for cubes, not sure why it isn't properly typed
          const width = physicsMesh.geometry.parameters.width;
          // @ts-expect-error because parameters does exist for cubes, not sure why it isn't properly typed
          const height = physicsMesh.geometry.parameters.height;
          // @ts-expect-error because parameters does exist for cubes, not sure why it isn't properly typed
          const depth = physicsMesh.geometry.parameters.depth;
          
          // Position clone with offset adjustments
          meshClone.position.set(
            (offset.x ?? 0) - width / 2,
            (offset.y ?? 0) - height / 2,
            (offset.z ?? 0) - depth / 2
          );
          
          const compoundBox = {
            shape: 'box',
            width,
            height,
            depth,
            x: 0,
            y: 0,
            z: 0
          };
          
          meshClone.visible = false;
          mesh.add(meshClone);
          enable3dObj.add.existing(meshClone, {compound : [compoundBox]});
          
          // Set collision flags
          const body = (meshClone as unknown as ExtendedMesh).body;
          if (body) {
            body.setCollisionFlags(2);
          }
        } else {
          const bbox = new THREE.Box3().setFromObject(mesh);
          const size = new THREE.Vector3();
          bbox.getSize(size);
          
          // Position clone with offset adjustments
          meshClone.position.set(
            (offset.x ?? 0),
            (offset.y ?? 0),
            (offset.z ?? 0)
          );
          
          const boxShape = { 
            width: size.x, 
            height: size.y, 
            depth: size.z, 
            x: 0,
            y: 0,
            z: 0
          }

          meshClone.visible = false;
          mesh.add(meshClone);
          enable3dObj.add.existing(meshClone, { addChildren: false, shape : 'box', ...boxShape });
          
          // Set collision flags
          const body = (meshClone as unknown as ExtendedMesh).body;
          if (body) {
            body.setCollisionFlags(2);
          }
        }
      }
    }
  }

  markObjectAsGripped(object_name : string, object : ExtendedObject3D){
    console.log("object_body", object, object.position, object.position.constructor.name)
    const gripperAWorldPosition = new THREE.Vector3()
    const gripperAWorldQuat = new THREE.Quaternion();

    this.gripper_a.getWorldPosition(gripperAWorldPosition)
    this.gripper_a.getWorldQuaternion(gripperAWorldQuat)

    const invGripperQuat = gripperAWorldQuat.clone().invert();
    const relativeQuat = object.quaternion.clone().premultiply(gripperAWorldQuat.clone().invert());

    const relativePositionAndRotation = object.position.clone()
    .sub(gripperAWorldPosition)
    .applyQuaternion(invGripperQuat);

    const relativePosition = new THREE.Vector3().subVectors(object.position, gripperAWorldPosition)
    this.gripped_objects.set(object_name, {object, relativePosition, relativePositionAndRotation, relativeQuat})
    object.body.setCollisionFlags(2)
  }

  markObjectAsUngripped(object_name : string){
    if(this.gripped_objects.has(object_name)){
      let object = this.gripped_objects.get(object_name).object
      this.gripped_objects.delete(object_name)
      object.body.setCollisionFlags(0)
    }
  }


  updateGrippedObjectPositions(){
    for(let [obj_name, details] of this.gripped_objects.entries()){
      let object = details.object as ExtendedObject3D
      const gripperAWorldPosition = new THREE.Vector3()
      const gripperAWorldQuat = new THREE.Quaternion();
  
      this.gripper_a.getWorldPosition(gripperAWorldPosition)
      this.gripper_a.getWorldQuaternion(gripperAWorldQuat)

      const rel = details.relativePositionAndRotation

      const rotatedOffset = rel.clone().applyQuaternion(gripperAWorldQuat)
      const newWorldPos = new THREE.Vector3().addVectors(gripperAWorldPosition, rotatedOffset);

      object.position.copy(newWorldPos)
      object.quaternion.copy(gripperAWorldQuat).multiply(details.relativeQuat)
      object.body.needUpdate = true
    }
  } 

  /**
   * Recursively adds all the children into enable3dObj, recursively adding physics objects for
   * URDF Links and joints
   * @param enable3dObj 
   * @param obj 
   */
  static markLinksAsNeedingPhysicsUpdate(obj : URDFRobot){
    for(let [_, link] of Object.entries(obj.links)){
      // @ts-expect-error enable3dObj.add.existing adds the body property to the object
      if(link.body){
      // @ts-expect-error enable3dObj.add.existing adds the body property to the object
        link.body.needUpdate = true;
      }
    }
  }

  static markVisualsAsNeedingPhysicsUpdate(obj : URDFRobot){
    if(!obj.visual) return;
    
    for(const [_, visual] of Object.entries(obj.visual)){
      const mesh = Robot.findFirstMesh(visual);
      // @ts-expect-error enable3dObj.add.existing adds the body property to the mesh
      if(mesh?.body){
        // @ts-expect-error enable3dObj.add.existing adds the body property to the mesh
        mesh.body.needUpdate = true;
      }
      
      // Check children for physics bodies (cloned meshes with physics)
      if(mesh?.children){
        for(const child of mesh.children){
          // @ts-expect-error enable3dObj.add.existing adds the body property to the child
          if(child.body){
            // @ts-expect-error enable3dObj.add.existing adds the body property to the child
            child.body.needUpdate = true;
          }
        }
      }
    }
  }

  /**
   * set the joint value for the urdf robot
   */
  setJointValue( name : string, ...values : number[] ) : boolean{
    if(!this.robot) throw Error("robot must be initialized before calling this function")
    // rotate the corresponding physics representation
    const pivotName : string | undefined = Object.keys(this.pivotMap).find(key => {
      return this.pivotMap[key].jointName === name
    })

    if(!pivotName){
      return false;
    }

    //this.moveSubsequentPivotsAndPhysicsBodies(pivotName, values[0])

    const pivot = this.pivotMap[pivotName]

    if(pivot && pivot.physicsRepresentation)
      pivot.physicsRepresentation.currentRotation = values[0];

    Robot.markLinksAsNeedingPhysicsUpdate(this.robot)
    Robot.markVisualsAsNeedingPhysicsUpdate(this.robot)
    this.updateGrippedObjectPositions()

    return this.robot.setJointValue(name, ...values)
  }

  /**
   * set the joint values for the urdf robot
   */
  setJointValues( jointValueDictionary : { [key: string]: number | number[]; } ) : boolean{
    if(!this.robot) throw Error("robot must be initialized before calling this function")

    let finalBoolean : boolean = true

    for(let [key, value] of Object.entries(jointValueDictionary)){
      if(!Array.isArray(value)) value = [value]
      finalBoolean = finalBoolean && this.setJointValue(key, ...value)
    }

    return finalBoolean
  }

  get joints(){
    return this.robot?.joints
  }

  /**
   * Get all pivots
   */
  get pivots(): PivotMap {
    return this.pivotMap;
  }

  /**
   * Set a single pivot value and update the corresponding joint
   * @param name Name of the pivot
   * @param value Value to set
   * @returns Boolean indicating success
   */
  setPivotValue(name: string, value: number): boolean {
    if (!this.pivotMap[name]) {
      console.error(`Pivot '${name}' not found`);
      return false;
    }
    
    // Get the pivot
    const pivot = this.pivotMap[name];
    
    // Map the value from UI range (lower/upper) to joint range (mappedLower/mappedUpper)
    const jointValue = this.mapValue(
      value, 
      pivot.lower, 
      pivot.upper,
      pivot.mappedLower, 
      pivot.mappedUpper
    );

    
    // Update the actual robot joint using the jointName
    const returnVal = this.setJointValue(pivot.jointName, jointValue);

    // Update pivot value
    this.pivotMap[name].value = value;
    this.pivotMap[name].jointValue = jointValue;

    return returnVal
  }

  /**
   * Set multiple pivot values at once
   * @param pivotValueDictionary Dictionary of pivot names to values
   * @returns Boolean indicating success
   */
  setPivotValues(pivotValueDictionary: { [key: string]: number }): boolean {
    let success = true;
    
    // Create a joint value dictionary for the actual robot
    const jointValueDictionary: { [key: string]: number } = {};
    
    Object.entries(pivotValueDictionary).forEach(([name, value]) => {
      if (!this.pivotMap[name]) {
        console.error(`Pivot '${name}' not found`);
        success = false;
        return;
      }
      
      // Update pivot value
      this.pivotMap[name].value = value;
      
      // Get the pivot
      const pivot = this.pivotMap[name];
      
      // Map the value from UI range (lower/upper) to joint range (mappedLower/mappedUpper)
      const jointValue = this.mapValue(
        value, 
        pivot.lower, 
        pivot.upper,
        pivot.mappedLower, 
        pivot.mappedUpper
      );
      
      jointValueDictionary[pivot.jointName] = jointValue;
    });
    
    // Update the actual robot joints
    if (Object.keys(jointValueDictionary).length > 0) {
      success = success && this.setJointValues(jointValueDictionary);
    }
    
    return success;
  }

  /**
   * Map a value from one range to another using linear interpolation
   * For pivot controls, this maps from the UI control range (lower/upper) to the actual joint limits (mappedLower/mappedUpper)
   * @param value Value to map (from UI control)
   * @param fromLow Lower bound of the source range (pivot.lower, e.g. -100)
   * @param fromHigh Upper bound of the source range (pivot.upper, e.g. 100)
   * @param toLow Lower bound of the target range (pivot.mappedLower, e.g. -3.14)
   * @param toHigh Upper bound of the target range (pivot.mappedUpper, e.g. 3.14)
   * @returns Mapped value (actual joint value)
   * @private
   */
  private mapValue(value: number, fromLow: number, fromHigh: number, toLow: number, toHigh: number): number {
    // If the ranges are the same, no mapping needed
    if (fromLow === toLow && fromHigh === toHigh) {
      return value;
    }
    
    // Handle edge cases
    if (fromLow === fromHigh) return toLow;
    
    // Calculate the mapped value using linear interpolation
    const normalizedValue = (value - fromLow) / (fromHigh - fromLow);
    return toLow + normalizedValue * (toHigh - toLow);
  }
}

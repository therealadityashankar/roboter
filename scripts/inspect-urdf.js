const fs = require('fs');
const path = require('path');
const { parseString } = require('xml2js');

const urdfDir = path.join(__dirname, '../static/urdf');

// Recursively find all .urdf files
function findUrdfFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  
  files.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      findUrdfFiles(filePath, fileList);
    } else if (file.toLowerCase().endsWith('.urdf')) {
      fileList.push(filePath);
    }
  });
  
  return fileList;
}

// Parse and inspect a URDF file
function inspectUrdf(filePath) {
  console.log('\n' + '='.repeat(80));
  console.log(`📄 File: ${path.relative(urdfDir, filePath)}`);
  console.log('='.repeat(80));
  
  const xmlContent = fs.readFileSync(filePath, 'utf8');
  
  parseString(xmlContent, (err, result) => {
    if (err) {
      console.error(`❌ Error parsing ${filePath}:`, err);
      return;
    }
    
    const robot = result.robot;
    
    if (!robot) {
      console.log('⚠️  No robot element found');
      return;
    }
    
    // Robot name
    if (robot.$ && robot.$.name) {
      console.log(`\n🤖 Robot Name: ${robot.$.name}`);
    }
    
    // Links
    if (robot.link && robot.link.length > 0) {
      console.log(`\n🔗 Links (${robot.link.length}):`);
      robot.link.forEach((link, idx) => {
        const linkName = link.$ && link.$.name ? link.$.name : `unnamed_${idx}`;
        console.log(`  ${idx + 1}. ${linkName}`);
        
        // Check if link has visual elements
        if (link.visual && link.visual.length > 0) {
          link.visual.forEach((visual, vIdx) => {
            const visualName = visual.$ && visual.$.name ? visual.$.name : `visual_${vIdx}`;
            console.log(`     └─ Visual: ${visualName}`);
          });
        }
      });
    }
    
    // Visuals (top-level, though typically nested in links)
    const allVisuals = [];
    if (robot.link) {
      robot.link.forEach(link => {
        if (link.visual) {
          link.visual.forEach(visual => {
            const visualName = visual.$ && visual.$.name ? visual.$.name : null;
            if (visualName) {
              allVisuals.push({
                name: visualName,
                linkName: link.$ && link.$.name ? link.$.name : 'unknown'
              });
            }
          });
        }
      });
    }
    
    if (allVisuals.length > 0) {
      console.log(`\n👁️  All Visuals (${allVisuals.length}):`);
      allVisuals.forEach((visual, idx) => {
        console.log(`  ${idx + 1}. ${visual.name} (in link: ${visual.linkName})`);
      });
    }
    
    // Joints
    if (robot.joint && robot.joint.length > 0) {
      console.log(`\n🔧 Joints (${robot.joint.length}):`);
      robot.joint.forEach((joint, idx) => {
        const jointName = joint.$ && joint.$.name ? joint.$.name : `unnamed_${idx}`;
        const jointType = joint.$ && joint.$.type ? joint.$.type : 'unknown';
        console.log(`  ${idx + 1}. ${jointName} (type: ${jointType})`);
      });
    }
    
    // Materials
    if (robot.material && robot.material.length > 0) {
      console.log(`\n🎨 Materials (${robot.material.length}):`);
      robot.material.forEach((material, idx) => {
        const matName = material.$ && material.$.name ? material.$.name : `unnamed_${idx}`;
        console.log(`  ${idx + 1}. ${matName}`);
      });
    }
  });
}

// Main execution
try {
  if (!fs.existsSync(urdfDir)) {
    console.error(`❌ URDF directory not found: ${urdfDir}`);
    process.exit(1);
  }
  
  const urdfFiles = findUrdfFiles(urdfDir);
  
  if (urdfFiles.length === 0) {
    console.log('⚠️  No URDF files found in', urdfDir);
    process.exit(0);
  }
  
  console.log(`\n🔍 Found ${urdfFiles.length} URDF file(s)\n`);
  
  urdfFiles.forEach(inspectUrdf);
  
  console.log('\n' + '='.repeat(80));
  console.log('✅ Inspection complete');
  console.log('='.repeat(80) + '\n');
  
} catch (error) {
  console.error('❌ Error:', error);
  process.exit(1);
}

const fs = require('node:fs');
const path = require('node:path');

const helperPath = path.join(
  process.cwd(),
  'node_modules',
  'node-pty',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'spawn-helper'
);

if (fs.existsSync(helperPath)) {
  fs.chmodSync(helperPath, 0o755);
}

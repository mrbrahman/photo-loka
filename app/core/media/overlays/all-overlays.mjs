import * as fs from 'fs';
import { fileURLToPath } from 'url';
import * as path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// list all png images in current directory
let overlayFiles = fs.readdirSync(__dirname)
  .filter(f=>f.endsWith('.png'))
;

// read each image, and convert to an object with
// {<filename>: <file content buffer>}
export let overlays = overlayFiles.reduce((acc,curr)=>{
  acc[curr] = fs.readFileSync(path.join(__dirname, curr));
  return acc;
}, {});

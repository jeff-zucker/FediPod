// link-fedipod.mjs — inside a FediPod checkout, the `fedipod` this package
// imports is the checkout itself: node_modules/fedipod becomes a link to it,
// replacing a registry copy an `npm install` left. Anywhere else (a checkout
// of this package on its own, an install from npm) there is no checkout above
// and this does nothing; the registry copy is the one to use.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const above = path.resolve(pkg, '../..');
let name = null;
try { name = JSON.parse(fs.readFileSync(path.join(above, 'package.json'), 'utf8')).name; } catch { /* not a checkout */ }
if (name !== 'fedipod') process.exit(0);

const link = path.join(pkg, 'node_modules', 'fedipod');
fs.mkdirSync(path.dirname(link), { recursive: true });
let current = null;
try { current = fs.lstatSync(link); } catch { /* absent */ }
if (current?.isSymbolicLink() && path.resolve(path.dirname(link), fs.readlinkSync(link)) === above) process.exit(0);
if (current) {
  console.log(`link-fedipod: replacing node_modules/fedipod (${current.isSymbolicLink() ? 'a link elsewhere' : 'a registry copy'}) with a link to the checkout`);
  fs.rmSync(link, { recursive: true, force: true });
}
fs.symlinkSync(path.relative(path.dirname(link), above), link, 'dir');
console.log('link-fedipod: node_modules/fedipod -> the checkout');

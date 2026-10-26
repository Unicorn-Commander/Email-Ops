import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceRoots = ['app', 'components', 'lib', 'state'];
const extensions = new Set(['.ts', '.tsx', '.js', '.jsx']);
const violations = [];

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (entry === 'node_modules' || entry === '.next') continue;
    if (statSync(path).isDirectory()) walk(path);
    else if (extensions.has(path.slice(path.lastIndexOf('.')))) {
      const source = readFileSync(path, 'utf8');
      if (/\bconsole\.log\s*\(/.test(source)) violations.push(`${relative(root, path)}: console.log`);
      if (/\bdebugger\s*;/.test(source)) violations.push(`${relative(root, path)}: debugger`);
      if (/next\/font\/google/.test(source)) violations.push(`${relative(root, path)}: network font import`);
    }
  }
}

for (const directory of sourceRoots) walk(join(root, directory));
if (violations.length) {
  console.error(`Frontend lint failed:\n${violations.join('\n')}`);
  process.exit(1);
}

const tsc = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--pretty', 'false'], {
  cwd: root,
  encoding: 'utf8',
});
if (tsc.status !== 0) {
  process.stderr.write(tsc.stdout || '');
  process.stderr.write(tsc.stderr || '');
  process.exit(tsc.status ?? 1);
}
console.log('Frontend lint passed (source hygiene and TypeScript checks).');

import { mkdir, readFile, writeFile } from 'node:fs/promises';

const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const worker = await readFile('src/worker.mjs', 'utf8');
await mkdir('dist/server', { recursive: true });
await writeFile('dist/server/index.js', 'const PAGE = ' + JSON.stringify(page) + ';\n' + worker.slice(worker.indexOf('\n') + 1));

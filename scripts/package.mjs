import { mkdir, copyFile, readFile } from 'node:fs/promises';
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const directory = `dist/${manifest.id}`;
await mkdir(directory, { recursive: true });
for (const name of ['main.js', 'manifest.json', 'styles.css', 'README.md', 'LICENSE', 'ARCHITECTURE.md', 'RELEASE-CHECKLIST.md', 'VALIDATION.md']) await copyFile(name, `${directory}/${name}`);
console.log(`Installable plugin: ${directory}`);

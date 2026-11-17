import * as esbuild from 'esbuild';
const options = {
  entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian', 'electron'],
  platform: 'node', format: 'cjs', target: 'es2022', outfile: 'main.js',
  loader: { '.py': 'text' }, minify: false,
  banner: {js: '/* Photo Workspace | MIT | Built from source. */'}
};
if (process.argv.includes('--watch')) await (await esbuild.context(options)).watch();
else await esbuild.build(options);

import { build } from 'esbuild';

await build({
	entryPoints: ['src/server.js'],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	outfile: 'dist-server/server.cjs',
	external: ['better-sqlite3'],
	logLevel: 'info'
});

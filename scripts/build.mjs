// Bundles the runtime so installed plugins need no npm install.
import { build } from 'esbuild';
import { copyFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const root = join(dirname(new URL(import.meta.url).pathname), '..');
const out = join(root, 'dist');
await rm(out, { recursive: true, force: true });
await build({
  entryPoints: [join(root, 'runtime/worker.mjs')], outfile: join(out, 'worker.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'none',
});
// The QuickJS variant resolves its WASM next to the bundle via import.meta.url.
const variant = createRequire(import.meta.url).resolve('@jitl/quickjs-wasmfile-release-sync');
await copyFile(join(dirname(variant), 'emscripten-module.wasm'), join(out, 'emscripten-module.wasm'));

// Construye la app en dist/. Uso: node build.mjs [--prueba]
import { build } from 'esbuild';
import { cpSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const prueba = process.argv.includes('--prueba');
const salida = prueba ? 'dist-prueba' : 'dist';
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
rmSync(salida, { recursive: true, force: true });
mkdirSync(salida);
cpSync('public', salida, { recursive: true });

await build({
  entryPoints: ['src/app.js'],
  bundle: true, format: 'esm', target: ['chrome100', 'safari15'],
  minify: !prueba, sourcemap: false, legalComments: 'none',
  outfile: `${salida}/app.js`,
  // En modo prueba, el acceso a Firebase se reemplaza por un servidor simulado.
  plugins: prueba ? [{
    name: 'datos-falso',
    setup(b) { b.onResolve({ filter: /^\.\/datos\.js$/ }, () => ({ path: new URL('./test/datos_falso.js', import.meta.url).pathname })); },
  }] : [],
  logLevel: 'warning',
});
const sw = `${salida}/sw.js`;
writeFileSync(sw, readFileSync(sw, 'utf8').replace('__VERSION__', version + (prueba ? '-prueba' : '')));
console.log(`Listo: ${salida}/ (version ${version}${prueba ? ', MODO PRUEBA' : ''})`);

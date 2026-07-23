import { readFileSync } from 'node:fs';
import typescript from '@rollup/plugin-typescript';

const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

const externalPackages = new Set([
  '@garfish/loader',
  '@garfish/utils',
  '@jspm/import-map',
]);

const injectPackageVersion = () => ({
  name: 'inject-package-version',
  transform(code, id) {
    if (!id.endsWith('src/runtime.ts')) {
      return null;
    }

    return {
      code: code.replaceAll("'__PACKAGE_VERSION__'", JSON.stringify(packageJson.version)),
      map: null,
    };
  },
});

export default {
  input: {
    index: 'src/index.ts',
    compiler: 'src/compiler.ts',
    'runtime-entry': 'src/runtime-entry.ts',
    vite: 'src/vite.ts',
  },
  output: {
    dir: 'dist',
    format: 'es',
    hoistTransitiveImports: false,
    preserveModules: true,
    preserveModulesRoot: 'src',
    sourcemap: true,
  },
  external(id) {
    return (
      externalPackages.has(id) ||
      id.startsWith('../pkg/') ||
      id.startsWith('garfish-wasm-esm-plugin/pkg/')
    );
  },
  plugins: [
    injectPackageVersion(),
    typescript({
      tsconfig: 'tsconfig.lib.json',
    }),
  ],
};

import typescript from '@rollup/plugin-typescript';

const externalPackages = new Set([
  '@garfish/loader',
  '@garfish/utils',
  '@jspm/import-map',
]);

export default {
  input: {
    index: 'src/index.ts',
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
    typescript({
      tsconfig: 'tsconfig.lib.json',
    }),
  ],
};

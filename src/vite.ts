import type { OutputAsset, OutputChunk } from 'rollup';
import type { Plugin } from 'vite';
import {
  compileGarfishModule,
  type CompileGarfishModuleOptions,
} from './compiler';

export interface GarfishPrecompileOptions
  extends CompileGarfishModuleOptions {
  outDir?: string;
  copyAssets?: boolean;
  htmlEntries?: string[];
}

const normalizeOutDir = (value: string) => {
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  const segments = normalized.split('/');

  if (
    !normalized ||
    normalized === '.' ||
    segments.some((segment) => segment === '..')
  ) {
    throw new Error(`Invalid Garfish output directory "${value}"`);
  }

  return normalized;
};

const joinOutputPath = (directory: string, fileName: string) => {
  return `${directory}/${fileName.replace(/^\/+/, '')}`;
};

const isJavaScriptChunk = (
  output: OutputAsset | OutputChunk,
): output is OutputChunk => output.type === 'chunk';

const isCopyableAsset = (
  output: OutputAsset | OutputChunk,
): output is OutputAsset => {
  return (
    output.type === 'asset' &&
    !output.fileName.endsWith('.html') &&
    !output.fileName.endsWith('.map')
  );
};

const rewriteHtmlUrls = (
  html: string,
  base: string,
  outDir: string,
  mirroredFileNames: string[],
) => {
  if (!base || base.startsWith('.')) return html;
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;

  return mirroredFileNames.reduce((output, fileName) => {
    const sourceUrl = `${normalizedBase}${fileName}`;
    const targetUrl = `${normalizedBase}${joinOutputPath(outDir, fileName)}`;
    return output.split(sourceUrl).join(targetUrl);
  }, html);
};

export function garfishPrecompile(
  options: GarfishPrecompileOptions = {},
): Plugin {
  const outDir = normalizeOutDir(options.outDir || 'garfish');
  const copyAssets = options.copyAssets ?? true;
  const htmlEntries = new Set(options.htmlEntries || []);
  let base = '/';

  return {
    name: 'garfish-esm-precompile',
    apply: 'build',
    enforce: 'post',

    configResolved(config) {
      base = config.base;
    },

    generateBundle: {
      order: 'post',

      async handler(outputOptions, bundle) {
        if (outputOptions.format !== 'es') {
          throw new Error(
            'garfish-esm-precompile only supports Vite ES output',
          );
        }
        if (outputOptions.sourcemap) {
          throw new Error(
            'garfish-esm-precompile does not support generated sourcemaps yet',
          );
        }

        const outputs = Object.values(bundle).filter(
          (output) =>
            !output.fileName.startsWith(`${outDir}/`),
        );
        const chunks = outputs.filter(isJavaScriptChunk);
        const assets = copyAssets
          ? outputs.filter(isCopyableAsset)
          : [];
        const compiledChunks = await Promise.all(
          chunks.map(async (chunk) => ({
            fileName: joinOutputPath(outDir, chunk.fileName),
            source: await compileGarfishModule(
              chunk.code,
              chunk.fileName,
              { wasm: options.wasm },
            ),
          })),
        );

        compiledChunks.forEach(({ fileName, source }) => {
          this.emitFile({
            type: 'asset',
            fileName,
            source,
          });
        });

        assets.forEach((asset) => {
          this.emitFile({
            type: 'asset',
            fileName: joinOutputPath(outDir, asset.fileName),
            source: asset.source,
          });
        });

        if (htmlEntries.size > 0) {
          const mirroredFileNames = [
            ...chunks.map((chunk) => chunk.fileName),
            ...assets.map((asset) => asset.fileName),
          ];
          const emittedHtmlEntries = new Set<string>();

          outputs.forEach((output) => {
            if (
              output.type !== 'asset' ||
              !htmlEntries.has(output.fileName) ||
              typeof output.source !== 'string'
            ) {
              return;
            }

            emittedHtmlEntries.add(output.fileName);
            this.emitFile({
              type: 'asset',
              fileName: joinOutputPath(outDir, output.fileName),
              source: rewriteHtmlUrls(
                output.source,
                base,
                outDir,
                mirroredFileNames,
              ),
            });
          });

          htmlEntries.forEach((fileName) => {
            if (!emittedHtmlEntries.has(fileName)) {
              this.error(`Vite HTML entry "${fileName}" was not emitted`);
            }
          });
        }
      },
    },
  };
}

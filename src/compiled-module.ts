export interface ModuleImportInfo {
  moduleId: string;
}

export interface CompiledModule {
  code: string;
  imports: ModuleImportInfo[];
  exports: string[];
}

const COMPILED_MODULE_HEADER = '/*#__GARFISH_COMPILED_MODULE_V1__';
const COMPILED_MODULE_HEADER_END = '__*/';

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isModuleImports = (value: unknown): value is ModuleImportInfo[] =>
  Array.isArray(value) &&
  value.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as ModuleImportInfo).moduleId === 'string',
  );

export function createCompiledModuleArtifact(output: CompiledModule) {
  const metadata = JSON.stringify({
    imports: output.imports,
    exports: output.exports,
  }).replace(/\*\//g, '*\\/');

  return `${COMPILED_MODULE_HEADER}${metadata}${COMPILED_MODULE_HEADER_END}\n${output.code}`;
}

export function readCompiledModuleArtifact(
  artifact: string,
): CompiledModule | undefined {
  if (!artifact.startsWith(COMPILED_MODULE_HEADER)) return;

  const metadataEnd = artifact.indexOf(
    COMPILED_MODULE_HEADER_END,
    COMPILED_MODULE_HEADER.length,
  );
  if (metadataEnd === -1) {
    throw new Error('Invalid Garfish compiled module header');
  }

  const metadataSource = artifact.slice(
    COMPILED_MODULE_HEADER.length,
    metadataEnd,
  );
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataSource);
  } catch (error) {
    throw new Error(
      `Invalid Garfish compiled module metadata: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    !isModuleImports((metadata as CompiledModule).imports) ||
    !isStringArray((metadata as CompiledModule).exports)
  ) {
    throw new Error('Invalid Garfish compiled module metadata');
  }

  return {
    code: artifact.slice(metadataEnd + COMPILED_MODULE_HEADER_END.length),
    imports: (metadata as CompiledModule).imports,
    exports: (metadata as CompiledModule).exports,
  };
}

const ts = require('typescript');

module.exports = {
  process(sourceText, sourcePath) {
    const commonJsSource = sourceText
      .replace(/\bimport\.meta\.url\b/g, '__filename')
      .replace(/\bimport\.meta\.resolve\(/g, 'require.resolve(')
      .replace(/\bimport\.meta\.dirname\b/g, '__dirname')
      .replace(/\bimport\.meta\.filename\b/g, '__filename')
      .replace(/^\s*(?:const|let|var) require = createRequire\(__filename\);\s*$/gm, '');
    const result = ts.transpileModule(commonJsSource, {
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        sourceMap: false,
        target: ts.ScriptTarget.ES2021,
      },
      fileName: sourcePath,
    });

    return { code: result.outputText };
  },
};

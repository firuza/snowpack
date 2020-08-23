import fs from 'fs';
import path from 'path';
import glob from 'glob';
import * as esbuild from 'esbuild';
import {init, parse} from 'es-module-lexer';
import {SnowpackConfig, SnowpackPlugin} from '../types/snowpack';
import {appendHTMLToHead, getExt, relativeURL} from '../util';

interface OptimizePluginOptions {
  exclude?: string | string[];
  minifyCSS?: boolean;
  minifyHTML?: boolean;
  minifyJS?: boolean;
}

/**
 * Default optimizer for Snawpack, unless another one is given
 */
export function optimize(config: SnowpackConfig, options: OptimizePluginOptions): SnowpackPlugin {
  async function optimizeFile({
    esbuildService,
    file,
    modulesToPreload,
    preloadModuleFile,
  }: {
    esbuildService: esbuild.Service;
    file: string;
    modulesToPreload: Set<string>;
    preloadModuleFile: string;
  }) {
    const {baseExt} = getExt(file);

    // optimize based on extension. if it’s not here, leave as-is
    switch (baseExt) {
      case '.css': {
        // TODO: minify CSS
        break;
      }
      case '.js':
      case '.mjs': {
        try {
          let code = fs.readFileSync(file, 'utf-8');

          // 1. take imports, add to preload
          const [imports] = parse(code);
          imports
            .filter(({d}) => d === -1) // only preload static imports (this will be > -1 for dynamic)
            .forEach(({s, e}) => {
              modulesToPreload.add(path.resolve(path.dirname(file), code.substring(s, e)));
            });

          // 2. minify (if enabled)
          if (options.minifyJS) {
            const minified = await esbuildService.transform(code, {minify: true});
            code = minified.js;
            fs.writeFileSync(file, code);
          }
        } catch (err) {
          throw new Error(`Trouble optimizing JS: ${file}\n${err.toString()}`);
        }
        break;
      }
      case '.html': {
        // TODO: minify HTML
        let code = fs.readFileSync(file, 'utf-8');

        const preloadScript = `<link rel="modulepreload" href="${relativeURL(
          path.dirname(file),
          preloadModuleFile,
        )}" />`;

        code = appendHTMLToHead(code, preloadScript);
        return fs.writeFileSync(file, code);
        break;
      }
    }
  }

  function writeModulePreloadFile({
    dest,
    modulesToPreload,
  }: {
    dest: string;
    modulesToPreload: Set<string>;
  }) {
    const sortedModules = [...modulesToPreload];
    sortedModules.sort((a, b) => a.localeCompare(b));
    const code = `import '${sortedModules
      .map((url) => relativeURL(path.dirname(dest), url))
      .join("';\nimport '")}';`;
    fs.writeFileSync(dest, code, 'utf-8');
  }

  return {
    name: '@snowpack/plugin-optimize',
    async optimize({buildDirectory}) {
      const esbuildService = await esbuild.startService();
      await init;

      // 1. scan directory
      const allFiles = glob.sync('**/*', {
        cwd: buildDirectory,
        ignore: [`${config.buildOptions.metaDir}/*`, ...((options && options.exclude) || [])],
      });

      // 2. optimize all files in parallel
      const modulesToPreload = new Set<string>();
      const preloadModuleFile = path.join(
        buildDirectory,
        config.buildOptions.metaDir,
        'module-preload.mjs',
      );
      await Promise.all(
        allFiles.map((file) =>
          optimizeFile({
            file: path.join(buildDirectory, file),
            esbuildService,
            modulesToPreload,
            preloadModuleFile,
          }),
        ),
      );

      // 3. write module-preload.mjs file after fully built
      writeModulePreloadFile({dest: preloadModuleFile, modulesToPreload});

      // 4. clean up
      esbuildService.stop();
    },
  };
}

import dotenv from 'dotenv'

// Reproducible builds only read the committed build.env, never local overrides.
const Reproducible = process.argv.includes('--reproducible')

// dotenv keeps the first value it reads, so .env overrides build.env.
dotenv.config({
    path: Reproducible ? ['build.env'] : ['.env', 'build.env'],
    quiet: true,
})

import chalk from 'chalk'
import { execSync } from 'child_process'
import { mkdir, readdir, rm, writeFile } from 'fs/promises'
import { dirname, parse } from 'path'
import { rolldown } from 'rolldown'
import { importGlobPlugin } from 'rolldown/experimental'
import { fileURLToPath } from 'url'
import pkg from '../package.json' with { type: 'json' }
import { boolEnv, exists, stringEnv } from './_shared'
import {
    getBundleManifest,
    getInternalPluginManifests,
    PluginsDir,
    Stages,
} from './manifest'
import asRequire from './plugins/as-require'
import hermesSwcPlugin from './plugins/hermes-swc'
import hermesCPlugin from './plugins/hermesc'
import importDefer from './plugins/import-defer'
import shimAliases from './plugins/shim-aliases'

const __dirname = dirname(fileURLToPath(import.meta.url))

const ShimsDir = `${__dirname}/../shims`
const AssetsDir = `${__dirname}/../src/assets`
const GeneratedAssetsDir = `${__dirname}/../dist/assets/generated`
const Dev =
    process.argv.includes('--dev') || process.env.NODE_ENV === 'development'
const OutDirArg = process.argv.indexOf('--out')
const OutDir = OutDirArg === -1 ? undefined : process.argv[OutDirArg + 1]!
const TargetArg = process.argv.indexOf('--target')
const Target = TargetArg === -1 ? 'rn' : process.argv[TargetArg + 1]!

if (Target !== 'rn' && Target !== 'phoenix')
    throw new Error(`Unknown --target: ${Target}. Use "rn" or "phoenix".`)

// If this file is being run directly, build the project
if (import.meta.main) build()

export default async function build(
    dev = Dev,
    log = true,
    target: 'rn' | 'phoenix' = Target,
) {
    const phoenix = target === 'phoenix'
    // Separate directories, so the two targets don't overwrite each other's manifest.
    const outDir = OutDir ?? (phoenix ? 'dist/phoenix' : 'dist')

    // Generated assets are React Native only, and both targets share the directory.
    if (!phoenix)
        await rm(GeneratedAssetsDir, { recursive: true, force: true })
            .then(() =>
                console.debug(
                    chalk.gray('\u{1F5BB} Deleted old generated assets'),
                ),
            )
            .catch()

    const start = performance.now()

    if (!phoenix) {
        if (log) console.info(chalk.gray('\u{1F5BB} Generating assets...'))
        await generateAssets()
        if (log) console.info(chalk.cyanBright('\u{1F5BB} Assets generated'))
    }

    if (log) console.info(chalk.gray('\u{1F5CE} Compiling JS...'))

    // The last commit touching the bundle, so unrelated commits don't change the output.
    const COMMIT = execSync('git log -1 --format=%h --abbrev=7 -- .')
        .toString()
        .trim()

    const bundle = await rolldown({
        input: phoenix ? 'src/phoenix.ts' : 'src/index.ts',
        platform: 'browser',
        external: [/^node:/],
        optimization: {
            inlineConst: {
                mode: 'smart',
                pass: 5,
            },
            pifeForModuleWrappers: true,
        },
        experimental: {
            lazyBarrel: true,
        },
        preserveEntrySignatures: false,
        transform: {
            define: {
                __BUILD_DISCORD_SERVER_URL__: stringEnv(
                    'VALENCED_DISCORD_SERVER_URL',
                ),
                __BUILD_SOURCE_REPOSITORY_URL__: stringEnv(
                    'VALENCED_SOURCE_REPOSITORY_URL',
                ),
                __BUILD_LICENSE_URL__: stringEnv('VALENCED_LICENSE_URL'),
                __BUILD_VERSION__: JSON.stringify(pkg.version),
                __BUILD_COMMIT__: JSON.stringify(COMMIT),
                __DEV__: String(dev),
                __BUILD_DEFAULT_PLUGIN_REPOSITORY_URL__: stringEnv(
                    'VALENCED_DEFAULT_PLUGIN_REPOSITORY_URL',
                    undefined,
                    false,
                ),

                __BUILD_DONATE_URL__: stringEnv(
                    'VALENCED_DONATE_URL',
                    undefined,
                    false,
                ),

                // See types/build.d.ts for what these flags do
                __BUILD_FLAG_DEBUG_MODULE_LOOKUPS__: String(
                    boolEnv('VALENCED_DEBUG_MODULE_LOOKUPS', dev),
                ),
                __BUILD_FLAG_DEBUG_MODULE_WAITS__: String(
                    boolEnv('VALENCED_DEBUG_MODULE_WAITS', dev),
                ),
                __BUILD_FLAG_DEBUG_LAZY_VALUES__: String(
                    boolEnv('VALENCED_DEBUG_LAZY_VALUES', false),
                ),
                __BUILD_FLAG_LOG_PROMISE_REJECTIONS__: String(
                    boolEnv('VALENCED_LOG_PROMISE_REJECTIONS', dev),
                ),
            },
        },
        tsconfig: 'tsconfig.json',
        treeshake: true,
        moduleTypes: {
            '.webp': 'dataurl',
        },
        plugins: [
            asRequire(),
            shimAliases(ShimsDir),
            importGlobPlugin(),
            // QuickJS-ng needs no Hermes downleveling. Keep importDefer after this.
            hermesSwcPlugin(phoenix ? 'es2020' : undefined),
            importDefer(),
            // Phoenix runs plain JS, so there is no bytecode step.
            ...(phoenix
                ? []
                : [
                      hermesCPlugin({
                          flags: [
                              dev ? '-Og' : '-O',
                              dev ? '-g3' : '-g1',
                              '-reuse-prop-cache',
                              '-optimized-eval',
                              '-strict',
                              '-finline',
                          ],
                          before(ver) {
                              if (log) {
                                  console.debug(
                                      chalk.cyanBright(
                                          '\u{1F5CE} JS compilation finished...',
                                      ),
                                  )

                                  console.debug(
                                      chalk.gray(
                                          `\u{1F5CE} Compiling bytecode with ${ver}...`,
                                      ),
                                  )
                              }
                          },
                          after() {
                              if (log)
                                  console.debug(
                                      chalk.cyanBright(
                                          '\u{1F5CE} Bytecode compilation finished',
                                      ),
                                  )
                          },
                      }),
                  ]),
        ],
    })

    await bundle.write({
        minify: dev
            ? 'dce-only'
            : {
                  codegen: {
                      removeWhitespace: false,
                  },
                  mangle: {
                      keepNames: true,
                  },
                  compress: {
                      joinVars: true,
                      keepNames: {
                          class: true,
                          function: true,
                      },
                      unused: true,
                  },
              },
        esModule: false,
        minifyInternalExports: true,
        hoistTransitiveImports: false,
        file: `${outDir}/${phoenix ? 'valenced.phoenix.bundle' : 'valenced.js'}`,
        format: 'iife',
        keepNames: true,
        postFooter: `//# sourceURL=Valenced`,
        topLevelVar: true,
    })

    if (log)
        console.info(
            chalk.greenBright(
                `\u{2714} Compiled successfully! ${chalk.gray(`(took ${(performance.now() - start).toFixed(2)}ms)`)}`,
            ),
        )

    const manifest = getBundleManifest(
        pkg.version,
        await getInternalPluginManifests(
            PluginsDir,
            dev,
            phoenix ? Stages.phoenix : Stages.rn,
        ),
    )

    await writeFile(`${outDir}/manifest.json`, JSON.stringify(manifest))

    if (log)
        console.info(chalk.cyanBright('\u{1F5BB} Internal manifests emitted'))
}

async function generateAssets() {
    if (!(await exists(GeneratedAssetsDir)))
        await mkdir(GeneratedAssetsDir, { recursive: true })

    const promises: Promise<void>[] = []

    for (const file of await readdir(AssetsDir)) {
        const { name, ext } = parse(file)
        const path = `${AssetsDir}/${file}`
        const path2 = `${GeneratedAssetsDir}/${name}.js`

        if (await exists(path2)) continue

        // We attempt to sanitize the path, but not the name as it should fail if name contains invalid characters
        const uriPath = JSON.stringify(path)
        const type = JSON.stringify(ext.slice(1))

        promises.push(
            writeFile(
                path2,
                `import{registerAsset}from'@valenced/assets';import uri from${uriPath};const ${name}=registerAsset({name:'${name}',type:${type},uri});export { ${name} as default }`,
            ),
        )
    }

    await Promise.all(promises)
}

// Stands in for `@valenced/modules/metro/*` without a runtime. Modules in `mExports` count as initialized
export const mExports = new Map<number, unknown>()

// metro/utils
export const getModuleDependencies = () => undefined
export const getInitializedModuleExports = (id: number) => mExports.get(id)
export const isModuleInitialized = (id: number) => (mExports.has(id) ? 1 : 0)
export const isModuleExportBad = (exp: unknown) => exp == null

// metro/patches
export const mInitialized = new Set<number>()

// metro/runtime
export const metroRequire = () => {}

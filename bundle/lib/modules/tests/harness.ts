import { vi } from 'vitest'

// Runs the real Metro runtime. Only native calls and build constants are fake.
vi.mock('@valenced/modules/native', () => import('./mocks/native'))
vi.mock('~constants', () => ({ FullVersion: 'test' }))

import { logs } from './mocks/globals'
import { nativeCalls } from './mocks/native'

const { cache } = await import('../src/caches')
const { noDefaultExportsCache } = await import('../src/finders/_internal')
const {
    mDeps,
    mInitialized,
    mList,
    mModuleIdToSegmentId,
    mSegmentDefiners,
    mUninitialized,
} = await import('../src/metro/patches')
const { mErrorChain, metroRequire } = await import('../src/metro/runtime')
const { sInitialize, sInitializeAny, sRequire, sRequireAny } = await import(
    '../src/metro/subscriptions/_internal'
)

export type Factory = (module: { exports: any }) => void

/** Registers an uninitialized module through Metro's `__d`. */
export function defineModule(
    id: number,
    factory: Factory = () => {},
    deps: number[] = [],
) {
    globalThis.__d((_g, _r, _d, _a, module) => factory(module), id, deps)
}

/** Registers and initializes a module exporting `exports`. */
export function define(id: number, exports: unknown, deps: number[] = []) {
    defineModule(
        id,
        module => {
            module.exports = exports
        },
        deps,
    )
    return metroRequire(id)
}

/** Clears runtime, cache and log state between tests. */
export function reset() {
    for (const key of Object.keys(cache.finds)) delete cache.finds[key]
    cache.blacklist.length = 0
    for (const store of [
        mDeps,
        mInitialized,
        mList,
        mModuleIdToSegmentId,
        mUninitialized,
        noDefaultExportsCache,
        sInitialize,
        sInitializeAny,
        sRequire,
        sRequireAny,
    ])
        store.clear()
    mSegmentDefiners.length = 0
    mErrorChain.length = 0
    logs.length = 0
    nativeCalls.length = 0
}

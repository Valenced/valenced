import { beforeEach, describe, expect, test } from 'vitest'
import { define, defineModule, reset } from './harness'
import { nativeCalls } from './mocks/native'

const { cache } = await import('../src/caches')
const { mInitialized, mList, mUninitialized } = await import(
    '../src/metro/patches'
)
const {
    HasError,
    mErrorChain,
    metroImportAll,
    metroImportDefault,
    metroRequire,
} = await import('../src/metro/runtime')
const {
    onAnyModuleFirstRequired,
    onAnyModuleInitialized,
    onModuleFirstRequired,
    onModuleInitialized,
} = await import('../src/metro/subscriptions')
const {
    getInitializedModuleExports,
    getModuleDependencies,
    isModuleExportBad,
    isModuleInitialized,
} = await import('../src/metro/utils')

beforeEach(reset)

describe('metroRequire', () => {
    test('defines modules as uninitialized', () => {
        defineModule(1, undefined, [2, 3])

        expect(mUninitialized.has(1)).toBe(true)
        expect(isModuleInitialized(1)).toBe(0)
        expect(getInitializedModuleExports(1)).toBeUndefined()
        expect(getModuleDependencies(1)).toEqual([2, 3])
    })

    test('initializes once and returns the same exports', () => {
        let runs = 0
        defineModule(1, module => {
            runs++
            module.exports = { x: 1 }
        })

        const exports = metroRequire(1)
        expect(metroRequire(1)).toBe(exports)
        expect(runs).toBe(1)
        expect(isModuleInitialized(1)).toBeTruthy()
        expect(getInitializedModuleExports(1)).toBe(exports)
        expect(mUninitialized.has(1)).toBe(false)
        expect(mInitialized.has(1)).toBe(true)
    })

    test('throws on unknown modules', () => {
        expect(() => metroRequire(404)).toThrow('Requiring unknown module: 404')
    })

    test('returns partial exports on circular requires', () => {
        defineModule(1, module => {
            module.exports.early = true
            metroRequire(2)
            module.exports.late = true
        })
        defineModule(2, module => {
            module.exports = { seen: { ...metroRequire(1) } }
        })

        metroRequire(1)
        expect(metroRequire(2).seen).toEqual({ early: true })
    })

    test('poisons a module whose factory throws', () => {
        let runs = 0
        const error = new Error('boom')
        defineModule(1, () => {
            runs++
            throw error
        })

        const exports = metroRequire(1)
        expect(exports).toEqual({})
        expect(metroRequire(1)).toBe(exports)
        expect(runs).toBe(1)

        expect(mList.get(1)!.flags & HasError).toBeTruthy()
        expect(mErrorChain).toEqual([[1, error]])
        expect(nativeCalls.map(([name]) => name)).toContain(
            'valenced.alertError',
        )

        // Finders see it in neither set
        expect(mUninitialized.has(1)).toBe(false)
        expect(mInitialized.has(1)).toBe(false)
    })

    test('blacklists modules with empty or primitive exports', () => {
        define(1, {})
        define(2, 'string')
        define(3, () => {})
        define(4, { x: 1 })

        expect(cache.blacklist).toEqual([1, 2])
        expect([...mInitialized]).toEqual([3, 4])
    })

    // Remove `.fails` once handleFactoryCall guards `Reflect.ownKeys(null)`
    test.fails('blacklists modules exporting null', () => {
        define(1, null)

        expect(mList.get(1)!.flags & HasError).toBeFalsy()
        expect(cache.blacklist).toEqual([1])
    })
})

describe('metroImportDefault', () => {
    test('returns the default export of ES modules', () => {
        define(1, { __esModule: true, default: 'value' })
        expect(metroImportDefault(1)).toBe('value')
    })

    test('returns the namespace of CommonJS modules', () => {
        const exports = define(1, { x: 1 })
        expect(metroImportDefault(1)).toBe(exports)
    })
})

describe('metroImportAll', () => {
    test('leaves ES modules alone', () => {
        const exports = define(1, { __esModule: true, default: 'value' })
        expect(metroImportAll(1)).toBe(exports)
        expect(exports.default).toBe('value')
    })
})

describe('segments', () => {
    test('route requires to the segment definer', () => {
        const defined: number[] = []
        globalThis.__registerSegment(
            1,
            id => {
                defined.push(id)
                define(id, { segment: 1 })
            },
            [100],
        )

        expect(metroRequire(100)).toEqual({ segment: 1 })
        expect(defined).toEqual([100])
    })

    test('fall back to segment 0 for unlisted modules', () => {
        globalThis.__registerSegment(0, id => defineModule(id), undefined)
        expect(metroRequire(200)).toEqual({})
    })

    test('reapply the blacklist after loading', () => {
        defineModule(1)
        cache.blacklist.push(1)
        globalThis.__registerSegment(1, id => defineModule(id), [100])

        metroRequire(100)
        expect(mUninitialized.has(1)).toBe(false)
    })
})

describe('subscriptions', () => {
    test('run first required before the factory, and initialized after', () => {
        const events: string[] = []
        defineModule(1, module => {
            events.push('factory')
            module.exports = { x: 1 }
        })

        onAnyModuleFirstRequired(id => events.push(`any required ${id}`))
        onModuleFirstRequired(1, id => events.push(`required ${id}`))
        onAnyModuleInitialized((id, exports) =>
            events.push(`any initialized ${id} ${exports.x}`),
        )
        onModuleInitialized(1, (id, exports) =>
            events.push(`initialized ${id} ${exports.x}`),
        )

        metroRequire(1)
        expect(events).toEqual([
            'any required 1',
            'required 1',
            'factory',
            'any initialized 1 1',
            'initialized 1 1',
        ])
    })

    test('per module callbacks run once', () => {
        let calls = 0
        onModuleInitialized(1, () => calls++)
        define(1, { x: 1 })

        onAnyModuleInitialized(() => calls++)
        define(2, { x: 1 })

        expect(calls).toBe(2)
    })

    test('unsubscribe removes the callback', () => {
        let calls = 0
        onModuleInitialized(1, () => calls++)()
        onAnyModuleInitialized(() => calls++)()
        define(1, { x: 1 })

        expect(calls).toBe(0)
    })

    test('a throwing callback does not stop the others', () => {
        let calls = 0
        onAnyModuleInitialized(() => {
            throw new Error('boom')
        })
        onAnyModuleInitialized(() => calls++)
        define(1, { x: 1 })

        expect(calls).toBe(1)
        expect(mInitialized.has(1)).toBe(true)
    })
})

describe('isModuleExportBad', () => {
    test('flags nullish values and catch-all proxies', () => {
        const catchAll = new Proxy({}, { get: () => 1, has: () => true })

        expect(isModuleExportBad(null)).toBe(true)
        expect(isModuleExportBad(undefined)).toBe(true)
        expect(isModuleExportBad(catchAll)).toBe(true)
    })

    test('accepts objects, functions and primitives', () => {
        expect(isModuleExportBad({ x: 1 })).toBe(false)
        expect(isModuleExportBad(() => {})).toBe(false)
        expect(isModuleExportBad(0)).toBe(false)
        expect(isModuleExportBad('')).toBe(false)
    })
})

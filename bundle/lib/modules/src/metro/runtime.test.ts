import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ValencedMetro } from '../types'

const { mList } = vi.hoisted(() => {
    Object.assign(globalThis, {
        __DEV__: false,
        nativeLoggingHook: () => {},
    })
    return { mList: new Map<number, ValencedMetro.ModuleDefinition>() }
})

vi.mock('./patches', () => ({ mList, loadModuleFromSegment: () => undefined }))
vi.mock('./subscriptions/_internal', () => ({
    executeInitializeSubscriptions: () => {},
    executeRequireSubscriptions: () => {},
}))
vi.mock('@valenced/modules/native', () => ({ callNativeMethodSync: () => {} }))
vi.mock('@valenced/utils/error', () => ({ getErrorStack: String }))
vi.mock('~constants', () => ({ FullVersion: 'test' }))

const { metroImportAll, metroImportDefault, metroRequire } = await import(
    './runtime'
)

function define(id: number, factory: (module: { exports: any }) => void) {
    const def: ValencedMetro.ModuleDefinition = {
        flags: 0,
        module: undefined,
        factory: () => factory(def.module!),
        importedAll: undefined,
        error: undefined,
    }
    mList.set(id, def)
}

describe('metroImportDefault', () => {
    beforeEach(() => mList.clear())

    test('late patch on default reaches later calls', () => {
        const original = () => 'original'
        define(1, ({ exports }) => {
            exports.__esModule = true
            exports.default = original
        })

        expect(metroImportDefault(1)).toBe(original)

        const patched = () => 'patched'
        metroRequire(1).default = patched
        expect(metroImportDefault(1)).toBe(patched)
    })

    test('a read mid-cycle does not keep the partial value', () => {
        let midCycle: unknown = 'unset'
        const value = () => {}
        define(1, ({ exports }) => {
            exports.__esModule = true
            metroRequire(2)
            exports.default = value
        })
        define(2, () => {
            midCycle = metroImportDefault(1)
        })

        metroRequire(1)

        expect(midCycle).toBeUndefined()
        expect(metroImportDefault(1)).toBe(value)
    })

    test('CommonJS and null exports return the exports', () => {
        const fn = () => {}
        define(1, module => {
            module.exports = fn
        })
        define(2, module => {
            module.exports = null
        })

        expect(metroImportDefault(1)).toBe(fn)
        expect(metroImportDefault(2)).toBeNull()
    })
})

// metro-runtime's importAll, for comparing namespace shapes
function metroReference(exports: any) {
    if (exports?.__esModule) return exports
    const namespace: any = {}
    if (exports != null)
        for (const key in exports)
            if (Object.hasOwn(exports, key)) namespace[key] = exports[key]
    namespace.default = exports
    return namespace
}

describe('metroImportAll', () => {
    beforeEach(() => mList.clear())

    class Instance {
        own = 1
        method() {}
    }
    const shapes: Record<string, () => unknown> = {
        'plain object': () => ({ a: 1, b: () => {} }),
        'object with own default': () => ({ default: 1, a: 2 }),
        'function with statics': () => Object.assign(() => {}, { a: 1 }),
        'class instance': () => new Instance(),
        'frozen object': () => Object.freeze({ a: 1 }),
        null: () => null,
        undefined: () => undefined,
        number: () => 5,
        string: () => 'str',
        esm: () => ({ __esModule: true, default: 1, a: 2 }),
    }

    for (const [name, make] of Object.entries(shapes))
        test(`matches Metro for ${name} exports`, () => {
            const value = make()
            define(1, module => {
                module.exports = value
            })

            const namespace = metroImportAll(1)
            expect({ ...namespace }).toEqual({ ...metroReference(value) })
            expect(typeof namespace).toBe(typeof metroReference(value))
            expect(metroImportAll(1)).toBe(namespace)
        })

    test('CommonJS exports stay unmodified', () => {
        define(1, ({ exports }) => {
            exports.a = 1
        })

        const exports = metroRequire(1)
        const namespace = metroImportAll(1)

        expect(namespace).not.toBe(exports)
        expect(Object.keys(exports)).toEqual(['a'])
        expect(namespace.default).toBe(exports)
    })

    test('patches on exports reach the namespace', () => {
        const original = () => 'original'
        define(1, ({ exports }) => {
            exports.fn = original
        })

        const namespace = metroImportAll(1)
        const patched = () => 'patched'
        metroRequire(1).fn = patched

        expect(namespace.fn).toBe(patched)
    })

    test('writes stay on the namespace', () => {
        define(1, ({ exports }) => {
            exports.a = 1
        })

        const namespace = metroImportAll(1)
        namespace.a = 2

        expect(namespace.a).toBe(2)
        expect(metroRequire(1).a).toBe(1)
    })

    test('namespace from a cycle gains later keys', () => {
        let namespace: any
        define(1, ({ exports }) => {
            exports.a = 1
            metroRequire(2)
            exports.b = 2
        })
        define(2, () => {
            namespace = metroImportAll(1)
        })

        metroRequire(1)

        expect({ ...namespace }).toEqual({
            a: 1,
            b: 2,
            default: metroRequire(1),
        })
        expect(metroImportAll(1)).toBe(namespace)
    })

    test('namespace from a cycle keeps values when the factory throws', () => {
        let namespace: any
        define(1, ({ exports }) => {
            exports.a = 1
            metroRequire(2)
            throw new Error('fail')
        })
        define(2, () => {
            namespace = metroImportAll(1)
        })

        metroRequire(1)

        expect(metroRequire(1)).toEqual({})
        expect(namespace.a).toBe(1)
        expect(namespace.default).toEqual({ a: 1 })
        expect(metroImportAll(1)).toBe(namespace)
    })
})

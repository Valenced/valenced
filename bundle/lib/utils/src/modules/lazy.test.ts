import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { logs, initialized, waiters } = vi.hoisted(() => {
    const logs: string[] = []
    Object.assign(globalThis, {
        __DEV__: false,
        nativeLoggingHook: (message: string) => logs.push(message),
    })
    return {
        logs,
        initialized: [] as unknown[],
        waiters: new Set<(exports: unknown) => void>(),
    }
})

vi.mock('@valenced/modules/finders/filters', () => ({
    FilterScopes: { Initialized: 4 },
}))
type FakeFilter = { match(exports: unknown): boolean }

vi.mock('@valenced/modules/finders', () => ({
    lookupModule: (f: FakeFilter) => {
        const exports = initialized.find(f.match)
        return exports ? [exports, 1] : [undefined, undefined]
    },
    *lookupModules(f: FakeFilter) {
        for (const exports of initialized.filter(f.match)) yield [exports, 1]
    },
    waitForModules: (f: FakeFilter, callback: (exports: unknown) => void) => {
        const waiter = (exports: unknown) => {
            if (f.match(exports)) callback(exports)
        }
        waiters.add(waiter)
        return () => waiters.delete(waiter)
    },
}))

const { lazyModule, lazyModules } = await import('./lazy')

const noop = () => 0

function filter<T>(key = 'test', match = (_: unknown) => true) {
    const f = { key, match, scope: () => f }
    return f as unknown as import('@valenced/modules/finders/filters').Filter<{
        Result: T
        Scopes: []
    }>
}

/** Initializes a module, running waiters like `executeInitializeSubscriptions`. */
function init(exports: unknown) {
    initialized.push(exports)
    for (const waiter of Array.from(waiters)) waiter(exports)
}

interface Module {
    fn: (x: number) => number
    other?: () => string
    nested: { fn: () => string }
}

const make = (): Module => ({
    fn: x => x,
    other: () => 'other',
    nested: { fn: () => 'nested' },
})

beforeEach(() => {
    logs.length = 0
    initialized.length = 0
    waiters.clear()
})

describe('lazyModule', () => {
    test('patches an initialized module immediately', () => {
        const m = make()
        init(m)

        lazyModule(filter<Module>()).instead('fn', () => 2)

        expect(m.fn(1)).toBe(2)
        expect(waiters.size).toBe(0)
    })

    test('patches at init and stops waiting', () => {
        const handle = lazyModule(filter<Module>())
        handle.instead('fn', () => 2)
        expect(waiters.size).toBe(1)

        const m = make()
        init(m)

        expect(m.fn(1)).toBe(2)
        expect(waiters.size).toBe(0)
    })

    test('patches only the first match', () => {
        lazyModule(filter<Module>()).instead('fn', () => 2)
        const [a, b] = [make(), make()]
        init(a)
        init(b)

        expect(a.fn(1)).toBe(2)
        expect(b.fn(1)).toBe(1)
    })

    test('unpatching before the match stops waiting', () => {
        const unpatch = lazyModule(filter<Module>()).instead('fn', () => 2)
        unpatch()
        expect(waiters.size).toBe(0)

        const m = make()
        init(m)
        expect(m.fn(1)).toBe(1)
    })

    test('unpatching after the match restores, and is safe twice', () => {
        const m = make()
        const original = m.fn
        init(m)

        const unpatch = lazyModule(filter<Module>()).instead('fn', () => 2)
        unpatch()
        unpatch()

        expect(m.fn).toBe(original)
    })

    test('patches on one handle share one wait', () => {
        const handle = lazyModule(filter<Module>())
        handle.instead('fn', () => 2)
        handle.after('other', () => 'patched')
        expect(waiters.size).toBe(1)

        const m = make()
        init(m)
        expect([m.fn(1), m.other!()]).toEqual([2, 'patched'])
    })

    test('replays a known match to later patches', () => {
        const handle = lazyModule(filter<Module>())
        handle.instead('fn', () => 2)
        const m = make()
        init(m)

        handle.after('other', () => 'patched')
        expect(m.other!()).toBe('patched')
    })

    test('looks up again after the last unpatch', () => {
        const handle = lazyModule(filter<Module>())
        handle.instead('fn', () => 2)()
        const m = make()
        init(m)

        handle.instead('fn', () => 3)
        expect(m.fn(1)).toBe(3)
    })

    test('reports a missing key and writes nothing', () => {
        const m = { a: 1 } as unknown as Module
        init(m)

        lazyModule(filter<Module>()).instead('fn', () => 2)

        expect(Object.keys(m)).toEqual(['a'])
        expect(logs).toHaveLength(1)
        expect(logs[0]).toContain('fn is not a function')
    })

    test('skips a missing key silently with optional', () => {
        init({})
        lazyModule(filter<Module>()).instead('fn', () => 2, { optional: true })
        expect(logs).toHaveLength(0)
    })

    test('reports a failed patch on a frozen parent', () => {
        const m = Object.freeze(make())
        init(m)

        expect(() =>
            lazyModule(filter<Module>()).instead('fn', () => 2),
        ).not.toThrow()
        expect(logs[0]).toContain('failed')
    })

    test('lets hook errors reach the caller', () => {
        const m = make()
        init(m)
        lazyModule(filter<Module>()).instead('fn', () => {
            throw new Error('hook')
        })

        expect(() => m.fn(1)).toThrow('hook')
    })
})

describe('use', () => {
    test('allows no undo function', () => {
        const m = make()
        init(m)
        const apply = vi.fn()

        const unpatch = lazyModule(filter<Module>()).use(apply)

        expect(apply).toHaveBeenCalledWith(m)
        expect(unpatch).not.toThrow()
    })

    test('reports errors thrown by apply', () => {
        init(make())
        lazyModule(filter<Module>()).use(() => {
            throw new Error('apply')
        })
        expect(logs[0]).toContain('apply')
    })

    test('runs the undo function', () => {
        init(make())
        const undo = vi.fn()

        lazyModule(filter<Module>()).use(() => undo)()

        expect(undo).toHaveBeenCalledOnce()
    })
})

describe('prop', () => {
    test('patches the nested object', () => {
        const m = make()
        init(m)

        lazyModule(filter<Module>())
            .prop('nested')
            .instead('fn', () => 'patched')

        expect(m.nested.fn()).toBe('patched')
    })

    test('unpatching stops the parent wait', () => {
        const unpatch = lazyModule(filter<Module>())
            .prop('nested')
            .instead('fn', () => 'patched')
        expect(waiters.size).toBe(1)

        unpatch()
        expect(waiters.size).toBe(0)
    })

    test('reports a missing nested object', () => {
        init({})
        lazyModule(filter<Module>())
            .prop('nested')
            .instead('fn', () => 'patched')
        expect(logs[0]).toContain('nested is not an object')
    })
})

describe('lazyModules', () => {
    test('patches every match, now and later', () => {
        const [a, b] = [make(), make()]
        init(a)
        lazyModules(filter<Module>()).instead('fn', () => 2)
        init(b)

        expect([a.fn(1), b.fn(1)]).toEqual([2, 2])
        expect(waiters.size).toBe(1)
    })

    test('patches a shared object once', () => {
        const m = make()
        const apply = vi.fn()
        lazyModules(filter<Module>()).use(apply)
        init(m)
        init(m)

        expect(apply).toHaveBeenCalledOnce()
    })

    test('skips modules without the key silently', () => {
        const m = make()
        init({})
        lazyModules(filter<Module>()).instead('fn', () => 2)
        init(m)

        expect(m.fn(1)).toBe(2)
        expect(logs).toHaveLength(0)
    })

    test('unpatching undoes every match', () => {
        const [a, b] = [make(), make()]
        const originals = [a.fn, b.fn]
        init(a)
        const unpatch = lazyModules(filter<Module>()).instead('fn', () => 2)
        init(b)
        unpatch()

        expect([a.fn, b.fn]).toEqual(originals)
        expect(waiters.size).toBe(0)
    })
})

describe('dev logs', () => {
    beforeEach(() => {
        Object.assign(globalThis, { __DEV__: true })
    })
    afterEach(() => {
        Object.assign(globalThis, { __DEV__: false })
    })

    test('logs a pending handle, then its match', () => {
        lazyModule(filter<Module>('handle')).instead('fn', noop)
        expect(logs).toHaveLength(1)
        expect(logs[0]).toMatch(/Pending lazy module: .*handle/)

        init(make())
        expect(logs).toHaveLength(2)
        expect(logs[1]).toMatch(/Resolved lazy module: .*handle/)
    })
})

describe('types', () => {
    test('limits keys to functions', () => {
        interface Shape {
            fn(): void
            opt?: () => void
            union: (() => void) | string
            value: number
        }
        const handle = lazyModule(filter<Shape>())

        handle.instead('fn', () => {})
        handle.instead('opt', () => {})
        handle.instead('union', () => {})
        // @ts-expect-error: not a function
        handle.instead('value', () => {})

        expect(waiters.size).toBe(1)
    })
})

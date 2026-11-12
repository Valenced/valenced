import { beforeEach, describe, expect, test, vi } from 'vitest'
import { define, defineModule, reset } from './harness'

const { cache } = await import('../src/caches')
const { FilterResultFlags } = await import('../src/finders/_internal')
const { FilterScopes, allOf, withDependencies, withProps, withoutProps } =
    await import('../src/finders/filters')
const { getModules } = await import('../src/finders/get')
const { NotFoundResult, lookupModule, lookupModules } = await import(
    '../src/finders/lookup'
)
const { waitForModules } = await import('../src/finders/wait')
const { metroRequire } = await import('../src/metro/runtime')

beforeEach(reset)

const ids = (results: Iterable<[unknown, number]>) =>
    [...results].map(([, id]) => id)

describe('lookupModule', () => {
    test('matches the namespace', () => {
        define(1, { x: 1 })
        expect(lookupModule(withProps('x'))).toEqual([{ x: 1 }, 1])
    })

    test('matches the default export, and returns it', () => {
        const exports = define(1, { default: { x: 1 } })

        expect(lookupModule(withProps('x'))).toEqual([{ x: 1 }, 1])
        expect(lookupModule(withProps('x'), { returnNamespace: true })).toEqual(
            [exports, 1],
        )
    })

    test('caches matches by filter key', () => {
        define(1, { default: { x: 1 } })
        define(2, { x: 1 })

        lookupModule(withProps('x'))
        expect(cache.finds['valenced.props(x)']).toEqual({
            1: FilterResultFlags.Default,
        })
    })

    test('returns cached matches without running the filter', () => {
        define(1, { x: 1 })
        lookupModule(withProps('x'))

        // A stale cache entry wins over the module that matches now
        define(2, { x: 1 })
        cache.finds['valenced.props(x)'] = { 2: FilterResultFlags.Namespace }
        expect(lookupModule(withProps('x'))[1]).toBe(2)
        expect(lookupModule(withProps('x'), { cached: false })[1]).toBe(1)
    })

    test('returns NotFoundResult on a miss', () => {
        define(1, { y: 1 })
        expect(lookupModule(withProps('x'))).toBe(NotFoundResult)
    })

    test('caches a miss only for full lookups', () => {
        lookupModule(withProps('x'))
        expect('valenced.props(x)' in cache.finds).toBe(false)

        const all = withProps('x').scope(
            FilterScopes.All,
            FilterScopes.Initialized,
        )
        lookupModule(all)
        expect(cache.finds[all.key]).toBeNull()

        // Later matches stay hidden until the cache is dropped
        define(1, { x: 1 })
        expect(lookupModule(all)).toBe(NotFoundResult)
    })

    test('skips blacklisted modules', () => {
        define(1, {})
        expect(lookupModule(withoutProps('x'))).toBe(NotFoundResult)
    })

    test('can leave cached uninitialized matches alone', () => {
        defineModule(1, m => (m.exports = { x: 1 }), [9])
        cache.finds['valenced.deps([9])'] = { 1: FilterResultFlags.Found }

        expect(
            lookupModule(withDependencies([9]), { initialize: false }),
        ).toEqual([undefined, 1])
        expect(lookupModule(withDependencies([9]))).toEqual([{ x: 1 }, 1])
    })
})

describe('lookupModules', () => {
    test('yields every match once, cached ones first', () => {
        define(1, { x: 1 })
        define(2, { x: 2 })
        cache.finds['valenced.props(x)'] = { 2: FilterResultFlags.Namespace }

        expect(ids(lookupModules(withProps('x')))).toEqual([2, 1])
    })

    test('still visits modules a previous match initialized', () => {
        defineModule(
            1,
            m => {
                metroRequire(2)
                m.exports = { x: 1 }
            },
            [9],
        )
        defineModule(2, m => (m.exports = { x: 2 }), [9])

        const filter = allOf(withProps('x'), withDependencies([9]))
        expect(ids(lookupModules(filter))).toEqual([1, 2])
    })
})

describe('waitForModules', () => {
    test('calls back for modules initialized later', () => {
        const callback = vi.fn()
        define(1, { x: 1 })
        waitForModules(withProps('x'), callback)

        define(2, { default: { x: 2 } })
        expect(callback.mock.calls).toEqual([[{ x: 2 }, 2]])
    })

    test('returns the namespace when asked', () => {
        const callback = vi.fn()
        waitForModules(withProps('x'), callback, { returnNamespace: true })

        const exports = define(1, { default: { x: 1 } })
        expect(callback).toHaveBeenCalledWith(exports, 1)
    })

    test('skips blacklisted modules', () => {
        const callback = vi.fn()
        waitForModules(withoutProps('x'), callback)

        define(1, {})
        expect(callback).not.toHaveBeenCalled()
    })

    test('stops after unsubscribing', () => {
        const callback = vi.fn()
        waitForModules(withProps('x'), callback)()

        define(1, { x: 1 })
        expect(callback).not.toHaveBeenCalled()
    })

    test('waits on cached IDs only when cached', () => {
        const callback = vi.fn()
        cache.finds['valenced.props(x)'] = { 2: FilterResultFlags.Default }
        waitForModules(withProps('x'), callback, { cached: true })

        define(1, { x: 1 })
        define(2, { default: { x: 2 } })
        expect(callback.mock.calls).toEqual([[{ x: 2 }, 2]])
    })

    test('never calls back for a cached miss', () => {
        const callback = vi.fn()
        cache.finds['valenced.props(x)'] = null
        waitForModules(withProps('x'), callback, { cached: true })

        define(1, { x: 1 })
        expect(callback).not.toHaveBeenCalled()
    })
})

describe('getModules', () => {
    test('calls back for initialized modules after returning', async () => {
        const callback = vi.fn()
        define(1, { x: 1 })

        getModules(withProps('x'), callback)
        expect(callback).not.toHaveBeenCalled()

        await Promise.resolve()
        expect(callback).toHaveBeenCalledWith({ x: 1 }, 1)
    })

    test('combines found and later modules up to max', async () => {
        const callback = vi.fn()
        define(1, { x: 1 })

        getModules(withProps('x'), callback, { max: 2 })
        define(2, { x: 2 })
        define(3, { x: 3 })

        await Promise.resolve()
        // The found module calls back asynchronously, after 2 initialized
        expect(callback.mock.calls.map(([, id]) => id)).toEqual([2, 1])
    })
})

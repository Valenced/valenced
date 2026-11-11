import { beforeEach, describe, expect, test } from 'vitest'
import { define, defineModule, reset } from './harness'
import { logs } from './mocks/globals'

const {
    FilterScopes,
    allOf,
    anyOf,
    createFilterGenerator,
    withDependencies,
    withName,
    withProps,
    withSingleProp,
    withoutProps,
} = await import('../src/finders/filters')
const { lookupModule } = await import('../src/finders/lookup')
const { mInitialized } = await import('../src/metro/patches')

beforeEach(reset)

/** Filter recording each call, matching uninitialized modules only when `match` says so. */
function spy(key: string, scopes: number, match: (id: number) => boolean) {
    const calls: [id: number, initialized: boolean][] = []
    const filter = createFilterGenerator<[]>(
        (_, id, __, initialized) => {
            calls.push([id, initialized])
            return match(id)
        },
        () => key,
        scopes,
    )()

    return Object.assign(filter, { calls })
}

describe('withProps', () => {
    test('matches objects and functions with every prop', () => {
        const fn = Object.assign(() => {}, { x: 1, y: 1 })

        expect(withProps('x', 'y')(1, { x: 1, y: 1 }, true)).toBe(true)
        expect(withProps('x', 'y')(1, fn, true)).toBe(true)
        expect(withProps('x', 'y')(1, { x: 1 }, true)).toBe(false)
    })

    test('rejects bad exports and primitives', () => {
        const catchAll = new Proxy({}, { get: () => 1, has: () => true })

        for (const exports of [null, undefined, 'x', 1, catchAll])
            expect(withProps('x')(1, exports, true)).toBe(false)
    })

    test('has a stable key', () => {
        expect(withProps('x', 'y').key).toBe('valenced.props(x,y)')
        expect(withProps('x').scopes).toBe(FilterScopes.Initialized)
    })
})

describe('withoutProps', () => {
    test('rejects exports with any prop', () => {
        expect(withoutProps('x', 'y')(1, { y: 1 }, true)).toBe(false)
        expect(withoutProps('x', 'y')(1, { z: 1 }, true)).toBe(true)
    })

    test('accepts exports that cannot have props', () => {
        expect(withoutProps('x')(1, null, true)).toBe(true)
        expect(withoutProps('x')(1, 1, true)).toBe(true)
    })
})

describe('withSingleProp', () => {
    test('matches exports with exactly that prop', () => {
        expect(withSingleProp('x')(1, { x: 1 }, true)).toBe(true)
        expect(withSingleProp('x')(1, { x: 1, y: 1 }, true)).toBe(false)
        expect(withSingleProp('x')(1, { y: 1 }, true)).toBe(false)
        expect(withSingleProp('x')(1, null, true)).toBe(false)
    })
})

describe('withName', () => {
    test('matches the name property', () => {
        function Foo() {}

        expect(withName('Foo')(1, Foo, true)).toBe(true)
        expect(withName('Bar')(1, Foo, true)).toBe(false)
        expect(withName('Foo')(1, undefined, true)).toBe(false)
    })
})

describe('createFilterGenerator', () => {
    test('names the filter after its key', () => {
        expect(withProps('x').name).toBe('Filter(valenced.props(x))')
    })

    test('turns a throwing predicate into a miss and logs it', () => {
        const filter = createFilterGenerator<[]>(
            () => {
                throw new Error('boom')
            },
            () => 'test.throws',
        )()

        expect(filter(1, {}, true)).toBe(false)
        expect(logs.join('\n')).toContain('test.throws threw an error')
    })

    test('reads the initialized state when not passed', () => {
        const filter = spy('test.state', FilterScopes.Initialized, () => true)
        define(1, { x: 1 })
        defineModule(2)

        filter(1)
        filter(2)
        expect(filter.calls).toEqual([
            [1, true],
            [2, false],
        ])
    })

    test('computes scopes from the arguments', () => {
        const generator = createFilterGenerator<[scopes: number]>(
            () => true,
            ([scopes]) => `test.scopes(${scopes})`,
            ([scopes]) => scopes,
        )

        expect(generator(FilterScopes.Uninitialized).scopes).toBe(
            FilterScopes.Uninitialized,
        )
        expect(generator.defaultScopesFor([FilterScopes.All])).toBe(
            FilterScopes.All,
        )
        expect(generator.keyFor([1])).toBe('test.scopes(1)')
    })
})

describe('filter helpers', () => {
    test('keyAs replaces the key in place', () => {
        const filter = withProps('x')
        expect(filter.keyAs('custom')).toBe(filter)
        expect(filter.key).toBe('custom')
    })

    test('new copies the filter', () => {
        const filter = withProps('x')
        const copy = filter.new()

        expect(copy).not.toBe(filter)
        expect(copy.key).toBe(filter.key)
        expect(copy(1, { x: 1 }, true)).toBe(true)

        copy.keyAs('custom')
        expect(filter.key).toBe('valenced.props(x)')
    })

    test('scope combines scopes on a copy and keeps the key', () => {
        const filter = withProps('x')
        const scoped = filter.scope(FilterScopes.All, FilterScopes.Initialized)

        expect(scoped.scopes).toBe(FilterScopes.All | FilterScopes.Initialized)
        expect(scoped.key).toBe(filter.key)
        expect(filter.scopes).toBe(FilterScopes.Initialized)
    })

    test('and and or build composites', () => {
        expect(withProps('x').and(withName('y')).key).toBe(
            'valenced.allOf(valenced.props(x),valenced.name(y))',
        )
        expect(withProps('x').or(withName('y')).key).toBe(
            'valenced.anyOf(valenced.props(x),valenced.name(y))',
        )
    })
})

describe('allOf', () => {
    test('requires both filters', () => {
        const filter = allOf(withProps('x'), withProps('y'))

        expect(filter(1, { x: 1, y: 1 }, true)).toBe(true)
        expect(filter(1, { x: 1 }, true)).toBe(false)
        expect(filter.scopes).toBe(FilterScopes.Initialized)
    })

    test('runs only the exportless filter on uninitialized modules', () => {
        const exportsFilter = spy(
            'test.exports',
            FilterScopes.Initialized,
            () => true,
        )
        const depsFilter = spy(
            'test.deps',
            FilterScopes.Uninitialized,
            () => true,
        )
        const filter = allOf(exportsFilter, depsFilter)

        expect(filter(1, undefined, false)).toBe(true)
        expect(exportsFilter.calls).toEqual([])
        expect(depsFilter.calls).toEqual([[1, false]])

        expect(filter(1, {}, true)).toBe(true)
        expect(exportsFilter.calls).toEqual([[1, true]])
    })

    test('puts the exportless filter last in the key', () => {
        const deps = withDependencies([9])

        expect(allOf(deps, withProps('x')).key).toBe(
            allOf(withProps('x'), deps).key,
        )
        expect(allOf.keyFor([deps, withProps('x')])).toBe(
            allOf(withProps('x'), deps).key,
        )
    })

    test('initializes only modules passing the exportless filter', () => {
        defineModule(1, m => (m.exports = { x: 1 }), [8])
        defineModule(2, m => (m.exports = { x: 1 }), [9])

        expect(
            lookupModule(allOf(withProps('x'), withDependencies([9]))),
        ).toEqual([{ x: 1 }, 2])
        expect([...mInitialized]).toEqual([2])
    })
})

describe('anyOf', () => {
    test('requires either filter', () => {
        const filter = anyOf(withProps('x'), withProps('y'))

        expect(filter(1, { y: 1 }, true)).toBe(true)
        expect(filter(1, { z: 1 }, true)).toBe(false)
    })

    test('runs only the exportless filter on uninitialized modules', () => {
        const exportsFilter = spy(
            'test.exports',
            FilterScopes.Initialized,
            () => true,
        )
        const depsFilter = spy(
            'test.deps',
            FilterScopes.Uninitialized,
            () => false,
        )
        const filter = anyOf(exportsFilter, depsFilter)

        expect(filter(1, undefined, false)).toBe(false)
        expect(exportsFilter.calls).toEqual([])

        expect(filter(1, {}, true)).toBe(true)
    })
})

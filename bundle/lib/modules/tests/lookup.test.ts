import { beforeEach, describe, expect, test } from 'vitest'
import { define, reset } from './harness'

const {
    FilterScopes,
    allOf,
    anyOf,
    createFilterGenerator,
    namespaceOnly,
    withProps,
} = await import('../src/finders/filters')
const { migrateSkipDefaultOption } = await import('../src/finders/_compat')
const { noDefaultExportsCache, runFilter } = await import(
    '../src/finders/_internal'
)
const { NamespaceOnlyMark } = await import('../src/finders/filters/_internal')
const { lookupModule, lookupModules } = await import('../src/finders/lookup')
const { getInitializedModuleExports } = await import('../src/metro/utils')

beforeEach(reset)

describe('namespaceOnly', () => {
    test('is part of the filter key, and kept when rescoping', () => {
        const filter = namespaceOnly(withProps('x'))

        expect(filter.key).toBe('valenced.namespaceOnly(valenced.props(x))')
        expect(filter.scopes).toBe(FilterScopes.Initialized)
        expect(
            filter.scope(FilterScopes.All, FilterScopes.Initialized).key,
        ).toBe(filter.key)
    })

    test('is marked privately, and copies keep the mark', () => {
        const filter = namespaceOnly(withProps('x'))

        expect(filter[NamespaceOnlyMark as never]).toBe(true)
        expect(
            filter.scope(FilterScopes.Initialized)[NamespaceOnlyMark as never],
        ).toBe(true)
        expect(withProps('x')[NamespaceOnlyMark as never]).toBeUndefined()
        // Composites aren't marked, the wrapper inside handles the default export
        expect(
            anyOf(filter, withProps('y'))[NamespaceOnlyMark as never],
        ).toBeUndefined()
    })

    test('skips the default export pass entirely', () => {
        // The default export pass remembers modules without a default export, so it shows whether it ran
        define(50, { y: 1 })

        expect(
            runFilter(
                namespaceOnly(withProps('x')),
                50,
                getInitializedModuleExports(50),
            ),
        ).toBeUndefined()
        expect(noDefaultExportsCache.has(50)).toBe(false)

        expect(
            runFilter(withProps('x'), 50, getInitializedModuleExports(50)),
        ).toBeUndefined()
        expect(noDefaultExportsCache.has(50)).toBe(true)
    })

    test('matches the namespace, not the default export', () => {
        define(50, { x: 1 })
        define(51, { default: { x: 1 } })

        const filter = namespaceOnly(withProps('x'))
        expect([...lookupModules(filter)].map(([, id]) => id)).toEqual([50])
    })

    test('applies inside anyOf', () => {
        define(50, { default: { x: 1 } })
        define(51, { default: { y: 1 } })

        const filter = anyOf(namespaceOnly(withProps('x')), withProps('y'))
        expect([...lookupModules(filter)].map(([, id]) => id)).toEqual([51])
    })

    test('applies inside allOf', () => {
        define(50, { default: { x: 1, y: 1 } })
        define(51, { x: 1, y: 1 })

        const filter = allOf(namespaceOnly(withProps('x')), withProps('y'))
        expect([...lookupModules(filter)].map(([, id]) => id)).toEqual([51])
    })

    test('leaves uninitialized modules to the filter', () => {
        const calls: [number, unknown, boolean][] = []
        const inner = createFilterGenerator<[]>(
            (_, id, exports, initialized) => {
                calls.push([id, exports, initialized])
                return false
            },
            () => 'test.uninitialized',
            FilterScopes.Uninitialized,
        )()

        const filter = namespaceOnly(inner)
        expect(filter.scopes).toBe(FilterScopes.Uninitialized)
        expect(filter(50, undefined, false)).toBe(false)
        expect(calls).toEqual([[50, undefined, false]])
    })
})

describe('migrateSkipDefaultOption', () => {
    test('only wraps when needed', () => {
        const filter = withProps('x')
        expect(migrateSkipDefaultOption(filter)).toBe(filter)
        expect(migrateSkipDefaultOption(filter, { skipDefault: false })).toBe(
            filter,
        )
        expect(
            migrateSkipDefaultOption(filter, { skipDefault: true }).key,
        ).toBe('valenced.namespaceOnly(valenced.props(x))')
    })
})

describe('skipDefault option', () => {
    test('still matches the namespace', () => {
        define(50, { x: 1 })

        const [exports, id] = lookupModule(withProps('x'), {
            skipDefault: true,
        })
        expect(id).toBe(50)
        expect(exports).toEqual({ x: 1 })
    })

    test('does not match the default export', () => {
        define(50, { default: { x: 1 } })

        expect(lookupModule(withProps('x'), { skipDefault: true })).toEqual([])
        expect([
            ...lookupModules(withProps('x'), { skipDefault: true }),
        ]).toEqual([])
    })

    test('ignores cached default matches from lookups without it', () => {
        define(50, { default: { x: 1 } })

        expect(lookupModule(withProps('x'))[1]).toBe(50)
        expect(lookupModule(withProps('x'), { skipDefault: true })).toEqual([])
        expect([
            ...lookupModules(withProps('x'), { skipDefault: true }),
        ]).toEqual([])
    })

    test('does not hide default matches from later lookups without it', () => {
        define(50, { default: { x: 1 } })

        // All-scoped filters cache when nothing is found
        const filter = withProps('x').scope(
            FilterScopes.All,
            FilterScopes.Initialized,
        )

        expect(lookupModule(filter, { skipDefault: true })).toEqual([])
        expect(lookupModule(filter)).toEqual([{ x: 1 }, 50])
    })

    test('is honored by runFilter for direct callers', () => {
        define(50, { default: { x: 1 } })

        expect(
            runFilter(withProps('x'), 50, getInitializedModuleExports(50)),
        ).toBeTruthy()
        expect(
            runFilter(withProps('x'), 50, getInitializedModuleExports(50), {
                skipDefault: true,
            }),
        ).toBeUndefined()
    })
})

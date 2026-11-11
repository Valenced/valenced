import { beforeEach, describe, expect, expectTypeOf, test, vi } from 'vitest'

vi.mock('@valenced/modules/metro/utils', () => import('./mocks/metro'))
vi.mock('@valenced/modules/metro/patches', () => import('./mocks/metro'))
vi.mock('../src/metro/runtime', () => import('./mocks/metro'))
vi.mock('../src/caches', () => import('./mocks/caches'))

import './mocks/globals'
import { mExports } from './mocks/metro'

const { FilterScopes, withDefaultExport, withName, withProps } = await import(
    '../src/finders/filters'
)

import type { FilterResult } from '../src/finders/filters'

const {
    exportsFromFilterResultFlag,
    FilterResultFlags,
    noDefaultExportsCache,
    runFilter,
} = await import('../src/finders/_internal')

function define(id: number, exports: unknown) {
    mExports.set(id, exports)
    return id
}

function lookup(filter: Parameters<typeof runFilter>[0], id: number) {
    const exports = mExports.get(id)
    const flag = runFilter(filter, id, exports)
    return flag && exportsFromFilterResultFlag(flag, exports)
}

describe('withDefaultExport', () => {
    beforeEach(() => {
        mExports.clear()
        noDefaultExportsCache.clear()
    })

    function Foo() {}

    test('matches the default export and returns the namespace', () => {
        const namespace = { __esModule: true, default: Foo, helper: 1 }
        const id = define(1, namespace)
        const filter = withDefaultExport(withName('Foo'))

        expect(runFilter(filter, id, namespace)).toBe(
            FilterResultFlags.Namespace,
        )
        expect(lookup(filter, id)).toBe(namespace)
    })

    test('rejects a namespace matching only by itself', () => {
        const id = define(1, { name: 'Foo', default: {} })

        expect(lookup(withDefaultExport(withName('Foo')), id)).toBeUndefined()
    })

    test('matches a function namespace with a default', () => {
        const namespace = Object.assign(() => {}, { default: Foo })
        const id = define(1, namespace)

        expect(lookup(withDefaultExport(withName('Foo')), id)).toBe(namespace)
    })

    test('rejects modules without a default export', () => {
        define(1, { a: 1 })
        define(2, null)
        define(3, 5)
        define(4, undefined)

        const filter = withDefaultExport(withProps('a'))
        for (const id of [1, 2, 3, 4])
            expect(lookup(filter, id)).toBeUndefined()
    })

    test('skips a nested default under composites', () => {
        // { default: { default: Foo, helper } } must not match through the default pass
        const id = define(1, { default: { default: Foo, helper: 1 } })
        const filter = withDefaultExport(withName('Foo')).and(
            withProps('helper'),
        )

        expect(lookup(filter, id)).toBeUndefined()
    })

    test('works next to sibling filters', () => {
        const namespace = { default: Foo, helper: 1 }
        const id = define(1, namespace)
        const filter = withDefaultExport(withName('Foo')).and(
            withProps('helper'),
        )

        expect(lookup(filter, id)).toBe(namespace)
    })

    test('leaves uninitialized modules to the filter', () => {
        const inner = Object.assign(
            vi.fn(() => true),
            {
                key: 'inner',
                scopes: FilterScopes.Uninitialized,
            },
        )
        const filter = withDefaultExport(inner)

        expect(filter(1, undefined, false)).toBe(true)
        expect(inner).toHaveBeenCalledWith(1, undefined, false)
        expect(filter.scopes).toBe(FilterScopes.Uninitialized)
    })

    test('keeps its key and mark through scope()', () => {
        const filter = withDefaultExport(withName('Foo'))
        const scoped = filter.scope(FilterScopes.Initialized)
        const namespace = { default: { default: Foo } }
        const id = define(1, namespace)

        expect(filter.key).toBe('valenced.default(valenced.name(Foo))')
        expect(scoped.key).toBe(filter.key)
        // Mark skips the default pass, which would match { default: Foo }
        expect(lookup(scoped, id)).toBeUndefined()
    })

    test('or() with the plain filter matches returnNamespace', () => {
        const shapes = [
            { name: 'Foo' },
            { default: Foo },
            { default: { name: 'Bar' } },
            { default: { default: Foo } },
            null,
        ]
        const filter = withName('Foo')
        const replacement = filter.or(withDefaultExport(filter))

        shapes.forEach((exports, i) => {
            const id = define(i + 1, exports)
            const flag = runFilter(filter, id, exports)
            expect(lookup(replacement, id)).toBe(
                flag &&
                    exportsFromFilterResultFlag(flag, exports, {
                        returnNamespace: true,
                    }),
            )
        })

        // Only difference: runFilter skips `default` on function namespaces
        const fn = Object.assign(() => {}, { default: Foo })
        const id = define(shapes.length + 1, fn)
        expect(runFilter(filter, id, fn)).toBeUndefined()
        expect(lookup(replacement, id)).toBe(fn)
    })

    test('types', () => {
        type FC = () => null

        const inferred = withDefaultExport(withName<FC>('Foo'))
        const explicit = withDefaultExport<{ default: FC; helper(): void }>(
            withName('Foo'),
        )

        expectTypeOf<FilterResult<typeof inferred>>().toEqualTypeOf<{
            default: FC
        }>()
        expectTypeOf<FilterResult<typeof explicit>>().toEqualTypeOf<{
            default: FC
            helper(): void
        }>()
    })
})

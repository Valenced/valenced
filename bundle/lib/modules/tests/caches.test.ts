import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { reset } from './harness'
import { nativeCalls } from './mocks/native'

const {
    cache,
    cacheBlacklistedModule,
    cacheFilterNotFound,
    cacheFilterResultForId,
    getBlacklistedModules,
    getFilterMatches,
} = await import('../src/caches')

beforeEach(() => {
    reset()
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
})

const writes = () =>
    nativeCalls.filter(([name]) => name === 'valenced.caches.modules.write')

test('reads the saved cache from native', () => {
    expect(cache.outdated).toBeUndefined()
    expect(cache.version).toBe(3)
})

test('records matches and misses by key', () => {
    expect(cacheFilterResultForId('a', 1, 2)).toBe(2)
    cacheFilterResultForId('a', 3, 3)
    cacheFilterNotFound('b')

    expect(getFilterMatches('a')).toEqual({ 1: 2, 3: 3 })
    expect(getFilterMatches('b')).toBeNull()
    expect(getFilterMatches('c')).toBeUndefined()
})

test('records blacklisted modules', () => {
    cacheBlacklistedModule(1)
    expect(getBlacklistedModules()).toEqual([1])
})

test('saves once per burst of writes', () => {
    cacheBlacklistedModule(1)
    cacheFilterResultForId('a', 1, 2)
    expect(writes()).toEqual([])

    vi.advanceTimersByTime(1000)
    expect(writes()).toEqual([
        ['valenced.caches.modules.write', [[1], { a: { 1: 2 } }]],
    ])
})

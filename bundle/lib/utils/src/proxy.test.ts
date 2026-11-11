import { describe, expect, test, vi } from 'vitest'

vi.hoisted(() => {
    Object.assign(globalThis, { __BUILD_FLAG_DEBUG_LAZY_VALUES__: false })
})

import { isProxified, proxify, unproxify, withResolvedReads } from './proxy'

describe('unproxify', () => {
    test('returns the signal value for a proxy', () => {
        const value = { a: 1 }
        const prox = proxify(() => value, { hint: {} })

        expect(isProxified(prox)).toBe(true)
        expect(unproxify(prox)).toBe(value)
    })

    test('returns a non-proxified value as is', () => {
        const value = { a: 1 }
        expect(unproxify(value)).toBe(value)
    })
})

function makeNamespace() {
    let ModuleId: number | undefined
    const signal = vi.fn(() => {
        ModuleId = 42
        return { open: () => 'opened' }
    })
    const Module = proxify(signal, { hint: {} })

    const ns = Object.defineProperties({} as Record<string, unknown>, {
        __esModule: { value: true },
        Module: { enumerable: true, get: () => Module },
        ModuleId: { enumerable: true, get: () => ModuleId },
        Other: { enumerable: true, get: () => 'other' },
    })

    return { ns, signal }
}

describe('withResolvedReads', () => {
    test('resolves the paired proxy before reading a mapped key', () => {
        const { ns, signal } = makeNamespace()
        const facade = withResolvedReads(ns, { ModuleId: 'Module' })

        expect(signal).not.toHaveBeenCalled()
        expect(facade.ModuleId).toBe(42)
        expect(signal).toHaveBeenCalledOnce()
    })

    test('leaves unmapped keys lazy and live', () => {
        const { ns, signal } = makeNamespace()
        const facade = withResolvedReads(ns, { ModuleId: 'Module' })

        expect(facade.Other).toBe('other')
        expect(signal).not.toHaveBeenCalled()
        expect((facade.Module as { open(): string }).open()).toBe('opened')
    })

    test('keeps non-enumerable keys and key order', () => {
        const { ns } = makeNamespace()
        const facade = withResolvedReads(ns, { ModuleId: 'Module' })

        expect(facade.__esModule).toBe(true)
        expect(Object.keys(facade)).toEqual(['Module', 'ModuleId', 'Other'])
    })
})

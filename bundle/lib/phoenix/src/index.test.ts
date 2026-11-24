import { describe, expect, test } from 'vitest'
import { onDispatch, onInvoke, onOps } from '.'

const frames = globalThis.__valencedPhoenixFrames!

describe('onOps', () => {
    test('installs a handler only while a listener is registered', () => {
        expect(frames.onApplyOps).toBeUndefined()

        const off = onOps(() => {})
        expect(frames.onApplyOps).toBeInstanceOf(Function)

        off()
        expect(frames.onApplyOps).toBeUndefined()
    })

    test('passes the frame through', () => {
        const seen: number[] = []
        const off = onOps(bytes => {
            seen.push(bytes[0]!)
        })

        expect(frames.onApplyOps!(new Uint8Array([9]))).toBeUndefined()
        expect(seen).toEqual([9])
        off()
    })

    test('drops the frame', () => {
        const off = onOps(() => false)
        expect(frames.onApplyOps!(new Uint8Array([9]))).toBe(false)
        off()
    })

    test('feeds a replacement to the next listener', () => {
        const seen: number[] = []
        const first = onOps(() => new Uint8Array([2]))
        const second = onOps(bytes => {
            seen.push(bytes[0]!)
        })

        expect([
            ...(frames.onApplyOps!(new Uint8Array([1])) as Uint8Array),
        ]).toEqual([2])
        expect(seen).toEqual([2])

        first()
        second()
    })

    test('stops at the first listener that drops', () => {
        let reached = false
        const first = onOps(() => false)
        const second = onOps(() => {
            reached = true
        })

        expect(frames.onApplyOps!(new Uint8Array([1]))).toBe(false)
        expect(reached).toBe(false)

        first()
        second()
    })
})

describe('onInvoke', () => {
    test('replaces the payload', () => {
        const off = onInvoke(() => new Uint8Array([7]))
        expect([
            ...(frames.onInvoke!(new Uint8Array([1])) as Uint8Array),
        ]).toEqual([7])
        off()
    })
})

describe('onDispatch', () => {
    test('passes through when no listener decides', () => {
        const off = onDispatch(() => {})
        expect(frames.onDispatch!(1, new Uint8Array())).toBeUndefined()
        off()
    })

    test('replaces the frame', () => {
        const seen: number[] = []
        const first = onDispatch(() => new Uint8Array([2]))
        const second = onDispatch((_, bytes) => {
            seen.push(...bytes)
        })

        expect([
            ...(frames.onDispatch!(1, new Uint8Array([1])) as Uint8Array),
        ]).toEqual([2])
        expect(seen).toEqual([2])

        first()
        second()
    })

    test('the first boolean wins', () => {
        const first = onDispatch(() => undefined)
        const second = onDispatch(() => true)
        const third = onDispatch(() => false)

        expect(frames.onDispatch!(1, new Uint8Array())).toBe(true)

        first()
        second()
        third()
    })
})

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { logs } from './mocks/globals'

// Fake bridge. Each call reads `reply` to build its response.
let reply: (payload: any) => unknown = () => ({ result: null })
const payloads: any[] = []
let callableModule: (() => Record<string, (...args: any[]) => void>) | undefined

Object.assign(globalThis, {
    nativeModuleProxy: {
        RNSVGRenderableModule: {
            getBBox: (_: number, payload: object) => {
                payloads.push(payload)
                return reply(payload)
            },
        },
        FileReaderModule: {
            readAsDataURL: async (payload: object) => {
                payloads.push(payload)
                return reply(payload)
            },
        },
    },
    RN$registerCallableModule: (_: string, provider: typeof callableModule) => {
        callableModule = provider
    },
})

const {
    callNativeMethod,
    callNativeMethodSync,
    getBridgeInfo,
    getNativeModule,
    registerJSMethod,
} = await import('../src/native')

beforeEach(() => {
    reply = () => ({ result: null })
    payloads.length = 0
    logs.length = 0
})

const returned = () =>
    payloads
        .filter(p => p.valenced.method === 'valenced.__callableReturn')
        .map(p => p.valenced.args[0])

describe('callNativeMethodSync', () => {
    test('sends the method and arguments, and unwraps the result', () => {
        reply = () => ({ result: 'ok' })

        expect(callNativeMethodSync('valenced.info', [])).toBe('ok')
        expect(payloads).toEqual([
            { valenced: { method: 'valenced.info', args: [] } },
        ])
    })

    test('throws native errors', () => {
        reply = () => ({ error: 'nope' })
        expect(() => callNativeMethodSync('valenced.info', [])).toThrow(
            'Call failed: nope',
        )
    })

    test('throws when native returns neither', () => {
        reply = () => ({})
        expect(() => callNativeMethodSync('valenced.info', [])).toThrow(
            'native hook must have failed',
        )
    })
})

describe('callNativeMethod', () => {
    test('resolves the result', async () => {
        reply = () => ({ result: 'ok' })
        await expect(callNativeMethod('valenced.info', [])).resolves.toBe('ok')
    })

    test('rejects native errors', async () => {
        reply = () => ({ error: 'nope' })
        await expect(callNativeMethod('valenced.info', [])).rejects.toThrow(
            'Call failed: nope',
        )
    })
})

describe('getBridgeInfo', () => {
    test('returns null and logs on failure', () => {
        reply = () => ({ error: 'nope' })

        expect(getBridgeInfo()).toBeNull()
        expect(logs.join('\n')).toContain('Failed to get native bridge info')
    })
})

describe('getNativeModule', () => {
    test('throws for missing modules', () => {
        expect(() => getNativeModule('Missing')).toThrow(
            'Unable to access native module: Missing',
        )
    })
})

describe('registerJSMethod', () => {
    test('returns the result to native', () => {
        registerJSMethod('test.add', (a: number, b: number) => a + b)
        callableModule!()['test.add']!(1, 2)

        expect(returned()).toEqual([{ result: 3 }])
    })

    test('returns null for undefined results', () => {
        registerJSMethod('test.void', () => {})
        callableModule!()['test.void']!()

        expect(returned()).toEqual([{ result: null }])
    })

    test('returns thrown errors to native', () => {
        registerJSMethod('test.throws', () => {
            throw new Error('boom')
        })
        callableModule!()['test.throws']!()

        expect(returned()[0].error).toContain('boom')
    })

    test('returns after a promise settles', async () => {
        const { promise, resolve } = Promise.withResolvers<string>()
        registerJSMethod('test.async', () => promise)
        callableModule!()['test.async']!()
        expect(returned()).toEqual([])

        resolve('done')
        await vi.waitFor(() => expect(returned()).toEqual([{ result: 'done' }]))
    })

    test('warns when overwriting a method', () => {
        registerJSMethod('test.twice', () => {})
        registerJSMethod('test.twice', () => {})

        expect(logs.join('\n')).toContain(
            'Overwriting existing registered JS method: test.twice',
        )
    })

    test('throws for unknown methods', () => {
        expect(() => callableModule!()['test.unknown']!()).toThrow(
            'JS method not found: test.unknown',
        )
    })
})

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

const { jsMethods, logs, files, fetches, invokes } = vi.hoisted(() => {
    const jsMethods = new Map<string, (...args: any[]) => any>()
    const logs: string[] = []
    const files = new Map<string, string>()
    const fetches: unknown[][] = []
    const invokes: Uint8Array[] = []

    const native = (method: string, args: any[]): unknown => {
        switch (method) {
            case 'valenced.plugins.getConstants':
                return {
                    result: {
                        storageRootPath: '/storage',
                        distRootPath: '/dist',
                        defaultsOnlySlot: 'defaults',
                    },
                }
            case 'valenced.plugins.list':
                return { result: [] }
            case 'valenced.plugins.states.getRuntime':
                return {
                    result: {
                        id: 'slot',
                        plugins: new Proxy(
                            {},
                            { get: () => ({ enabled: true }) },
                        ),
                    },
                }
            case 'valenced.plugins.settings.read':
                return { result: {} }
            case 'valenced.plugins.setEnabled':
                return { result: null }
            case 'valenced.fs.getConstants':
                return { data: '/data' }
            case 'valenced.fs.exists':
                return files.has(args[0])
            case 'valenced.fs.read':
                return files.get(args[0])
            case 'valenced.fs.write':
                files.set(args[0], args[1])
                return null
            case 'valenced.fs.delete':
                return files.delete(args[0])
            case 'valenced.themes.getState':
                return '{}'
            case 'valenced.phoenix.compatUnsupported':
                return null
            case 'valenced.phoenix.dispatch':
            case 'valenced.phoenix.http.invoke':
                invokes.push(
                    Uint8Array.from(atob(args[0]), c => c.charCodeAt(0)),
                )
                return null
            case 'valenced.http.fetch':
                fetches.push(args)
                return {
                    status: 200,
                    statusText: 'OK',
                    url: args[0],
                    redirected: false,
                    headers: [['content-type', 'application/json']],
                    body: btoa('{"ok":true}'),
                }
        }
        throw new Error(`Unmocked native method: ${method}`)
    }

    type Call = { valenced: { method: string; args: any[] } }
    Object.assign(globalThis, {
        __DEV__: false,
        __BUILD_VERSION__: '1.0.0',
        nativeLoggingHook: (message: string) => logs.push(message),
        [Symbol.for('valenced.bridge.call.sync')]: ({ valenced }: Call) => ({
            result: native(valenced.method, valenced.args),
        }),
        [Symbol.for('valenced.bridge.call.async')]: async ({
            valenced,
        }: Call) => ({
            result: native(valenced.method, valenced.args),
        }),
    })

    return { jsMethods, logs, files, fetches, invokes }
})

vi.mock('@valenced/modules/native', async importOriginal => ({
    ...(await importOriginal<object>()),
    registerJSMethod: (name: string, method: (...args: any[]) => any) =>
        jsMethods.set(name, method),
}))

import { ByteReader, ByteWriter, decodeUtf8, encodeUtf8 } from './bytes'
import { AbortController, FormData, fetch, URLSearchParams } from './fetch'
import { mayCarryToken, onRequest, request, watch } from './http'
import { startExternalPhoenixPlugins } from './plugins'

const gateway = (event: string, data: object) =>
    globalThis.__valencedPhoenixGateway!.onEvent?.(event, JSON.stringify(data))

const failures = (id: string) =>
    logs.filter(log => log.startsWith(`Phoenix plugin "${id}" failed`))

async function start(id: string, script: string) {
    await jsMethods.get('valenced.plugins.events.pluginInstallResult')!({
        error: false,
        plugin: { manifest: { id }, script, compat: true },
    })
    await new Promise(resolve => setTimeout(resolve))
}

const stop = (id: string) => jsMethods.get('valenced.plugins.stopping')!(id)

const rnPlugin = (body: string) =>
    `(function(e,t){var s=t.StyleSheet.create({a:1}),C=valenced.react.React.createContext();class K extends valenced.react.React.Component{}return e.default=plugin(${body}),e})({},valenced.react.ReactJSXRuntime)`

beforeAll(() => startExternalPhoenixPlugins())

beforeEach(() => {
    logs.length = 0
})

describe('compat host', () => {
    test('runs lifecycles in order with the React Native scoped API', async () => {
        const calls: string[] = []
        Object.assign(globalThis, { calls })
        await start(
            'test.order',
            rnPlugin(`{
                jsonStorage: { load: true, default: { on: true } },
                preInit(api) { calls.push('preInit:' + typeof api.unscoped.discord.design.Design.Button) },
                init() { calls.push('init:' + (this.manifest.id)) },
                start({ jsonStorage, cleanup, logger, plugin }) {
                    calls.push('start:' + jsonStorage.cache.on + ':' + jsonStorage.use().on)
                    cleanup(() => calls.push('cleanup'), undefined)
                    logger.info('hi', 1)
                    valenced.modules.finders.getModules(valenced.modules.finders.filters.withName('X'), () => calls.push('found'))
                    calls.push('lookup:' + valenced.modules.finders.lookupModule(valenced.modules.finders.filters.withProps('y'))[0])
                },
                stop() { calls.push('stop') },
            }`),
        )
        await stop('test.order')

        expect(calls).toEqual([
            'preInit:function',
            'init:test.order',
            'start:true:true',
            'lookup:undefined',
            'stop',
            'cleanup',
        ])
        expect(files.get('/storage/test.order/storage.json')).toBe(
            '{"on":true}',
        )
        expect(failures('test.order')).toEqual([])
        expect(logs).toContain('[test.order] hi 1')
        expect(
            logs.filter(log => log.includes('Unsupported in Phoenix')),
        ).toEqual([
            '[test.order] Unsupported in Phoenix: valenced.react.ReactJSXRuntime.StyleSheet.create, valenced.react.React.createContext, valenced.modules.finders.getModules(withName("X")), valenced.modules.finders.lookupModule(withProps("y"))',
        ])
    })

    test('reports and cleans up a plugin that throws', async () => {
        await start(
            'test.throws',
            rnPlugin(`{
                start({ cleanup }) {
                    cleanup(valenced.discord.flux.onFluxEventDispatched('MESSAGE_CREATE', p => p))
                    throw new Error('boom')
                },
            }`),
        )

        expect(failures('test.throws')[0]).toContain('boom')
        expect(globalThis.__valencedPhoenixGateway!.onEvent).toBeUndefined()
    })

    test('maps Flux patches onto gateway events', async () => {
        await start(
            'test.flux',
            rnPlugin(`{
                start() {
                    const { onFluxEventDispatched, Stores } = valenced.discord.flux
                    onFluxEventDispatched('MESSAGE_CREATE', p => { p.message.content += '!'; return p })
                    onFluxEventDispatched('MESSAGE_UPDATE', () => undefined)
                    onFluxEventDispatched('MESSAGE_DELETE', p =>
                        Stores.MessageStore.getMessage(p.channelId, p.id)?.state === 'SENT'
                            ? { type: 'MESSAGE_UPDATE', message: { id: p.id } }
                            : p)
                    onFluxEventDispatched('MESSAGE_DELETE_BULK', p => ({ ...p, ids: p.ids.slice(1) }))
                    onFluxEventDispatched('LOCAL_ACTIVITY_UPDATE', () => {})
                    valenced.discord.common.flux.Dispatcher.subscribe('CONNECTION_OPEN', p => { globalThis.user = Stores.UserStore.getCurrentUser().id + p.user.id })
                },
            }`),
        )

        const results = [
            gateway('READY', {
                session_id: 's',
                user: { id: 'me' },
                guilds: [],
            }),
            gateway('READY_SUPPLEMENTAL', { guilds: [] }),
            (globalThis as any).user,
            gateway('MESSAGE_CREATE', {
                id: '1',
                channel_id: 'c',
                content: 'a',
                author: { id: 'u' },
            }),
            gateway('MESSAGE_UPDATE', { id: '1', channel_id: 'c' }),
            gateway('MESSAGE_DELETE', { id: '1', channel_id: 'c' }),
            gateway('MESSAGE_DELETE', { id: '2', channel_id: 'c' }),
            gateway('MESSAGE_DELETE_BULK', {
                ids: ['1', '2'],
                channel_id: 'c',
            }),
        ]
        await stop('test.flux')

        expect(results).toEqual([
            undefined,
            undefined,
            'meme',
            '{"id":"1","channel_id":"c","content":"a!","author":{"id":"u"}}',
            false,
            false,
            '{"id":"2","channel_id":"c"}',
            '{"ids":["2"],"channel_id":"c"}',
        ])
        expect(logs.join(' ')).toContain(
            'onFluxEventDispatched("LOCAL_ACTIVITY_UPDATE")',
        )
        expect(globalThis.__valencedPhoenixGateway!.onEvent).toBeUndefined()
    })

    test('passes unmapped gateway events through in their gateway shape', async () => {
        await start(
            'test.unmapped',
            rnPlugin(`{
                start() {
                    valenced.discord.flux.onFluxEventDispatched('TYPING_START', p => ({ ...p, userId: 'x' }))
                    valenced.discord.common.flux.Dispatcher.subscribe('TYPING_START', p => { globalThis.typing = p })
                },
            }`),
        )
        const result = gateway('TYPING_START', {
            channel_id: 'c',
            user_id: 'u',
        })
        await stop('test.unmapped')

        expect(result).toBeUndefined()
        expect((globalThis as any).typing).toEqual({
            type: 'TYPING_START',
            channel_id: 'c',
            channelId: 'c',
            user_id: 'u',
            userId: 'x',
        })
        expect(failures('test.unmapped')).toEqual([])
        expect(globalThis.__valencedPhoenixGateway!.onEvent).toBeUndefined()
    })

    test('maps IDLE onto presence updates and dispatches gateway events', async () => {
        const frames = globalThis.__valencedPhoenixFrames!
        const message = new ByteWriter()
            .u32(3)
            .u32(0x17a)
            .u32(0)
            .u32(0)
            .raw(encodeUtf8('{"t":"X","s":7,"op":0,"d":{}}'))
            .toBytes()
        frames.onDispatch!(
            0,
            new ByteWriter()
                .u16(4)
                .raw(new Uint8Array(14))
                .u32(message.length)
                .raw(message)
                .toBytes(),
        )
        const presence = (afk: boolean) => {
            const struct = new ByteWriter().u8(8).i32(0).toBytes()
            return new ByteWriter()
                .u16(1)
                .u16(0x3f)
                .u32(0x125)
                .u32(1)
                .u32(struct.length)
                .raw(struct)
                .raw(
                    encodeUtf8(
                        JSON.stringify({
                            op: 3,
                            d: { status: 'online', since: 5, afk },
                        }),
                    ),
                )
                .toBytes()
        }

        await start(
            'test.idle',
            rnPlugin(`{
                start() {
                    valenced.discord.flux.onFluxEventDispatched('IDLE', p => ({ ...p, idle: false }))
                    valenced.discord.common.flux.Dispatcher.dispatch({ type: 'MESSAGE_CREATE', message: { id: '9', channel_id: 'c' } })
                },
            }`),
        )
        const active = frames.onInvoke!(presence(true)) as Uint8Array
        const untouched = frames.onInvoke!(presence(false))
        await stop('test.idle')

        expect(decodeUtf8(active.subarray(21))).toBe(
            '{"op":3,"d":{"status":"online","since":0,"afk":false}}',
        )
        expect(untouched).toBeUndefined()
        expect(decodeUtf8(invokes.at(-1)!.subarray(36))).toBe(
            '{"t":"MESSAGE_CREATE","s":7,"op":0,"d":{"id":"9","channel_id":"c"}}',
        )
    })
})

describe('fetch', () => {
    test('sends multipart bodies over the bridge and reads JSON', async () => {
        const form = new FormData()
        form.append('a', 'b')
        form.append('file', new Uint8Array([1, 2]), 'x.bin')

        const response = await fetch('https://example.com/upload', {
            method: 'post',
            body: form,
            headers: { 'X-Test': '1' },
        })
        const [url, method, headers, body] = fetches.at(-1)! as [
            string,
            string,
            [string, string][],
            string,
        ]

        expect([url, method]).toEqual(['https://example.com/upload', 'POST'])
        expect(headers[0]).toEqual(['x-test', '1'])
        expect(headers[1]![1]).toMatch(/^multipart\/form-data; boundary=/)
        expect(atob(body)).toContain(
            'name="file"; filename="x.bin"\r\nContent-Type: application/octet-stream\r\n\r\n\x01\x02\r\n',
        )
        expect(response.ok).toBe(true)
        expect(response.headers.get('Content-Type')).toBe('application/json')
        expect(await response.json()).toEqual({ ok: true })
    })

    test('rejects with the abort reason', async () => {
        const controller = new AbortController()
        controller.abort()
        await expect(
            fetch('https://example.com', { signal: controller.signal }),
        ).rejects.toMatchObject({ name: 'AbortError' })
    })
})

describe('Discord HTTP', () => {
    const frames = globalThis.__valencedPhoenixFrames!
    const empty = new ByteWriter().u16(4).raw(new Uint8Array(14)).toBytes()

    const strings = (writer: ByteWriter, values: string[]) => {
        writer.u8(7).i32(values.length)
        for (const value of values) {
            const utf8 = encodeUtf8(value)
            writer.u8(6).i32(utf8.length).raw(utf8)
        }
        return writer
    }

    function guest(id: number, method: string, url: string, body = '') {
        const struct = new ByteWriter().u8(8).i32(4).varint(161).u8(3).i32(id)
        for (const [key, value] of [
            [165, method],
            [166, url],
        ] as const) {
            const utf8 = encodeUtf8(value)
            struct.varint(key).u8(6).i32(utf8.length).raw(utf8)
        }
        struct.varint(167).u8(7).i32(2)
        strings(struct, ['authorization', 'secret'])
        strings(struct, ['user-agent', 'test'])
        const bytes = struct.toBytes()
        return new ByteWriter()
            .u16(1)
            .u16(0x2b)
            .u32(0xa8)
            .u32(7)
            .u32(bytes.length)
            .raw(bytes)
            .raw(encodeUtf8(body))
            .toBytes()
    }

    function reply(id: number, status: number, body: string) {
        const struct = new ByteWriter()
            .u8(8)
            .i32(2)
            .varint(161)
            .u8(3)
            .i32(id)
            .varint(174)
            .u8(3)
            .i32(status)
            .toBytes()
        const event = new ByteWriter()
            .u32(3)
            .u32(0x141)
            .u32(0)
            .u32(struct.length)
            .raw(struct)
            .raw(encodeUtf8(body))
            .toBytes()
        return new ByteWriter()
            .raw(empty)
            .u32(event.length)
            .raw(event)
            .toBytes()
    }

    const read = (frame: Uint8Array) => {
        const reader = new ByteReader(frame)
        reader.raw(12)
        const length = reader.u32()
        return {
            id: new DataView(frame.buffer, frame.byteOffset).getInt32(24, true),
            struct: decodeUtf8(frame.subarray(16, 16 + length)),
            body: decodeUtf8(frame.subarray(16 + length)),
        }
    }

    test('sends plugin requests with the headers Phoenix sends and takes their replies', async () => {
        const response = request({
            method: 'POST',
            url: 'https://discord.com/api/v9/channels/1/messages',
            headers: {
                'content-type': 'application/json',
                Authorization: 'plugin',
            },
            body: '{"content":"x"}',
        })
        expect(
            frames.onInvoke!(
                guest(1, 'GET', 'https://discord.com/api/v9/users/@me'),
            ),
        ).toBeUndefined()
        await new Promise(resolve => setTimeout(resolve))

        const sent = read(
            invokes.find(frame =>
                decodeUtf8(frame).includes('/channels/1/messages'),
            )!,
        )
        expect(sent.struct).toContain('secret')
        expect(sent.struct).toContain('content-type')
        expect(sent.struct).not.toContain('plugin')
        expect(sent.body).toBe('{"content":"x"}')

        expect(
            frames.onDispatch!(0, reply(sent.id, 200, '{"id":"9"}')),
        ).toEqual(empty)
        const { status, body } = await response
        expect([status, decodeUtf8(body)]).toEqual([200, '{"id":"9"}'])
    })

    test('runs compat patches on Phoenix requests', async () => {
        await start(
            'test.http',
            rnPlugin(`{
                start({ cleanup }) {
                    const { getModules, filters } = valenced.modules.finders
                    getModules(filters.withProps('sendMessage', 'receiveMessage'), m =>
                        cleanup(valenced.patcher.before(m, 'sendMessage', a => { a[1].content = a[1].content.toUpperCase(); return a })))
                    getModules(filters.withProps('HTTP', 'get'), ({ HTTP }) =>
                        cleanup(valenced.patcher.instead(HTTP, 'get', (a, orig) =>
                            a[0].url.startsWith('/gifs/') ? Promise.resolve({ body: [a[0].query.q] }) : orig(...a))))
                    cleanup(valenced.discord.flux.onFluxEventDispatched('TYPING_START_LOCAL', () => undefined))
                },
            }`),
        )

        const sent = frames.onInvoke!(
            guest(
                2,
                'POST',
                'https://discord.com/api/v9/channels/5/messages',
                '{"content":"hi","nonce":"1"}',
            ),
        ) as Uint8Array
        const gifs = frames.onInvoke!(
            guest(3, 'GET', 'https://discord.com/api/v9/gifs/search?q=cat+dog'),
        )
        const typing = frames.onInvoke!(
            guest(4, 'POST', 'https://discord.com/api/v9/channels/5/typing'),
        )
        const passed = frames.onInvoke!(
            guest(5, 'GET', 'https://discord.com/api/v9/users/@me?x=1'),
        ) as Uint8Array
        await new Promise(resolve => setTimeout(resolve))
        const replies = decodeUtf8(frames.onDispatch!(0, empty) as Uint8Array)
        await stop('test.http')

        expect(read(sent).body).toBe('{"content":"HI","nonce":"1"}')
        expect([gifs, typing]).toEqual([false, false])
        expect(replies).toContain('["cat dog"]')
        expect(read(passed).struct).toContain('/users/@me?x=1')
        expect(failures('test.http')).toEqual([])
    })

    test('keeps the token from plugins', () => {
        const seen: object[] = []
        const off = onRequest(request => {
            seen.push(request)
        })
        frames.onInvoke!(
            guest(5, 'GET', 'https://discord.com/api/v9/users/@me'),
        )
        off()
        expect(Object.keys(seen[0]!)).toEqual(['id', 'method', 'url', 'body'])

        expect(mayCarryToken(encodeUtf8('{"token":"secret"}'))).toBe(true)
        expect(mayCarryToken(encodeUtf8('{"token":"other"}'))).toBe(false)

        const watched: unknown[] = []
        watch(6, response => watched.push(response))
        frames.onDispatch!(0, reply(6, 200, '{"token":"secret"}'))
        expect(watched).toEqual([])
    })

    test('URLSearchParams encodes and parses forms', () => {
        const params = new URLSearchParams({ q: 'a b', key: 'x&y' })
        params.append('q', 'c')
        expect(params.toString()).toBe('q=a+b&key=x%26y&q=c')
        expect(new URLSearchParams('?q=a+b&k=1').getAll('q')).toEqual(['a b'])
    })
})

const root =
    process.env.VALENCED_COMMUNITY_PLUGINS ??
    resolve(
        import.meta.dirname,
        '../../../../../valenced-community-plugins/plugins',
    )
const builds = existsSync(root)
    ? readdirSync(root).filter(dir =>
          existsSync(join(root, dir, 'build/js/index.js')),
      )
    : []
const script = (dir: string) =>
    readFileSync(join(root, dir, 'build/js/index.js'), 'utf8')

const knownFailures: Record<string, string> = {
    // stop calls a function only its React patch assigns
    'better-chat-buttons': 'o is not a function',
}

describe.skipIf(!builds.length)(
    `community plugins in ${root} (set VALENCED_COMMUNITY_PLUGINS, skipped when absent)`,
    () => {
        test.each(builds)('%s evals, starts and stops', async dir => {
            await start(dir, script(dir))
            await stop(dir)
            if (dir in knownFailures) {
                expect(failures(dir)).toHaveLength(1)
                expect(failures(dir)[0]).toContain(knownFailures[dir])
            } else expect(failures(dir)).toEqual([])
        })

        test('clear-urls strips tracking parameters from new messages', async () => {
            await start('clear-urls', script('clear-urls'))
            const message = gateway('MESSAGE_CREATE', {
                id: '1',
                channel_id: 'c',
                content: 'https://example.com/?utm_source=x&page=2',
            })
            await stop('clear-urls')

            expect(JSON.parse(message as string).content).toBe(
                'https://example.com/?page=2',
            )
        })

        test.each(['message-logger', 'no-delete'])(
            '%s keeps deleted messages',
            async dir => {
                await start(dir, script(dir))
                gateway('MESSAGE_CREATE', {
                    id: '1',
                    channel_id: 'c',
                    content: 'hi',
                    flags: 0,
                    author: { id: 'u' },
                })
                const deleted = gateway('MESSAGE_DELETE', {
                    id: '1',
                    channel_id: 'c',
                })
                const unknown = gateway('MESSAGE_DELETE', {
                    id: '2',
                    channel_id: 'c',
                })
                await stop(dir)

                expect([deleted, unknown]).toEqual([
                    false,
                    '{"id":"2","channel_id":"c"}',
                ])
                expect(failures(dir)).toEqual([])
            },
        )
    },
)

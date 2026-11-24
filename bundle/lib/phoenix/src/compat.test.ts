import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

const { jsMethods, logs, files, fetches } = vi.hoisted(() => {
    const jsMethods = new Map<string, (...args: any[]) => any>()
    const logs: string[] = []
    const files = new Map<string, string>()
    const fetches: unknown[][] = []

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

    return { jsMethods, logs, files, fetches }
})

vi.mock('@valenced/modules/native', async importOriginal => ({
    ...(await importOriginal<object>()),
    registerJSMethod: (name: string, method: (...args: any[]) => any) =>
        jsMethods.set(name, method),
}))

import { AbortController, FormData, fetch } from './fetch'
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
                    onFluxEventDispatched('TYPING_START_LOCAL', () => {})
                    valenced.discord.common.flux.Dispatcher.subscribe('CONNECTION_OPEN', p => { globalThis.user = Stores.UserStore.getCurrentUser().id + p.sessionId })
                },
            }`),
        )

        const results = [
            gateway('READY', {
                session_id: 's',
                user: { id: 'me' },
                guilds: [],
            }),
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
            'mes',
            '{"id":"1","channel_id":"c","content":"a!","author":{"id":"u"}}',
            false,
            false,
            '{"id":"2","channel_id":"c"}',
            '{"ids":["2"],"channel_id":"c"}',
        ])
        expect(logs.join(' ')).toContain(
            'onFluxEventDispatched("TYPING_START_LOCAL")',
        )
        expect(globalThis.__valencedPhoenixGateway!.onEvent).toBeUndefined()
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
    // JSON.parse of an inert native call in preInit
    'api.themes': 'SyntaxError',
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

import * as jsonStorage from '@valenced/json-storage'
import {
    callNativeMethod,
    callNativeMethodSync,
} from '@valenced/modules/native'
import * as patcher from '@valenced/patcher'
import { after, before, instead } from '@valenced/patcher'
import { noop } from '@valenced/utils/callback'
import { attachHttp, httpShims } from './compat-http'
import { AbortController, FormData, fetch, URLSearchParams } from './fetch'
import {
    addFluxListener,
    addFluxPatch,
    attachFlux,
    dispatchFlux,
    isFluxEventSupported,
    removeFluxListener,
    stores,
} from './flux'
import type { JsonStorage, JsonStorageOptions } from '@valenced/json-storage'
import type { FluxPatch, FluxPayload } from './flux'
import type { PhoenixPluginOptions, PhoenixPluginScope } from './types'

type Lifecycle = (this: unknown, api: unknown) => unknown

interface CompatOptions {
    preInit?: Lifecycle
    init?: Lifecycle
    start?: Lifecycle
    stop?: Lifecycle
    SettingsComponent?: unknown
    jsonStorage?: JsonStorageOptions & { file?: string }
}

const inertPaths = new WeakMap<object, string>()
export function evalCompatPlugin(
    script: string,
    scope: PhoenixPluginScope,
    stop: () => Promise<unknown>,
): PhoenixPluginOptions {
    const { id } = scope.plugin
    const used = new Set<string>()
    let started = false
    const publish = () =>
        callNativeMethod(
            'valenced.phoenix.compatUnsupported' as never,
            [id, [...used]] as never,
        )

    const report = (api: string) => {
        if (used.has(api) || api.startsWith('valenced.modules.finders.filters'))
            return
        used.add(api)
        if (!started) return
        scope.logger.warn(`Unsupported in Phoenix: ${api}`)
        publish()
    }

    const describe = (value: unknown) =>
        typeof value === 'string'
            ? JSON.stringify(value)
            : (inertPaths.get(value as object) ?? typeof value)

    const cache = new Map<string, any>()
    const inert = (
        path: string,
        overrides: Record<PropertyKey, any> = {},
    ): any => {
        if (cache.has(path)) return cache.get(path)

        const call = (args: unknown[]) => {
            if (!path.includes('(')) report(path)
            return inert(`${path}(${args.map(describe).join(', ')})`)
        }
        // biome-ignore lint/complexity/useArrowFunction: arrows are not constructible
        const proxy = new Proxy(function () {}, {
            get: (_, key) => {
                if (Object.hasOwn(overrides, key)) return overrides[key]
                if (key === Symbol.iterator) return function* () {}
                if (key === Symbol.toPrimitive)
                    return (hint: string) => (hint === 'number' ? 0 : '')
                if (key === 'then' || typeof key === 'symbol') return
                return inert(`${path}.${key}`)
            },
            set: (_, key, value) => {
                if (Object.hasOwn(overrides, key)) overrides[key] = value
                return true
            },
            apply: (_, __, args) => call(args),
            construct: (_, args) => call(args),
        })
        inertPaths.set(proxy, path)
        if (!path.includes('(')) cache.set(path, proxy)
        return proxy
    }

    const finder =
        (path: string, result: unknown) =>
        (filter: unknown, callback?: unknown) => {
            const key = /\.with(?:Props|Name)\("([^"]+)"/.exec(
                describe(filter),
            )?.[1]
            if (key && Object.hasOwn(httpShims, key)) {
                if (typeof callback === 'function') callback(httpShims[key])
                return Array.isArray(result) ? [httpShims[key]] : noop
            }
            report(
                `${path}(${describe(filter).replace('valenced.modules.finders.filters.', '')})`,
            )
            return result
        }

    const self = {
        manifest: scope.plugin.manifest,
        lifecycles: {} as CompatOptions,
        startedLate: false,
        errors: [] as unknown[],
        reportError: (error: unknown) => {
            self.errors.push(error)
            scope.plugin.reportError(error)
        },
        SettingsComponent: undefined as unknown,
        api: undefined as unknown,
        stop,
        disable: async () => {
            await callNativeMethod(
                'valenced.plugins.setEnabled' as never,
                [id, false, false] as never,
            )
            await stop()
        },
        requireReload: () => report('plugin.requireReload'),
    }

    const subscribe = (
        api: string,
        type: string,
        add: () => () => void,
    ): (() => void) => {
        if (!isFluxEventSupported(type)) {
            report(`${api}(${JSON.stringify(type)})`)
            return noop
        }
        const off = add()
        scope.cleanup(off)
        return off
    }

    const Stores = inert(
        'valenced.discord.flux.Stores',
        Object.fromEntries(
            Object.entries(stores).map(([name, store]) => [
                name,
                inert(`valenced.discord.flux.Stores.${name}`, store),
            ]),
        ),
    )

    const valenced = inert('valenced', {
        patcher: {
            ...patcher,
            ...Object.fromEntries(
                Object.entries({ before, after, instead }).map(
                    ([name, hook]) => [
                        name,
                        (parent: any, key: PropertyKey, ...rest: any[]) => {
                            if (inertPaths.has(parent?.[key])) {
                                report(
                                    `valenced.patcher.${name}(${inertPaths.get(parent[key])})`,
                                )
                                return noop
                            }
                            return (hook as (...args: any[]) => unknown)(
                                parent,
                                key,
                                ...rest,
                            )
                        },
                    ],
                ),
            ),
        },
        jsonStorage,
        modules: inert('valenced.modules', {
            // Native plugin parts load in Phoenix too, so their methods are real
            native: inert('valenced.modules.native', {
                callNativeMethodSync: (name: string, args: unknown[] = []) => {
                    try {
                        return callNativeMethodSync(
                            name as never,
                            args as never,
                        )
                    } catch {
                        report(
                            `valenced.modules.native.callNativeMethodSync(${JSON.stringify(name)})`,
                        )
                        return inert(
                            `valenced.modules.native.callNativeMethodSync(${JSON.stringify(name)})`,
                        )
                    }
                },
                callNativeMethod: (name: string, args: unknown[] = []) =>
                    callNativeMethod(name as never, args as never).catch(() => {
                        report(
                            `valenced.modules.native.callNativeMethod(${JSON.stringify(name)})`,
                        )
                        return inert(
                            `valenced.modules.native.callNativeMethod(${JSON.stringify(name)})`,
                        )
                    }),
            }),
            finders: inert('valenced.modules.finders', {
                getModules: finder('valenced.modules.finders.getModules', noop),
                waitForModules: finder(
                    'valenced.modules.finders.waitForModules',
                    noop,
                ),
                lookupModule: finder('valenced.modules.finders.lookupModule', [
                    undefined,
                ]),
                lookupModules: finder(
                    'valenced.modules.finders.lookupModules',
                    [],
                ),
            }),
        }),
        discord: inert('valenced.discord', {
            flux: inert('valenced.discord.flux', {
                Stores,
                getStore: (
                    name: string,
                    callback: (store: unknown) => void,
                ) => {
                    if (name in stores) callback(Stores[name])
                    else report(`valenced.discord.flux.getStore("${name}")`)
                    return noop
                },
                onFluxEventDispatched: (type: string, patch: FluxPatch) =>
                    subscribe(
                        'valenced.discord.flux.onFluxEventDispatched',
                        type,
                        () => addFluxPatch(type, patch, self.reportError),
                    ),
                onAnyFluxEventDispatched: (patch: FluxPatch) => {
                    const off = addFluxPatch(undefined, patch, self.reportError)
                    scope.cleanup(off)
                    return off
                },
            }),
            common: inert('valenced.discord.common', {
                flux: inert('valenced.discord.common.flux', {
                    Dispatcher: inert(
                        'valenced.discord.common.flux.Dispatcher',
                        {
                            subscribe: (
                                type: string,
                                listener: (payload: FluxPayload) => unknown,
                            ) => {
                                subscribe(
                                    'valenced.discord.common.flux.Dispatcher.subscribe',
                                    type,
                                    () =>
                                        addFluxListener(
                                            type,
                                            listener,
                                            self.reportError,
                                        ),
                                )
                            },
                            unsubscribe: (
                                type: string,
                                listener: (payload: FluxPayload) => unknown,
                            ) => removeFluxListener(type, listener),
                            dispatch: (payload?: FluxPayload) => {
                                const sent = payload && dispatchFlux(payload)
                                if (sent) return sent.catch(self.reportError)
                                report(
                                    `valenced.discord.common.flux.Dispatcher.dispatch(${JSON.stringify(payload?.type)})`,
                                )
                                return Promise.resolve()
                            },
                        },
                    ),
                }),
            }),
            utils: inert('valenced.discord.utils', {
                modules: inert('valenced.discord.utils.modules', {
                    finders: inert('valenced.discord.utils.modules.finders', {
                        getModuleWithImportedPath: finder(
                            'valenced.discord.utils.modules.finders.getModuleWithImportedPath',
                            noop,
                        ),
                        waitForModuleWithImportedPath: finder(
                            'valenced.discord.utils.modules.finders.waitForModuleWithImportedPath',
                            noop,
                        ),
                        lookupModuleWithImportedPath: finder(
                            'valenced.discord.utils.modules.finders.lookupModuleWithImportedPath',
                            [undefined],
                        ),
                    }),
                }),
            }),
        }),
    })

    const options = new Function(
        'valenced',
        'plugin',
        'fetch',
        'FormData',
        'AbortController',
        'URLSearchParams',
        'crypto',
        `return ${script}\n//# sourceURL=Valenced:PhoenixCompatPlugin:${id}`,
    )(
        valenced,
        (options: CompatOptions) => options,
        fetch,
        FormData,
        AbortController,
        URLSearchParams,
        {
            getRandomValues: (array: Uint8Array) => {
                for (let i = 0; i < array.length; i++)
                    array[i] = Math.floor(Math.random() * 256)
                return array
            },
        },
    )?.default as CompatOptions | undefined

    if (!options || typeof options !== 'object')
        throw new Error('Plugin options must be an object')
    for (const key of ['preInit', 'init', 'start', 'stop'] as const)
        if (options[key] !== undefined && typeof options[key] !== 'function')
            throw new Error(
                `${key} must be a function, got ${typeof options[key]}`,
            )

    const format = (args: unknown[]) =>
        args
            .map(arg => (arg instanceof Error ? arg.stack : String(arg)))
            .join(' ')

    let storage: JsonStorage<Record<string, unknown>> | undefined
    const api = inert('api', {
        cleanup: (...callbacks: unknown[]) =>
            scope.cleanup(
                ...(callbacks.filter(
                    callback => typeof callback === 'function',
                ) as Array<() => unknown>),
            ),
        decorate: () => report('decorate'),
        plugin: self,
        settings: scope.settings,
        unscoped: valenced,
        logger: inert('logger', {
            log: (...args: unknown[]) => scope.logger.log(format(args)),
            info: (...args: unknown[]) => scope.logger.log(format(args)),
            verbose: (...args: unknown[]) => scope.logger.log(format(args)),
            warn: (...args: unknown[]) => scope.logger.warn(format(args)),
            error: (...args: unknown[]) => scope.logger.error(format(args)),
        }),
        get jsonStorage() {
            if (!storage) {
                storage = jsonStorage.getJsonStorage(
                    jsonStorage.pluginStoragePathFor(
                        id,
                        options.jsonStorage?.file,
                    ),
                    { ...options.jsonStorage, load: false },
                )
                storage.use = () => storage!.cache
            }
            return storage
        },
    })

    self.lifecycles = options
    self.SettingsComponent = options.SettingsComponent
    self.api = api

    return {
        start: async () => {
            scope.cleanup(attachFlux(), attachHttp())
            try {
                if (options.jsonStorage?.load) await api.jsonStorage.get()
                for (const lifecycle of [
                    options.preInit,
                    options.init,
                    options.start,
                ])
                    await lifecycle?.call(self, api)
            } finally {
                started = true
                if (used.size) {
                    scope.logger.warn(
                        `Unsupported in Phoenix: ${[...used].join(', ')}`,
                    )
                    publish()
                }
            }
        },
        stop: () => options.stop?.call(self, api),
    }
}

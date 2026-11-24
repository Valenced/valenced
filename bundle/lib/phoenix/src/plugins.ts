import {
    callNativeMethod,
    callNativeMethodSync,
    registerJSMethod,
} from '@valenced/modules/native'
import * as gateway from './gateway'
import * as phoenix from './index'
import type { PhoenixPluginOptions, PhoenixPluginScope } from './types'

interface NativePlugin {
    manifest: { id: string }
    script?: string | null
    essential?: boolean
    enabledByDefault?: boolean
}

interface RuntimeState {
    id: string
    plugins: Record<string, { enabled?: boolean }>
}

interface RunningPlugin {
    options: PhoenixPluginOptions
    scope: PhoenixPluginScope
    cleanups: Array<() => unknown>
}

const plugins = new Map<string, NativePlugin>()
const running = new Map<string, RunningPlugin>()
const settingListeners = new Map<string, Set<(value: unknown) => void>>()
const settingValues = new Map<string, Record<string, unknown>>()
let runtimeSlotId: string | undefined

const phoenixApi = { ...phoenix, ...gateway }

/** Starts enabled plugins with a `dist.phoenix` artifact from the native registry. */
export async function startExternalPhoenixPlugins() {
    registerJSMethod('valenced.plugins.stopping', stopPlugin)
    registerJSMethod('valenced.plugins.states.update', onStateUpdate)
    registerJSMethod('valenced.plugins.settings.update', onSettingUpdate)
    registerJSMethod(
        'valenced.plugins.events.pluginInstallResult',
        onInstallResult,
    )

    await refreshPlugins()
}

async function refreshPlugins() {
    const descriptors = callPluginSystem<NativePlugin[]>(
        'valenced.plugins.list',
    )
    const runtime = callPluginSystem<RuntimeState>(
        'valenced.plugins.states.getRuntime',
    )

    plugins.clear()
    runtimeSlotId = runtime.id
    for (const descriptor of descriptors) {
        plugins.set(descriptor.manifest.id, descriptor)
        const state = runtime.plugins[descriptor.manifest.id]
        const enabled =
            state?.enabled ??
            (descriptor.essential === true ||
                descriptor.enabledByDefault === true)
        if (enabled && descriptor.script) await startPlugin(descriptor)
    }
}

async function startPlugin(plugin: NativePlugin) {
    const id = plugin.manifest.id
    if (running.has(id) || !plugin.script) return

    const cleanups: Array<() => unknown> = []
    const settings = callPluginSystem<Record<string, unknown>>(
        'valenced.plugins.settings.read',
        [id],
    )
    settingValues.set(id, settings)
    const scope: PhoenixPluginScope = {
        cleanup: (...callbacks) => {
            for (const callback of callbacks) {
                if (typeof callback !== 'function')
                    throw new TypeError('cleanup expects functions')
                cleanups.push(callback)
            }
        },
        logger: {
            log: message => nativeLoggingHook(`[${id}] ${String(message)}`, 1),
            warn: message => nativeLoggingHook(`[${id}] ${String(message)}`, 2),
            error: message =>
                nativeLoggingHook(`[${id}] ${String(message)}`, 3),
        },
        phoenix: phoenixApi,
        callNativeMethod: (name, args = []) =>
            callNativeMethodSync(name as never, args as never),
        settings: {
            get: <T = unknown>(key: string): T => {
                const values = settingValues.get(id) ?? settings
                if (!(key in values))
                    throw new Error(`Unknown plugin setting: ${key}`)
                return values[key] as T
            },
            set: async (key, value) => {
                const response = (await callNativeMethod(
                    'valenced.plugins.settings.write' as never,
                    [id, key, value] as never,
                )) as unknown as PluginSystemResponse<null>
                if (response.error) throw new Error(response.error.message)
            },
            subscribe: (key, listener) => {
                if (!(key in settings))
                    throw new Error(`Unknown plugin setting: ${key}`)
                const eventKey = `${id}\0${key}`
                let listeners = settingListeners.get(eventKey)
                if (!listeners)
                    settingListeners.set(eventKey, (listeners = new Set()))
                listeners.add(listener)
                const unsubscribe = () => {
                    listeners!.delete(listener)
                    if (!listeners!.size) settingListeners.delete(eventKey)
                }
                cleanups.push(unsubscribe)
                return unsubscribe
            },
        },
        plugin: {
            id,
            manifest: plugin.manifest,
            reportError: error => reportError(id, error),
        },
    }

    try {
        const module = new Function(
            'valenced',
            'plugin',
            `return ${plugin.script}\n//# sourceURL=Valenced:PhoenixPlugin:${id}`,
        )(
            {
                ...phoenixApi,
                phoenix: phoenixApi,
                callNativeMethod: scope.callNativeMethod,
                callNativeMethodSync: scope.callNativeMethod,
            },
            (options: PhoenixPluginOptions) => options,
        ) as { default?: PhoenixPluginOptions } | undefined

        const options = module?.default
        if (!options || typeof options !== 'object')
            throw new Error(
                'Phoenix plugin bundle must return an options object as default',
            )
        if (options.start !== undefined && typeof options.start !== 'function')
            throw new Error('Phoenix plugin start must be a function')
        if (options.stop !== undefined && typeof options.stop !== 'function')
            throw new Error('Phoenix plugin stop must be a function')

        const entry = { options, scope, cleanups }
        running.set(id, entry)
        await options.start?.(scope)
        nativeLoggingHook(`Started Phoenix plugin: ${id}`, 1)
    } catch (error) {
        await runCleanups(cleanups, id)
        running.delete(id)
        reportError(id, error)
    }
}

async function stopPlugin(id: string) {
    const entry = running.get(id)
    if (!entry) return null

    running.delete(id)
    try {
        await entry.options.stop?.(entry.scope)
    } catch (error) {
        reportError(id, error)
    }
    await runCleanups(entry.cleanups, id)
    return null
}

async function runCleanups(cleanups: Array<() => unknown>, id: string) {
    for (const cleanup of cleanups.reverse()) {
        try {
            await cleanup()
        } catch (error) {
            reportError(id, error)
        }
    }
}

async function onStateUpdate(
    slotId: string,
    id: string,
    flags: { enabled?: boolean },
) {
    if (slotId !== runtimeSlotId) return null

    if (flags.enabled) {
        const plugin = plugins.get(id)
        if (plugin?.script) await startPlugin(plugin)
    } else {
        await stopPlugin(id)
    }
    return null
}

function onSettingUpdate(id: string, key: string, value: unknown) {
    const values = settingValues.get(id)
    if (values) values[key] = value
    for (const listener of settingListeners.get(`${id}\0${key}`) ?? []) {
        try {
            listener(value)
        } catch (error) {
            reportError(id, error)
        }
    }
}

async function onInstallResult(result: {
    error?: boolean
    plugin?: NativePlugin
}) {
    if (result.error === false && result.plugin) {
        plugins.set(result.plugin.manifest.id, result.plugin)
        const runtime = callPluginSystem<RuntimeState>(
            'valenced.plugins.states.getRuntime',
        )
        runtimeSlotId = runtime.id
        const id = result.plugin.manifest.id
        if (runtime.plugins[id]?.enabled && result.plugin.script)
            await startPlugin(result.plugin)
    }
    return null
}

interface PluginSystemResponse<T> {
    result?: T
    error?: { message: string }
}

function callPluginSystem<T>(name: string, args: unknown[] = []) {
    const response = callNativeMethodSync(
        name as never,
        args as never,
    ) as unknown as PluginSystemResponse<T>
    if (response.error) throw new Error(response.error.message)
    return response.result as T
}

function reportError(id: string, error: unknown) {
    nativeLoggingHook(
        `Phoenix plugin "${id}" failed: ${error instanceof Error ? error.stack : String(error)}`,
        2,
    )
}

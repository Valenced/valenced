import { registerJSMethod } from '@valenced/modules/native'
import { callPluginSystemMethod, callPluginSystemMethodSync } from './native'
import type { PluginSettingValue, PluginValueSettingsApi } from '../types'

const listeners = new Map<
    string,
    Map<string, Set<(value: PluginSettingValue) => void>>
>()

registerJSMethod(
    'valenced.plugins.settings.update',
    (pluginId: string, key: string, value: PluginSettingValue) => {
        for (const listener of listeners.get(pluginId)?.get(key) ?? [])
            listener(value)
        return null
    },
)

export function createPluginSettingsApi(
    pluginId: string,
): PluginValueSettingsApi {
    return {
        get<T extends PluginSettingValue>(key: string): T {
            const values = callPluginSystemMethodSync(
                'valenced.plugins.settings.read',
                [pluginId],
            )
            let value: unknown = values
            for (const part of key.split('.')) {
                if (
                    !value ||
                    typeof value !== 'object' ||
                    Array.isArray(value) ||
                    !(part in value)
                )
                    throw new Error(
                        `Unknown setting "${key}" for "${pluginId}"`,
                    )
                value = (value as Record<string, unknown>)[part]
            }
            return value as T
        },
        async set(key, value) {
            await callPluginSystemMethod('valenced.plugins.settings.write', [
                pluginId,
                key,
                value,
            ])
        },
        subscribe(key, listener) {
            let pluginListeners = listeners.get(pluginId)
            if (!pluginListeners) {
                pluginListeners = new Map()
                listeners.set(pluginId, pluginListeners)
            }
            let settingListeners = pluginListeners.get(key)
            if (!settingListeners) {
                settingListeners = new Set()
                pluginListeners.set(key, settingListeners)
            }
            const subscriber = listener as (value: PluginSettingValue) => void
            settingListeners.add(subscriber)
            return () => {
                settingListeners!.delete(subscriber)
                if (settingListeners!.size === 0) pluginListeners!.delete(key)
                if (pluginListeners!.size === 0) listeners.delete(pluginId)
            }
        },
    }
}

export async function clearPluginSettings(pluginId: string): Promise<void> {
    await callPluginSystemMethod('valenced.plugins.settings.clear', [pluginId])
}

declare module '@valenced/modules/native' {
    export interface NativeMethods {
        'valenced.plugins.settings.read': [
            [pluginId: string],
            Record<string, PluginSettingValue>,
        ]
        'valenced.plugins.settings.write': [
            [pluginId: string, key: string, value: PluginSettingValue],
            null,
        ]
        'valenced.plugins.settings.clear': [[pluginId: string], null]
    }
}

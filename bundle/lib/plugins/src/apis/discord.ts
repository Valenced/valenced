import defer * as DiscordActions from '@valenced/discord/actions'
import defer * as DiscordCommonConstants from '@valenced/discord/common/constants'
import defer * as DiscordCommonFlux from '@valenced/discord/common/flux'
import defer * as DiscordCommonLogger from '@valenced/discord/common/logger'
import defer * as DiscordCommonTokens from '@valenced/discord/common/tokens'
import defer * as DiscordDesign from '@valenced/discord/design'
import defer * as DiscordFlux from '@valenced/discord/flux'
import defer * as DiscordModulesMainTabsV2 from '@valenced/discord/modules/main_tabs_v2'
import defer * as DiscordNative from '@valenced/discord/native'
import defer * as DiscordUtilsFinders from '@valenced/discord/utils/modules/finders'
import defer * as DiscordUtilsMetroSubscriptions from '@valenced/discord/utils/modules/metro/subscriptions'
import { defineLazyProperties } from '@valenced/utils/object'
import { withResolvedReads } from '@valenced/utils/proxy'
import { guardIndexInitialized } from '.'

export interface PreInitPluginApiDiscord {
    actions: PluginApiDiscord.Actions
    common: PreInitPluginApiDiscordCommon
    design: PluginApiDiscord.Design
    flux: PluginApiDiscord.Flux
    modules: PluginApiDiscord.Modules
    native: PluginApiDiscord.Native
    utils: PluginApiDiscord.Utils
}

export interface InitPluginApiDiscord extends PreInitPluginApiDiscord {
    common: InitPluginApiDiscordCommon
}

interface PreInitPluginApiDiscordCommon {
    appStartPerformance: typeof import('@valenced/discord/common/app-start-performance')
    importTracker: typeof import('@valenced/discord/common/import-tracker')
    utils: typeof import('@valenced/discord/common/utils')
    /** This API is available in and after the `init` phase. */
    constants: unknown
    /** This API is available in and after the `init` phase. */
    flux: unknown
    /** This API is available in and after the `init` phase. */
    logger: unknown
    /** This API is available in and after the `init` phase. */
    tokens: unknown
}

interface InitPluginApiDiscordCommon extends PreInitPluginApiDiscordCommon {
    constants: typeof import('@valenced/discord/common/constants')
    flux: typeof import('@valenced/discord/common/flux')
    logger: typeof import('@valenced/discord/common/logger')
    tokens: typeof import('@valenced/discord/common/tokens')
}

export type PluginApiDiscord = PreInitPluginApiDiscord | InitPluginApiDiscord

export namespace PluginApiDiscord {
    export type Actions = typeof import('@valenced/discord/actions')
    export type Common =
        | PreInitPluginApiDiscordCommon
        | InitPluginApiDiscordCommon
    export type Design = typeof import('@valenced/discord/design')
    export type Flux = typeof import('@valenced/discord/flux')
    export type Native = typeof import('@valenced/discord/native')

    export interface Utils {
        modules: {
            finders: typeof import('@valenced/discord/utils/modules/finders')
            metro: {
                subscriptions: typeof import('@valenced/discord/utils/modules/metro/subscriptions')
            }
        }
    }

    export interface Modules {
        mainTabsV2: typeof import('@valenced/discord/modules/main_tabs_v2')
        settings: typeof import('@valenced/discord/modules/settings') & {
            renderer: typeof import('@valenced/discord/modules/settings/renderer')
        }
    }
}

export const discord = defineLazyProperties(
    {
        common: defineLazyProperties(
            {
                appStartPerformance: require('@valenced/discord/common/app-start-performance'),
                importTracker: require('@valenced/discord/common/import-tracker'),
                utils: require('@valenced/discord/common/utils'),
            } as InitPluginApiDiscordCommon,
            {
                constants: () => {
                    guardIndexInitialized('Discord.common.constants')
                    return DiscordCommonConstants
                },
                flux: () => {
                    guardIndexInitialized('Discord.common.flux')
                    return DiscordCommonFlux
                },
                logger: () => {
                    guardIndexInitialized('Discord.common.logger')
                    return DiscordCommonLogger
                },
                tokens: () => {
                    guardIndexInitialized('Discord.common.tokens')
                    return DiscordCommonTokens
                },
            },
        ),
        modules: defineLazyProperties({} as PluginApiDiscord.Modules, {
            mainTabsV2: () => {
                return DiscordModulesMainTabsV2
            },
            settings: () => ({
                ...require('@valenced/discord/modules/settings'),
                renderer: require('@valenced/discord/modules/settings/renderer'),
            }),
        }),
        utils: {
            modules: {
                finders: DiscordUtilsFinders,
                metro: {
                    subscriptions: DiscordUtilsMetroSubscriptions,
                },
            },
        },
    } as PluginApiDiscord,
    {
        actions: () => {
            guardIndexInitialized('Discord.actions')
            return withResolvedReads(DiscordActions, {
                ActionSheetActionCreatorsModuleId: 'ActionSheetActionCreators',
                AlertActionCreatorsModuleId: 'AlertActionCreators',
                ToastActionCreatorsModuleId: 'ToastActionCreators',
            })
        },
        flux: () => {
            return DiscordFlux
        },
        design: () => {
            guardIndexInitialized('Discord.design')
            return DiscordDesign
        },
        native: () => {
            return DiscordNative
        },
    },
)

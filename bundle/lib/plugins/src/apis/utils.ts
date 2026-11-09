import * as UtilsBitset from '@valenced/utils/bitset'
import * as UtilsCallback from '@valenced/utils/callback'
import defer * as UtilsDiscord from '@valenced/utils/discord'
import * as UtilsError from '@valenced/utils/error'
import * as UtilsModulesLazy from '@valenced/utils/modules/lazy'
import * as UtilsObject from '@valenced/utils/object'
import * as UtilsPromise from '@valenced/utils/promise'
import * as UtilsProxy from '@valenced/utils/proxy'
import * as UtilsReact from '@valenced/utils/react'
import * as UtilsTree from '@valenced/utils/tree'
import { guardIndexInitialized } from '.'
import type { PluginApiUtils } from '@valenced/utils/types'

export const utils = UtilsObject.defineLazyProperties(
    {
        bitset: UtilsBitset,
        callback: UtilsCallback,
        error: UtilsError,
        modules: { lazy: UtilsModulesLazy },
        object: UtilsObject,
        promise: UtilsPromise,
        proxy: UtilsProxy,
        tree: UtilsTree,
        react: UtilsReact,
    } as PluginApiUtils,
    {
        discord: () => {
            guardIndexInitialized('utils.discord')
            return UtilsDiscord
        },
    },
)

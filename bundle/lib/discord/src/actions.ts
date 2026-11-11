import { lookupModule, lookupModules } from '@valenced/modules/finders'
import {
    anyOf,
    withDependencies,
    withProps,
} from '@valenced/modules/finders/filters'
import { getModuleDependencies } from '@valenced/modules/metro/utils'
import {
    ReactJSXRuntimeModuleId,
    ReactModuleId,
    ReactNativeModuleId,
} from '@valenced/react'
import { proxify } from '@valenced/utils/proxy'
import { DispatcherModuleId } from './common/flux'
import { ImportTrackerModuleId } from './common/import-tracker'
import type { Metro } from '@valenced/modules/types'
import type { DiscordModules } from './types'

const { atMost, relative, ordered } = withDependencies

// Module IDs set by their lookups, unset until the module proxy resolves.
// Plugins read them through `withResolvedReads` in lib/plugins/src/apis/discord.ts.

// modules/action_sheet/native/ActionSheetActionCreators.tsx
export let ActionSheetActionCreatorsModuleId: Metro.ModuleID
export const ActionSheetActionCreators = proxify(
    () => {
        const [module, id] = lookupModule(
            withProps<DiscordModules.Actions.ActionSheetActionCreators>(
                'hideActionSheet',
                'openLazy',
            )
                .and(
                    anyOf(
                        // [?, React, +1, JSXRuntime, +2, +3, ?, Dispatcher, ImportTracker] as of 352202
                        withDependencies(
                            ordered([
                                ReactModuleId,
                                // [?, Dispatcher, ImportTracker]
                                relative.withDependencies(
                                    ordered([
                                        DispatcherModuleId,
                                        ImportTrackerModuleId,
                                    ]),
                                    1,
                                ),
                                ReactJSXRuntimeModuleId,
                                relative(2),
                                relative(3),
                                DispatcherModuleId,
                                ImportTrackerModuleId,
                            ]),
                        ),
                        // TODO: Remove when stable >= 352202
                        withDependencies(
                            ordered([
                                ReactModuleId,
                                ReactJSXRuntimeModuleId,
                                relative.withDependencies(
                                    ordered([
                                        relative(2, true),
                                        relative(3, true),
                                        ImportTrackerModuleId,
                                    ]),
                                    1,
                                ),
                                relative(2),
                            ]),
                        ).and(
                            withDependencies(
                                ordered([
                                    DispatcherModuleId,
                                    ImportTrackerModuleId,
                                ]),
                            ),
                        ),
                    ),
                )
                .keyAs('valenced.discord.actions.ActionSheetActionCreators'),
        )

        if (module) {
            ActionSheetActionCreatorsModuleId = id!
            return module
        }
    },
    {
        hint: {},
    },
) as DiscordModules.Actions.ActionSheetActionCreators

// actions/native/AlertActionCreators.tsx
export let AlertActionCreatorsModuleId: Metro.ModuleID
export const AlertActionCreators = proxify(
    () => {
        const [module, id] = lookupModule(
            withProps<DiscordModules.Actions.AlertActionCreators>('openAlert')
                .and(
                    withDependencies([
                        null,
                        null,
                        [ReactNativeModuleId, ImportTrackerModuleId],
                        relative(1),
                        relative(3),
                        ImportTrackerModuleId,
                    ]),
                )
                .keyAs('valenced.discord.actions.AlertActionCreators'),
        )

        if (module) {
            AlertActionCreatorsModuleId = id!
            return module
        }
    },
    {
        hint: {},
    },
) as DiscordModules.Actions.AlertActionCreators

// modules/toast/native/ToastActionCreators.tsx
export let ToastActionCreatorsModuleId: Metro.ModuleID
export const ToastActionCreators = proxify(
    () => {
        const generator = lookupModules(
            withProps<DiscordModules.Actions.ToastActionCreators>(
                'open',
                'close',
            )
                .and(
                    anyOf(
                        // TODO: Remove atMost and ordered when stable > 350204
                        withDependencies(
                            atMost(
                                3,
                                ordered([
                                    relative.withDependencies(
                                        [ImportTrackerModuleId, relative(1)],
                                        1,
                                    ),
                                    ImportTrackerModuleId,
                                ]),
                            ),
                        ),
                        // TODO: Remove when stable > 350204
                        // [useToastStore (+1), DesignSystemsNotificationComponents, toManaToast, Dispatcher, ImportTracker]
                        withDependencies(
                            ordered([
                                // useToastStore: [ImportTracker, +1]
                                relative.withDependencies(
                                    [ImportTrackerModuleId, relative(1)],
                                    1,
                                ),
                                // toManaToast: [+1, ImportTracker]
                                [relative(1), ImportTrackerModuleId],
                                DispatcherModuleId,
                                ImportTrackerModuleId,
                            ]),
                        ),
                    ),
                )
                .keyAs('valenced.discord.actions.ToastActionCreators'),
        )

        for (const [module, id] of generator)
            if (
                getModuleDependencies(id)![0] === ImportTrackerModuleId
                    ? module.open.length === 1
                    : true
            ) {
                ToastActionCreatorsModuleId = id
                return module
            }
    },
    {
        hint: {},
    },
) as DiscordModules.Actions.ToastActionCreators

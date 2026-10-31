import { ToastActionCreators } from '@valenced/discord/actions'
import { getStore, Stores } from '@valenced/discord/flux'
import { getModules } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import { registerInternalPlugin } from '@valenced/plugins/_'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import manifest from './manifest.json'
import type { DiscordModules } from '@valenced/discord/types'

registerInternalPlugin(manifest, {
    start({ cleanup, logger, plugin }) {
        const CircleInformationIcon = lookupGeneratedIconComponent(
            'CircleInformationIcon',
            'CircleInformationIcon-secondary',
            'CircleInformationIcon-primary',
        )

        const showToast = () =>
            ToastActionCreators.open('VALENCED_STAFF_SETTINGS_ACTION', {
                text: 'Navigate out of Settings to apply changes',
                icon: CircleInformationIcon,
            })

        function reset() {
            getStore<{
                initialize(): void
            }>('DeveloperExperimentStore', store => {
                logger.log(
                    'Reinitializing DeveloperExperimentStore to apply changes...',
                )

                const unpatch = instead(
                    Object,
                    'defineProperties',
                    args => args[0],
                )

                store.initialize()
                unpatch()
            })
        }

        cleanup(
            getModules(withProps('isStaffEnv'), UserStoreUtils => {
                logger.log('Patching UserStoreUtils...')

                cleanup(
                    instead(
                        UserStoreUtils,
                        'isStaffEnv',
                        ([user]) =>
                            user ===
                            (
                                Stores.UserStore as DiscordModules.Flux.Store<{
                                    getCurrentUser(): unknown
                                }>
                            ).getCurrentUser(),
                    ),
                    reset,
                    showToast,
                )

                reset()
                if (plugin.startedLate) showToast()
            }, { max: 1 }),
        )
    },
})

import { ToastActionCreators } from '@valenced/discord/actions'
import { Clipboard } from '@valenced/externals/react-native-clipboard'
import { callNativeMethodSync } from '@valenced/modules/native'
import { ReactNative } from '@valenced/react'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import type { SettingsItem } from '@valenced/discord/modules/settings'

const CopyIcon = lookupGeneratedIconComponent('CopyIcon')

export const CopyableSetting = (
    item: Omit<SettingsItem, 'type' | 'onClick'>,
    description: () => string,
): SettingsItem => ({
    ...item,
    useDescription: item.useDescription ?? (() => description()),
    type: 'pressable',
    onPress() {
        Clipboard.setString(description())
        ToastActionCreators.open('VALENCED_SETTING_COPIED', {
            text: 'Copied to clipboard',
            icon: CopyIcon,
        })
    },
})

export type ClientMode = 'follow' | 'phoenix' | 'rn'

export const ClientLabels: Record<ClientMode, string> = {
    follow: 'Follow Discord',
    phoenix: 'Phoenix',
    rn: 'React Native',
}

export const getClientInfo = () =>
    callNativeMethodSync('valenced.client.info', [])

declare module '@valenced/modules/native' {
    interface NativeMethods {
        'valenced.client.info': [
            [],
            { running: 'phoenix' | 'rn'; mode: ClientMode; framework: string },
        ]
        'valenced.client.setMode': [[ClientMode], null]
    }
}

export const getRNVersion = () => {
    const { major, minor, patch, prerelease } =
        ReactNative.Platform.constants.reactNativeVersion
    return `${major}.${minor}.${patch}${prerelease ? `-${prerelease}` : ''}`
}

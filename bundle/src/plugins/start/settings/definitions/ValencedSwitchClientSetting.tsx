import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Design } from '@valenced/discord/design'
import { callNativeMethodSync } from '@valenced/modules/native'
import { reloadApp } from '@valenced/modules/native/app'
import { ScrollView, View } from 'react-native'
import { RouteNames, Setting } from '../constants'
import { ClientLabels, getClientInfo } from './shared'
import type { SettingsItem } from '@valenced/discord/modules/settings'
import type { ClientMode } from './shared'

const { TableRadioGroup, TableRadioRow } = Design

function SwitchClientScreen() {
    const { mode } = getClientInfo()

    return (
        <ScrollView style={{ flex: 1 }}>
            <View style={{ padding: 16 }}>
                <TableRadioGroup
                    defaultValue={mode}
                    onChange={value => {
                        if (value === mode) return
                        callNativeMethodSync('valenced.client.setMode', [
                            value as ClientMode,
                        ])
                        reloadApp()
                    }}
                >
                    {Object.entries(ClientLabels).map(([value, label]) => (
                        <TableRadioRow
                            key={value}
                            label={label}
                            value={value}
                        />
                    ))}
                </TableRadioGroup>
            </View>
        </ScrollView>
    )
}

const ValencedSwitchClientSetting: SettingsItem = {
    parent: Setting.Valenced,
    type: 'route',
    IconComponent: () => <TableRowAssetIcon name="MobilePhoneIcon" />,
    useTitle: () => 'Switch Client',
    useDescription: () => ClientLabels[getClientInfo().mode],
    screen: {
        route: RouteNames[Setting.ValencedSwitchClient],
        getComponent: () => SwitchClientScreen,
    },
}

export default ValencedSwitchClientSetting

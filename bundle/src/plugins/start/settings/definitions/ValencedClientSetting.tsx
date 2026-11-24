import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Setting } from '../constants'
import { ClientLabels, CopyableSetting, getClientInfo } from './shared'
import type { SettingsItem } from '@valenced/discord/modules/settings'

const ValencedClientSetting: SettingsItem = CopyableSetting(
    {
        parent: Setting.Valenced,
        IconComponent: () => <TableRowAssetIcon name="MobilePhoneIcon" />,
        useTitle: () => 'Client',
    },
    () => ClientLabels[getClientInfo().running],
)

export default ValencedClientSetting

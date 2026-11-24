import { getAssetIdByName } from '@valenced/assets'
import { Design } from '@valenced/discord/design'
import { useSetting } from '@valenced/plugins/_/react'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import type {
    PluginApi,
    PluginSettingDefinition,
    PluginSettingValue,
} from '@valenced/plugins/types'

const {
    IconButton,
    Stack,
    TableRadioGroup,
    TableRadioRow,
    TableRow,
    TableRowGroup,
    TableSwitchRow,
    TextInput,
} = Design

const TrashIcon = getAssetIdByName('TrashIcon', 'png')!

export default function GeneratedPluginSettings({
    api,
}: {
    api: PluginApi<any>
}) {
    const settings = api.plugin.manifest.settings ?? []
    if (!settings.length) return null

    const groups = new Map<string | undefined, PluginSettingDefinition[]>()
    for (const setting of settings) {
        const group = groups.get(setting.section) ?? []
        group.push(setting)
        groups.set(setting.section, group)
    }

    return (
        <Stack spacing={16}>
            {[...groups].flatMap(([section, fields]) => {
                const rows = fields.filter(field => field.type !== 'object')
                return [
                    rows.length > 0 && (
                        <TableRowGroup
                            key={section ?? 'default'}
                            title={section}
                        >
                            {rows.map(setting => (
                                <SettingField
                                    key={setting.key}
                                    api={api}
                                    setting={setting}
                                />
                            ))}
                        </TableRowGroup>
                    ),
                    ...fields
                        .filter(field => field.type === 'object')
                        .map(setting => (
                            <SettingField
                                key={`object:${setting.key}`}
                                api={api}
                                setting={setting}
                            />
                        )),
                ]
            })}
        </Stack>
    )
}

function SettingField({
    api,
    setting,
    parent,
}: {
    api: PluginApi<any>
    setting: PluginSettingDefinition
    parent?: string
}) {
    const key = parent ? `${parent}.${setting.key}` : setting.key
    const condition =
        setting.showIf &&
        (parent ? `${parent}.${setting.showIf.key}` : setting.showIf.key)
    const [value, save] = useSetting(api.settings, key)
    const [conditionValue] = useSetting(api.settings, condition ?? key)

    if (
        setting.showIf &&
        JSON.stringify(conditionValue) !== JSON.stringify(setting.showIf.equals)
    )
        return null

    if (setting.type === 'object')
        return (
            <TableRowGroup
                title={setting.label}
                description={setting.description}
            >
                {setting.settings?.map(child => (
                    <SettingField
                        key={child.key}
                        api={api}
                        setting={child}
                        parent={setting.key}
                    />
                ))}
            </TableRowGroup>
        )

    if (setting.type === 'switch')
        return (
            <TableSwitchRow
                label={setting.label}
                subLabel={setting.description}
                value={value as boolean}
                onValueChange={next => save(next).catch(api.plugin.reportError)}
            />
        )

    if (setting.type === 'select')
        return (
            <TableRadioGroup
                title={setting.label}
                value={value as string}
                onChange={next =>
                    save(String(next)).catch(api.plugin.reportError)
                }
            >
                {setting.options?.map(option => (
                    <TableRadioRow
                        key={option.value}
                        label={option.label}
                        value={option.value}
                    />
                ))}
            </TableRadioGroup>
        )

    if (setting.type === 'list') {
        const items = value as Array<string | number>
        const item = { ...setting, type: setting.item!, description: undefined }
        return (
            <TableRowGroup
                title={setting.label}
                description={setting.description}
            >
                {items.map((entry, index) => (
                    <TextSettingField
                        // biome-ignore lint/suspicious/noArrayIndexKey: List items can repeat and have no IDs
                        key={`${index}:${entry}`}
                        setting={{ ...item, label: String(index + 1) }}
                        value={entry}
                        save={next =>
                            save(
                                items.map((other, at) =>
                                    at === index ? next : other,
                                ) as PluginSettingValue,
                            )
                        }
                        remove={() =>
                            save(
                                items.filter(
                                    (_, at) => at !== index,
                                ) as PluginSettingValue,
                            ).catch(api.plugin.reportError)
                        }
                    />
                ))}
                {(setting.maxItems === undefined ||
                    items.length < setting.maxItems) && (
                    <TextSettingField
                        key={`add:${items.length}`}
                        setting={{ ...item, label: 'Add' }}
                        value=""
                        save={next =>
                            save([...items, next] as PluginSettingValue)
                        }
                    />
                )}
            </TableRowGroup>
        )
    }

    return (
        <TextSettingField
            setting={setting}
            value={value as string | number}
            save={save}
        />
    )
}

function TextSettingField({
    setting,
    value,
    save,
    remove,
}: {
    setting: PluginSettingDefinition
    value: string | number
    save: (value: string | number) => Promise<void>
    remove?: () => void
}) {
    const [draft, setDraft] = useState(String(value))
    useEffect(() => setDraft(String(value)), [value])

    const number = Number(draft)
    const failures: Array<[unknown, string]> =
        setting.type === 'number'
            ? [
                  [
                      !draft.trim() || !Number.isFinite(number),
                      'Must be a number',
                  ],
                  [
                      setting.integer && !Number.isInteger(number),
                      'Must be a whole number',
                  ],
                  [
                      number < (setting.min ?? -Infinity),
                      `Must be at least ${setting.min}`,
                  ],
                  [
                      number > (setting.max ?? Infinity),
                      `Must be at most ${setting.max}`,
                  ],
              ]
            : setting.type === 'color'
              ? [
                    [
                        !/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(draft),
                        'Must be #RRGGBB or #AARRGGBB',
                    ],
                ]
              : [
                    [
                        draft.length < (setting.minLength ?? 0),
                        `Must be at least ${setting.minLength} characters`,
                    ],
                    [
                        draft.length > (setting.maxLength ?? Infinity),
                        `Must be at most ${setting.maxLength} characters`,
                    ],
                    [
                        setting.pattern &&
                            !new RegExp(setting.pattern).test(draft),
                        'Invalid format',
                    ],
                ]
    const error =
        draft === String(value)
            ? undefined
            : failures.find(([failed]) => failed)?.[1]
    const color = String(value)

    return (
        <TableRow
            label={setting.label}
            subLabel={error ?? setting.description}
            icon={
                setting.type === 'color' && (
                    <View
                        style={{
                            width: 24,
                            height: 24,
                            borderRadius: 12,
                            backgroundColor:
                                color.length === 9
                                    ? `#${color.slice(3)}${color.slice(1, 3)}`
                                    : color,
                        }}
                    />
                )
            }
            trailing={
                <Stack direction="horizontal" spacing={8} align="center">
                    <TextInput
                        value={draft}
                        onChange={setDraft}
                        onBlur={() => {
                            if (draft === String(value) || error) return
                            save(
                                setting.type === 'number' ? number : draft,
                            ).catch(() => setDraft(String(value)))
                        }}
                        status={error ? 'error' : 'default'}
                        placeholder={setting.type === 'text' ? '' : undefined}
                        style={{ minWidth: 100 }}
                    />
                    {remove && (
                        <IconButton
                            variant="secondary"
                            size="sm"
                            icon={TrashIcon}
                            onPress={remove}
                        />
                    )}
                </Stack>
            }
        />
    )
}

import { decodeUtf8 } from './bytes'
import { dispatch, on, onSend } from './gateway'
import { request } from './http'

export interface FluxPayload {
    type: string
    [key: string]: any
}

export type FluxPatch = (payload: FluxPayload) => FluxPayload | undefined | void

type OnError = (error: unknown) => void

const fluxEvents: Record<
    string,
    {
        gateway: string
        toFlux(data: any): FluxPayload
        toGateway?(payload: FluxPayload, data: any): unknown
    }
> = {
    MESSAGE_CREATE: {
        gateway: 'MESSAGE_CREATE',
        toFlux: message => ({
            type: 'MESSAGE_CREATE',
            channelId: message.channel_id,
            guildId: message.guild_id,
            message,
            optimistic: false,
            isPushNotification: false,
        }),
        toGateway: payload => payload.message,
    },
    MESSAGE_UPDATE: {
        gateway: 'MESSAGE_UPDATE',
        toFlux: message => ({
            type: 'MESSAGE_UPDATE',
            guildId: message.guild_id,
            message,
        }),
        toGateway: payload => payload.message,
    },
    MESSAGE_DELETE: {
        gateway: 'MESSAGE_DELETE',
        toFlux: data => ({
            type: 'MESSAGE_DELETE',
            id: data.id,
            channelId: data.channel_id,
            guildId: data.guild_id,
        }),
        toGateway: (payload, data) => ({
            ...data,
            id: payload.id,
            channel_id: payload.channelId,
            guild_id: payload.guildId,
        }),
    },
    MESSAGE_DELETE_BULK: {
        gateway: 'MESSAGE_DELETE_BULK',
        toFlux: data => ({
            type: 'MESSAGE_DELETE_BULK',
            ids: data.ids,
            channelId: data.channel_id,
            guildId: data.guild_id,
        }),
        toGateway: (payload, data) => ({
            ...data,
            ids: payload.ids,
            channel_id: payload.channelId,
            guild_id: payload.guildId,
        }),
    },
    // Observe only. Phoenix applies READY outside its gateway handlers.
    CONNECTION_OPEN: {
        gateway: 'READY_SUPPLEMENTAL',
        toFlux: data => ({
            ...data,
            type: 'CONNECTION_OPEN',
            user: currentUser,
        }),
    },
}

const fluxTypes = Object.fromEntries(
    Object.entries(fluxEvents).map(([type, { gateway }]) => [gateway, type]),
)

const anyPatches = new Map<FluxPatch, OnError>()
const patches = new Map<string, Map<FluxPatch, OnError>>()
const listeners = new Map<
    string,
    Map<(payload: FluxPayload) => unknown, OnError>
>()

const MaxMessages = 2000
const messages = new Map<string, any>()
const users = new Map<string, any>()
const channels = new Map<string, any>()
let currentUser: any

let attached = 0
let detach: Array<() => void> = []

// Gateway events in Phoenix's registry, the same in 356207 and 357200
const gatewayEvents = new Set(
    'ACTIVITY_START ACTIVITY_USER_ACTION APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE APPLICATION_COMMAND_PERMISSIONS_UPDATE AUTHENTICATOR_CREATE AUTHENTICATOR_DELETE AUTH_SESSION_CHANGE AUTO_MODERATION_ACTION_EXECUTION AUTO_MODERATION_CONTENT_DELETED AUTO_MODERATION_MENTION_RAID_DETECTION AUTO_MODERATION_RULE_CREATE AUTO_MODERATION_RULE_DELETE AUTO_MODERATION_RULE_UPDATE CALL_CREATE CALL_DELETE CALL_UPDATE CHANNEL_CREATE CHANNEL_DELETE CHANNEL_INFO CHANNEL_MEMBER_COUNT_UPDATE CHANNEL_PINS_UPDATE CHANNEL_RECIPIENT_ADD CHANNEL_RECIPIENT_REMOVE CHANNEL_SYNC CHANNEL_UNREAD_UPDATE CHANNEL_UPDATE CONVERSATION_SUMMARY_UPDATE CREATOR_MONETIZATION_RESTRICTIONS_UPDATE DELETED_ENTITY_IDS DM_SETTINGS_UPSELL_SHOW EMBEDDED_ACTIVITY_UPDATE_V2 EXPERIMENT_SESSION_OVERRIDE_CREATE EXPERIMENT_SESSION_OVERRIDE_DELETE FORUM_UNREADS FRIEND_SUGGESTION_CREATE FRIEND_SUGGESTION_DELETE GAME_RELATIONSHIP_ADD GAME_RELATIONSHIP_REMOVE GAME_SERVER_CREATE GAME_SERVER_DELETE GAME_SERVER_UPDATE GENERIC_PUSH_NOTIFICATION_SENT GIFT_CODE_UPDATE GUILD_APPLICATION_COMMAND_INDEX_UPDATE GUILD_AUDIT_LOG_ENTRY_CREATE GUILD_BAN_ADD GUILD_BAN_REMOVE GUILD_BULK_BAN_UPDATE GUILD_CREATE GUILD_DELETE GUILD_DIRECTORY_ENTRY_CREATE GUILD_DIRECTORY_ENTRY_DELETE GUILD_DIRECTORY_ENTRY_UPDATE GUILD_EMOJIS_UPDATE GUILD_FEATURE_ACK GUILD_JOIN_REQUEST_CREATE GUILD_JOIN_REQUEST_DELETE GUILD_JOIN_REQUEST_UPDATE GUILD_MEMBERS_CHUNK GUILD_MEMBER_ADD GUILD_MEMBER_LIST_UPDATE GUILD_MEMBER_REMOVE GUILD_MEMBER_UPDATE GUILD_OFFICIAL_GAME_APPLICATIONS_UPDATE GUILD_PRUNE_UPDATE GUILD_ROLE_CREATE GUILD_ROLE_DELETE GUILD_ROLE_UPDATE GUILD_ROOM_CONNECT GUILD_ROOM_DISCONNECT GUILD_ROOM_UPDATE GUILD_SCHEDULED_EVENT_CREATE GUILD_SCHEDULED_EVENT_DELETE GUILD_SCHEDULED_EVENT_EXCEPTION_CREATE GUILD_SCHEDULED_EVENT_EXCEPTION_DELETE GUILD_SCHEDULED_EVENT_EXCEPTION_UPDATE GUILD_SCHEDULED_EVENT_UPDATE GUILD_SCHEDULED_EVENT_USER_ADD GUILD_SCHEDULED_EVENT_USER_REMOVE GUILD_SOUNDBOARD_SOUNDS_UPDATE GUILD_SOUNDBOARD_SOUND_CREATE GUILD_SOUNDBOARD_SOUND_DELETE GUILD_SOUNDBOARD_SOUND_UPDATE GUILD_STICKERS_UPDATE GUILD_UPDATE INITIAL_GUILD INTERACTION_CREATE INTERACTION_FAILURE INTERACTION_IFRAME_MODAL_CREATE INTERACTION_MODAL_CREATE INTERACTION_SUCCESS INVITE_CREATE INVITE_DELETE LAST_MESSAGES LIBRARY_APPLICATION_UPDATE MESSAGE_ACK MESSAGE_CREATE MESSAGE_DELETE MESSAGE_DELETE_BULK MESSAGE_POLL_VOTE_ADD MESSAGE_POLL_VOTE_ADD_MANY MESSAGE_POLL_VOTE_REMOVE MESSAGE_REACTION_ADD MESSAGE_REACTION_ADD_MANY MESSAGE_REACTION_REMOVE MESSAGE_REACTION_REMOVE_ALL MESSAGE_REACTION_REMOVE_EMOJI MESSAGE_REQUEST_NOTIFICATION_SENT MESSAGE_UPDATE NOTIFICATION_CENTER_ITEMS_ACK NOTIFICATION_CENTER_ITEM_COMPLETED NOTIFICATION_CENTER_ITEM_CREATE NOTIFICATION_CENTER_ITEM_DELETE NOTIFICATION_SETTINGS_UPDATE OAUTH2_TOKEN_CREATE OAUTH2_TOKEN_DELETE ORBS_ARCADE_GAME_STATE_UPDATE PASSIVE_UPDATE_V2 PRESENCES_REPLACE PRESENCE_UPDATE QUESTS_USER_COMPLETION_UPDATE QUESTS_USER_STATUS_UPDATE QUEST_PREVIEW_UPDATE REACTION_NOTIFICATION_SENT READY READY_SUPPLEMENTAL RECENT_MENTION_DELETE RELATIONSHIP_ADD RELATIONSHIP_REMOVE RELATIONSHIP_UPDATE RESUMED SAVED_MESSAGE_CREATE SAVED_MESSAGE_DELETE SESSIONS_REPLACE SOUNDBOARD_SOUNDS STAGE_INSTANCE_CREATE STAGE_INSTANCE_DELETE STAGE_INSTANCE_UPDATE STATE_UPDATE STREAM_CREATE STREAM_DELETE STREAM_SERVER_UPDATE STREAM_UPDATE THREAD_CREATE THREAD_DELETE THREAD_LIST_SYNC THREAD_MEMBERS_UPDATE THREAD_MEMBER_LIST_UPDATE THREAD_MEMBER_UPDATE THREAD_UPDATE TYPING_START USER_APPLICATION_IDENTITY_REMOVE USER_APPLICATION_IDENTITY_UPDATE USER_APPLICATION_REMOVE USER_APPLICATION_UPDATE USER_BADGE_STATE_UPDATE USER_CONNECTIONS_CALLBACK USER_CONNECTIONS_LINK_CALLBACK USER_CONNECTIONS_UPDATE USER_DISCORD_ACHIEVEMENT_STATE_UPDATE USER_GUILD_SETTINGS_UPDATE USER_NON_CHANNEL_ACK USER_NOTE_UPDATE USER_REQUIRED_ACTION_UPDATE USER_SETTINGS_PROTO_UPDATE USER_UPDATE VIRTUAL_CURRENCY_BALANCE_UPDATE VOICE_CHANNEL_EFFECT_SEND VOICE_CHANNEL_START_TIME_UPDATE VOICE_CHANNEL_STATUS_UPDATE VOICE_SERVER_UPDATE VOICE_STATE_UPDATE VOICE_STATE_UPDATE_BATCH WEBHOOKS_UPDATE WISHLIST_ITEM_PURCHASED'.split(
        ' ',
    ),
)
const storeEvents = [
    'READY',
    'READY_SUPPLEMENTAL',
    'GUILD_CREATE',
    'CHANNEL_CREATE',
    'CHANNEL_UPDATE',
    'CHANNEL_DELETE',
    'USER_UPDATE',
    'MESSAGE_CREATE',
    'MESSAGE_UPDATE',
    'MESSAGE_DELETE',
    'MESSAGE_DELETE_BULK',
]
// Gateway listeners for unmapped events, while a plugin patches or subscribes to one
const unmapped = new Map<string, () => void>()

export const stores: Record<
    string,
    Record<string, (...args: any[]) => unknown>
> = {
    MessageStore: {
        getMessage: (channelId: string, id: string) => {
            const message = messages.get(id)
            return message?.channel_id === channelId ? message : undefined
        },
        getMessages: (channelId: string) => {
            const list = [...messages.values()].filter(
                message => message.channel_id === channelId,
            )
            return {
                toArray: () => list,
                get: (id: string) => list.find(message => message.id === id),
                has: (id: string) => list.some(message => message.id === id),
            }
        },
    },
    UserStore: {
        getCurrentUser: () => currentUser,
        getUser: (id: string) =>
            users.get(id) ?? (currentUser?.id === id ? currentUser : undefined),
    },
    ChannelStore: {
        getChannel: (id: string) => channels.get(id),
    },
    AuthenticationStore: {
        getId: () => currentUser?.id,
    },
}

// Client-local events, run from the HTTP requests and gateway messages they cause
const localEvents = new Set(['TYPING_START_LOCAL', 'IDLE'])

export const isFluxEventSupported = (type: string) =>
    type in fluxEvents || localEvents.has(type) || gatewayEvents.has(type)

/** Runs patches and listeners for a client-local event. Returns `undefined` when a patch blocks it. */
export function dispatchLocalFlux(payload: FluxPayload) {
    let result: FluxPayload | undefined | void = payload
    for (const [patch, onError] of [
        ...anyPatches,
        ...(patches.get(payload.type) ?? []),
    ]) {
        try {
            result = patch(result!)
        } catch (error) {
            onError(error)
        }
        if (!result) return
    }
    for (const [listener, onError] of listeners.get(payload.type) ?? [])
        try {
            listener(result)
        } catch (error) {
            onError(error)
        }
    return result
}

/** Feeds an event with a gateway form to Phoenix. Returns `undefined` for other types. */
export function dispatchFlux(payload: FluxPayload) {
    const event = fluxEvents[payload.type]
    if (event?.toGateway)
        return dispatch(event.gateway, event.toGateway(payload, {}))
}

export function addFluxPatch(
    type: string | undefined,
    patch: FluxPatch,
    onError: OnError,
) {
    let set = type === undefined ? anyPatches : patches.get(type)
    if (!set) patches.set(type!, (set = new Map()))
    set.set(patch, onError)
    if (type !== undefined) listenUnmapped(type)
    return () => {
        set.delete(patch)
        if (type !== undefined) unlistenUnmapped(type)
    }
}

export function addFluxListener(
    type: string,
    listener: (payload: FluxPayload) => unknown,
    onError: OnError,
) {
    let set = listeners.get(type)
    if (!set) listeners.set(type, (set = new Map()))
    set.set(listener, onError)
    listenUnmapped(type)
    return () => removeFluxListener(type, listener)
}

export function removeFluxListener(
    type: string,
    listener: (payload: FluxPayload) => unknown,
) {
    listeners.get(type)?.delete(listener)
    unlistenUnmapped(type)
}

function listenUnmapped(type: string) {
    if (
        type in fluxEvents ||
        storeEvents.includes(type) ||
        unmapped.has(type) ||
        !gatewayEvents.has(type)
    )
        return
    unmapped.set(
        type,
        on(type, data => route(type, data)),
    )
}

function unlistenUnmapped(type: string) {
    if (patches.get(type)?.size || listeners.get(type)?.size) return
    unmapped.get(type)?.()
    unmapped.delete(type)
}

export function attachFlux() {
    if (!attached++) {
        request({ url: 'https://discord.com/api/v9/users/@me' }).then(
            response => {
                if (attached && response.status === 200)
                    currentUser ??= JSON.parse(decodeUtf8(response.body))
            },
            () => {},
        )
        detach = storeEvents.map(event => on(event, data => route(event, data)))
        // Presence updates carry Phoenix's idle state, and a blocked IDLE keeps the client active
        detach.push(
            onSend(3, presence => {
                const idle =
                    dispatchLocalFlux({
                        type: 'IDLE',
                        idle: presence.afk === true,
                        idleSince: presence.since,
                    })?.idle === true
                if (idle !== (presence.afk === true))
                    return {
                        ...presence,
                        afk: idle,
                        since: idle ? presence.since : 0,
                    }
            }),
        )
    }

    let released = false
    return () => {
        if (released) return
        released = true
        if (--attached) return
        for (const off of detach) off()
        detach = []
        messages.clear()
        users.clear()
        channels.clear()
        currentUser = undefined
    }
}

function route(event: string, data: any) {
    const type =
        fluxTypes[event] ?? (gatewayEvents.has(event) ? event : undefined)
    const specific = type ? patches.get(type) : undefined
    const subscribed = type ? listeners.get(type) : undefined

    if (type && (anyPatches.size || specific?.size || subscribed?.size)) {
        // Unmapped events keep their gateway shape, with camelCase copies of snake_case keys. Observe only.
        const { toFlux, toGateway } = fluxEvents[type] ?? {
            toFlux: (data: any): FluxPayload => {
                const payload: FluxPayload = Array.isArray(data)
                    ? { type, data }
                    : { ...data, type }
                for (const key of Object.keys(payload))
                    if (key.includes('_'))
                        payload[
                            key.replace(/_([a-z])/g, (_, c: string) =>
                                c.toUpperCase(),
                            )
                        ] ??= payload[key]
                return payload
            },
        }
        let payload: FluxPayload | undefined | void = toFlux(data)

        for (const [patch, onError] of [...anyPatches, ...(specific ?? [])]) {
            try {
                payload = patch(payload!)
            } catch (error) {
                onError(error)
            }
            if (!payload) break
        }

        // Phoenix can't swap event types. Plugins swap deletes to keep the message, which a drop also does.
        if (!payload || payload.type !== type)
            return toGateway ? false : undefined

        const result =
            toGateway && (anyPatches.size || specific?.size)
                ? toGateway(payload, data)
                : undefined

        updateStores(event, result ?? data)
        for (const [listener, onError] of subscribed ?? [])
            try {
                listener(payload)
            } catch (error) {
                onError(error)
            }
        return result
    }

    updateStores(event, data)
}

function updateStores(event: string, data: any) {
    switch (event) {
        case 'READY':
            currentUser = data.user
            for (const user of data.users ?? []) users.set(user.id, user)
            for (const channel of data.private_channels ?? [])
                channels.set(channel.id, channel)
            for (const guild of data.guilds ?? [])
                updateStores('GUILD_CREATE', guild)
            break
        case 'GUILD_CREATE':
            for (const channel of data.channels ?? [])
                channels.set(channel.id, { ...channel, guild_id: data.id })
            break
        case 'CHANNEL_CREATE':
        case 'CHANNEL_UPDATE':
            channels.set(data.id, data)
            break
        case 'CHANNEL_DELETE':
            channels.delete(data.id)
            break
        case 'USER_UPDATE':
            users.set(data.id, data)
            if (data.id === currentUser?.id) currentUser = data
            break
        case 'MESSAGE_CREATE':
        case 'MESSAGE_UPDATE': {
            const old = messages.get(data.id)
            if (event === 'MESSAGE_UPDATE' && !old) break
            messages.delete(data.id)
            messages.set(data.id, { ...old, ...data, state: 'SENT' })
            if (data.author) users.set(data.author.id, data.author)
            if (messages.size > MaxMessages)
                messages.delete(messages.keys().next().value!)
            break
        }
        case 'MESSAGE_DELETE':
            messages.delete(data.id)
            break
        case 'MESSAGE_DELETE_BULK':
            for (const id of data.ids ?? []) messages.delete(id)
    }
}

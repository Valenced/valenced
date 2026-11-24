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
    type in fluxEvents || localEvents.has(type)

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
    return () => {
        set.delete(patch)
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
    return () => removeFluxListener(type, listener)
}

export function removeFluxListener(
    type: string,
    listener: (payload: FluxPayload) => unknown,
) {
    listeners.get(type)?.delete(listener)
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
        detach = [
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
        ].map(event => on(event, data => route(event, data)))
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
    const type = fluxTypes[event]
    const specific = type ? patches.get(type) : undefined
    const subscribed = type ? listeners.get(type) : undefined

    if (type && (anyPatches.size || specific?.size || subscribed?.size)) {
        const { toFlux, toGateway } = fluxEvents[type]!
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

// Sets __valencedPhoenixFrames before the host can read it
import '@valenced/phoenix'
import '@valenced/phoenix/devtools'
import { callNativeMethod } from '@valenced/modules/native'
import { startExternalPhoenixPlugins } from '@valenced/phoenix/plugins'
import { getErrorStack } from '@valenced/utils/error'
import { BuildEnvironment, FullVersion } from '~constants'

// QuickJS has no ErrorUtils, but the two properties are what reporters look for.
// @ts-expect-error
globalThis.ErrorUtils = {
    reportError: onError,
    reportFatalError: onError,
}

function onError(error: unknown) {
    // QuickJS stacks leave out the message
    const stack =
        error instanceof Error
            ? `${error}\n${getErrorStack(error)}`
            : getErrorStack(error)

    callNativeMethod('valenced.alertError', [
        stack,
        `${FullVersion} (${BuildEnvironment})`,
    ])

    nativeLoggingHook(`\u001b[31m${stack}\u001b[0m`, 2)
}

async function start() {
    try {
        if (__DEV__)
            nativeLoggingHook(
                `\u001b[31m--- PHOENIX START STAGE ---\u001b[0m`,
                1,
            )

        await import('./plugins/phoenix')
        await startExternalPhoenixPlugins()
    } catch (e) {
        onError(e)
    }
}

// Phoenix has no Metro and no runApplication, so the stages run in order here.
start()

import { transform } from '@swc/core'
import type { JscTarget } from '@swc/core'
import type { RolldownPlugin } from 'rolldown'

/**
 * Transforms TS and JSX. Downlevels for Hermes unless a target is given.
 *
 * @param target Engine target, for runtimes that need no Hermes workarounds.
 */
export default function hermesSwcPlugin(target?: JscTarget): RolldownPlugin {
    return {
        name: 'swc',
        transform: {
            filter: {
                moduleType: ['js', 'jsx', 'ts', 'tsx'],
            },
            handler(code) {
                return transform(code, {
                    jsc: {
                        ...(target && { target }),
                        transform: {
                            react: {
                                runtime: 'automatic',
                            },
                        },
                        parser: {
                            syntax: 'typescript',
                            tsx: true,
                        },
                    },
                    ...(!target && {
                        env: {
                            // https://github.com/facebook/hermes/blob/main/doc/Features.md
                            targets: 'fully supports es6',
                            include: [
                                'transform-arrow-functions',
                                'transform-async-generator-functions',
                                'transform-block-scoping',
                                'transform-classes',
                                'transform-duplicate-named-capturing-groups-regex',
                                'transform-named-capturing-groups-regex',
                            ],
                            exclude: [
                                // Async functions are supported, only async arrow functions aren't
                                // Source: https://github.com/facebook/hermes/issues/1395
                                'transform-async-to-generator',
                                'transform-exponentiation-operator',
                                'transform-logical-assignment-operators',
                                'transform-nullish-coalescing-operator',
                                'transform-numeric-separator',
                                'transform-object-rest-spread',
                                'transform-optional-catch-binding',
                                'transform-optional-chaining',
                                'transform-parameters',
                                'transform-template-literals',
                            ],
                        },
                    }),
                })
            },
        },
    }
}

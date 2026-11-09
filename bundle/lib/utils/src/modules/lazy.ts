import {
	lookupModule,
	lookupModules,
	waitForModules,
} from '@valenced/modules/finders'
import { FilterScopes } from '@valenced/modules/finders/filters'
import { after, before, instead } from '@valenced/patcher'
import { noop } from '@valenced/utils/callback'
import { getErrorStack } from '@valenced/utils/error'
import type { Filter, FilterResult } from '@valenced/modules/finders/filters'
import type {
	AfterHook,
	BeforeHook,
	HookOptions,
	InsteadHook,
	UnknownFunction,
	UnpatchFunction,
} from '@valenced/patcher/types'

export interface LazyHookOptions extends HookOptions {
	/**
	 * Whether to skip reporting a missing key, or a key not holding a function.
	 *
	 * Failed patches are still reported.
	 *
	 * @default false
	 */
	optional?: boolean
}

/** Keys holding a function, including optional and union-typed ones. */
export type FunctionKey<T> = {
	[K in keyof T]-?: [Extract<T[K], UnknownFunction>] extends [never] ? never : K
}[keyof T]

type FunctionAt<T, K extends keyof T> = Extract<T[K], UnknownFunction>

/** Patches a match, returning the function to undo it. */
export type LazyApply<T> = (value: T) => UnpatchFunction | void

/** Emits matches, returning the function to stop. */
export type LazySource<T> = (emit: (value: T) => void) => () => void

type PatchFunction = (
	parent: any,
	key: PropertyKey,
	hook: any,
	options?: HookOptions,
) => UnpatchFunction

interface Applier<T> {
	apply: LazyApply<T>
	undos: UnpatchFunction[]
}

/**
 * Handle patching matches whenever they exist.
 *
 * All patches on one handle share one source, which starts on the first patch and stops after the last unpatch.
 * Matches are deduplicated, so an object under several module IDs is patched once.
 *
 * @see {@link lazyModule} and {@link lazyModules} to instantiate.
 */
export class LazyModule<T> {
	/** Whether to patch every match, instead of only the first. */
	readonly every: boolean
	/** Name for reports. */
	readonly name: string

	private readonly source: LazySource<T>
	private readonly values = new Set<T>()
	private readonly appliers = new Set<Applier<T>>()
	private stop: (() => void) | undefined

	constructor(source: LazySource<T>, every: boolean, name: string) {
		this.source = source
		this.every = every
		this.name = name
	}

	/**
	 * Runs {@link apply} for each match, now and later.
	 *
	 * Errors thrown by {@link apply} are reported, not thrown.
	 *
	 * @param apply The function to patch a match, optionally returning the function to undo it.
	 * @returns A function to stop waiting and undo the patches.
	 *
	 * @example
	 * ```ts
	 * const unpatch = lazyModule(withProps('isStaffEnv')).use(m =>
	 *   instead(m, 'isStaffEnv', () => true),
	 * )
	 * ```
	 */
	use(apply: LazyApply<T>): UnpatchFunction {
		const applier: Applier<T> = { apply, undos: [] }
		this.appliers.add(applier)

		for (const value of this.values) this.run(applier, value)

		if (!this.stop) {
			// Marks as started, since the source may emit before returning
			this.stop = noop
			const stop = this.source(this.emit)
			if (this.stop === noop) this.stop = stop
			// Last patch undone while the source started
			else stop()
		}

		return () => this.undo(applier)
	}

	/**
	 * Creates a handle over `value[key]` of each match, with the same match mode.
	 *
	 * Reads `value[key]` once per match. A replaced `value[key]` keeps later patches on the old object.
	 *
	 * @param key The key holding the object to patch.
	 *
	 * @example
	 * ```ts
	 * lazyModule(withProps('HTTP')).prop('HTTP').instead('post', hook)
	 * ```
	 */
	prop<K extends keyof T>(key: K): LazyModule<NonNullable<T[K]>> {
		return new LazyModule<NonNullable<T[K]>>(
			emit =>
				this.use(value => {
					const child = value[key]
					const type = typeof child
					if ((type === 'object' && child !== null) || type === 'function')
						emit(child as NonNullable<T[K]>)
					else if (!this.every) reportMissing(this.name, key, 'an object')
				}),
			this.every,
			`${this.name}.${String(key)}`,
		)
	}

	/**
	 * Adds a `before` hook to `key` of each match.
	 *
	 * @see {@link before} for more documentation.
	 */
	before<K extends FunctionKey<T>>(
		key: K,
		hook: BeforeHook<FunctionAt<T, K>>,
		options?: LazyHookOptions,
	): UnpatchFunction {
		return this.patch(before, key, hook, options)
	}

	/**
	 * Adds an `instead` hook to `key` of each match.
	 *
	 * @see {@link instead} for more documentation.
	 */
	instead<K extends FunctionKey<T>>(
		key: K,
		hook: InsteadHook<FunctionAt<T, K>>,
		options?: LazyHookOptions,
	): UnpatchFunction {
		return this.patch(instead, key, hook, options)
	}

	/**
	 * Adds an `after` hook to `key` of each match.
	 *
	 * @see {@link after} for more documentation.
	 */
	after<K extends FunctionKey<T>>(
		key: K,
		hook: AfterHook<FunctionAt<T, K>>,
		options?: LazyHookOptions,
	): UnpatchFunction {
		return this.patch(after, key, hook, options)
	}

	private patch(
		patch: PatchFunction,
		key: PropertyKey,
		hook: unknown,
		options?: LazyHookOptions,
	) {
		return this.use(value => {
			if (typeof (value as any)?.[key] === 'function')
				return patch(value, key, hook, options)

			// lazyModules skips modules without the key
			if (!(options?.optional || this.every))
				reportMissing(this.name, key, 'a function')
		})
	}

	private emit = (value: T) => {
		if (this.values.has(value)) return

		this.values.add(value)
		for (const applier of Array.from(this.appliers)) this.run(applier, value)
	}

	private run(applier: Applier<T>, value: T) {
		// Undone by an earlier applier
		if (!this.appliers.has(applier)) return

		try {
			const undo = applier.apply(value)
			if (typeof undo === 'function') applier.undos.push(undo)
		} catch (e) {
			reportError(this.name, e)
		}
	}

	private undo(applier: Applier<T>) {
		if (!this.appliers.delete(applier)) return

		const { undos } = applier
		while (undos.length)
			try {
				undos.pop()!()
			} catch (e) {
				reportError(this.name, e)
			}

		if (!this.appliers.size && this.stop) {
			const { stop } = this
			this.stop = undefined
			this.values.clear()
			stop()
		}
	}
}

/**
 * Creates a handle patching the first module matching the filter, whenever it initializes.
 *
 * Patches apply immediately if the module is initialized.
 * Otherwise, they apply at module init, before `require` returns to the importer.
 * Modules are never initialized to look for a match.
 *
 * **Filters should match one unique module to prevent non-deterministic behavior.**
 *
 * @param filter The filter to use.
 *
 * @example
 * ```ts
 * const unpatch = lazyModule(withProps('initSentry')).instead('initSentry', noop)
 * ```
 *
 * @example Several patches on one handle
 * ```ts
 * const SentryUtils = lazyModule(withProps('profiledRootComponent'))
 * cleanup(
 *   SentryUtils.instead('profiledRootComponent', args => args[0]),
 *   SentryUtils.instead('addBreadcrumb', noop, { optional: true }),
 * )
 * ```
 */
export function lazyModule<F extends Filter>(
	filter: F,
): LazyModule<FilterResult<F>> {
	return new LazyModule<FilterResult<F>>(
		DEBUG_trackPending(filter.key, emit => {
			const [exports, id] = lookupModule(filter.scope(FilterScopes.Initialized))

			if (id !== undefined) {
				emit(exports)
				return noop
			}

			const unsub = waitForModules(
				filter,
				exports => {
					unsub()
					emit(exports)
				},
				{ cached: true },
			)

			return unsub
		}),
		false,
		filter.key,
	)
}

/**
 * Creates a handle patching every module matching the filter, now and later.
 *
 * Modules without the key are skipped silently.
 * Runs the filter on every module init until the last unpatch.
 *
 * @see {@link lazyModule} for more documentation.
 *
 * @param filter The filter to use.
 *
 * @example
 * ```ts
 * const unpatch = lazyModules(withProps('track')).instead('track', noop)
 * ```
 *
 * @see {@link lazyModule} for more documentation.
 */
export function lazyModules<F extends Filter>(
	filter: F,
): LazyModule<FilterResult<F>> {
	return new LazyModule<FilterResult<F>>(
		DEBUG_trackPending(filter.key, emit => {
			for (const [exports] of lookupModules(
				filter.scope(FilterScopes.Initialized),
			))
				emit(exports)

			return waitForModules(filter, emit)
		}),
		true,
		filter.key,
	)
}

function reportMissing(name: string, key: PropertyKey, expected: string) {
	nativeLoggingHook(
		`\u001b[33mLazy patch on ${name}: ${String(key)} is not ${expected}\u001b[0m`,
		2,
	)
}

function reportError(name: string, error: unknown) {
	nativeLoggingHook(
		`\u001b[31mLazy patch on ${name} failed:\n${getErrorStack(error)}\u001b[0m`,
		3,
	)
}

function DEBUG_trackPending<T>(
	name: string,
	source: LazySource<T>,
): LazySource<T> {
	if (!__DEV__) return source

	return emit => {
		nativeLoggingHook(
			`\u001b[94mPending lazy module: \u001b[93m${name}\u001b[0m`,
			1,
		)

		const stop = source(value => {
			emit(value)

			nativeLoggingHook(
				`\u001b[32mResolved lazy module: \u001b[33m${name}\u001b[0m with value: \u001b[36m${String(value)}\u001b[0m`,
				1,
			)
		})

		return stop
	}
}

import { css, on, ref } from 'remix/ui'
import {
	Fragment,
	jsx as remixJsx,
	type ElementProps,
	type ElementType,
	type RemixElement,
} from 'remix/ui/jsx-runtime'

type LegacyEventHandler = (event: Event) => void | Promise<void>

type LegacyProps = ElementProps & {
	connect?: (node: Element, signal: AbortSignal) => void
	css?: Record<string, unknown>
	on?: Record<string, LegacyEventHandler | null | undefined>
}

type LegacyHostProps = {
	connect?: (node: any, signal: AbortSignal) => void
	css?: Record<string, unknown>
	on?: Record<string, ((event: any) => void | Promise<void>) | null | undefined>
}

declare module 'remix/ui' {
	interface HostProps<
		eventTarget extends EventTarget,
	> extends LegacyHostProps {}
}

declare global {
	namespace JSX {
		interface IntrinsicAttributes extends LegacyHostProps {
			key?: any
		}
	}
}

function normalizeProps(props: ElementProps | null | undefined) {
	if (!props || (!props.css && !props.connect && !props.on)) return props

	const {
		connect,
		css: cssProps,
		mix,
		on: eventHandlers,
		...nextProps
	} = props as LegacyProps
	const legacyMix = []

	if (cssProps) {
		legacyMix.push(css(cssProps as never))
	}

	if (connect) {
		legacyMix.push(ref(connect as never))
	}

	if (eventHandlers) {
		for (const [eventName, handler] of Object.entries(eventHandlers)) {
			if (handler) {
				legacyMix.push(on(eventName as never, handler as never))
			}
		}
	}

	if (legacyMix.length > 0) {
		nextProps.mix = mix ? [mix, ...legacyMix] : legacyMix
	}

	return nextProps
}

export { Fragment }

export function jsx(
	type: ElementType,
	props: ElementProps | null | undefined,
	key?: string,
): RemixElement {
	return remixJsx(type, normalizeProps(props) ?? {}, key)
}

export const jsxs = jsx
export const jsxDEV = jsx

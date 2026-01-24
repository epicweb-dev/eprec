import type { Handle } from 'remix/component'

type CounterSetup = { initial?: number }

export function Counter(handle: Handle, setup: CounterSetup = {}) {
	let count = setup.initial ?? 0
	return () => (
		<button
			type="button"
			class="counter-button"
			on={{
				click: () => {
					count += 1
					handle.update()
				},
			}}
		>
			<span>Click count</span>
			<span class="counter-value">{count}</span>
		</button>
	)
}

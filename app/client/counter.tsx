import { on, type Handle } from 'remix/ui'

type CounterSetup = { initial?: number }
type CounterProps = { setup?: CounterSetup }

export function Counter(handle: Handle<CounterProps>) {
	let count = handle.props.setup?.initial ?? 0
	return () => (
		<button
			type="button"
			class="counter-button"
			mix={[
				on<HTMLButtonElement>('click', () => {
					count += 1
					handle.update()
				}),
			]}
		>
			<span>Click count</span>
			<span class="counter-value">{count}</span>
		</button>
	)
}

import { expect, test } from 'bun:test'
import { on } from 'remix/ui'
import { jsx } from './jsx-runtime.ts'

test('preserves existing mix descriptors when adding legacy event props', () => {
	const existingMix = on<HTMLElement>('focus', () => {})
	const element = jsx('button', {
		mix: [existingMix],
		on: { click: () => {} },
	})

	expect(element.props.mix).toBeArray()
	expect(element.props.mix).toHaveLength(2)
	expect(element.props.mix[0]).toBe(existingMix)
})

test('preserves existing mix descriptors when legacy props add no descriptors', () => {
	const existingMix = on<HTMLElement>('focus', () => {})
	const element = jsx('button', {
		mix: [existingMix],
		on: {},
	})

	expect(element.props.mix).toBeArray()
	expect(element.props.mix).toHaveLength(1)
	expect(element.props.mix[0]).toBe(existingMix)
})

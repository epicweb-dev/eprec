/**
 * Allocate padding at join points between videos, intelligently distributing
 * silence when one side lacks sufficient padding.
 */
export function allocateJoinPadding(options: {
	paddingSeconds: number
	previousAvailableSeconds: number
	currentAvailableSeconds: number
}): { previousPaddingSeconds: number; currentPaddingSeconds: number } {
	const desiredTotal = options.paddingSeconds * 2
	const totalAvailable =
		options.previousAvailableSeconds + options.currentAvailableSeconds
	const targetTotal = Math.min(desiredTotal, totalAvailable)
	let previousPadding = Math.min(
		options.paddingSeconds,
		options.previousAvailableSeconds,
	)
	let currentPadding = Math.min(
		options.paddingSeconds,
		options.currentAvailableSeconds,
	)
	let remaining = targetTotal - (previousPadding + currentPadding)

	if (remaining > 0) {
		const extra = Math.min(
			options.previousAvailableSeconds - previousPadding,
			remaining,
		)
		previousPadding += extra
		remaining -= extra
	}
	if (remaining > 0) {
		const extra = Math.min(
			options.currentAvailableSeconds - currentPadding,
			remaining,
		)
		currentPadding += extra
	}

	return {
		previousPaddingSeconds: previousPadding,
		currentPaddingSeconds: currentPadding,
	}
}

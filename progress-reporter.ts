export type StepProgressReporter = {
	start: (options: { stepCount: number; label?: string }) => void
	step: (label: string) => void
	setLabel: (label: string) => void
	finish: (label?: string) => void
}

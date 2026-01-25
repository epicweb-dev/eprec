export const colors = {
	primary: 'var(--color-primary)',
	primaryHover: 'var(--color-primary-hover)',
	primaryActive: 'var(--color-primary-active)',
	onPrimary: 'var(--color-on-primary)',
	background: 'var(--color-background)',
	surface: 'var(--color-surface)',
	surfaceMuted: 'var(--color-surface-muted)',
	surfaceInverse: 'var(--color-surface-inverse)',
	text: 'var(--color-text)',
	textMuted: 'var(--color-text-muted)',
	textSubtle: 'var(--color-text-subtle)',
	textSecondary: 'var(--color-text-secondary)',
	textFaint: 'var(--color-text-faint)',
	textInverse: 'var(--color-text-inverse)',
	border: 'var(--color-border)',
	borderStrong: 'var(--color-border-strong)',
	borderAccent: 'var(--color-border-accent)',
	infoSurface: 'var(--color-info-surface)',
	infoText: 'var(--color-info-text)',
	successSurface: 'var(--color-success-surface)',
	successText: 'var(--color-success-text)',
	warningSurface: 'var(--color-warning-surface)',
	warningText: 'var(--color-warning-text)',
	warningBorder: 'var(--color-warning-border)',
	dangerSurface: 'var(--color-danger-surface)',
	dangerText: 'var(--color-danger-text)',
	dangerBorder: 'var(--color-danger-border)',
	dangerBorderStrong: 'var(--color-danger-border-strong)',
	primarySoft: 'color-mix(in srgb, var(--color-primary) 12%, transparent)',
	primaryMuted: 'color-mix(in srgb, var(--color-primary) 24%, transparent)',
	borderSubtle: 'color-mix(in srgb, var(--color-border) 60%, transparent)',
} as const

export const typography = {
	fontFamily: 'var(--font-family)',
	fontSize: {
		xs: 'var(--font-size-xs)',
		sm: 'var(--font-size-sm)',
		base: 'var(--font-size-base)',
		lg: 'var(--font-size-lg)',
		xl: 'var(--font-size-xl)',
		'2xl': 'var(--font-size-2xl)',
	},
	fontWeight: {
		normal: 'var(--font-weight-normal)',
		medium: 'var(--font-weight-medium)',
		semibold: 'var(--font-weight-semibold)',
		bold: 'var(--font-weight-bold)',
	},
} as const

export const spacing = {
	xs: 'var(--spacing-xs)',
	sm: 'var(--spacing-sm)',
	md: 'var(--spacing-md)',
	lg: 'var(--spacing-lg)',
	xl: 'var(--spacing-xl)',
	'2xl': 'var(--spacing-2xl)',
} as const

export const radius = {
	sm: 'var(--radius-sm)',
	md: 'var(--radius-md)',
	lg: 'var(--radius-lg)',
	xl: 'var(--radius-xl)',
	pill: 'var(--radius-pill)',
} as const

export const shadows = {
	sm: 'var(--shadow-sm)',
	md: 'var(--shadow-md)',
	lg: 'var(--shadow-lg)',
} as const

export const transitions = {
	fast: 'var(--transition-fast)',
	normal: 'var(--transition-normal)',
} as const

export const responsive = {
	spacingPage: 'var(--spacing-page)',
	spacingSection: 'var(--spacing-section)',
	cardMinWidth: 'var(--card-min-width)',
} as const

export const breakpoints = {
	mobile: '640px',
	tablet: '1024px',
} as const

export const mq = {
	mobile: `@media (max-width: ${breakpoints.mobile})`,
	tablet: `@media (max-width: ${breakpoints.tablet})`,
	desktop: `@media (min-width: 1025px)`,
} as const

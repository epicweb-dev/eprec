import {
	colors,
	mq,
	radius,
	responsive,
	shadows,
	spacing,
	transitions,
	typography,
} from '../styles/tokens.ts'

const sectionStyle = {
	display: 'flex',
	flexDirection: 'column',
	gap: spacing.lg,
	marginTop: responsive.spacingSection,
}

const headerStyle = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: spacing.md,
	flexWrap: 'wrap',
}

const gridStyle = {
	display: 'grid',
	gap: spacing.lg,
	gridTemplateColumns: `repeat(auto-fit, minmax(${responsive.cardMinWidth}, 1fr))`,
	[mq.mobile]: {
		gridTemplateColumns: '1fr',
	},
}

const cardStyle = {
	padding: spacing.xl,
	backgroundColor: colors.surface,
	borderRadius: radius.lg,
	border: `1px solid ${colors.border}`,
	boxShadow: shadows.sm,
	display: 'flex',
	flexDirection: 'column',
	gap: spacing.md,
	transition: `box-shadow ${transitions.fast}, transform ${transitions.fast}`,
	'&:hover': {
		boxShadow: shadows.md,
		transform: 'translateY(-1px)',
	},
	[mq.mobile]: {
		padding: spacing.lg,
	},
}

const primaryButtonStyle = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	gap: spacing.sm,
	padding: `${spacing.sm} ${spacing.lg}`,
	borderRadius: radius.md,
	border: `1px solid ${colors.primaryActive}`,
	backgroundColor: colors.primary,
	color: colors.onPrimary,
	fontSize: typography.fontSize.base,
	fontWeight: typography.fontWeight.semibold,
	cursor: 'pointer',
	transition: `background-color ${transitions.fast}, box-shadow ${transitions.fast}, transform ${transitions.fast}`,
	'&:hover': {
		backgroundColor: colors.primaryHover,
		boxShadow: shadows.sm,
	},
	'&:active': {
		backgroundColor: colors.primaryActive,
		transform: 'translateY(1px)',
	},
}

const pillStyle = {
	padding: `${spacing.xs} ${spacing.sm}`,
	borderRadius: radius.pill,
	backgroundColor: colors.infoSurface,
	color: colors.infoText,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.semibold,
}

const swatchStyle = (color: string) => ({
	width: spacing.sm,
	height: spacing.sm,
	borderRadius: radius.xl,
	backgroundColor: color,
	boxShadow: `0 0 0 1px ${colors.border}`,
})

export function StyleSystemSample() {
	return () => (
		<section css={sectionStyle}>
			<header css={headerStyle}>
				<div>
					<h2
						css={{
							margin: 0,
							fontSize: typography.fontSize.xl,
							fontWeight: typography.fontWeight.semibold,
							color: colors.text,
						}}
					>
						Design tokens
					</h2>
					<p
						css={{
							margin: 0,
							color: colors.textMuted,
							fontSize: typography.fontSize.base,
							lineHeight: 1.6,
						}}
					>
						Shared CSS variables and TypeScript helpers for consistent theming.
					</p>
				</div>
				<span css={pillStyle}>Auto dark mode</span>
			</header>

			<div css={gridStyle}>
				<div css={cardStyle}>
					<h3
						css={{
							margin: 0,
							fontSize: typography.fontSize.lg,
							fontWeight: typography.fontWeight.semibold,
							color: colors.text,
						}}
					>
						Surface card
					</h3>
					<p
						css={{
							margin: 0,
							color: colors.textMuted,
							fontSize: typography.fontSize.base,
							lineHeight: 1.5,
						}}
					>
						Spacing, radius, and shadows come from tokens with responsive
						overrides.
					</p>
					<button type="button" css={primaryButtonStyle}>
						Primary action
					</button>
				</div>

				<div css={cardStyle}>
					<h3
						css={{
							margin: 0,
							fontSize: typography.fontSize.lg,
							fontWeight: typography.fontWeight.semibold,
							color: colors.text,
						}}
					>
						Semantic palette
					</h3>
					<p
						css={{
							margin: 0,
							color: colors.textMuted,
							fontSize: typography.fontSize.base,
							lineHeight: 1.5,
						}}
					>
						Use semantic names like primary, surface, and text instead of hex
						values.
					</p>
					<div
						css={{
							display: 'flex',
							gap: spacing.sm,
							alignItems: 'center',
							flexWrap: 'wrap',
							color: colors.textSecondary,
							fontSize: typography.fontSize.sm,
						}}
					>
						<span css={swatchStyle(colors.primary)} />
						<span css={swatchStyle(colors.infoSurface)} />
						<span css={swatchStyle(colors.successSurface)} />
						<span css={swatchStyle(colors.warningSurface)} />
						<span css={swatchStyle(colors.dangerSurface)} />
						<span>Primary, info, success, warning, danger</span>
					</div>
				</div>
			</div>
		</section>
	)
}

import { html, type SafeHtml } from 'remix/html-template'
import { baseImportMap } from '../config/import-map.ts'

export function Layout({
	children,
	title = 'Eprec Studio',
	entryScript = '/app/client/entry.tsx',
	appConfig,
}: {
	children?: SafeHtml
	title?: string
	entryScript?: string | false
	appConfig?: Record<string, unknown>
}) {
	const importmap = { imports: baseImportMap }
	const importmapJson = JSON.stringify(importmap)
	const importmapScript = html.raw`<script type="importmap">${importmapJson}</script>`
	const modulePreloads = Object.values(baseImportMap).map((value) => {
		return html`<link rel="modulepreload" href="${value}" />`
	})
	const appConfigJson = appConfig ? JSON.stringify(appConfig) : null
	const appConfigScript = appConfigJson
		? html.raw`<script>window.__EPREC_APP__=${appConfigJson.replace(
				/</g,
				'\\u003c',
			)}</script>`
		: ''

	return html`<html lang="en">
		<head>
			<meta charset="utf-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1" />
			<title>${title}</title>
			<link rel="stylesheet" href="/assets/styles.css" />
			${importmapScript} ${modulePreloads}
		</head>
		<body>
			<div id="root">${children ?? ''}</div>
			${appConfigScript}
			${entryScript
				? html`<script type="module" src="${entryScript}"></script>`
				: ''}
		</body>
	</html>`
}

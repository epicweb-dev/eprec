import { html, type SafeHtml } from 'remix/html-template'
import { baseImportMap } from '../config/import-map.ts'

export function Layout({
	children,
	title = 'Eprec Studio',
	entryScript = '/app/client/entry.tsx',
}: {
	children?: SafeHtml
	title?: string
	entryScript?: string | false
}) {
	const importmap = { imports: baseImportMap }
	const importmapJson = JSON.stringify(importmap)
	const importmapScript = html.raw`<script type="importmap">${importmapJson}</script>`
	const modulePreloads = Object.values(baseImportMap).map((value) => {
		return html`<link rel="modulepreload" href="${value}" />`
	})

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
			${entryScript
				? html`<script type="module" src="${entryScript}"></script>`
				: ''}
		</body>
	</html>`
}

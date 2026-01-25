import { html } from 'remix/html-template'
import { Layout } from '../components/layout.tsx'
import { render } from '../helpers/render.ts'

const indexHandler = {
	middleware: [],
	loader() {
		return render(
			Layout({
				title: 'Eprec Studio',
				children: html`<main class="app-shell">
					<header class="app-header">
						<span class="app-kicker">Eprec Studio</span>
						<h1 class="app-title">Editing workspace</h1>
						<p class="app-subtitle">
							Review transcript-based edits, refine cut ranges, and prepare
							exports.
						</p>
					</header>
					<section class="app-card app-card--full">
						<h2>Timeline editor</h2>
						<p class="app-muted">
							Loading preview video, timeline controls, and cut ranges.
						</p>
						<div class="timeline-track timeline-track--skeleton"></div>
					</section>
					<div class="app-grid app-grid--two">
						<section class="app-card">
							<h2>Chapter plan</h2>
							<p class="app-muted">
								Output names and skip flags appear after the client boots.
							</p>
						</section>
						<section class="app-card">
							<h2>Command windows</h2>
							<p class="app-muted">
								Jarvis command detection will populate this panel.
							</p>
						</section>
					</div>
					<section class="app-card app-card--full">
						<h2>Transcript search</h2>
						<p class="app-muted">
							Search and jump controls will load in the interactive UI.
						</p>
					</section>
				</main>`,
			}),
		)
	},
}

export default indexHandler

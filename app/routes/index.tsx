import { html } from 'remix/html-template'
import { Layout } from '../components/layout.tsx'
import routes from '../config/routes.ts'
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
							Prepare edits with the CLI, then review them here.
						</p>
					</header>
					<div class="app-grid">
						<section class="app-card">
							<h2>Workflow</h2>
							<ol class="app-list">
								<li>Run a CLI edit command.</li>
								<li>Open the workspace UI.</li>
								<li>Review and refine the cut list.</li>
							</ol>
						</section>
						<section class="app-card">
							<h2>UI status</h2>
							<p class="status-pill">UI booted</p>
							<p class="app-muted">
								Client-side components load after the first paint.
							</p>
						</section>
						<section class="app-card">
							<h2>Interaction check</h2>
							<p class="app-muted">Client bundle loads after this page.</p>
							<button class="counter-button" type="button" disabled>
								<span>Click count</span>
								<span class="counter-value">0</span>
							</button>
						</section>
					</div>
				</main>`,
			}),
		)
	},
}

export default indexHandler

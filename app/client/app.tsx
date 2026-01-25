import { Counter } from './counter.tsx'

export function App() {
	return () => (
		<main class="app-shell">
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
					<p class="status-pill">Running locally</p>
					<p class="app-muted">Server-rendered shell with client-side edits.</p>
				</section>
				<section class="app-card">
					<h2>Interaction check</h2>
					<p class="app-muted">Click the counter to verify interactivity.</p>
					<Counter setup={{ initial: 0 }} />
				</section>
			</div>
		</main>
	)
}

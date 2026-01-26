import { html } from 'remix/html-template'
import { Layout } from '../components/layout.tsx'
import { render } from '../helpers/render.ts'

const trimPointsHandler = {
	middleware: [],
	loader() {
		const initialVideoPath = process.env.EPREC_APP_VIDEO_PATH?.trim()
		return render(
			Layout({
				title: 'Trim points - Eprec Studio',
				appConfig: initialVideoPath ? { initialVideoPath } : undefined,
				children: html`<main class="app-shell">
					<header class="app-header">
						<span class="app-kicker">Eprec Studio</span>
						<h1 class="app-title">Trim points</h1>
						<p class="app-subtitle">
							Add start and stop points, generate an ffmpeg trim command, and
							run it with live progress.
						</p>
						<nav class="app-nav">
							<a class="app-link" href="/">Editing workspace</a>
						</nav>
					</header>
					<section class="app-card app-card--full">
						<h2>Video source</h2>
						<p class="app-muted">
							Enter a video file path once the interactive UI loads.
						</p>
					</section>
					<section class="app-card app-card--full">
						<h2>Timeline</h2>
						<p class="app-muted">
							Add trim ranges and drag their handles to fine-tune timestamps.
						</p>
						<div class="trim-track trim-track--skeleton"></div>
					</section>
					<section class="app-card app-card--full">
						<h2>ffmpeg command</h2>
						<p class="app-muted">
							Command output and progress details appear after you load a video.
						</p>
						<pre class="command-preview">Loading trim preview...</pre>
					</section>
				</main>`,
			}),
		)
	},
}

export default trimPointsHandler

import { createRoot } from 'remix/component'
import { App } from './app.tsx'

const rootElement = document.getElementById('root')
if (rootElement) {
	rootElement.innerHTML = ''
}
createRoot(rootElement ?? document.body).render(<App />)

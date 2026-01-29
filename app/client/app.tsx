import { EditingWorkspace } from './editing-workspace.tsx'
import { TrimPoints } from './trim-points.tsx'

export function App() {
	return () => {
		const pathname =
			typeof window === 'undefined' ? '/' : window.location.pathname
		if (pathname.startsWith('/trim-points')) {
			return <TrimPoints />
		}
		return <EditingWorkspace />
	}
}

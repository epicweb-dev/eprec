# Agent Guidelines

## Commit Message Format

Use [Conventional Commits](https://www.conventionalcommits.org/) format:

```
type(scope): description

[optional body]
```

**Types:**

- `feat` - New feature (triggers minor release)
- `fix` - Bug fix (triggers patch release)
- `docs` - Documentation only (no release triggered)
- `refactor` - Code change that neither fixes a bug nor adds a feature (no
  release triggered)
- `test` - Adding or updating tests (no release triggered)
- `chore` - Maintenance tasks (no release triggered)

**Breaking changes:** Add `!` after type or include `BREAKING CHANGE:` in body
(triggers major release).

**Examples:**

```
feat: add chapter selection utility
fix(ffmpeg): handle missing audio streams
docs: update pipeline documentation
feat!: change CLI argument format
```

## No React

This application does NOT use React. We use `remix/component` for UI components.
Do not introduce React, Preact, or any other UI framework.

### Remix Components vs React Components

Remix components work differently from React. Here's how:

#### All Components Receive a Handle

**All components** receive a `Handle` as their first argument and return a
render function that receives props. Even if you don't need the handle, you must
accept it:

```tsx
import type { Handle } from 'remix/component'

// Simple component that doesn't use the handle
function Greeting(handle: Handle) {
	return (props: { name: string }) => <div>Hello, {props.name}!</div>
}

// Component that doesn't take props at all
function SimpleComponent(handle: Handle) {
	return () => <div>Hello, world!</div>
}
```

#### Stateful Components

For components that need state, use the closure above the return to store state:

```tsx
import type { Handle } from 'remix/component'

function Counter(handle: Handle) {
	// State lives in the closure
	let count = 0

	// Call handle.update() to re-render when state changes
	const increment = () => {
		count++
		handle.update()
	}

	// Return a render function
	return () => (
		<div>
			<span>Count: {count}</span>
			<button on={{ click: increment }}>+</button>
		</div>
	)
}
```

#### Components with Setup Props and Regular Props

Components have two phases: **setup** (runs once) and **render** (runs on
updates). The second parameter is the **setup prop** (for initialization), and
the returned function receives **regular props** (for rendering):

> **⚠️ Important:** Always use the props from the render function to get the
> latest values. The setup prop is captured once at setup time and may be stale.

```tsx
import type { Handle } from 'remix/component'

function UserCard(
	handle: Handle,
	setup: { userId: string }, // Setup prop - runs once for initialization
) {
	let user: User | null = null
	let loading = true

	// Use setup prop for initial data fetching
	fetch(`/api/users/${setup.userId}`)
		.then((res) => res.json())
		.then((data) => {
			user = data
			loading = false
			handle.update()
		})

	// Regular props - always has the latest values on each render
	return (props: { userId: string; label?: string }) => (
		<div>
			<h2>
				{props.label || 'User'}: {props.userId}
			</h2>
			{loading ? <span>Loading...</span> : <span>{user?.name}</span>}
		</div>
	)
}
```

#### Event Handling

Use `on={{ eventName: handler }}` instead of `onClick`:

```tsx
<button on={{ click: handleClick }}>Click me</button>
<input on={{ input: handleInput, blur: handleBlur }} />
```

#### CSS-in-JS

Use the `css` prop for inline styles with pseudo-selector support:

```tsx
<button
	css={{
		padding: '8px 16px',
		backgroundColor: '#3b82f6',
		'&:hover': {
			backgroundColor: '#2563eb',
		},
	}}
>
	Styled Button
</button>
```

#### Subscribing to Events

Use `handle.on()` to subscribe to custom events or other event targets:

```tsx
function RouterAware(handle: Handle) {
	handle.on(router, { navigate: () => handle.update() })

	return () => <div>Current path: {location.pathname}</div>
}
```

#### Abort Signal

Use `handle.signal` for cancellable async operations:

```tsx
function DataLoader(handle: Handle) {
	let data = null

	fetch('/api/data', { signal: handle.signal })
		.then((res) => res.json())
		.then((d) => {
			data = d
			handle.update()
		})
		.catch((err) => {
			if (handle.signal.aborted) return // Component unmounted
			console.error(err)
		})

	return () => <div>{data ? JSON.stringify(data) : 'Loading...'}</div>
}
```

#### The `connect` Prop (No refs!)

Remix components do **NOT** support React-style refs. Instead, use the `connect`
prop to detect when an element has been added to the screen and get a reference
to the DOM node.

```tsx
function MyComponent() {
	return (
		<div
			connect={(node, signal) => {
				// This runs when the element is added to the DOM
				console.log('Element added to screen:', node)

				// The signal is aborted when the element is removed
				signal.addEventListener('abort', () => {
					console.log('Element removed from screen')
				})
			}}
		>
			Hello World
		</div>
	)
}
```

**Key features:**

- **Automatic cleanup**: The `AbortSignal` is automatically aborted when the
  element is removed from the DOM
- **Flexible signature**: You can use either `(node)` or `(node, signal)`
  depending on whether you need cleanup logic
- **Scheduled execution**: The callback runs after the element is inserted into
  the DOM

**Example with DOM manipulation:**

```tsx
function AutoFocusInput(handle: Handle) {
	return () => (
		<input
			type="text"
			connect={(input: HTMLInputElement) => {
				input.focus()
			}}
		/>
	)
}
```

**Example with cleanup:**

```tsx
function ResizeAware(handle: Handle) {
	let width = 0

	return () => (
		<div
			connect={(node: HTMLDivElement, signal) => {
				const observer = new ResizeObserver((entries) => {
					width = entries[0].contentRect.width
					handle.update()
				})
				observer.observe(node)

				signal.addEventListener('abort', () => {
					observer.disconnect()
				})
			}}
		>
			Width: {width}px
		</div>
	)
}
```

#### Context System

The context system allows indirect ancestor/descendant communication without
passing props through every level. It's accessed via `handle.context` on the
`Handle` interface.

**Setting Context (Provider):**

A parent component provides context using `handle.context.set()`. The context
type is declared as a generic parameter on `Handle`:

```tsx
import type { Handle } from 'remix/component'

function ThemeProvider(handle: Handle<{ theme: 'light' | 'dark' }>) {
	// Set context value for all descendants
	handle.context.set({ theme: 'dark' })

	return () => (
		<div>
			<ThemedButton />
			<ThemedText />
		</div>
	)
}
```

**Getting Context (Consumer):**

Descendant components retrieve context using `handle.context.get()`, passing the
provider component as the key:

```tsx
import type { Handle } from 'remix/component'

function ThemedButton(handle: Handle) {
	// Get context from nearest ancestor ThemeProvider
	const theme = handle.context.get(ThemeProvider)

	return () => (
		<button
			css={{
				background: theme?.theme === 'dark' ? '#333' : '#fff',
				color: theme?.theme === 'dark' ? '#fff' : '#333',
			}}
		>
			Click me
		</button>
	)
}
```

**Key Features:**

- **Type Safety**: Context is fully typed via TypeScript generics -
  `Handle<{ theme: string }>` defines the context shape
- **Ancestor Lookup**: Automatically traverses up the component tree to find the
  nearest ancestor that provides the requested context
- **Scoped**: Each component instance can provide its own context, allowing
  nested providers with different values
- **Component-keyed**: Use the provider component function itself as the lookup
  key

**Full Example with Multiple Consumers:**

```tsx
import type { Handle } from 'remix/component'

// Provider component with typed context
function UserProvider(
	handle: Handle<{ user: { name: string; role: string } }>,
) {
	handle.context.set({ user: { name: 'Alice', role: 'admin' } })

	return () => (
		<div>
			<UserGreeting />
			<UserBadge />
		</div>
	)
}

// Consumer component 1
function UserGreeting(handle: Handle) {
	const ctx = handle.context.get(UserProvider)

	return () => <h1>Welcome, {ctx?.user.name}!</h1>
}

// Consumer component 2
function UserBadge(handle: Handle) {
	const ctx = handle.context.get(UserProvider)

	return () => (
		<span
			css={{
				padding: '4px 8px',
				background: ctx?.user.role === 'admin' ? '#ef4444' : '#3b82f6',
				borderRadius: '4px',
				color: 'white',
			}}
		>
			{ctx?.user.role}
		</span>
	)
}
```

#### Known Bug: DOM insertBefore Error

There's a known bug in Remix components where navigating with the client-side
router can sometimes cause this console error:

```
Uncaught NotFoundError: Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.
```

**Workaround:** If you see this error while testing, simply refresh the page.
This is a framework-level issue that doesn't indicate a problem with your code.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MarkdownPreview, PREVIEW_DEBOUNCE_MS } from './markdown-preview'

// Pre-warm the lazy chunk's dependency graph so its transform happens once at
// module collection time instead of inside the first test's Suspense (cold
// transform of react-markdown's micromark tree takes >20s under vitest). The
// component still loads them via its own dynamic import; this just makes the
// first Suspense resolution fast.
await import('react-markdown')
await import('remark-gfm')

// React's act() wants this flag set under jsdom (silences its warning).
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: Root | null = null

// The renderer is loaded via React.lazy + a dynamic import, so the Suspense
// boundary must resolve before the content is queryable. Poll (outside act)
// until the rendered content actually appears: the pre-warmed chunk resolves
// in microseconds, so a tight timeout fails fast instead of spinning a 10s
// real-time deadline (React won't flush the lazy resolution inside an
// in-act macrotask poll, which is why the old loop always ran to expiry).
async function renderPreview(text: string) {
	host = document.createElement('div')
	document.body.appendChild(host)
	root = createRoot(host)
	act(() => {
		root!.render(<MarkdownPreview text={text} />)
	})
	await vi.waitFor(
		() => {
			expect(host!.querySelector('.markdown-preview')?.childElementCount).toBeGreaterThan(0)
		},
		{ timeout: 2000, interval: 5 },
	)
	return host
}

afterEach(() => {
	if (root) {
		act(() => {
			root!.unmount()
		})
		root = null
	}
	if (host) {
		host.remove()
		host = null
	}
})

describe('MarkdownPreview', () => {
	it(
		'renders headings, paragraphs, links, and a GFM table',
		async () => {
			const el = await renderPreview(
				[
					'# Title',
					'',
					'Some [link](https://example.com) text.',
					'',
					'| a | b |',
					'|---|---|',
					'| 1 | 2 |',
				].join('\n'),
			)
			expect(el.querySelector('h1')?.textContent).toBe('Title')
			expect(el.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
			expect(el.textContent).toContain('link')
			expect(el.querySelector('table')).not.toBeNull()
			expect(el.querySelector('td')?.textContent).toBe('1')
		},
	)

	it(
		'renders raw HTML as inert text, never injecting elements',
		async () => {
			const el = await renderPreview('hello\n\n<img src=x onerror="alert(1)">\n\nafter')
			// Escape-by-default: the snippet stays literal text, no <img> element
			// is created and no onerror attribute can ever fire.
			expect(el.querySelector('img')).toBeNull()
			expect(el.textContent).toContain('<img src=x onerror="alert(1)">')
			expect(el.textContent).toContain('hello')
			expect(el.textContent).toContain('after')
		},
	)

	it(
		'preserves data:image URIs on markdown images but blocks dangerous urls',
		async () => {
			const dataUri =
				'data:image/svg+xml;base64,' +
				Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="40"/>').toString('base64')
			const el = await renderPreview(
				`A wide image:\n\n![w](${dataUri})\n\n[bad](javascript:alert(1))\n\n[d](data:text/html,<script>x</script>)`,
			)
			// The markdown image's data:image src is preserved (writers embed
			// inline art as data URIs; an <img> data: payload never executes).
			const img = el.querySelector('img')
			expect(img).not.toBeNull()
			expect(img?.getAttribute('src')).toBe(dataUri)
			// javascript: and non-image data: urls are still stripped by the
			// default transform (href emptied).
			const links = Array.from(el.querySelectorAll('a'))
			expect(links.length).toBe(2)
			expect(links[0]?.getAttribute('href')).toBe('')
			expect(links[1]?.getAttribute('href')).toBe('')
		},
	)

	it(
		'debounces live updates: preview lags the draft by PREVIEW_DEBOUNCE_MS',
		async () => {
			const el = await renderPreview('first draft')
			expect(el.querySelector('p')?.textContent).toBe('first draft')

			// Re-render with a new draft; the pane must NOT update synchronously
			// (the trailing debounce window has not elapsed). Fake timers let us
			// observe the quiet window and its expiry without real time.
			vi.useFakeTimers()
			try {
				await act(async () => {
					root!.render(<MarkdownPreview text="second draft" />)
					await Promise.resolve()
				})
				expect(el.querySelector('p')?.textContent).toBe('first draft')
				// Advance past the trailing debounce, then the pane catches up.
				act(() => {
					vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS + 1)
				})
				expect(el.querySelector('p')?.textContent).toBe('second draft')
			} finally {
				vi.useRealTimers()
			}
		},
	)
})

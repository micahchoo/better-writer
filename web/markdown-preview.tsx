import { Suspense, lazy, useEffect, useState } from 'react'

// Trailing debounce for the live rendered pane (milliseconds). Markdown
// rendering is O(doc), so the pane is decoupled from the keystroke hot path:
// the editor dispatches a `text` prop change on every keystroke, but the pane
// only re-renders after this much quiet time. Cost is bounded to one render
// per quiet stretch instead of one per key; the tradeoff is the rendered pane
// lags typing by this window (typing fast never pays the render, stopping
// briefly does).
export const PREVIEW_DEBOUNCE_MS = 250

// Toggled rendered preview (single-pane 'full' or side-by-side 'split'). The
// whole renderer (react-markdown + remark-gfm) is loaded via React.lazy +
// dynamic import so it lands in a SEPARATE vite chunk: the main bundle stays
// flat and the typing hot path never pays an O(doc) render cost unless the
// pane is actually open.
//
// Escape-by-default is the safety contract here: react-markdown renders raw
// HTML as literal text unless a rehype HTML plugin is added, and we
// deliberately add NONE (no rehype-raw, no dangerouslySetInnerHTML). A
// hostile snippet like `<img src=x onerror=...>` stays inert text.
//
// URL safety: react-markdown's default transform strips any url that is not a
// safe protocol (javascript:, vbscript:, file:, data: for non-images, …). We
// keep that blocking behavior for EVERY url except markdown-image `src`
// values that are `data:image/*` URIs — writers routinely embed generated or
// inline art as data URIs, and an `<img>` data: payload never executes
// scripts (raw HTML stays escaped regardless), so allowing it is safe. Links
// and all other attributes still go through the default transform.
const Inner = lazy(async () => {
	const [{ default: ReactMarkdown, defaultUrlTransform }, { default: remarkGfm }] = await Promise.all([
		import('react-markdown'),
		import('remark-gfm'),
	])
	const transformUrl = (url: string, key: string, node: unknown): string => {
		const n = node as { tagName?: string } | null
		if (key === 'src' && n?.tagName === 'img' && /^data:image\//i.test(url)) {
			return url
		}
		return defaultUrlTransform(url)
	}
	return {
		default: (p: { text: string }) => (
			<ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={transformUrl}>
				{p.text}
			</ReactMarkdown>
		),
	}
})

export function MarkdownPreview({ text }: { text: string }) {
	// Show the current draft immediately on mount/toggle, then lag subsequent
	// edits by the trailing debounce so re-renders never sit in the keystroke
	// hot path.
	const [displayed, setDisplayed] = useState(text)
	useEffect(() => {
		const t = setTimeout(() => setDisplayed(text), PREVIEW_DEBOUNCE_MS)
		return () => clearTimeout(t)
	}, [text])
	return (
		<div className="markdown-preview">
			<Suspense fallback="Loading…">
				<Inner text={displayed} />
			</Suspense>
		</div>
	)
}

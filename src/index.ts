/**
 * The MC百科 (mcmod.cn) content source.
 *
 * A Chinese Minecraft wiki: it catalogues 模组 (mods) and 整合包 (modpacks),
 * each with a Chinese name, a Chinese description, and the game versions and
 * loaders it supports. It has no API — everything below is read out of the
 * server-rendered HTML, which is why the parsing lives in its own small
 * helpers instead of a typed client.
 *
 * The two sections are the two content types, and they share a page shape:
 *
 * - 模组     `/class/<id>.html`, listed under `/modlist.html?category=<id>`
 * - 整合包   `/modpack/<id>.html`, listed under `/modpack/`
 *
 * **This source cannot install anything.** mcmod's own downloads sit behind a
 * captcha (`/frame/class/DownloadCaptcha/`), so `resolve_download` is declared
 * false and no `resolveDownload` is registered; the launcher degrades to
 * browsing, and every entry links on to its page on the site. Reading the site
 * is what robots.txt permits — it only disallows the add/edit endpoints.
 */

import type {
	ContentCard,
	ContentFilterGroup,
	ContentFilterOption,
	ContentPage,
	ContentProject,
	ContentQuery,
	ContentSourceApi,
} from '@celestial/content-source'

const SITE = 'https://www.mcmod.cn'
const SEARCH_SITE = 'https://search.mcmod.cn'

/** The listing and detail URL for a content type. */
function sectionOf(contentType: string): {
	listing: (categoryId: string | undefined, page: number) => string
	detail: (id: string) => string
} {
	if (contentType === 'modpack') {
		return {
			listing: (_categoryId, page) => `${SITE}/modpack/?&page=${page}`,
			detail: (id) => `${SITE}/modpack/${encodeURIComponent(id)}.html`,
		}
	}
	return {
		listing: (categoryId, page) =>
			categoryId
				? `${SITE}/class/category/${encodeURIComponent(categoryId)}-${page}.html`
				: `${SITE}/modlist.html?page=${page}`,
		detail: (id) => `${SITE}/class/${encodeURIComponent(id)}.html`,
	}
}

/** mcmod writes most of its own links protocol-relative (`//i.mcmod.cn/…`). */
function absolute(url: string | null | undefined): string | undefined {
	if (!url) return undefined
	if (url.startsWith('//')) return `https:${url}`
	if (url.startsWith('/')) return `${SITE}${url}`
	return url
}

/** The numeric id a class or modpack link points at. */
function idFromHref(href: string | null | undefined, section: 'class' | 'modpack'): string | undefined {
	if (!href) return undefined
	const match = href.match(new RegExp(`/${section}/(\\d+)(?:\\.html)?`))
	return match?.[1]
}

/**
 * A listing title comes through as the site prints it — an abbreviation in
 * brackets, the Chinese name, then the English name in parentheses:
 * `[JEI] JEI物品管理器 (Just Enough Items)`. The abbreviation is the site's own
 * short handle for the entry, not part of its name, and the English name is
 * worth its own line on a card rather than being glued to the Chinese one.
 */
function splitTitle(raw: string): { name: string; english?: string } {
	const trimmed = raw.replace(/\s+/g, ' ').trim()
	const withoutShort = trimmed.replace(/^\[[^\]]{1,12}\]\s*/, '')
	const parenthesised = withoutShort.match(/^(.*?)\s*\(([^()]+)\)\s*$/)
	if (parenthesised?.[1]?.trim() && parenthesised[2]?.trim()) {
		return { name: parenthesised[1].trim(), english: parenthesised[2].trim() }
	}
	return { name: withoutShort || trimmed }
}

/** The total the site prints in its pager; the entries' own count otherwise. */
function totalFromDoc(doc: Document, fallback: number): number {
	const pager = doc.querySelector('.pagination, .page-list, ul.pagination')
	const text = pager?.textContent?.replace(/,/g, '') ?? ''
	const numbers = text.match(/\d+/g)
	if (!numbers || numbers.length === 0) return fallback
	return Number(numbers[numbers.length - 1]) || fallback
}

export async function activate(api: ContentSourceApi) {
	async function fetchDoc(url: string): Promise<Document> {
		const response = await api.net.fetch(url, {
			headers: { accept: 'text/html,application/xhtml+xml' },
		})
		if (!response.ok) {
			throw new Error(`MC百科 ${response.status} ${url}`)
		}
		return new DOMParser().parseFromString(response.body, 'text/html')
	}

	/**
	 * One entry out of a listing. The two sections use different container
	 * classes for the same four things — a cover, a name, an optional English
	 * name, and (on the category pages only) a view count.
	 */
	function cardFromListing(el: Element, contentType: string): ContentCard | null {
		const section = contentType === 'modpack' ? 'modpack' : 'class'
		const anchor =
			el.querySelector('.title .name a') ??
			el.querySelector('.name a') ??
			el.querySelector('a[href]')
		const id = idFromHref(anchor?.getAttribute('href'), section)
		const raw =
			el.querySelector('.title .name')?.textContent?.trim() ?? anchor?.textContent?.trim() ?? ''
		if (!id || !raw) return null

		const { name, english } = splitTitle(raw)
		const englishCell = el.querySelector('.title .ename')?.textContent?.trim()
		const cover = el.querySelector('img')?.getAttribute('src')

		// The category pages print an abbreviated view count in the text and the
		// full number in the tooltip. Only those pages carry it; the full
		// catalogue listing has no counts at all, and a card without one is left
		// without rather than given a made-up zero.
		const views = el.querySelector('.num')?.getAttribute('title')

		return {
			sourceId: api.source.id,
			id,
			contentType: contentType as ContentCard['contentType'],
			name,
			summary: englishCell || english || undefined,
			iconUrl: absolute(cover),
			downloads: views ? Number(views.replace(/[^\d]/g, '')) || undefined : undefined,
		}
	}

	/** One entry out of a search result. */
	function cardFromResult(el: Element, contentType: string): ContentCard | null {
		const section = contentType === 'modpack' ? 'modpack' : 'class'
		const anchor =
			el.querySelector(`.head a[href*="/${section}/"]`) ?? el.querySelector('a[href]')
		const id = idFromHref(anchor?.getAttribute('href'), section)
		if (!id) return null

		const { name, english } = splitTitle(anchor?.textContent ?? '')
		if (!name) return null

		const excerpt = el.querySelector('.body')?.textContent?.replace(/\s+/g, ' ').trim()
		const updated = Array.from(el.querySelectorAll('.foot .info')).find((info) =>
			(info.textContent ?? '').includes('更新'),
		)

		return {
			sourceId: api.source.id,
			id,
			contentType: contentType as ContentCard['contentType'],
			name,
			summary: excerpt ? excerpt.slice(0, 200) : english,
			iconUrl: undefined,
			updatedAt: dateFromText(updated?.querySelector('.value')?.textContent),
		}
	}

	/** `2026-10-01` as the site prints it, or undefined for anything else. */
	function dateFromText(text: string | null | undefined): string | undefined {
		const match = text?.match(/\d{4}-\d{2}-\d{2}/)
		return match?.[0]
	}

	/**
	 * The categories, as the site's own nav prints them: an id and a Chinese
	 * name. Read once and kept — the list changes about as often as the site
	 * does, and every listing page carries the same nav.
	 */
	let categoryCache: ContentFilterOption[] | null = null

	async function categories(): Promise<ContentFilterOption[]> {
		if (categoryCache) return categoryCache
		const doc = await fetchDoc(`${SITE}/modlist.html`)
		const options: ContentFilterOption[] = []
		const seen = new Set<string>()
		for (const link of Array.from(
			doc.querySelectorAll('a[href*="modlist.html?category="]'),
		)) {
			const id = link.getAttribute('href')?.match(/category=(\d+)/)?.[1]
			const label = link.textContent?.trim()
			if (!id || !label || seen.has(id)) continue
			seen.add(id)
			options.push({ id, label })
		}
		categoryCache = options
		return options
	}

	async function listing(
		request: ContentQuery,
		categoryId: string | undefined,
	): Promise<ContentPage> {
		const section = sectionOf(request.contentType)
		const doc = await fetchDoc(section.listing(categoryId, request.page))

		// The category pages wrap each entry in `div.block`; the modpack and full
		// catalogue listings use `div.modlist-block`. Both carry the same parts.
		const entries = Array.from(doc.querySelectorAll('div.modlist-block, div.block'))
		const items = entries
			.map((entry) => cardFromListing(entry, request.contentType))
			.filter((card): card is ContentCard => card !== null)

		return { items, total: totalFromDoc(doc, items.length) }
	}

	async function browse(request: ContentQuery): Promise<ContentPage> {
		const selected = request.filters?.category
		return listing(request, Array.isArray(selected) ? selected[0] : undefined)
	}

	async function search(request: ContentQuery): Promise<ContentPage> {
		const needle = request.query?.trim()
		if (!needle) return browse(request)

		const url = `${SEARCH_SITE}/s?key=${encodeURIComponent(needle)}&p=${request.page}`
		const doc = await fetchDoc(url)
		const items = Array.from(doc.querySelectorAll('.search-result-list .result-item'))
			.map((entry) => cardFromResult(entry, request.contentType))
			.filter((card): card is ContentCard => card !== null)

		return { items, total: totalFromDoc(doc, items.length) }
	}

	/** The entry's game versions and loaders, as the page's version layer prints them. */
	function gameVersionsAndLoaders(doc: Document): {
		gameVersions: string[]
		loaders: string[]
	} {
		const layer = doc.querySelector('.layer-version')
		const values = Array.from(layer?.querySelectorAll('a, span, li') ?? [])
			.map((node) => node.textContent?.trim() ?? '')
			.filter((value) => value.length > 0 && value.length < 24)

		const loaders: string[] = []
		const gameVersions: string[] = []
		for (const value of values) {
			// The layer is a flat run of chips: loaders by name, game versions as
			// numbers. Each is filed where the launcher's own columns expect it.
			if (/^\d/.test(value)) {
				if (!gameVersions.includes(value)) gameVersions.push(value)
			} else if (/^(forge|fabric|neoforge|quilt|liteloader|rift|vanilla)$/i.test(value)) {
				const loader = value.toLowerCase()
				if (!loaders.includes(loader)) loaders.push(loader)
			}
		}
		return { gameVersions, loaders }
	}

	/**
	 * The entry's description, as the site renders it. It arrives as HTML with
	 * mcmod's own wrapper elements, so it is handed over as-is — the launcher
	 * sanitises a source's body anyway — after its protocol-relative image and
	 * link targets are made absolute, since a `//i.mcmod.cn/…` would otherwise
	 * resolve against the launcher's own origin.
	 */
	function descriptionOf(doc: Document): string | undefined {
		const body = doc.querySelector('.text-area.common-text')
		if (!body) return undefined

		const clone = body.cloneNode(true) as Element
		for (const node of Array.from(clone.querySelectorAll('[src], [href]'))) {
			for (const attribute of ['src', 'href']) {
				const value = node.getAttribute(attribute)
				const fixed = absolute(value)
				if (fixed) node.setAttribute(attribute, fixed)
			}
		}
		// Scripts and inline styles are the site's own furniture, not content.
		for (const node of Array.from(clone.querySelectorAll('script, style'))) node.remove()

		const html = clone.innerHTML.trim()
		return html.length > 0 ? html : undefined
	}

	/** The cover the entry's page paints as its backdrop. */
	function coverOf(doc: Document): string | undefined {
		const html = doc.documentElement.innerHTML
		const match = html.match(/common-background\{background-image:url\(["']?([^"')]+)/)
		return absolute(match?.[1])
	}

	async function detail(id: string, contentType: string): Promise<ContentProject> {
		const doc = await fetchDoc(sectionOf(contentType).detail(id))

		const title = doc.querySelector('.class-title')
		const raw =
			title?.querySelector('h3')?.textContent?.trim() ??
			doc.querySelector('h1')?.textContent?.trim() ??
			id
		const { name, english } = splitTitle(raw)
		const englishName = title?.querySelector('h4')?.textContent?.trim() || english
		const shortName = title?.querySelector('.short-name')?.textContent?.trim()
		const { gameVersions, loaders } = gameVersionsAndLoaders(doc)

		const tags = Array.from(doc.querySelectorAll('.common-class-category a'))
			.map((node) => node.textContent?.trim() ?? '')
			.filter((label) => label.length > 0)

		return {
			sourceId: api.source.id,
			id,
			contentType: contentType as ContentCard['contentType'],
			name,
			summary: englishName || undefined,
			iconUrl: coverOf(doc),
			gameVersions,
			loaders,
			tags: [shortName, ...tags].filter((tag): tag is string => Boolean(tag)),
			body: descriptionOf(doc),
			links: [{ label: '在 MC百科 查看', url: sectionOf(contentType).detail(id) }],
		}
	}

	api.register({
		search,
		browse,

		/**
		 * The site's own categories, offered as the sidebar's 类别 section so a
		 * tick narrows the list to that category — the same ids the listing URLs
		 * take.
		 */
		async filters(contentType: string): Promise<ContentFilterGroup[]> {
			if (contentType === 'modpack') return []
			const options = await categories()
			if (options.length === 0) return []
			return [{ id: 'category', header: 'categories', options }]
		},

		detail,
	})
}

/**
 * The MC百科 (mcmod.cn) content source.
 *
 * A Chinese Minecraft wiki: it catalogues 模组 (mods) and 整合包 (modpacks), each
 * with a Chinese name, a Chinese one-line summary and a long Chinese body, plus
 * the game versions and loaders it supports. It has no API — everything below is
 * read out of the server-rendered HTML, which is why the parsing lives in small
 * named helpers instead of a typed client.
 *
 * The two sections are the two content types and each has its own listing page:
 *
 * - 模组     `/modlist.html`, entries under `/class/<id>.html`
 * - 整合包   `/modpack.html`, entries under `/modpack/<id>.html`
 *
 * **This source cannot install anything.** mcmod's own downloads sit behind a
 * captcha (`/frame/class/DownloadCaptcha/`), so `resolve_download` is declared
 * false and no `resolveDownload` is registered; the launcher degrades to
 * browsing and every entry links on to its page on the site. Reading the site is
 * what robots.txt permits — it only disallows the add/edit endpoints.
 *
 * Two things about the site are worth knowing before reading the queries below:
 *
 * - Its filter block is **single-select** (`?category=1&category=2` keeps only
 *   one of them), so several ticked options are answered by asking once per
 *   option and merging, rather than by one request with several values.
 * - Only the listing pages carry a keyword filter for mods; the modpack listing
 *   ignores `key`, so a modpack search goes to the site's own search host and
 *   comes back without covers.
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

/**
 * The site's own 「运作方式」 numbering, which each section numbers differently:
 * NeoForge is 13 among mods and 7 among modpacks. Mapped from the loader names
 * the launcher uses (Modrinth's loader tags), so an instance's loader narrows
 * the list.
 */
const MOD_LOADERS: Record<string, string> = {
	forge: '1',
	fabric: '2',
	quilt: '11',
	neoforge: '13',
	rift: '3',
	liteloader: '4',
	nilloader: '14',
	cleanroom: '15',
	'java-agent': '17',
}

const MODPACK_LOADERS: Record<string, string> = {
	forge: '1',
	fabric: '2',
	quilt: '3',
	liteloader: '5',
	rift: '6',
	neoforge: '7',
}

/** The site's own single-select filters that have no launcher equivalent. */
const STATIC_GROUPS: Record<string, { id: string; header: string; options: ContentFilterOption[] }[]> = {
	mod: [
		{
			id: 'status',
			header: '官方状态',
			options: [
				{ id: '1', label: '活跃' },
				{ id: '2', label: '半弃坑' },
				{ id: '3', label: '停更' },
			],
		},
		{
			id: 'mode',
			header: '运行环境',
			options: [
				{ id: '1', label: '仅客户端' },
				{ id: '2', label: '仅服务端' },
				{ id: '3', label: '主客户端' },
				{ id: '4', label: '主服务端' },
				{ id: '5', label: '皆需安装' },
				{ id: '6', label: '皆为选装' },
			],
		},
	],
	modpack: [
		{
			id: 'mold',
			header: '整合包类型',
			options: [
				{ id: '1', label: '原生整合' },
				{ id: '2', label: '魔改整合' },
			],
		},
		{
			id: 'pack',
			header: '打包方式',
			options: [
				{ id: '1', label: 'CurseForge 托管' },
				{ id: '2', label: 'FTB 整合包' },
				{ id: '3', label: '其他启动器打包' },
				{ id: '4', label: '手动精简打包' },
				{ id: '5', label: 'ATLauncher 打包' },
				{ id: '6', label: 'Modrinth 托管' },
				{ id: '100', label: '其他方式' },
			],
		},
	],
}

/** The section a content type is read from. */
function sectionOf(contentType: string): {
	listing: string
	detail: (id: string) => string
	kind: 'class' | 'modpack'
} {
	if (contentType === 'modpack') {
		return {
			listing: `${SITE}/modpack.html`,
			detail: (id) => `${SITE}/modpack/${encodeURIComponent(id)}.html`,
			kind: 'modpack',
		}
	}
	return {
		listing: `${SITE}/modlist.html`,
		detail: (id) => `${SITE}/class/${encodeURIComponent(id)}.html`,
		kind: 'class',
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
function idFromHref(
	href: string | null | undefined,
	kind: 'class' | 'modpack',
): string | undefined {
	if (!href) return undefined
	return href.match(new RegExp(`/${kind}/(\\d+)(?:\\.html)?`))?.[1]
}

/** The category id a listing link carries, in either of the site's URL shapes. */
function categoryIdFromHref(href: string | null | undefined): string | undefined {
	if (!href) return undefined
	return (
		href.match(/[?&]category=(\d+)/)?.[1] ??
		href.match(/\/category\/(\d+)-\d+\.html/)?.[1]
	)
}

/**
 * A listing title comes through as the site prints it — an abbreviation in
 * brackets, the Chinese name, then sometimes the English name in parentheses:
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

/**
 * The site's outbound links are wrapped: `//link.mcmod.cn/target/<base64>` is
 * the real destination, base64-encoded, with the label beside it. Decoding it
 * is what turns a row of site-internal redirects into links a reader recognises.
 */
function decodeLink(href: string | null | undefined): string | undefined {
	if (!href) return undefined
	const encoded = href.match(/link\.mcmod\.cn\/target\/([A-Za-z0-9+/=]+)/)?.[1]
	if (!encoded) return absolute(href)
	try {
		const binary = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='))
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
		const decoded = new TextDecoder().decode(bytes)
		return /^https?:\/\//.test(decoded) ? decoded : undefined
	} catch {
		return undefined
	}
}

/**
 * The total the site prints. The two listings print it in their pager
 * (`当前 1 / 979 页，共计 31303 条。`) and the search host in its own info line
 * (`找到约 287 条结果，共约 10 页。`), so both shapes are tried before the page's
 * own count.
 *
 * The search host's line is matched first and on its own: it names a page count
 * as well as a result count, and a looser pattern over the whole string would
 * take the pages (`共约 10 页`) for the entries.
 */
function totalFromDoc(doc: Document, fallback: number): number {
	const info = doc.querySelector('.search-result .info')?.textContent ?? ''
	const fromSearch = info.match(/找到约\s*([\d,]+)\s*条/)
	if (fromSearch) return Number(fromSearch[1].replace(/,/g, '')) || fallback

	const pager = doc.querySelector('.pagination, .page-list')?.textContent ?? ''
	const fromPager = pager.match(/共计\s*([\d,]+)\s*条/)
	if (fromPager) return Number(fromPager[1].replace(/,/g, '')) || fallback

	return fallback
}

/** `2026-10-01` as the search results print it, or undefined for anything else. */
function dateFromText(text: string | null | undefined): string | undefined {
	return text?.match(/\d{4}-\d{2}-\d{2}/)?.[0]
}

/** `2015-12-23 00:08:13` as the detail page keeps it, as an ISO timestamp. */
function timestampFromText(text: string | null | undefined): string | undefined {
	const match = text?.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
	return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}` : undefined
}

/** The `title` attribute the site keeps the exact number in, e.g. `浏览：530650`. */
function countFromTitle(text: string | null | undefined): number | undefined {
	const digits = text?.replace(/[^\d]/g, '')
	return digits ? Number(digits) || undefined : undefined
}

/**
 * The first real paragraph of a body, for an entry whose page prints no English
 * name. The site's own bodies open with a heading chip (`概述`, `整合包介绍`),
 * so the tags are stripped before the text is read.
 */
function openingParagraph(body: string | undefined): string | undefined {
	if (!body) return undefined
	const paragraph = body.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1]
	const text = (paragraph ?? '')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
	return text.length > 0 ? text.slice(0, 200) : undefined
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
	 * Fetch several pages at once, keeping the ones that answered.
	 *
	 * A browse with several categories ticked is several requests, and one of them
	 * failing should not lose the others — the site is slow and rate-limits (429),
	 * so a partial answer is the common case rather than the exceptional one. When
	 * *every* request fails the error is rethrown, so the launcher reports the
	 * source as failed instead of silently empty. Nothing is retried: the site's
	 * limiter is not something to hammer at, and the launcher re-asks on its own.
	 */
	async function fetchDocs(urls: string[]): Promise<Document[]> {
		const settled = await Promise.allSettled(urls.map((url) => fetchDoc(url)))
		const docs: Document[] = []
		const failures: string[] = []
		for (const result of settled) {
			if (result.status === 'fulfilled') docs.push(result.value)
			else failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason))
		}
		if (docs.length === 0) {
			throw new Error(failures[0] ?? 'MC百科 请求失败')
		}
		if (failures.length > 0) {
			api.log(`部分请求失败，已用其余结果继续：${failures.join('；')}`)
		}
		return docs
	}

	/**
	 * Every category the site offers for one section, as id and label.
	 *
	 * Each listing page names its own section's categories in two places, and
	 * neither is complete: the header nav names the headline few but no others,
	 * and the listing's own filter block carries all of them but prints the
	 * headline ones as bare icons. Merged, they cover the section, and the filter
	 * block's own label wins where the two disagree — it is the one the site shows
	 * beside the filter. The two sections are read from their own pages, since
	 * neither page lists the other's.
	 */
	const categoryCache = new Map<string, ContentFilterOption[]>()

	async function categories(contentType: string): Promise<ContentFilterOption[]> {
		const cached = categoryCache.get(contentType)
		if (cached) return cached

		const doc = await fetchDoc(sectionOf(contentType).listing)
		const byId = new Map<string, ContentFilterOption>()
		// The two sections are told apart by the listing a link points at, never by
		// the page it was read from: each page carries both sections' navs, and the
		// links are written protocol-relative, so only the path is comparable.
		const listing = sectionOf(contentType).listing.replace(SITE, '')

		// The nav's named few, which the filter block prints as icons only.
		for (const link of Array.from(doc.querySelectorAll('.layer-category a'))) {
			const href = link.getAttribute('href') ?? ''
			const id = categoryIdFromHref(href)
			const label = link.textContent?.trim()
			if (id && label && href.includes(listing)) byId.set(id, { id, label })
		}
		// The filter block, which carries every category — the named ones as bare
		// icons, which keep the name the nav gave them.
		for (const link of Array.from(doc.querySelectorAll('a[onclick*="category="]'))) {
			const onclick = link.getAttribute('onclick') ?? ''
			if (!onclick.includes(listing)) continue
			const id = onclick.match(/[?&]category=(\d+)/)?.[1]
			if (!id) continue
			const label = link.textContent?.trim()
			if (label) byId.set(id, { id, label })
			else if (!byId.has(id)) byId.set(id, { id, label: id })
		}

		const options = [...byId.values()]
		categoryCache.set(contentType, options)
		return options
	}

	/**
	 * The site's own query parameters for a request: its loader numbering, its
	 * version and sort names. `key` and `category` are added by the caller, since
	 * which of them a request uses is what tells a browse from a search.
	 */
	function listingParams(request: ContentQuery): URLSearchParams {
		const params = new URLSearchParams()
		const loaders = sectionOf(request.contentType).kind === 'modpack'
			? MODPACK_LOADERS
			: MOD_LOADERS

		if (request.loader && loaders[request.loader.toLowerCase()]) {
			params.set('api', loaders[request.loader.toLowerCase()])
		}
		if (request.gameVersion) params.set('mcver', request.gameVersion)
		if (request.sort === 'newest') params.set('sort', 'createtime')
		if (request.sort === 'updated') params.set('sort', 'lastedittime')
		return params
	}

	/** A listing page for one category, one page, and whatever else the request asks. */
	function listingUrl(request: ContentQuery, categoryId: string | undefined): string {
		const params = listingParams(request)
		if (categoryId) params.set('category', categoryId)
		params.set('page', String(request.page))
		return `${sectionOf(request.contentType).listing}?${params}`
	}

	/**
	 * One entry out of a listing. Every entry carries a cover, a name, an
	 * optional English name and a one-line Chinese summary; nothing else — the
	 * listing prints no counts at all, so a card without one is left without
	 * rather than given a made-up zero.
	 */
	function cardFromListing(el: Element, contentType: string): ContentCard | null {
		const kind = sectionOf(contentType).kind
		const anchor = el.querySelector('.title .name a') ?? el.querySelector('a[href]')
		const id = idFromHref(anchor?.getAttribute('href'), kind)
		const raw = anchor?.textContent?.trim() ?? ''
		if (!id || !raw) return null

		const { name, english } = splitTitle(raw)
		const englishCell = el.querySelector('.ename')?.textContent?.trim()
		const intro = el.querySelector('.intro-content span')?.textContent?.replace(/\s+/g, ' ').trim()
		const cover = el.querySelector('.cover img')?.getAttribute('src')

		return {
			sourceId: api.source.id,
			id,
			contentType: contentType as ContentCard['contentType'],
			name,
			summary: intro || englishCell || english || undefined,
			iconUrl: absolute(cover),
		}
	}

	/**
	 * One entry out of the search host's results.
	 *
	 * The result's own heading is the *second* link in `.head`: the first is the
	 * category icon, which points at a listing and carries no entry id. Only the
	 * direct child is the entry, and it is an absolute URL rather than the
	 * protocol-relative one the listings use.
	 */
	function cardFromResult(el: Element, contentType: string): ContentCard | null {
		const kind = sectionOf(contentType).kind
		const anchor = el.querySelector('.head > a')
		const id = idFromHref(anchor?.getAttribute('href'), kind)
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
			updatedAt: dateFromText(updated?.querySelector('.value')?.textContent),
		}
	}

	/**
	 * Read the entries out of one or more listing pages and merge them.
	 *
	 * The site takes one category per request, so several ticked options arrive as
	 * several pages; the same entry can appear on more than one of them, and the
	 * totals are summed because the site reports each page's own count rather than
	 * the union's. This is the shape the launcher's own merge uses too: page N of
	 * the merged list is page N from each answer.
	 */
	function collect(docs: Document[], contentType: string): ContentPage {
		const seen = new Set<string>()
		const items: ContentCard[] = []
		let total = 0
		for (const doc of docs) {
			const cards = Array.from(doc.querySelectorAll('.modlist-block'))
				.map((entry) => cardFromListing(entry, contentType))
				.filter((card): card is ContentCard => card !== null)
			total += totalFromDoc(doc, cards.length)
			for (const card of cards) {
				if (seen.has(card.id)) continue
				seen.add(card.id)
				items.push(card)
			}
		}
		return { items, total }
	}

	/** The category ids a request ticks, as the site's own parameter takes them. */
	function requestedCategories(request: ContentQuery): string[] {
		const selected = request.filters?.category
		return Array.isArray(selected) ? selected : []
	}

	async function browse(request: ContentQuery): Promise<ContentPage> {
		const categories = requestedCategories(request)
		const wanted = categories.length > 0 ? categories : [undefined]
		const docs = await fetchDocs(wanted.map((categoryId) => listingUrl(request, categoryId)))
		return collect(docs, request.contentType)
	}

	async function search(request: ContentQuery): Promise<ContentPage> {
		const needle = request.query?.trim()
		if (!needle) return browse(request)

		if (sectionOf(request.contentType).kind === 'modpack') {
			// The modpack listing ignores `key` outright — the same query with and
			// without it answers identically — so a modpack search goes to the
			// site's search host, which is the one place that filters modpacks by
			// keyword. That host carries no cover and no category on a modpack
			// result, so a ticked category cannot narrow it; the launcher's own
			// cross-source filter still drops the whole source when a category it
			// cannot serve is the only one selected.
			const url = `${SEARCH_SITE}/s?key=${encodeURIComponent(needle)}&filter=2&page=${request.page}`
			const doc = await fetchDoc(url)
			const items = Array.from(doc.querySelectorAll('.search-result-list .result-item'))
				.map((entry) => cardFromResult(entry, request.contentType))
				.filter((card): card is ContentCard => card !== null)
			return { items, total: totalFromDoc(doc, items.length) }
		}

		// The mod listing does filter by keyword, and does it alongside every other
		// filter the sidebar offers, so a mod search stays on the same page shape as
		// a browse — covers and category filter included.
		const categories = requestedCategories(request)
		const wanted = categories.length > 0 ? categories : [undefined]
		const docs = await fetchDocs(
			wanted.map((categoryId) => {
				const params = listingParams(request)
				if (categoryId) params.set('category', categoryId)
				params.set('key', needle)
				params.set('page', String(request.page))
				return `${sectionOf(request.contentType).listing}?${params}`
			}),
		)
		return collect(docs, request.contentType)
	}

	/**
	 * The entry's supported game versions and loaders.
	 *
	 * The version block is one flat run of alternating children — a loader title
	 * (`Fabric (共 20 个版本):`) then the versions that loader runs — so the two are
	 * paired by walking the block rather than by nesting. A modpack with a single
	 * version prints its versions as bare links rather than dropdowns; both shapes
	 * are read. Nothing here reads the site's header nav, which lists every version
	 * the site knows about rather than the ones this entry supports.
	 */
	function gameVersionsAndLoaders(doc: Document): {
		gameVersions: string[]
		loaders: string[]
	} {
		const loaders: string[] = []
		const gameVersions: string[] = []

		for (const block of Array.from(doc.querySelectorAll('li.mcver .platform-block'))) {
			for (const child of Array.from(block.children)) {
				if (child.classList.contains('mcver-title')) {
					const loader = child.textContent?.trim().match(/^([A-Za-z][\w-]*)/)?.[1]
					const name = loader?.toLowerCase()
					if (name && !loaders.includes(name)) loaders.push(name)
					continue
				}
				// The version row that follows the loader title above it. Collapsed
				// groups print as buttons and are skipped; the expanded versions are
				// the links inside, whichever shape the row takes.
				for (const link of Array.from(child.querySelectorAll('.dropdown-item, a'))) {
					const version = link.textContent?.trim()
					if (!version || version === 'earlier') continue
					if (!gameVersions.includes(version)) gameVersions.push(version)
				}
			}
		}

		return { gameVersions, loaders }
	}

	/** The entry's own tags, as the page's tag row prints them. */
	function tagsOf(doc: Document): string[] {
		const row = Array.from(doc.querySelectorAll('.class-info-left li')).find((li) =>
			li.className.includes('tag'),
		)
		return Array.from(row?.querySelectorAll('ul li a') ?? [])
			.map((node) => node.textContent?.trim() ?? '')
			.filter((label) => label.length > 0)
	}

	/** The categories the entry is filed under, named through the category index. */
	async function categoriesOf(doc: Document, contentType: string): Promise<string[]> {
		const index = await categories(contentType).catch(() => [])
		const byId = new Map(index.map((option) => [option.id, option.label ?? option.id]))
		const ids = Array.from(doc.querySelectorAll('.common-class-category a, .class-category a'))
			.map((node) => categoryIdFromHref(node.getAttribute('href')))
			.filter((id): id is string => Boolean(id))
		return ids.map((id) => byId.get(id) ?? id)
	}

	/** The people the page credits, as its author row prints them. */
	function authorOf(doc: Document): string | undefined {
		const row = Array.from(doc.querySelectorAll('.class-info-left li')).find((li) =>
			li.className.includes('author'),
		)
		const names = Array.from(row?.querySelectorAll('.member .name a') ?? [])
			.map((node) => node.textContent?.trim() ?? '')
			.filter((name) => name.length > 0)
		if (names.length === 0) return undefined
		return names.length > 2 ? `${names.slice(0, 2).join('、')} 等 ${names.length} 人` : names.join('、')
	}

	/** One of the page's dated info rows, as the ISO timestamp it keeps in a tooltip. */
	function infoTimestamp(doc: Document, label: string): string | undefined {
		const row = Array.from(doc.querySelectorAll('.class-info-left li')).find((li) =>
			(li.textContent ?? '').includes(label),
		)
		return timestampFromText(row?.getAttribute('data-original-title'))
	}

	/**
	 * The entry's description, as the site renders it. It arrives as HTML, so it
	 * is handed over as-is — the launcher sanitises a source's body anyway — after
	 * two things are put right: its images are lazy-loaded (`src` is a placeholder
	 * and the real file sits in `data-src`), and its protocol-relative targets are
	 * made absolute, since a `//i.mcmod.cn/…` would otherwise resolve against the
	 * launcher's own origin.
	 */
	function descriptionOf(doc: Document): string | undefined {
		const body = doc.querySelector('.text-area.common-text')
		if (!body) return undefined

		const clone = body.cloneNode(true) as Element
		for (const node of Array.from(clone.querySelectorAll('img'))) {
			const lazy = node.getAttribute('data-src')
			const fixed = absolute(lazy)
			if (fixed) node.setAttribute('src', fixed)
			node.removeAttribute('data-src')
			node.removeAttribute('data-error')
			node.classList.remove('lazy')
		}
		for (const node of Array.from(clone.querySelectorAll('[src], [href]'))) {
			for (const attribute of ['src', 'href']) {
				const fixed = absolute(node.getAttribute(attribute))
				if (fixed) node.setAttribute(attribute, fixed)
			}
		}
		// Scripts and inline styles are the site's own furniture, not content.
		for (const node of Array.from(clone.querySelectorAll('script, style'))) node.remove()

		const html = clone.innerHTML.trim()
		return html.length > 0 ? html : undefined
	}

	/** The entry's outbound links, with the site's own redirect wrappers decoded. */
	function linksOf(doc: Document, contentType: string, id: string): ContentProject['links'] {
		const links: NonNullable<ContentProject['links']> = [
			{ label: '在 MC百科 查看', url: sectionOf(contentType).detail(id) },
		]
		for (const row of Array.from(doc.querySelectorAll('.common-link-frame .list li'))) {
			const url = decodeLink(row.querySelector('a')?.getAttribute('href'))
			const label =
				row.querySelector('.name')?.textContent?.trim() ||
				row.querySelector('a')?.getAttribute('data-original-title')?.split(':')[0]?.trim()
			if (url && label) links.push({ label, url })
		}
		return links
	}

	/**
	 * The entry's own page, and the only place the site prints a count for it.
	 *
	 * `总浏览` — the page's total views — is the closest thing mcmod has to a
	 * popularity figure, and is carried as `downloads` so the launcher's
	 * popularity sort has something to work with. It is a view count, not a
	 * download count; the site has no downloads to count.
	 */
	async function detail(id: string, contentType: string): Promise<ContentProject> {
		const doc = await fetchDoc(sectionOf(contentType).detail(id))

		const title = doc.querySelector('.class-title')
		const raw =
			title?.querySelector('h3')?.textContent?.trim() ??
			doc.querySelector('h1')?.textContent?.trim() ??
			id
		const englishName = title?.querySelector('h4')?.textContent?.trim()
		const { name, english } = splitTitle(raw)
		const { gameVersions, loaders } = gameVersionsAndLoaders(doc)
		const body = descriptionOf(doc)
		const viewCount = countFromTitle(
			doc.querySelector('.class-excount .infos .span')?.getAttribute('title'),
		)

		const tags = [...(await categoriesOf(doc, contentType).catch(() => [])), ...tagsOf(doc)]

		return {
			sourceId: api.source.id,
			id,
			contentType: contentType as ContentCard['contentType'],
			name,
			// The English name is the one-line handle the listing also shows; the
			// body's opening paragraph stands in when the page prints none.
			summary: englishName || english || openingParagraph(body),
			iconUrl: absolute(
				doc.querySelector('.class-cover-image img')?.getAttribute('src'),
			),
			author: authorOf(doc),
			downloads: viewCount,
			publishedAt: infoTimestamp(doc, '收录时间'),
			updatedAt: infoTimestamp(doc, '最后编辑'),
			gameVersions,
			loaders,
			tags: [...new Set(tags)],
			body,
			links: linksOf(doc, contentType, id),
		}
	}

	api.register({
		search,
		browse,

		/**
		 * The site's own filters, offered as sidebar sections. `categories` names
		 * a built-in header, so the categories merge into the launcher's own 类别
		 * section beside Modrinth's rather than standing as a second one.
		 */
		async filters(contentType: string): Promise<ContentFilterGroup[]> {
			const groups: ContentFilterGroup[] = []
			const options = await categories(contentType).catch(() => [])
			if (options.length > 0) {
				groups.push({ id: 'category', header: 'categories', options })
			}
			groups.push(...(STATIC_GROUPS[contentType] ?? []))
			return groups
		},

		detail,
	})
}

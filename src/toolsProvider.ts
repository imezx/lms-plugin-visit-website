import { tool, Tool, ToolsProviderController } from "@lmstudio/sdk";
import { writeFile } from "fs/promises";
import * as https from "node:https";
import * as http from "node:http";
import { setServers } from "node:dns";
import { join } from "path";
import { z } from "zod";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { configSchematics } from "./config";

setServers(["1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4"]);

export async function toolsProvider(ctl: ToolsProviderController): Promise<Tool[]> {
	const tools: Tool[] = [];

	const fetchHTML = async (url: string, signal: AbortSignal, _warn: (msg: string) => void) => {
		const headers = spoofHeaders(url);

		const maxAttempts = 3;
		let responseText: string | undefined;
		let lastError: any;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const timeoutController = new AbortController();
			const timeoutId = setTimeout(() => timeoutController.abort(), 15_000);

			const combined = AbortSignal.any
				? AbortSignal.any([signal, timeoutController.signal])
				: timeoutController.signal;

			try {
				const response = await fetch(url, { method: "GET", signal: combined, headers });
				if (!response.ok) {
					throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
				}
				responseText = await response.text();
				lastError = undefined;
				break;
			} catch (err: any) {
				const message: string = err?.cause?.message ?? err?.message ?? "";
				const isTlsError = /altnames|certificate|CERT_|SSL|TLS|self[._]signed/i.test(message);
				const isTimeout = timeoutController.signal.aborted && !signal.aborted;

				if (isTlsError) {
					try {
						responseText = await fetchInsecure(url, headers, signal);
						lastError = undefined;
						break;
					} catch (insecureErr: any) {
						lastError = insecureErr;
					}
				} else if (signal.aborted) {
					lastError = err;
					break;
				} else {
					lastError = isTimeout
						? new Error(`Request timed out after 15s (attempt ${attempt}/${maxAttempts})`)
						: err;
					if (attempt < maxAttempts) {
						await new Promise(resolve => setTimeout(resolve, 500));
					}
				}
			} finally {
				clearTimeout(timeoutId);
			}
		}

		if (lastError || responseText === undefined) {
			const reason = lastError?.cause?.message ?? lastError?.message ?? "unknown error";
			throw new Error(`Failed to reach ${url} after ${maxAttempts} attempts: ${reason}`);
		}

		const html = responseText;
		const headStart = html.indexOf("<head>");
		const headEnd = html.indexOf("</head>") + 7;
		const head = html.substring(headStart, headEnd);
		const bodyStart = html.match(/<body[^>]*>/)?.index || 0;
		const bodyEnd = html.lastIndexOf("</body>") || html.length - 1;
		const body = html.substring(bodyStart, bodyEnd);
		return { html, head, body };
	}

	const extractLinks = (doc: Document, baseUrl: string, maxLinks: number, searchTerms?: string[]) =>
		[...doc.querySelectorAll<HTMLAnchorElement>("a[href]")]
			.map((el, index) => {
				const link = el.href;
				const label = (el.textContent ?? "").replace(/\s+/g, " ").trim();
				return { index, label, link };
			})
			.filter(({ link }) => link.startsWith("http"))
			.map((x, index, { length }) => {
				const ratio = 1 / Math.min(1, /\d/g.exec(x.link)?.length || 1);
				const score
					= ratio * (100 - (x.label.length + x.link.length + (20 * index / length)))
					+ (1 - ratio) * x.label.split(/\s+/).length;
				return {
					...x,
					score: searchTerms?.length
						&& searchTerms.reduce((acc, term) => acc + (x.label.toLowerCase().includes(term.toLowerCase()) ? 1000 : 0), score)
						|| score,
				};
			})
			.sort((a, b) => b.score - a.score)
			.filter((x, i, arr) => !arr.find((y, j) => j < i && y.link === x.link))
			.slice(0, maxLinks)
			.map(({ label, link }) => [label, link] as [string, string]);

	const extractImages = (doc: Document, baseUrl: string, maxImages: number, searchTerms?: string[]) =>
		[...doc.querySelectorAll<HTMLImageElement>("img")]
			.map((el, index) => {
				const alt = el.getAttribute("alt") ?? "";

				const lazyAttrs = [
					"data-src", "data-lazy-src", "data-original", "data-url", "data-lazy",
				];
				let src: string | undefined;
				for (const attr of lazyAttrs) {
					const val = el.getAttribute(attr);
					if (val?.trim()) { src = val.trim(); break; }
				}

				if (!src) {
					const srcset = el.getAttribute("data-srcset") ?? el.getAttribute("srcset");
					if (srcset) src = srcset.split(/[\s,]+/)[0];
				}

				if (!src) src = el.src || undefined;

				if (src && src.startsWith("/")) src = new URL(src, baseUrl).href;

				return {
					index,
					alt,
					src,
					score: searchTerms?.length
						&& searchTerms.reduce((acc, term) => acc + (alt.toLowerCase().includes(term.toLowerCase()) ? 1000 : 0), alt.length)
						|| alt.length,
				};
			})
			.filter(({ src }) => src && src.startsWith("http") && /\.(svg|png|webp|gif|jpe?g)(\?.*)?$/i.test(src))
			.sort((a, b) => b.score - a.score)
			.slice(0, maxImages)
			.sort((a, b) => a.index - b.index)
			.map(({ src, alt }) => [alt, src] as [string, string]);

	const viewImagesTool = tool({
		name: "View Images",
		description: "Download images from a website or a list of image URLs to make them viewable.",
		parameters: {
			imageURLs: z.array(z.string().url()).optional().describe("List of image URLs to view that were not obtained via the Visit Website tool."),
			websiteURL: z.string().url().optional().describe("The URL of the website, whose images to view."),
			maxImages: z.number().int().min(1).max(200).optional().describe("Maximum number of images to view when websiteURL is provided."),
		},
		implementation: async ({ imageURLs, websiteURL, maxImages }, { status, warn, signal }) => {
			try {
				maxImages = undefinedIfAuto(ctl.getPluginConfig(configSchematics).get("maxImages"), -1)
					?? maxImages
					?? 10;

				const imageURLsToDownload = imageURLs || [];

				if (websiteURL) {
					status("Fetching image URLs from website...");

					const { html } = await fetchHTML(websiteURL, signal, warn);
					const websiteDom = new JSDOM(html, { url: websiteURL });
					const images = extractImages(websiteDom.window.document, websiteURL, maxImages).map(x => x[1]);
					imageURLsToDownload.push(...images);
				}

				status("Downloading images...");
				const workingDirectory = ctl.getWorkingDirectory();
				const timestamp = Date.now();
				const downloadPromises = imageURLsToDownload.map(async (url: string, i: number) => {
					if (url.startsWith(workingDirectory))
						return url;

					const index = i + 1;
					try {
						const headers = spoofHeaders(url);

						const imgTimeout = new AbortController();
						const imgTimeoutId = setTimeout(() => imgTimeout.abort(), 10_000);
						const imgSignal = AbortSignal.any
							? AbortSignal.any([signal, imgTimeout.signal])
							: imgTimeout.signal;

						let bytes: Uint8Array | undefined;
						let contentType = "";
						try {
							const imageResponse = await fetch(url, { method: "GET", signal: imgSignal, headers });
							if (!imageResponse.ok) {
								warn(`Failed to fetch image ${index}: ${imageResponse.statusText}`);
								return null;
							}
							contentType = imageResponse.headers.get("content-type") || "";
							bytes = await imageResponse.bytes();
						} catch (fetchErr: any) {
							const msg: string = fetchErr?.cause?.message ?? fetchErr?.message ?? "";
							const isTls = /altnames|certificate|CERT_|SSL|TLS|self[._]signed/i.test(msg);
							if (isTls && !signal.aborted) {
								const text = await fetchInsecure(url, headers, signal);
								bytes = Buffer.from(text, "binary");
							} else {
								throw fetchErr;
							}
						} finally {
							clearTimeout(imgTimeoutId);
						}

						if (!bytes || bytes.length === 0) {
							warn(`Image ${index} is empty: ${url}`);
							return null;
						}

						const fileExtension = /image\/([\w]+)/.exec(contentType)?.[1]
							|| /\.([\w]+)(?:\?.*)?$/.exec(url)?.[1]
							|| "jpg";
						const fileName = `${timestamp}-${index}.${fileExtension}`;
						const filePath = join(workingDirectory, fileName);
						const localPath = filePath.replace(/\\/g, "/").replace(/^C:/, "");
						await writeFile(filePath, bytes, "binary");
						return localPath;
					} catch (error: any) {
						if (error instanceof DOMException && error.name === "AbortError")
							return null;
						warn(`Error fetching image ${index}: ${error.message}`);
						return null;
					}
				});
				const downloadedImageMarkdowns = (await Promise.all(downloadPromises))
					.map((x, i) => x
						?
						`![Image ${i + 1}](${x})`
						: 'Error fetching image from URL: ' + imageURLsToDownload[i]
					);
				if (downloadedImageMarkdowns.length === 0) {
					warn('Error fetching images');
					return imageURLsToDownload;
				}

				status(`Downloaded ${downloadedImageMarkdowns.length} images successfully.`);

				return downloadedImageMarkdowns;
			} catch (error: any) {
				if (error instanceof DOMException && error.name === "AbortError") {
					return "Image download aborted by user.";
				}
				console.error(error);
				warn(`Error during image download: ${error.message}`);
				return `Error: ${error.message}`;
			}
		}
	});

	const visitWebsiteImpl = async (
		{ url, maxLinks, maxImages, contentLimit, searchTerms }: {
			url: string;
			maxLinks: number | undefined;
			maxImages: number | undefined;
			contentLimit: number | undefined;
			searchTerms: string[] | undefined;
		},
		context: Parameters<typeof visitWebsiteTool.implementation>[1],
	) => {
		const { status, warn, signal } = context;
		status("Visiting website...");

		maxLinks = undefinedIfAuto(ctl.getPluginConfig(configSchematics).get("maxLinks"), -1)
			?? maxLinks
			?? 40;
		maxImages = undefinedIfAuto(ctl.getPluginConfig(configSchematics).get("maxImages"), -1)
			?? maxImages
			?? 10;
		contentLimit = undefinedIfAuto(ctl.getPluginConfig(configSchematics).get("contentLimit"), -1)
			?? contentLimit
			?? 2000;

		const { html, body } = await fetchHTML(url, signal, warn);
		status("Website visited successfully.");

		const dom = new JSDOM(html, { url });
		const doc = dom.window.document;

		const title = doc.title || "";
		const h1 = doc.querySelector("h1")?.textContent?.trim() || "";
		const h2 = doc.querySelector("h2")?.textContent?.trim() || "";
		const h3 = doc.querySelector("h3")?.textContent?.trim() || "";
		const links = maxLinks && extractLinks(doc, url, maxLinks, searchTerms);
		const imagesToFetch = maxImages ? extractImages(doc, url, maxImages, searchTerms) : [];
		let images: false | [string, string][] = false;
		if (maxImages && imagesToFetch.length > 0) {
			try {
				images = (await viewImagesTool.implementation({ imageURLs: imagesToFetch.map(x => x[1]) }, context) as string[])
					.map((markdown, index) => [imagesToFetch[index][0], markdown] as [string, string]);
			} catch {
				warn("Image download failed, continuing without images.");
			}
		}

		let allContent = "";
		if (contentLimit) {
			try {
				const readerDoc = doc.cloneNode(true) as Document;
				const reader = new Readability(readerDoc, {
					serializer: (el) => el.textContent ?? "",
				});
				const article = reader.parse();
				if (article?.textContent?.trim()) {
					allContent = article.textContent
						.replace(/[ \t]+/g, " ")
						.replace(/\n{3,}/g, "\n\n")
						.trim();
				}
			} catch {
			}

			if (!allContent) {
				allContent = body
					.replace(/<script[\s\S]*?<\/script>/gi, "")
					.replace(/<style[\s\S]*?<\/style>/gi, "")
					.replace(/<[^>]+>/g, " ")
					.replace(/\s+/g, " ")
					.trim();
			}
		}

		let content = "";
		if (searchTerms?.length && contentLimit && contentLimit < allContent.length) {
			const padding = `.{0,${contentLimit / (searchTerms.length * 2)}}`;
			const matches = searchTerms
				.map(term => new RegExp(padding + term + padding, 'gi').exec(allContent))
				.filter(match => !!match)
				.sort((a, b) => a.index - b.index);
			let nextMinIndex = 0;
			for (const match of matches) {
				content += match.index >= nextMinIndex
					? match[0]
					: match[0].slice(nextMinIndex - match.index);
				nextMinIndex = match.index + match[0].length;
			}
		} else {
			content = allContent.slice(0, contentLimit || allContent.length);
		}

		return {
			url, title, h1, h2, h3,
			...(links ? { links } : {}),
			...(images ? { images } : {}),
			...(content ? { content } : {}),
		};
	};

	const visitWebsiteTool = tool({
		name: "Unsafe Visit Website",
		description: "(Reliable) Visit a non whitelisted website and return its title, headings, links, images, and text content. Images are automatically downloaded and viewable.",
		parameters: {
			url: z.string().url().describe("The URL of the website to visit"),
			findInPage: z.array(z.string()).optional().describe("Highly recommended! Optional search terms to prioritize which links, images, and content to return."),
			maxLinks: z.number().int().min(0).max(200).optional().describe("Maximum number of links to extract from the page."),
			maxImages: z.number().int().min(0).max(200).optional().describe("Maximum number of images to extract from the page."),
			contentLimit: z.number().int().min(0).max(10_000).optional().describe("Maximum text content length to extract from the page."),
		},
		implementation: async ({ url, maxLinks, maxImages, contentLimit, findInPage: searchTerms }, context) => {
			try {
				const whitelistDomain = undefinedIfAuto(ctl.getPluginConfig(configSchematics).get("whitelistDomains"), "") as string | undefined;
				if (whitelistDomain) {
					const requestedHostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
					const allowed = whitelistDomain
						.split(",")
						.map((d: string) => d.trim().toLowerCase().replace(/^www\./, ""))
						.filter((d: string) => d.length > 0)
						.some((d: string) => requestedHostname === d || requestedHostname.endsWith("." + d));
					if (allowed) {
						return `Error: domain is whitelisted, use "Unsafe" mode instead to bypass.`;
					}
				}

				return await visitWebsiteImpl({ url, maxLinks, maxImages, contentLimit, searchTerms }, context);
			} catch (error: any) {
				if (error instanceof DOMException && error.name === "AbortError") {
					return "Website visit aborted by user.";
				}
				console.error(error);
				context.warn(`Error during website visit: ${error.message}`);
				return `Error: ${error.message}`;
			}
		},
	});

	const filteredVisitWebsiteTool = tool({
		name: "Safe Visit Website",
		description: "(Unreliable) Visit a whitelisted website only that belongs to whitelisted domain and return its title, headings, links, images, and text content. Images are automatically downloaded and viewable. This should be prioritized than the other Visit Website tool.",
		parameters: {
			url: z.string().url().describe("The URL of the website to visit"),
			findInPage: z.array(z.string()).optional().describe("Highly recommended! Optional search terms to prioritize which links, images, and content to return."),
			maxLinks: z.number().int().min(0).max(200).optional().describe("Maximum number of links to extract from the page."),
			maxImages: z.number().int().min(0).max(200).optional().describe("Maximum number of images to extract from the page."),
			contentLimit: z.number().int().min(0).max(10_000).optional().describe("Maximum text content length to extract from the page."),
		},
		implementation: async ({ url, maxLinks, maxImages, contentLimit, findInPage: searchTerms }, context) => {
			try {
				const whitelistDomain = undefinedIfAuto(ctl.getPluginConfig(configSchematics).get("whitelistDomains"), "") as string | undefined;
				if (whitelistDomain) {
					const requestedHostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
					const allowed = whitelistDomain
						.split(",")
						.map((d: string) => d.trim().toLowerCase().replace(/^www\./, ""))
						.filter((d: string) => d.length > 0)
						.some((d: string) => requestedHostname === d || requestedHostname.endsWith("." + d));
					if (!allowed) {
						return `Error: domain is not whitelisted, use "Unsafe" mode instead to bypass.`;
					}
				}

				return await visitWebsiteImpl({ url, maxLinks, maxImages, contentLimit, searchTerms }, context);
			} catch (error: any) {
				if (error instanceof DOMException && error.name === "AbortError") {
					return "Website visit aborted by user.";
				}
				console.error(error);
				context.warn(`Error during website visit: ${error.message}`);
				return `Error: ${error.message}`;
			}
		},
	});

	const getCurrentWhitelist = tool({
		name: "Get Whitelist Domain",
		description: "Get a string that represents all whitelisted domain you can use with Visit Website (Filtered) tool.",
		parameters: {},
		implementation: async ({ }, context) => {
			const { status, warn, signal } = context;
			status("Visiting website...");

			try {
				const whitelistDomain = undefinedIfAuto(ctl.getPluginConfig(configSchematics).get("whitelistDomains"), "") as string | undefined;
				return whitelistDomain;
			} catch (error: any) {
				console.error(error);
				warn(`Error: ${error.message}`);
				return `Error: ${error.message}`;
			}
		},
	});

	tools.push(getCurrentWhitelist);
	tools.push(filteredVisitWebsiteTool);
	tools.push(visitWebsiteTool);
	tools.push(viewImagesTool);
	return tools;
}

const undefinedIfAuto = (value: unknown, autoValue: unknown) =>
	value === autoValue ? undefined : value as undefined;

const spoofedUserAgents = [

	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
	"Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0",
	"Mozilla/5.0 (X11; Linux x86_64; rv:134.0) Gecko/20100101 Firefox/134.0",
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1",
	"Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.39 Mobile Safari/537.36",
	"Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.39 Mobile Safari/537.36",
]

function spoofHeaders(url: string) {
	const domain = new URL(url).hostname;
	return {
		'User-Agent': spoofedUserAgents[Math.floor(Math.random() * spoofedUserAgents.length)],
		'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
		'Accept-Language': 'en-US,en;q=0.9',
		'Accept-Encoding': 'gzip, deflate, br',
		'Referer': 'https://' + domain + '/',
		'Origin': 'https://' + domain,
		'Connection': 'keep-alive',
		'Upgrade-Insecure-Requests': '1',
		'Sec-Fetch-Dest': 'document',
		'Sec-Fetch-Mode': 'navigate',
		'Sec-Fetch-Site': 'none',
		'Sec-Fetch-User': '?1',
		'Cache-Control': 'max-age=0',
	};
}

async function fetchInsecure(
	url: string,
	headers: Record<string, string>,
	signal: AbortSignal,
	maxRedirects = 5,
): Promise<string> {
	const safeHeaders = {
		...headers,
		"Accept-Encoding": "identity",
	};

	return new Promise((resolve, reject) => {
		const parsedUrl = new URL(url);
		const isHttps = parsedUrl.protocol === "https:";
		const lib = isHttps ? https : http;

		const req = lib.request(
			{
				hostname: parsedUrl.hostname,
				port: parsedUrl.port || (isHttps ? 443 : 80),
				path: parsedUrl.pathname + parsedUrl.search,
				method: "GET",
				headers: safeHeaders,
				rejectUnauthorized: false,
			},
			(res) => {
				const statusCode = res.statusCode ?? 0;

				if ([301, 302, 307, 308].includes(statusCode)) {
					const location = res.headers["location"];
					if (!location) {
						return reject(new Error(`Redirect from ${url} had no Location header`));
					}
					if (maxRedirects <= 0) {
						return reject(new Error(`Too many redirects from ${url}`));
					}

					res.resume();
					fetchInsecure(
						new URL(location, url).href,
						headers,
						signal,
						maxRedirects - 1,
					).then(resolve, reject);
					return;
				}

				if (statusCode < 200 || statusCode >= 300) {
					res.resume();
					return reject(new Error(`Failed to fetch ${url}: ${statusCode} ${res.statusMessage}`));
				}

				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
				res.on("error", reject);
			},
		);

		signal.addEventListener("abort", () => {
			req.destroy();
			reject(new DOMException("Request aborted", "AbortError"));
		}, { once: true });

		req.on("error", reject);
		req.end();
	});
}
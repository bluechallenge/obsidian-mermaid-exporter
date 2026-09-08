import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	extractTextLines,
	fixDimensions,
	getTextWidth,
	replaceForeignObjects,
	stripRootCss,
	svgElementToPng,
	wrapLine,
} from "../src/svgToPng";

// Stub canvas measurement as a fixed width per character, so wrap points are predictable.
const CHAR_WIDTH = 10;
function stubCharWidthMeasurement(): () => void {
	const original = HTMLCanvasElement.prototype.getContext;
	HTMLCanvasElement.prototype.getContext = function () {
		return {
			font: "",
			measureText: (text: string) => ({ width: text.length * CHAR_WIDTH }),
		} as unknown as CanvasRenderingContext2D;
	} as unknown as HTMLCanvasElement["getContext"];
	return () => {
		HTMLCanvasElement.prototype.getContext = original;
	};
}

const SVG_NS = "http://www.w3.org/2000/svg";

function makeSvg(inner = ""): SVGSVGElement {
	const doc = new DOMParser().parseFromString(
		`<svg xmlns="${SVG_NS}">${inner}</svg>`,
		"image/svg+xml",
	);
	return doc.documentElement as unknown as SVGSVGElement;
}

function makeForeignObject(htmlInner: string, attrs: Record<string, string> = {}): Element {
	const fo = document.createElementNS(SVG_NS, "foreignObject");
	for (const [k, v] of Object.entries(attrs)) fo.setAttribute(k, v);
	// Create the XHTML body via innerHTML on a div so jsdom parses the markup.
	const wrapper = document.createElement("div");
	wrapper.innerHTML = htmlInner;
	while (wrapper.firstChild) fo.appendChild(wrapper.firstChild);
	return fo;
}

describe("extractTextLines", () => {
	it("returns a single line for plain text", () => {
		const fo = makeForeignObject("<span>Hello world</span>");
		expect(extractTextLines(fo)).toEqual(["Hello world"]);
	});

	it("splits text on <br> tags", () => {
		const fo = makeForeignObject("<span>line one<br>line two</span>");
		expect(extractTextLines(fo)).toEqual(["line one", "line two"]);
	});

	it("handles multiple <br> producing multiple lines", () => {
		const fo = makeForeignObject("<div>a<br>b<br>c</div>");
		expect(extractTextLines(fo)).toEqual(["a", "b", "c"]);
	});

	it("walks nested elements and trims text nodes", () => {
		const fo = makeForeignObject(
			"<div><span><b>bold</b></span><br><span>tail</span></div>",
		);
		expect(extractTextLines(fo)).toEqual(["bold", "tail"]);
	});

	it("returns empty array when no text present", () => {
		const fo = makeForeignObject("");
		expect(extractTextLines(fo)).toEqual([]);
	});

	it("ignores leading <br> with empty current buffer", () => {
		const fo = makeForeignObject("<div><br>after</div>");
		expect(extractTextLines(fo)).toEqual(["after"]);
	});
});

describe("stripRootCss", () => {
	it("removes :root { ... } blocks from style tags", () => {
		const svg = makeSvg(
			`<style>:root { --x: 1px; } .node { fill: red; }</style>`,
		);
		stripRootCss(svg);
		const css = svg.querySelector("style")?.textContent ?? "";
		expect(css).not.toContain(":root");
		expect(css).toContain(".node");
	});

	it("handles multiple style elements", () => {
		const svg = makeSvg(
			`<style>:root{--a:1}</style><style>:root { --b: 2 } .x{fill:#000}</style>`,
		);
		stripRootCss(svg);
		const all = Array.from(svg.querySelectorAll("style")).map((s) => s.textContent || "");
		expect(all.join("")).not.toContain(":root");
		expect(all.join("")).toContain(".x");
	});

	it("is a no-op when no :root rule is present", () => {
		const svg = makeSvg(`<style>.x{fill:#000}</style>`);
		stripRootCss(svg);
		expect(svg.querySelector("style")?.textContent).toBe(".x{fill:#000}");
	});

	it("does nothing when there are no style tags", () => {
		const svg = makeSvg(`<g></g>`);
		expect(() => stripRootCss(svg)).not.toThrow();
	});
});

describe("fixDimensions", () => {
	it("leaves valid absolute width/height untouched", () => {
		const svg = makeSvg();
		svg.setAttribute("width", "300");
		svg.setAttribute("height", "200");
		fixDimensions(svg);
		expect(svg.getAttribute("width")).toBe("300");
		expect(svg.getAttribute("height")).toBe("200");
	});

	it("keeps absolute px units", () => {
		const svg = makeSvg();
		svg.setAttribute("width", "300px");
		svg.setAttribute("height", "200px");
		fixDimensions(svg);
		expect(svg.getAttribute("width")).toBe("300px");
		expect(svg.getAttribute("height")).toBe("200px");
	});

	it("falls back to viewBox when width/height are missing", () => {
		const svg = makeSvg();
		svg.setAttribute("viewBox", "0 0 640 480");
		fixDimensions(svg);
		expect(svg.getAttribute("width")).toBe("640");
		expect(svg.getAttribute("height")).toBe("480");
	});

	it("falls back to viewBox when width/height are non-absolute (e.g. 100%)", () => {
		const svg = makeSvg();
		svg.setAttribute("width", "100%");
		svg.setAttribute("height", "100%");
		svg.setAttribute("viewBox", "0 0 800 600");
		fixDimensions(svg);
		expect(svg.getAttribute("width")).toBe("800");
		expect(svg.getAttribute("height")).toBe("600");
	});

	it("falls back to 1200x800 when neither viewBox nor absolute dims are present", () => {
		const svg = makeSvg();
		svg.setAttribute("width", "auto");
		fixDimensions(svg);
		expect(svg.getAttribute("width")).toBe("1200");
		expect(svg.getAttribute("height")).toBe("800");
	});

	it("supports comma separators in viewBox", () => {
		const svg = makeSvg();
		svg.setAttribute("viewBox", "0,0,100,50");
		fixDimensions(svg);
		expect(svg.getAttribute("width")).toBe("100");
		expect(svg.getAttribute("height")).toBe("50");
	});
});

describe("replaceForeignObjects", () => {
	it("replaces a single-line foreignObject with a centered <text> node", () => {
		const fo = makeForeignObject("<span>Hello</span>", {
			x: "10",
			y: "20",
			width: "100",
			height: "40",
		});
		const svg = makeSvg();
		svg.appendChild(fo);
		// Same structure on the "original" tree (the helper reads computed style off it).
		const original = svg.cloneNode(true) as SVGSVGElement;

		replaceForeignObjects(svg, original);

		expect(svg.querySelector("foreignObject")).toBeNull();
		const text = svg.querySelector("text");
		expect(text).not.toBeNull();
		expect(text?.getAttribute("text-anchor")).toBe("middle");
		expect(text?.getAttribute("x")).toBe("60"); // 10 + 100/2
		expect(text?.getAttribute("y")).toBe("40"); // 20 + 40/2
		expect(text?.getAttribute("dominant-baseline")).toBe("middle");
		expect(text?.textContent).toBe("Hello");
	});

	it("emits one <tspan> per line for multiline foreignObjects", () => {
		const fo = makeForeignObject("<span>line a<br>line b<br>line c</span>", {
			x: "0",
			y: "0",
			width: "200",
			height: "90",
		});
		const svg = makeSvg();
		svg.appendChild(fo);
		const original = svg.cloneNode(true) as SVGSVGElement;

		replaceForeignObjects(svg, original);

		const tspans = svg.querySelectorAll("tspan");
		expect(tspans.length).toBe(3);
		expect(Array.from(tspans).map((t) => t.textContent)).toEqual([
			"line a",
			"line b",
			"line c",
		]);
		// All tspans share the same x (horizontal center).
		const xs = new Set(Array.from(tspans).map((t) => t.getAttribute("x")));
		expect(xs.size).toBe(1);
		expect(xs.has("100")).toBe(true); // 0 + 200/2
	});

	it("removes empty foreignObjects entirely", () => {
		const fo = makeForeignObject("", { x: "0", y: "0", width: "50", height: "20" });
		const svg = makeSvg();
		svg.appendChild(fo);
		const original = svg.cloneNode(true) as SVGSVGElement;

		replaceForeignObjects(svg, original);

		expect(svg.querySelector("foreignObject")).toBeNull();
		expect(svg.querySelector("text")).toBeNull();
	});

	it("unwraps <switch> elements, preserving their children", () => {
		const svg = makeSvg(
			`<switch><g id="kept"><rect/></g></switch>`,
		);
		const original = svg.cloneNode(true) as SVGSVGElement;
		replaceForeignObjects(svg, original);
		expect(svg.querySelector("switch")).toBeNull();
		expect(svg.querySelector("#kept")).not.toBeNull();
		expect(svg.querySelector("rect")).not.toBeNull();
	});

	describe("with a measurable canvas context", () => {
		let restore: () => void;

		beforeEach(() => {
			restore = stubCharWidthMeasurement();
		});

		afterEach(() => {
			restore();
		});

		it("wraps a line wider than its box into multiple tspans, keeping font-size unchanged", () => {
			const fo = makeForeignObject('<span style="font-size: 14px">a very long line of text</span>', {
				x: "0",
				y: "0",
				width: "100", // fits 10 chars per line at CHAR_WIDTH=10
				height: "60",
			});
			const svg = makeSvg();
			svg.appendChild(fo);
			const original = svg.cloneNode(true) as SVGSVGElement;

			replaceForeignObjects(svg, original);

			const text = svg.querySelector("text");
			expect(text?.getAttribute("font-size")).toBe("14"); // never scaled down
			const tspans = Array.from(svg.querySelectorAll("tspan")).map((t) => t.textContent);
			expect(tspans).toEqual(["a very", "long line", "of text"]);
		});

		it("leaves a line untouched when it already fits within its box", () => {
			const fo = makeForeignObject('<span style="font-size: 14px">ok</span>', {
				x: "0",
				y: "0",
				width: "100",
				height: "40",
			});
			const svg = makeSvg();
			svg.appendChild(fo);
			const original = svg.cloneNode(true) as SVGSVGElement;

			replaceForeignObjects(svg, original);

			const text = svg.querySelector("text");
			expect(text?.getAttribute("font-size")).toBe("14");
			expect(text?.textContent).toBe("ok");
		});

		it("wraps only the overflowing <br>-separated line, keeping the short one intact", () => {
			const fo = makeForeignObject(
				'<span style="font-size: 14px">short<br>a much much longer second line</span>',
				{ x: "0", y: "0", width: "100", height: "90" },
			);
			const svg = makeSvg();
			svg.appendChild(fo);
			const original = svg.cloneNode(true) as SVGSVGElement;

			replaceForeignObjects(svg, original);

			const text = svg.querySelector("text");
			const tspans = Array.from(svg.querySelectorAll("tspan")).map((t) => t.textContent);
			expect(text?.getAttribute("font-size")).toBe("14");
			expect(tspans[0]).toBe("short");
			expect(tspans.length).toBeGreaterThan(2); // the long second line got wrapped further
		});
	});
});

describe("wrapLine", () => {
	let restore: () => void;

	beforeEach(() => {
		restore = stubCharWidthMeasurement();
	});

	afterEach(() => {
		restore();
	});

	it("returns the line unchanged when it already fits", () => {
		expect(wrapLine("short", 100, 14, "sans-serif")).toEqual(["short"]);
	});

	it("breaks on word boundaries to stay within maxWidth", () => {
		const lines = wrapLine("a very long line of text", 100, 14, "sans-serif");
		expect(lines).toEqual(["a very", "long line", "of text"]);
		for (const line of lines) {
			expect(line.length * CHAR_WIDTH).toBeLessThanOrEqual(100);
		}
	});

	it("falls back to character breaks for a single word wider than maxWidth", () => {
		expect(wrapLine("abcdefghij", 50, 14, "sans-serif")).toEqual(["abcde", "fghij"]);
	});

	it("treats unmeasurable text (-1 sentinel) as fitting, leaving it unwrapped", () => {
		const original = HTMLCanvasElement.prototype.getContext;
		HTMLCanvasElement.prototype.getContext = function () {
			return null;
		} as unknown as HTMLCanvasElement["getContext"];
		try {
			expect(wrapLine("a very long line of text that would otherwise wrap", 50, 14, "sans-serif")).toEqual([
				"a very long line of text that would otherwise wrap",
			]);
		} finally {
			HTMLCanvasElement.prototype.getContext = original;
		}
	});
});

describe("getTextWidth", () => {
	it("returns -1 when no 2D canvas context is available", () => {
		const original = HTMLCanvasElement.prototype.getContext;
		HTMLCanvasElement.prototype.getContext = function () {
			return null;
		} as unknown as HTMLCanvasElement["getContext"];
		try {
			expect(getTextWidth("hello", 14, "sans-serif")).toBe(-1);
		} finally {
			HTMLCanvasElement.prototype.getContext = original;
		}
	});
});

describe("svgElementToPng (happy path with stubs)", () => {
	it("sanitizes the SVG and resolves with a PNG blob", async () => {
		// Stub Image so jsdom doesn't actually try to decode the data URL.
		class FakeImage {
			naturalWidth = 100;
			naturalHeight = 50;
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			set src(_v: string) {
				// Trigger onload on the next tick to mirror the real Image behavior.
				setTimeout(() => this.onload?.(), 0);
			}
		}
		(globalThis as unknown as { Image: typeof FakeImage }).Image = FakeImage;

		// Stub createEl (Obsidian helper) — return a real <canvas>, then patch toBlob.
		(globalThis as unknown as { createEl: (tag: string) => HTMLElement }).createEl = (
			tag: string,
		) => document.createElement(tag);

		const svg = makeSvg(`<rect width="10" height="10"/>`);
		svg.setAttribute("width", "100");
		svg.setAttribute("height", "50");

		// jsdom canvas has no real toBlob; patch it on the prototype.
		HTMLCanvasElement.prototype.getContext = function () {
			return {
				fillStyle: "",
				fillRect: () => undefined,
				drawImage: () => undefined,
			} as unknown as CanvasRenderingContext2D;
		} as unknown as HTMLCanvasElement["getContext"];
		HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
			cb(new Blob(["png"], { type: "image/png" }));
		};

		const blob = await svgElementToPng(svg, 1);
		expect(blob).toBeInstanceOf(Blob);
		expect(blob.type).toBe("image/png");
	});
});

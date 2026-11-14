import { a as VERSION, c as DATA_PATH, d as decode, f as httpDataSource, i as moduleFactoryOptions, l as DEFAULT_LANGUAGE, n as Espeak, o as encodeWav, p as jsdelivrDataUrl, r as EspeakError, s as toFloat32, t as DictionaryNotLoadedError, u as DataLoader } from "./core-w4y-vCu9.js";
import createEspeakModule from "../wasm/espeak-ng.js";
//#region src/web.ts
let wasmCompiles;
/**
* Whether this engine can compile WebAssembly. Compiling the smallest valid
* module answers that without a network request: it fails when there is no
* `WebAssembly` object and when a Content-Security-Policy forbids it. A CSP
* refusal also sends a violation report, so the answer is worked out once
* and remembered; neither a page's CSP nor Lockdown Mode changes while it is
* open.
*/
function canCompileWasm() {
	if (wasmCompiles === void 0) try {
		const empty = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
		wasmCompiles = new WebAssembly.Module(empty) instanceof WebAssembly.Module;
	} catch {
		wasmCompiles = false;
	}
	return wasmCompiles;
}
/** Resolves where the data comes from, given the options. */
function resolveDataUrl(options) {
	if (options.dataUrl !== void 0) return String(options.dataUrl);
	if (options.cdn === "jsdelivr") return jsdelivrDataUrl(VERSION);
	throw new Error("spellophone needs to know where espeak-ng-data is: pass { dataUrl } pointing at a copy of the package's espeak-ng-data directory, or { cdn: 'jsdelivr' } to fetch it from jsDelivr.");
}
/**
* Waits for the module and the data source, fetches the core data and the
* requested dictionaries, and initializes espeak-ng.
*/
async function createWebEspeak(modulePromise, sourcePromise, options) {
	const [module, source] = await Promise.all([modulePromise, sourcePromise]);
	const loader = new DataLoader(module, source);
	const languages = options.languages === "all" ? loader.availableLanguages() : [.../* @__PURE__ */ new Set(["en", ...options.languages ?? []])];
	await Promise.all([loader.loadCore(), ...languages.map((lang) => loader.loadDictionary(lang))]);
	const espeakOptions = { loader };
	if (options.phonemeEvents !== void 0) espeakOptions.phonemeEvents = options.phonemeEvents;
	return Espeak.create(module, espeakOptions);
}
//#endregion
//#region src/browser.ts
async function createModule(options) {
	const factoryOptions = moduleFactoryOptions(options.wasmUrl);
	if (!options.fallback || canCompileWasm()) return createEspeakModule(factoryOptions);
	console.warn("spellophone: WebAssembly is unavailable here, using the slower wasm2js fallback.");
	const { createWasm2jsModule } = await options.fallback();
	return createWasm2jsModule(factoryOptions);
}
/**
* Creates a ready-to-use espeak-ng instance in a browser or worker.
*
* Fetches the core data and the requested dictionaries over HTTP. Other
* languages can be fetched later with `Espeak.loadLanguages` or
* `Espeak.loadVoice`.
*/
async function createEspeak(options = {}) {
	const dataUrl = resolveDataUrl(options);
	return createWebEspeak(createModule(options), httpDataSource(dataUrl, options.fetch), options);
}
//#endregion
export { DATA_PATH, DEFAULT_LANGUAGE, DataLoader, DictionaryNotLoadedError, Espeak, EspeakError, VERSION, canCompileWasm, createEspeak, decode, encodeWav, httpDataSource, jsdelivrDataUrl, moduleFactoryOptions, resolveDataUrl, toFloat32 };

//# sourceMappingURL=browser.js.map
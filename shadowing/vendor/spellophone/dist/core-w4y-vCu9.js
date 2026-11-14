//#region src/data.ts
/** Where the loaders put espeak-ng-data inside the module's virtual file system. */
const DATA_PATH = "/espeak-ng-data";
/**
* The language espeak-ng loads while initializing. Its dictionary has to be
* present before `sp_initialize` runs, so every loader fetches it first.
*/
const DEFAULT_LANGUAGE = "en";
/**
* Copies files from a `DataSource` into the module's virtual file system.
*/
var DataLoader = class {
	module;
	source;
	dataPath;
	#pending = /* @__PURE__ */ new Map();
	constructor(module, source, dataPath = DATA_PATH) {
		this.module = module;
		this.source = source;
		this.dataPath = dataPath;
	}
	/** Languages the data source has a dictionary for. */
	availableLanguages() {
		return Object.keys(this.source.manifest.dictionaries);
	}
	/** Languages whose dictionary is in the virtual file system already. */
	loadedLanguages() {
		return this.availableLanguages().filter((lang) => this.hasDictionary(lang));
	}
	hasDictionary(language) {
		return this.module.FS.analyzePath(this.#dictionaryPath(language)).exists;
	}
	/** Writes everything except the dictionaries. Call this once, before init. */
	async loadCore() {
		const { core } = this.source.manifest;
		this.#writeCore(await this.source.read(core.file));
	}
	loadCoreSync() {
		if (!this.source.readSync) throw new Error("This data source cannot read synchronously.");
		const { core } = this.source.manifest;
		this.#writeCore(this.source.readSync(core.file));
	}
	/** Fetches and writes one language's dictionary. Resolves at once if present. */
	loadDictionary(language) {
		if (this.hasDictionary(language)) return Promise.resolve();
		const pending = this.#pending.get(language);
		if (pending) return pending;
		const entry = this.#dictionaryEntry(language);
		const task = this.source.read(entry.file).then((bytes) => {
			this.#writeFile(this.#dictionaryPath(language), bytes);
		}).finally(() => {
			this.#pending.delete(language);
		});
		this.#pending.set(language, task);
		return task;
	}
	/**
	* Synchronous variant for sources with `readSync`. Returns false when the
	* source cannot read synchronously, so callers can fall back to an error
	* that points at `loadDictionary`.
	*/
	loadDictionarySync(language) {
		if (this.hasDictionary(language)) return true;
		if (!this.source.readSync) return false;
		const entry = this.#dictionaryEntry(language);
		this.#writeFile(this.#dictionaryPath(language), this.source.readSync(entry.file));
		return true;
	}
	#dictionaryEntry(language) {
		const entry = this.source.manifest.dictionaries[language];
		if (!entry) throw new Error(`espeak-ng has no dictionary for "${language}". Available: ${this.availableLanguages().join(", ")}`);
		return entry;
	}
	#dictionaryPath(language) {
		return `${this.dataPath}/${language}_dict`;
	}
	#writeCore(bytes) {
		const { core } = this.source.manifest;
		if (bytes.length !== core.size) throw new Error(`${core.file} is ${bytes.length} bytes, the manifest expects ${core.size}. The data files and manifest.json do not match.`);
		let offset = 0;
		for (const entry of core.entries) {
			this.#writeFile(`${this.dataPath}/${entry.path}`, bytes.subarray(offset, offset + entry.size));
			offset += entry.size;
		}
	}
	#writeFile(path, bytes) {
		const dir = path.slice(0, path.lastIndexOf("/"));
		this.module.FS.mkdirTree(dir);
		this.module.FS.writeFile(path, bytes);
	}
};
/** Decodes a file the way the manifest says it was stored. */
async function decode(bytes, encoding) {
	if (encoding === "identity") return bytes;
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}
function isGzip(bytes) {
	return bytes[0] === 31 && bytes[1] === 139;
}
/**
* A `DataSource` that fetches the files over HTTP from `baseUrl`, the
* directory that holds `manifest.json`. A trailing slash is optional.
* `decodeImpl` replaces `decode`, for engines without `DecompressionStream`.
* Files the browser has already unzipped (served with
* `Content-Encoding: gzip`) are passed on as they are.
*/
async function httpDataSource(baseUrl, fetchImpl = fetch, decodeImpl = decode) {
	let base = String(baseUrl);
	if (!base.endsWith("/")) base += "/";
	if (!/^[a-z][a-z0-9+.-]*:/i.test(base)) {
		const location = globalThis.location?.href;
		if (!location) throw new Error(`The espeak-ng data URL must be absolute outside a browser context: ${base}`);
		base = new URL(base, location).href;
	}
	const fetchBytes = async (file) => {
		const response = await fetchImpl(new URL(file, base));
		if (!response.ok) throw new Error(`Failed to fetch espeak-ng data file ${file} from ${base}: ${response.status} ${response.statusText}`);
		return new Uint8Array(await response.arrayBuffer());
	};
	const manifestResponse = await fetchImpl(new URL("manifest.json", base));
	if (!manifestResponse.ok) throw new Error(`Failed to fetch espeak-ng data manifest from ${base}: ${manifestResponse.status} ${manifestResponse.statusText}`);
	const manifest = await manifestResponse.json();
	if (manifest.version !== 1) throw new Error(`Unsupported espeak-ng data manifest version ${String(manifest.version)} at ${base}`);
	return {
		manifest,
		read: async (file) => {
			const bytes = await fetchBytes(file);
			const encoding = manifest.encoding === "gzip" && !isGzip(bytes) ? "identity" : manifest.encoding;
			try {
				return await decodeImpl(bytes, encoding);
			} catch (error) {
				throw new Error(`Failed to decode espeak-ng data file ${file} from ${base}: ${String(error)}`, { cause: error });
			}
		}
	};
}
/**
* The jsDelivr URL of this package's data directory for a given version, for
* apps that would rather not host the data themselves.
*
* This is jsDelivr's npm endpoint, serving the `espeak-ng-data` directory of
* the package as published to npmjs.com.
*/
function jsdelivrDataUrl(version) {
	return `https://cdn.jsdelivr.net/npm/@spelling-creator/spellophone@${version}/espeak-ng-data/`;
}
//#endregion
//#region src/wav.ts
/**
* Encodes 16-bit mono PCM samples as a WAV file (RIFF, PCM format 1).
*
* The output is what `espeak-ng -w out.wav` would write, so it can be saved
* to disk, served over HTTP or handed to an `<audio>` element as a Blob.
*/
function encodeWav(samples, sampleRate) {
	const channels = 1;
	const bytesPerSample = 2;
	const dataSize = samples.length * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);
	const writeAscii = (offset, text) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};
	writeAscii(0, "RIFF");
	view.setUint32(4, 36 + dataSize, true);
	writeAscii(8, "WAVE");
	writeAscii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * bytesPerSample, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeAscii(36, "data");
	view.setUint32(40, dataSize, true);
	for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * bytesPerSample, samples[i] ?? 0, true);
	return new Uint8Array(buffer);
}
/**
* Converts 16-bit PCM samples to the float format the Web Audio API wants
* (`AudioBuffer.copyToChannel`), scaled to the range -1 to 1.
*/
function toFloat32(samples) {
	const out = new Float32Array(samples.length);
	for (let i = 0; i < samples.length; i++) out[i] = (samples[i] ?? 0) / 32768;
	return out;
}
//#endregion
//#region src/version.ts
/** This package's version, injected at build time from package.json. */
const VERSION = "0.2.1";
//#endregion
//#region src/core.ts
const PARAMETER_IDS = {
	rate: 1,
	volume: 2,
	pitch: 3,
	range: 4,
	punctuation: 5,
	capitals: 6,
	wordGap: 7
};
const FLAG_SSML = 16;
const FLAG_PHONEMES = 256;
const FLAG_ENDPAUSE = 4096;
const INIT_PHONEME_EVENTS = 1;
const INIT_PHONEME_IPA = 2;
const PHONEMES_IPA = 2;
const PHONEMES_TIE = 128;
const EVENT_WORD = 1;
const EVENT_SENTENCE = 2;
const EVENT_MARK = 3;
const EVENT_PLAY = 4;
const EVENT_END = 5;
const EVENT_PHONEME = 7;
var EspeakError = class extends Error {
	name = "EspeakError";
	/** The espeak_ERROR or espeak_ng_STATUS value. */
	code;
	constructor(message, code) {
		super(message);
		this.code = code;
	}
};
/**
* Thrown when a voice needs a dictionary that has not been loaded into the
* virtual file system and the data source cannot read it synchronously.
* Catch it, `await espeak.loadLanguages([error.language])`, and retry, or use
* `Espeak.loadVoice`, which does exactly that.
*/
var DictionaryNotLoadedError = class extends EspeakError {
	name = "DictionaryNotLoadedError";
	language;
	constructor(language) {
		super(`The "${language}" dictionary is not loaded. Load it with espeak.loadLanguages(["${language}"]) or pass it in the languages option.`, -1);
		this.language = language;
	}
};
/**
* Builds the module factory options the entry points share: an optional wasm
* location, and a stderr filter. espeak-ng prints "Can't read dictionary
* file" whenever a voice's dictionary is not in the virtual file system,
* which is an expected event here (it is what triggers loading it), so that
* line is dropped and everything else still reaches `console.error`.
*/
function moduleFactoryOptions(wasmUrl) {
	const options = { printErr: (line) => {
		if (line.startsWith("Can't read dictionary file:")) return;
		console.error(line);
	} };
	if (wasmUrl !== void 0) {
		const wasm = String(wasmUrl);
		options.locateFile = (file, prefix) => file.endsWith(".wasm") ? wasm : prefix + file;
	}
	return options;
}
function withCString(module, text, fn) {
	const size = module.lengthBytesUTF8(text) + 1;
	const ptr = module._malloc(size);
	try {
		module.stringToUTF8(text, ptr, size);
		return fn(ptr);
	} finally {
		module._free(ptr);
	}
}
function readLanguages(module, ptr) {
	const languages = [];
	if (ptr === 0) return languages;
	let p = ptr;
	for (;;) {
		const priority = module.HEAPU8[p] ?? 0;
		if (priority === 0) break;
		const name = module.UTF8ToString(p + 1);
		languages.push({
			priority,
			name
		});
		p += 1 + module.lengthBytesUTF8(name) + 1;
	}
	return languages;
}
function genderFromCode(code) {
	if (code === 1) return "male";
	if (code === 2) return "female";
}
/**
* A synchronous espeak-ng instance.
*
* Get one from `createEspeak` (the `spellophone/node` and `spellophone/browser`
* entry points) or, to bring your own module and data, from `Espeak.create`.
*/
var Espeak = class Espeak {
	module;
	/** Samples per second of the audio `synthesize` returns. */
	sampleRate;
	/** espeak-ng's version string, such as `1.52.0`. */
	version;
	dataPath;
	#loader;
	#disposed = false;
	/** Lowercased language tag to voice identifier, see `#voiceForLanguage`. */
	#languageVoices;
	constructor(module, sampleRate, dataPath, loader) {
		this.module = module;
		this.sampleRate = sampleRate;
		this.dataPath = dataPath;
		this.#loader = loader;
		const info = module.UTF8ToString(module._sp_version());
		this.version = info.split(/\s+/)[0] ?? info;
	}
	/**
	* Initializes espeak-ng on an already instantiated module whose virtual
	* file system holds espeak-ng-data at `options.dataPath` (default
	* `/espeak-ng-data`), with at least the English dictionary present.
	*/
	static create(module, options = {}) {
		const dataPath = options.dataPath ?? options.loader?.dataPath ?? "/espeak-ng-data";
		let flags = 0;
		if (options.phonemeEvents) flags |= INIT_PHONEME_EVENTS;
		if (options.phonemeEvents === "ipa") flags |= INIT_PHONEME_IPA;
		const rate = withCString(module, dataPath, (ptr) => module._sp_initialize(ptr, flags));
		if (rate <= 0) throw new EspeakError(`espeak-ng failed to initialize with data at ${dataPath} (status ${rate}). Is the data loaded, including the English dictionary?`, rate);
		return new Espeak(module, rate, dataPath, options.loader);
	}
	/** Every voice and language espeak-ng-data defines. */
	listVoices() {
		this.#check();
		const m = this.module;
		const voices = [];
		const count = m._sp_voice_count();
		for (let i = 0; i < count; i++) {
			const voice = {
				name: m.UTF8ToString(m._sp_voice_name(i)),
				identifier: m.UTF8ToString(m._sp_voice_identifier(i)),
				languages: readLanguages(m, m._sp_voice_languages(i))
			};
			const gender = genderFromCode(m._sp_voice_gender(i));
			if (gender) voice.gender = gender;
			const age = m._sp_voice_age(i);
			if (age > 0) voice.age = age;
			voices.push(voice);
		}
		return voices;
	}
	/** The selected voice, or null before any has been selected. */
	get voice() {
		this.#check();
		const m = this.module;
		const namePtr = m._sp_current_voice_name();
		if (namePtr === 0) return null;
		return {
			name: m.UTF8ToString(namePtr),
			languages: readLanguages(m, m._sp_current_voice_languages())
		};
	}
	/**
	* Selects a voice by name, language or properties. Loads the dictionary it
	* needs when the data source can do so synchronously (Node), and throws
	* `DictionaryNotLoadedError` otherwise. Use `loadVoice` to await it instead.
	*/
	setVoice(selector) {
		this.#check();
		this.#selectVoice(selector);
		if (this.module._sp_dictionary_loaded()) return;
		const language = this.module.UTF8ToString(this.module._sp_dictionary_name());
		if (this.#loader?.loadDictionarySync(language)) {
			this.#selectVoice(selector);
			if (this.module._sp_dictionary_loaded()) return;
		}
		throw new DictionaryNotLoadedError(language);
	}
	/** Like `setVoice`, but fetches a missing dictionary first. */
	async loadVoice(selector) {
		try {
			this.setVoice(selector);
		} catch (error) {
			if (!(error instanceof DictionaryNotLoadedError) || !this.#loader) throw error;
			await this.#loader.loadDictionary(error.language);
			this.setVoice(selector);
		}
	}
	/** Languages whose dictionary is loaded and ready to use. */
	loadedLanguages() {
		return this.#loader?.loadedLanguages() ?? [];
	}
	/** Languages the data source can provide a dictionary for. */
	availableLanguages() {
		return this.#loader?.availableLanguages() ?? [];
	}
	/** Fetches the dictionaries for these languages so voices can use them. */
	async loadLanguages(languages) {
		if (!this.#loader) throw new Error("This Espeak instance has no data loader.");
		await Promise.all(languages.map((lang) => this.#loader.loadDictionary(lang)));
	}
	getParameter(parameter, current = true) {
		this.#check();
		return this.module._sp_get_parameter(PARAMETER_IDS[parameter], current ? 1 : 0);
	}
	/** Sets a parameter for every later call. See `Parameter` for the ranges. */
	setParameter(parameter, value, relative = false) {
		this.#check();
		const status = this.module._sp_set_parameter(PARAMETER_IDS[parameter], value, relative ? 1 : 0);
		if (status !== 0) throw new EspeakError(`Could not set ${parameter} to ${value}`, status);
	}
	/**
	* Synthesizes `text` and returns the audio and the events espeak-ng raised
	* while producing it. Parameter overrides apply to this call only.
	*/
	synthesize(text, options = {}) {
		this.#check();
		if (options.voice !== void 0) this.setVoice(options.voice);
		const restore = this.#applyOverrides(options);
		try {
			let flags = 0;
			if (options.ssml) flags |= FLAG_SSML;
			if (options.phonemes) flags |= FLAG_PHONEMES;
			if (options.endPause) flags |= FLAG_ENDPAUSE;
			const status = withCString(this.module, text, (ptr) => this.module._sp_synthesize(ptr, flags));
			if (status !== 0) throw new EspeakError(`Synthesis failed (status ${status})`, status);
			return this.#collectResult();
		} finally {
			restore();
		}
	}
	/**
	* Transcribes `text` to phonemes, in IPA by default. espeak-ng works one
	* clause at a time, so the clauses are joined with a newline, as the
	* `espeak-ng -x` command line does.
	*/
	phonemes(text, options = {}) {
		this.#check();
		if (options.voice !== void 0) this.setVoice(options.voice);
		let mode = options.ipa === false ? 0 : PHONEMES_IPA;
		if (options.tie) mode |= PHONEMES_TIE;
		if (options.separator) {
			const code = options.separator.codePointAt(0) ?? 0;
			if (code > 65535) throw new RangeError("The phoneme separator must be a single BMP character.");
			mode |= code << 8;
		}
		const ptr = withCString(this.module, text, (p) => this.module._sp_text_to_phonemes(p, mode));
		return this.module.UTF8ToString(ptr);
	}
	/** Releases espeak-ng. The instance cannot be used afterwards. */
	dispose() {
		if (this.#disposed) return;
		this.#disposed = true;
		this.module._sp_terminate();
	}
	#check() {
		if (this.#disposed) throw new Error("This Espeak instance has been disposed.");
	}
	#selectVoice(selector) {
		const m = this.module;
		const byName = (name) => withCString(m, name, (ptr) => m._sp_set_voice_by_name(ptr));
		let status;
		if (typeof selector === "string") {
			status = byName(selector);
			if (status !== 0) {
				const plus = selector.indexOf("+");
				const tag = plus < 0 ? selector : selector.slice(0, plus);
				const identifier = this.#voiceForLanguage(tag);
				if (identifier !== void 0) status = byName(identifier + selector.slice(tag.length));
			}
		} else {
			const gender = selector.gender === "male" ? 1 : selector.gender === "female" ? 2 : 0;
			status = withCString(m, selector.name ?? "", (name) => withCString(m, selector.language ?? "", (language) => m._sp_set_voice_by_properties(name, language, gender, selector.age ?? 0, selector.variant ?? 0)));
		}
		if (status !== 0) throw new EspeakError(`No voice matches ${typeof selector === "string" ? `"${selector}"` : JSON.stringify(selector)} (status ${status})`, status);
	}
	/**
	* The identifier of the voice that lists this language tag (ignoring case)
	* with the best priority, which is the one espeak-ng picks for it. Built
	* once, since listing the voices reads every voice file.
	*/
	#voiceForLanguage(tag) {
		if (!this.#languageVoices) {
			const best = /* @__PURE__ */ new Map();
			for (const voice of this.listVoices()) for (const { name, priority } of voice.languages) {
				const key = name.toLowerCase();
				const current = best.get(key);
				if (!current || priority < current.priority) best.set(key, {
					identifier: voice.identifier,
					priority
				});
			}
			this.#languageVoices = new Map([...best].map(([key, { identifier }]) => [key, identifier]));
		}
		return this.#languageVoices.get(tag.toLowerCase());
	}
	#applyOverrides(overrides) {
		const previous = [];
		for (const parameter of [
			"rate",
			"volume",
			"pitch",
			"range",
			"wordGap"
		]) {
			const value = overrides[parameter];
			if (value === void 0) continue;
			previous.push([parameter, this.getParameter(parameter)]);
			this.setParameter(parameter, value);
		}
		return () => {
			for (const [parameter, value] of previous) this.setParameter(parameter, value);
		};
	}
	#collectResult() {
		const m = this.module;
		const sampleCount = m._sp_audio_samples();
		const samplePtr = m._sp_audio_data();
		const samples = new Int16Array(m.HEAP16.buffer, samplePtr, sampleCount).slice();
		const events = [];
		const count = m._sp_events_count();
		const recordSize = m._sp_event_size();
		const base = m._sp_events_data();
		const strings = m._sp_strings_data();
		for (let i = 0; i < count; i++) {
			const at = base + i * recordSize >> 2;
			const heap = m.HEAP32;
			const type = heap[at] ?? 0;
			const common = {
				textPosition: heap[at + 1] ?? 0,
				length: heap[at + 2] ?? 0,
				audioPosition: heap[at + 3] ?? 0,
				sample: heap[at + 4] ?? 0
			};
			const number = heap[at + 5] ?? 0;
			const nameOffset = heap[at + 6] ?? -1;
			const name = nameOffset >= 0 ? m.UTF8ToString(strings + nameOffset) : "";
			switch (type) {
				case EVENT_WORD:
					events.push({
						type: "word",
						...common,
						number
					});
					break;
				case EVENT_SENTENCE:
					events.push({
						type: "sentence",
						...common,
						number
					});
					break;
				case EVENT_MARK:
					events.push({
						type: "mark",
						...common,
						name
					});
					break;
				case EVENT_PLAY:
					events.push({
						type: "play",
						...common,
						name
					});
					break;
				case EVENT_PHONEME:
					events.push({
						type: "phoneme",
						...common,
						phoneme: name
					});
					break;
				case EVENT_END: events.push({
					type: "end",
					...common
				});
			}
		}
		return {
			samples,
			sampleRate: this.sampleRate,
			duration: sampleCount / this.sampleRate,
			events
		};
	}
};
//#endregion
export { VERSION as a, DATA_PATH as c, decode as d, httpDataSource as f, moduleFactoryOptions as i, DEFAULT_LANGUAGE as l, Espeak as n, encodeWav as o, jsdelivrDataUrl as p, EspeakError as r, toFloat32 as s, DictionaryNotLoadedError as t, DataLoader as u };

//# sourceMappingURL=core-w4y-vCu9.js.map
(() => {
  'use strict';

  const { $, statusOf, download } = W;
  const example = [
    { en: 'Small habits can make a big difference.', zh: '小习惯也能带来大变化。' },
    { en: 'Start with one thing you can do every day.', zh: '从一件你每天都能做到的事开始。' },
    { en: 'A few minutes of practice can help you build confidence.', zh: '几分钟的练习就能帮助你建立信心。' }
  ];
  const synth = window.speechSynthesis;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canRecord = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  const segmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('en', { granularity: 'sentence' }) : null;

  const english = $('#english');
  const chinese = $('#chinese');
  const sentenceList = $('#sentences');
  const voiceSelect = $('#voice');
  const recording = $('#recording');
  const samplePlayer = new Audio();
  const canUseBuiltInVoice = Boolean(window.WebAssembly && window.DecompressionStream);
  const showStatus = statusOf($('#practice-status'));
  const showSourceStatus = statusOf($('#source-status'));

  let sentences = [];
  let voices = [];
  let selected = 0;
  let usingExample = true;
  let playback = null;
  let capture = null;
  let builtInVoice;
  let continuous = null;
  let exporting = false;
  const words = $('#words');
  const library = $('#materials');
  const libraryKey = 'wenhuo.shadowing.materials';

  function updateControls() {
    const hasAudio = Boolean(voices.length || usingExample || canUseBuiltInVoice);
    const busy = Boolean(capture || continuous);
    $('#previous').disabled = busy || selected === 0;
    $('#next').disabled = busy || selected === sentences.length - 1;
    $('#listen').disabled = busy || !hasAudio;
    $('#listen-all').disabled = busy || !hasAudio;
    $('#stop').hidden = !playback && !continuous && !capture;
    $('#record').disabled = busy || !canRecord;
    $('#continuous').disabled = busy || !canRecord || !hasAudio;
    $('#listen-word').disabled = busy || !words.value || !(voices.length || canUseBuiltInVoice);
    $('#download-reference').disabled = busy || exporting || (!canUseBuiltInVoice && !usingExample);
    $('#finish').hidden = !capture?.recorder || capture.recorder.state !== 'recording';
    $('#compare').hidden = !sentences[selected].recording || !hasAudio;
    $('#compare').disabled = busy;
    voiceSelect.disabled = busy || voiceSelect.options.length < 2;
    recording.hidden = !sentences[selected].recording;
    sentenceList.querySelectorAll('button').forEach(button => { button.disabled = busy; });
  }

  function loadVoices() {
    const preferred = voiceSelect.value;
    voices = (synth?.getVoices() || []).filter(voice => /^en(?:[-_]|$)/i.test(voice.lang));
    voiceSelect.replaceChildren();
    if (usingExample) voiceSelect.add(new Option('示例参考音频', 'sample'));
    for (const voice of voices) {
      voiceSelect.add(new Option(voice.name, voice.voiceURI));
    }
    if (canUseBuiltInVoice) voiceSelect.add(new Option('内置英语语音', 'built-in'));
    if (!voiceSelect.options.length) voiceSelect.add(new Option('未找到英语语音', ''));
    if (preferred && [...voiceSelect.options].some(option => option.value === preferred)) {
      voiceSelect.value = preferred;
    }
    $('#voice-note').textContent = canUseBuiltInVoice
      ? '内置英语语音首次使用时下载语音资源，文章在浏览器里合成。'
      : voices.length ? '朗读声音由当前设备和浏览器提供。'
      : '当前浏览器暂无英语语音。你仍可播放示例音频，或录音回听自定义内容。';
    updateControls();
  }

  function stopPlayback() {
    if (playback) {
      const previous = playback;
      playback = null;
      previous.abort();
      synth?.cancel();
    }
    samplePlayer.pause();
    recording.pause();
  }

  function selectSentence(index) {
    selected = index;
    const sentence = sentences[index];
    const tokens = sentence.en.match(/[a-z]+(?:['’][a-z]+)*/gi) || [];
    words.replaceChildren(...[...new Set(tokens.map(word => word.toLowerCase()))].map(word => new Option(word)));
    updateLookup();
    sentenceList.querySelectorAll('button').forEach((button, i) => {
      button.setAttribute('aria-current', String(i === index));
    });
    if (sentence.recording) recording.src = sentence.recording;
    else recording.removeAttribute('src');
    $('#feedback').textContent = sentence.feedback || '';
    updateControls();
  }

  function updateLookup() {
    const link = $('#lookup-word');
    link.hidden = !words.value;
    if (words.value) link.href = 'https://www.youdao.com/result?lang=en&word=' + encodeURIComponent(words.value);
  }

  function showSentences(items, isExample) {
    continuous?.abort();
    continuous = null;
    stopPlayback();
    cancelCapture();
    recording.removeAttribute('src');
    for (const sentence of sentences) {
      if (sentence.recording) URL.revokeObjectURL(sentence.recording);
    }
    sentences = items;
    usingExample = isExample;
    const entries = items.map(({ en, zh }, index) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const number = document.createElement('span');
      number.className = 'sentence-num';
      number.textContent = index + 1;
      const text = document.createElement('span');
      const original = document.createElement('span');
      original.className = 'sentence-en';
      original.lang = 'en';
      original.textContent = en;
      original.hidden = !$('#show-english').checked;
      if (original.hidden) button.setAttribute('aria-label', '第 ' + (index + 1) + ' 句');
      text.append(original);
      if (zh) {
        const translation = document.createElement('span');
        translation.className = 'sentence-zh';
        translation.hidden = !$('#show-translation').checked;
        translation.textContent = zh;
        text.append(translation);
      }
      button.append(number, text);
      button.addEventListener('click', () => navigate(index));
      item.append(button);
      return item;
    });
    sentenceList.replaceChildren(...entries);
    $('#translation-toggle').hidden = !items.some(sentence => sentence.zh);
    selectSentence(0);
    loadVoices();
    showStatus(canRecord ? '' : '当前环境无法录音，仍可练习听读。', 's-run');
  }

  function navigate(index) {
    if (capture || continuous || index < 0 || index >= sentences.length) return;
    stopPlayback();
    selectSentence(index);
    showStatus('');
  }

  function splitEnglish(text) {
    return text.split(/\n+/).flatMap(line => {
      if (segmenter) return [...segmenter.segment(line)].map(item => item.segment);
      return line.split(/(?<=[.!?])\s+/);
    }).map(sentence => sentence.trim()).filter(Boolean);
  }

  function loadExample() {
    english.value = example.map(sentence => sentence.en).join('\n');
    chinese.value = '';
    showSentences(example.map(sentence => ({ ...sentence })), true);
    showSourceStatus('已载入示例，共 3 句。', 's-ok');
  }

  function waitForAudio(audio, signal) {
    return new Promise((resolve, reject) => {
      function done(error) {
        audio.removeEventListener('ended', ended);
        audio.removeEventListener('error', failed);
        signal.removeEventListener('abort', ended);
        if (error) reject(error);
        else resolve();
      }
      const ended = () => done();
      const failed = () => done(new Error('音频无法播放。请重试或切换朗读声音。'));
      audio.addEventListener('ended', ended);
      audio.addEventListener('error', failed);
      signal.addEventListener('abort', ended, { once: true });
      audio.play().catch(failed);
    });
  }

  function getBuiltInVoice() {
    if (!builtInVoice) {
      builtInVoice = import('./vendor/spellophone/dist/browser.js').then(async library => {
        const engine = await library.createEspeak({
          dataUrl: '/shadowing/vendor/spellophone/espeak-ng-data'
        });
        return { engine, encodeWav: library.encodeWav };
      }).catch(error => {
        builtInVoice = null;
        throw error;
      });
    }
    return builtInVoice;
  }

  async function speakBuiltIn(text, rate, signal) {
    try {
      const { engine, encodeWav } = await getBuiltInVoice();
      if (signal.aborted) return;
      const { samples, sampleRate } = engine.synthesize(text);
      const url = URL.createObjectURL(new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' }));
      try {
        samplePlayer.src = url;
        samplePlayer.playbackRate = rate;
        await waitForAudio(samplePlayer, signal);
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      throw new Error('内置语音暂时无法播放。请检查网络后重试。');
    }
  }

  function speak(index, signal, word = '') {
    const rate = Number($('#rate').value);
    if (!word && usingExample && voiceSelect.value === 'sample') {
      samplePlayer.src = '/shadowing/example-' + (index + 1) + '.wav';
      samplePlayer.playbackRate = rate;
      return waitForAudio(samplePlayer, signal);
    }
    const text = word || sentences[index].en;
    if (voiceSelect.value === 'built-in' ||
        (word && voiceSelect.value === 'sample' && canUseBuiltInVoice)) {
      return speakBuiltIn(text, rate, signal);
    }
    return new Promise((resolve, reject) => {
      const voice = voices.find(item => item.voiceURI === voiceSelect.value) ||
        (word && voiceSelect.value === 'sample' ? voices[0] : null);
      if (!voice) {
        reject(new Error('没有可用的英语语音。请选择示例或启用英语语音。'));
        return;
      }
      const speech = new SpeechSynthesisUtterance(text);
      speech.lang = voice.lang;
      speech.voice = voice;
      speech.rate = rate;
      const finished = () => {
        signal.removeEventListener('abort', finished);
        resolve();
      };
      speech.onend = finished;
      speech.onerror = () => {
        signal.removeEventListener('abort', finished);
        reject(new Error('朗读失败。请换一个声音或试听示例。'));
      };
      signal.addEventListener('abort', finished, { once: true });
      synth.speak(speech);
    });
  }

  async function play(indices, compare = false, word = '') {
    stopPlayback();
    const session = new AbortController();
    playback = session;
    updateControls();
    showStatus('正在播放参考朗读…', 's-run');
    try {
      const repeat = compare || word ? 1 : Number($('#repeat').value);
      for (const index of indices) {
        if (!word) selectSentence(index);
        for (let time = 0; time < repeat && !session.signal.aborted; time++) {
          await speak(index, session.signal, word);
        }
        if (session.signal.aborted) return;
      }
      if (compare) {
        showStatus('正在回放你的录音…', 's-run');
        recording.currentTime = 0;
        await waitForAudio(recording, session.signal);
      }
      if (playback === session) showStatus('播放完成。', 's-ok');
      return !session.signal.aborted;
    } catch (error) {
      if (playback === session) showStatus(error.message, 's-err');
    } finally {
      if (playback === session) {
        playback = null;
        updateControls();
      }
    }
  }

  function releaseMic(session) {
    session.stream?.getTracks().forEach(track => track.stop());
  }

  function cancelCapture() {
    const session = capture;
    capture = null;
    if (!session) return;
    clearTimeout(session.timer);
    try { session.recognition?.abort(); } catch {}
    if (session.recorder?.state === 'recording') session.recorder.stop();
    releaseMic(session);
    session.complete(false);
  }

  // Compare words in order, as in the original player. This measures text coverage.
  function wordCoverage(reference, transcript) {
    const words = text => text.toLowerCase().replace(/’/g, "'").match(/[a-z0-9]+(?:'[a-z]+)*/g) || [];
    const expected = words(reference);
    const actual = words(transcript);
    const counts = new Uint32Array(actual.length + 1);
    for (const word of expected) {
      let previous = 0;
      for (let index = 1; index <= actual.length; index++) {
        const saved = counts[index];
        counts[index] = word === actual[index - 1]
          ? previous + 1 : Math.max(counts[index], counts[index - 1]);
        previous = saved;
      }
    }
    return expected.length ? Math.round(counts[actual.length] / expected.length * 100) : 0;
  }

  function updateFeedback(session) {
    if (!session.saved) return;
    const sentence = session.sentence;
    sentence.feedback = session.transcript
      ? '词句匹配率 ' + wordCoverage(sentence.en, session.transcript) + '% · 识别为：' + session.transcript
      : '未获得识别结果，仍可回放录音。';
    if (sentences[selected] === sentence) $('#feedback').textContent = sentence.feedback;
  }

  function startRecognition(session) {
    if (!Recognition || !$('#recognize').checked) return;
    try {
      const recognizer = new Recognition();
      session.recognition = recognizer;
      recognizer.lang = voices.find(voice => voice.voiceURI === voiceSelect.value)?.lang || 'en-US';
      recognizer.continuous = true;
      recognizer.interimResults = true;
      recognizer.onresult = event => {
        session.transcript = [...event.results].map(result => result[0].transcript).join(' ').trim();
        updateFeedback(session);
      };
      recognizer.onend = () => updateFeedback(session);
      recognizer.onerror = () => updateFeedback(session);
      recognizer.start();
    } catch {
      session.recognition = null;
      session.recognitionUnavailable = true;
    }
  }

  function finishRecording() {
    if (capture?.recorder?.state !== 'recording') return;
    try { capture.recognition?.stop(); } catch {}
    capture.recorder.stop();
    updateControls();
    showStatus('正在整理录音…', 's-run');
  }

  async function startRecording(seconds = 60) {
    if (!canRecord || capture) return false;
    stopPlayback();
    const session = { sentence: sentences[selected], chunks: [] };
    const finished = new Promise(resolve => { session.complete = resolve; });
    capture = session;
    updateControls();
    showStatus('等待麦克风授权…', 's-run');
    try {
      session.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      if (capture !== session) {
        releaseMic(session);
        return;
      }
      const recorder = new MediaRecorder(session.stream);
      session.recorder = recorder;
      recorder.ondataavailable = event => {
        if (event.data.size) session.chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (capture !== session) return;
        cancelCapture();
        updateControls();
        showStatus('录音中断。请检查麦克风后重试。', 's-err');
      };
      recorder.onstop = () => {
        clearTimeout(session.timer);
        releaseMic(session);
        if (capture !== session) return;
        capture = null;
        if (!session.chunks.length) {
          updateControls();
          showStatus('没有录到音频。请检查麦克风后重试。', 's-err');
          session.complete(false);
          return;
        }
        const sentence = session.sentence;
        if (sentence.recording) URL.revokeObjectURL(sentence.recording);
        const type = recorder.mimeType || session.chunks[0].type;
        sentence.recording = URL.createObjectURL(new Blob(session.chunks, { type }));
        sentence.feedback = session.recognitionUnavailable ? '语音识别启动失败，仍可回放录音。' : '';
        selectSentence(selected);
        session.saved = true;
        if (session.recognition) updateFeedback(session);
        showStatus('录音完成。可回放或继续下一句。', 's-ok');
        session.complete(true);
      };
      session.stream.getAudioTracks().forEach(track => {
        track.addEventListener('ended', finishRecording, { once: true });
      });
      recorder.start();
      startRecognition(session);
      session.timer = setTimeout(finishRecording, seconds * 1000);
      showStatus('录音中，最长 ' + seconds + ' 秒。', 's-run');
      updateControls();
    } catch (error) {
      if (capture !== session) return;
      cancelCapture();
      updateControls();
      const message = error.name === 'NotAllowedError' ? '麦克风权限未开启。你仍可听读。'
        : '无法使用麦克风。请检查设备后重试。';
      showStatus(message, 's-err');
    }
    return finished;
  }

  async function runContinuous() {
    if (capture || continuous) return;
    const session = new AbortController();
    continuous = session;
    try {
      for (let index = selected; index < sentences.length && !session.signal.aborted; index++) {
        if (!await play([index])) break;
        if (session.signal.aborted) return;
        const wordCount = sentences[index].en.trim().split(/\s+/).length;
        const seconds = Math.max(5, Math.min(60, Math.ceil(wordCount / 2 + 3)));
        if (!await startRecording(seconds)) break;
        if (index === sentences.length - 1) showStatus('连续跟读完成。可逐句回听录音。', 's-ok');
      }
    } finally {
      if (continuous === session) continuous = null;
      updateControls();
    }
  }

  function readLibrary() {
    try {
      const value = JSON.parse(localStorage.getItem(libraryKey) || '[]');
      return Array.isArray(value) ? value.filter(item => typeof item?.en === 'string' &&
        typeof item.zh === 'string' && typeof item.example === 'boolean') : [];
    } catch {
      return [];
    }
  }

  function refreshLibrary() {
    const items = readLibrary();
    library.replaceChildren(...items.map((item, index) =>
      new Option(item.en.split('\n')[0].slice(0, 58), String(index))));
    if (!items.length) library.add(new Option('暂无收藏', ''));
    library.disabled = $('#open-material').disabled = $('#delete-material').disabled = !items.length;
  }

  function writeLibrary(items, message) {
    try {
      localStorage.setItem(libraryKey, JSON.stringify(items));
      refreshLibrary();
      showSourceStatus(message, 's-ok');
    } catch {
      showSourceStatus('浏览器存储不可用，未能保存收藏。', 's-err');
    }
  }

  async function downloadReference() {
    if (exporting) return;
    exporting = true;
    updateControls();
    const useSample = usingExample && (voiceSelect.value === 'sample' || !canUseBuiltInVoice);
    const sentence = sentences[selected];
    const index = selected + 1;
    try {
      let wav;
      if (useSample) {
        const response = await fetch('/shadowing/example-' + index + '.wav');
        if (!response.ok) throw new Error();
        wav = await response.blob();
      } else {
        const { engine, encodeWav } = await getBuiltInVoice();
        const { samples, sampleRate } = engine.synthesize(sentence.en);
        wav = new Blob([encodeWav(samples, sampleRate)], { type: 'audio/wav' });
      }
      download(wav, '英语跟读-第' + index + '句.wav');
      showStatus('已生成第 ' + index + ' 句的参考音频。', 's-ok');
    } catch {
      showStatus('参考音频生成失败，请重试。', 's-err');
    } finally {
      exporting = false;
      updateControls();
    }
  }

  $('#source').addEventListener('submit', event => {
    event.preventDefault();
    const items = splitEnglish(english.value);
    if (!items.some(sentence => /[a-z]/i.test(sentence))) {
      showSourceStatus('请先输入英文题目或文章。', 's-err');
      english.focus();
      return;
    }
    const translations = chinese.value.trim() ? chinese.value.split(/\r?\n/) : [];
    if (translations.length && translations.length !== items.length) {
      showSourceStatus('英文分为 ' + items.length + ' 句，请调整译文行数，或清空译文后继续。', 's-err');
      return;
    }
    showSentences(items.map((en, index) => ({ en, zh: translations[index]?.trim() || '' })), false);
    showSourceStatus('已准备 ' + items.length + ' 句。', 's-ok');
    $('#practice').scrollIntoView({ block: 'start' });
  });
  $('#example').addEventListener('click', loadExample);
  $('#previous').addEventListener('click', () => navigate(selected - 1));
  $('#next').addEventListener('click', () => navigate(selected + 1));
  $('#listen').addEventListener('click', () => play([selected]));
  $('#listen-all').addEventListener('click', () => play(sentences.map((_, index) => index)));
  $('#listen-word').addEventListener('click', () => play([selected], false, words.value));
  words.addEventListener('change', updateLookup);
  $('#download-reference').addEventListener('click', downloadReference);
  $('#stop').addEventListener('click', () => {
    continuous?.abort();
    continuous = null;
    cancelCapture();
    stopPlayback();
    updateControls();
    showStatus('已停止。');
  });
  $('#compare').addEventListener('click', () => play([selected], true));
  $('#record').addEventListener('click', () => startRecording());
  $('#continuous').addEventListener('click', runContinuous);
  $('#finish').addEventListener('click', finishRecording);
  voiceSelect.addEventListener('change', () => navigate(selected));
  $('#rate').addEventListener('input', event => {
    $('#rate-value').value = Number(event.target.value).toFixed(1) + '×';
    samplePlayer.playbackRate = Number(event.target.value);
  });
  $('#show-translation').addEventListener('change', event => {
    sentenceList.querySelectorAll('.sentence-zh').forEach(item => { item.hidden = !event.target.checked; });
  });
  $('#show-english').addEventListener('change', event => {
    sentenceList.querySelectorAll('button').forEach((button, index) => {
      button.querySelector('.sentence-en').hidden = !event.target.checked;
      if (event.target.checked) button.removeAttribute('aria-label');
      else button.setAttribute('aria-label', '第 ' + (index + 1) + ' 句');
    });
  });
  $('#save-material').addEventListener('click', () => {
    const en = sentences.map(sentence => sentence.en).join('\n');
    const zh = sentences.map(sentence => sentence.zh).join('\n');
    const existing = readLibrary().filter(item => item.en !== en || item.zh !== zh);
    writeLibrary([{ en, zh, example: usingExample }, ...existing].slice(0, 30), '已收藏当前练习。');
  });
  $('#open-material').addEventListener('click', () => {
    const item = readLibrary()[Number(library.value)];
    if (!item) return;
    if (item.example) {
      loadExample();
      return;
    }
    english.value = item.en;
    chinese.value = item.zh.trim() ? item.zh : '';
    const translations = item.zh.split('\n');
    showSentences(item.en.split('\n').map((en, index) => ({ en, zh: translations[index] || '' })), false);
    showSourceStatus('已打开收藏。', 's-ok');
  });
  $('#delete-material').addEventListener('click', () => {
    const index = Number(library.value);
    writeLibrary(readLibrary().filter((_, i) => i !== index), '已移除收藏。');
  });
  $('#recognition-option').hidden = !Recognition || !canRecord;
  $('#recognize').addEventListener('change', event => { $('#recognition-note').hidden = !event.target.checked; });
  window.addEventListener('pagehide', () => {
    continuous?.abort();
    continuous = null;
    stopPlayback();
    cancelCapture();
    updateControls();
  });
  W.mountNav();
  W.mountFooter($('.wrap'));
  loadExample();
  refreshLibrary();
  synth?.addEventListener('voiceschanged', loadVoices);
})();

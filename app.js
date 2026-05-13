const TARGET_SAMPLE_RATE = 16000;
const CUT_OFFSET_SECONDS = 0.5;
const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";
const TARGET_PHRASES = [
  {
    label: "open rayme",
    suffix: "rayme",
    aliases: ["rayme", "raymi", "raimi", "rame", "remy", "raymie", "raymey", "reymi", "raymee"],
    minLength: 4,
    maxLength: 8,
    maxDistance: 2,
    reject: ["ray", "me"],
  },
  {
    label: "open heystar",
    suffix: "heystar",
    aliases: ["heystar", "haystar", "heystarr", "heyestar", "heystare", "heystarrr", "heystaar"],
    minLength: 6,
    maxLength: 9,
    maxDistance: 2,
    reject: ["hey", "star"],
  },
  {
    label: "Open HAYE-DAR",
    suffix: "hayedar",
    aliases: ["hayedar", "haydar", "heyedar", "heydar", "hayedarr", "hayeder"],
    minLength: 6,
    maxLength: 9,
    maxDistance: 2,
    reject: ["haye", "hay", "dar"],
  },
  {
    label: "open vstyle",
    suffix: "vstyle",
    aliases: ["vstyle", "vestyle", "veestyle", "vstile", "vstyl", "vstyles", "weestyle"],
    minLength: 5,
    maxLength: 9,
    maxDistance: 2,
    reject: ["v", "style"],
  },
  {
    label: "open guma",
    suffix: "guma",
    aliases: ["guma", "gooma", "gouma", "goma", "gooma"],
    minLength: 4,
    maxLength: 6,
    maxDistance: 1,
    reject: [],
  },
  {
    label: "Open Haster",
    suffix: "haster",
    aliases: ["haster", "hastar", "hester", "hayster", "hastor", "hastr", "hasta"],
    minLength: 5,
    maxLength: 8,
    maxDistance: 2,
    reject: ["has", "ter"],
  },
  {
    label: "Open Hi-God!",
    suffix: "higod",
    aliases: ["higod", "highgod", "haigod", "higood", "hygod", "hiigod"],
    minLength: 5,
    maxLength: 8,
    maxDistance: 2,
    reject: ["hi", "god"],
  },
  {
    label: "Open style",
    suffix: "style",
    aliases: ["style", "stile", "styles", "styl"],
    minLength: 4,
    maxLength: 7,
    maxDistance: 1,
    reject: [],
  },
].map((target) => ({
  ...target,
  compact: normalizeToken(target.label),
  aliasSet: new Set(target.aliases.map(normalizeToken)),
  rejectSet: new Set(target.reject.map(normalizeToken)),
}));
const NO_MATCH_MESSAGE = "未检测到目标口播内容。";

const els = {
  analyzeButton: document.querySelector("#analyzeButton"),
  applyMatchButton: document.querySelector("#applyMatchButton"),
  autofillPanel: document.querySelector("#autofillPanel"),
  autofillStatus: document.querySelector("#autofillStatus"),
  copyAllButton: document.querySelector("#copyAllButton"),
  cutterFrame: document.querySelector("#cutterFrame"),
  cutterStatus: document.querySelector("#cutterStatus"),
  copyText: document.querySelector("#copyText"),
  dropZone: document.querySelector("#dropZone"),
  emptyResult: document.querySelector("#emptyResult"),
  fileMeta: document.querySelector("#fileMeta"),
  modelSelect: document.querySelector("#modelSelect"),
  matchSelect: document.querySelector("#matchSelect"),
  progressBar: document.querySelector("#progressBar"),
  progressText: document.querySelector("#progressText"),
  resultBody: document.querySelector("#resultBody"),
  resultCount: document.querySelector("#resultCount"),
  resultWrap: document.querySelector("#resultWrap"),
  silenceInput: document.querySelector("#silenceInput"),
  statusLine: document.querySelector("#statusLine"),
  toast: document.querySelector("#toast"),
  transcriptText: document.querySelector("#transcriptText"),
  videoInput: document.querySelector("#videoInput"),
  videoPreview: document.querySelector("#videoPreview"),
};

let selectedFile = null;
let selectedVideoUrl = "";
let activeJobId = 0;
let transformerModule = null;
let cachedModelId = "";
let cachedTranscriber = null;
let latestAudio = null;
let latestTranscription = null;
let latestWords = [];
let latestMatches = [];
let cutterApiPromise = null;
let cutterLoadPromise = Promise.resolve(null);

window.addEventListener("DOMContentLoaded", () => {
  window.lucide?.createIcons();
});

els.videoInput.addEventListener("change", () => {
  const [file] = els.videoInput.files;
  if (file) {
    receiveFile(file);
  }
});

els.analyzeButton.addEventListener("click", () => {
  if (selectedFile) {
    analyzeSelectedFile();
  }
});

els.copyAllButton.addEventListener("click", () => {
  copyValue(els.copyText.value);
});

els.applyMatchButton.addEventListener("click", () => {
  applySelectedMatchToCutter();
});

els.matchSelect.addEventListener("change", () => {
  applySelectedMatchToCutter();
});

els.silenceInput.addEventListener("change", () => {
  if (latestAudio && latestTranscription) {
    renderDetectionFromLatest();
  }
});

["dragenter", "dragover"].forEach((eventName) => {
  els.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropZone.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  els.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropZone.classList.remove("dragging");
  });
});

els.dropZone.addEventListener("drop", (event) => {
  const [file] = event.dataTransfer.files;
  if (file) {
    receiveFile(file);
  }
});

function receiveFile(file) {
  if (!file.type.startsWith("video/")) {
    showToast("请选择视频文件");
    return;
  }

  selectedFile = file;
  latestAudio = null;
  latestTranscription = null;
  latestWords = [];
  activeJobId += 1;

  if (selectedVideoUrl) {
    URL.revokeObjectURL(selectedVideoUrl);
  }
  selectedVideoUrl = URL.createObjectURL(file);
  els.videoPreview.src = selectedVideoUrl;
  els.fileMeta.textContent = `${file.name} · ${formatBytes(file.size)}`;
  els.analyzeButton.disabled = false;
  clearResults("准备分析音轨。");
  loadVideoIntoCutter(file);

  analyzeSelectedFile();
}

function getCutterApi() {
  if (cutterApiPromise) {
    return cutterApiPromise;
  }

  cutterApiPromise = new Promise((resolve, reject) => {
    const startedAt = performance.now();

    function check() {
      const api = els.cutterFrame?.contentWindow?.videoCutterTask;
      if (api) {
        resolve(api);
        return;
      }

      if (performance.now() - startedAt > 7000) {
        reject(new Error("剪辑器初始化超时。"));
        return;
      }

      window.setTimeout(check, 80);
    }

    check();
  });

  return cutterApiPromise;
}

async function loadVideoIntoCutter(file) {
  els.cutterStatus.textContent = "载入视频";
  cutterLoadPromise = getCutterApi()
    .then((api) => api.loadFile(file, { autoSelectFirstTail: true }))
    .then((status) => {
      els.cutterStatus.textContent = status?.hasFile ? "已载入" : "等待视频";
      return status;
    })
    .catch((error) => {
      els.cutterStatus.textContent = "剪辑器异常";
      setAutofillStatus(error.message || "剪辑器载入失败。", true);
      return null;
    });

  return cutterLoadPromise;
}

function buildCutterConfig(match) {
  const videoSegments = [
    { start: match.videoStart, end: match.cutPhraseStart },
    { start: match.cutPhraseEnd, end: match.cutScriptEnd },
  ];
  const tailAudioRange = {
    start: match.cutScriptEnd,
    end: match.videoEnd,
  };
  const warnings = [];
  const validSegments = videoSegments.filter((segment, index) => {
    const isValid = segment.end > segment.start;
    if (!isValid) {
      warnings.push(`第 ${index + 1} 个保留片段长度小于等于 0，已跳过。`);
    }
    return isValid;
  });
  const validTailAudioRange = tailAudioRange.end > tailAudioRange.start ? tailAudioRange : null;

  if (!validTailAudioRange) {
    warnings.push("尾版音轨片段长度小于等于 0，未自动填写。");
  }

  return {
    tailAudioRange: validTailAudioRange,
    videoSegments: validSegments,
    warnings,
  };
}

function getSelectedMatch() {
  const index = Number(els.matchSelect.value || 0);
  return latestMatches[index] || latestMatches[0] || null;
}

async function applySelectedMatchToCutter() {
  const match = getSelectedMatch();
  if (!match) return;

  const config = buildCutterConfig(match);
  if (!config.videoSegments.length) {
    setAutofillStatus("没有可用的保留片段，未写入剪辑配置。", true);
    return;
  }

  els.applyMatchButton.disabled = true;
  els.cutterStatus.textContent = "自动填充";
  setAutofillStatus(`正在把第 ${Number(els.matchSelect.value) + 1} 条识别结果写入剪辑器。`);

  try {
    const api = await getCutterApi();
    await cutterLoadPromise;
    const status = await api.applyAutoConfig({
      sourceLabel: match.phrase,
      tailAudioRange: config.tailAudioRange,
      videoSegments: config.videoSegments,
      warnings: config.warnings,
    });
    els.cutterStatus.textContent = "已填入";
    setAutofillStatus(describeAutofillResult(match, config, status), config.warnings.length > 0);
  } catch (error) {
    els.cutterStatus.textContent = "填入失败";
    setAutofillStatus(error.message || "自动填入剪辑配置失败。", true);
  } finally {
    els.applyMatchButton.disabled = false;
  }
}

function describeAutofillResult(match, config, status) {
  const warningText = config.warnings.length ? ` ${config.warnings.join(" ")}` : "";
  const segmentCount = status?.appliedSegments ?? config.videoSegments.length;
  const tailText = status?.appliedTailAudio || config.tailAudioRange ? "尾版音轨已填写。" : "尾版音轨未填写。";
  return `已使用“${match.phrase}”填入 ${segmentCount} 个保留片段，${tailText}${warningText}`;
}

function setAutofillStatus(message, isWarning = false) {
  els.autofillStatus.textContent = message;
  els.autofillStatus.classList.toggle("warning", Boolean(isWarning));
}

async function analyzeSelectedFile() {
  if (!selectedFile) return;

  const jobId = activeJobId + 1;
  activeJobId = jobId;
  setBusy(true);
  clearResults("正在分析，请稍候。");
  setProgress(4, "读取视频文件");

  try {
    const audio = await extractAudio(selectedFile);
    if (!isActive(jobId)) return;
    latestAudio = audio;
    setProgress(26, "音轨已提取");

    const transcriber = await loadTranscriber(els.modelSelect.value, jobId);
    if (!isActive(jobId)) return;
    setProgress(64, "正在识别音轨内容");

    const transcription = await transcribeAudio(transcriber, audio.samples);
    if (!isActive(jobId)) return;
    latestTranscription = transcription;
    latestWords = collectTimedWords(transcription, audio.duration);
    els.transcriptText.value = transcription.text?.trim() || "";

    renderDetectionFromLatest();
    setProgress(100, "分析完成");
    els.statusLine.textContent = "分析完成，可以复制关键时间点。";
  } catch (error) {
    console.error(error);
    renderError(error);
  } finally {
    if (isActive(jobId)) {
      setBusy(false);
    }
  }
}

async function extractAudio(file) {
  const arrayBuffer = await file.arrayBuffer();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error("当前浏览器不支持音频解码。");
  }

  const audioContext = new AudioContextClass();
  let decoded;
  try {
    decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    throw new Error("无法解码视频音轨。请使用 Chrome 或 Edge，并上传带 AAC/MP3 音轨的 MP4/WebM 视频。");
  } finally {
    audioContext.close?.().catch(() => {});
  }

  if (!decoded.duration || decoded.length === 0) {
    throw new Error("未检测到可分析的音轨。");
  }

  const samples = await renderMono16k(decoded);
  return {
    duration: decoded.duration,
    sampleRate: TARGET_SAMPLE_RATE,
    samples,
  };
}

async function renderMono16k(audioBuffer) {
  const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (OfflineContext) {
    const length = Math.max(1, Math.ceil(audioBuffer.duration * TARGET_SAMPLE_RATE));
    const offline = new OfflineContext(1, length, TARGET_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    return new Float32Array(rendered.getChannelData(0));
  }

  const mono = mixToMono(audioBuffer);
  return resampleLinear(mono, audioBuffer.sampleRate, TARGET_SAMPLE_RATE);
}

async function loadTranscriber(modelId, jobId) {
  if (cachedTranscriber && cachedModelId === modelId) {
    return cachedTranscriber;
  }

  setProgress(30, "加载识别引擎");
  transformerModule ||= await import(TRANSFORMERS_CDN);

  const { env, pipeline } = transformerModule;
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.wasmPaths = `${TRANSFORMERS_CDN}/dist/`;

  cachedModelId = modelId;
  cachedTranscriber = await pipeline("automatic-speech-recognition", modelId, {
    quantized: true,
    progress_callback: (progress) => {
      if (!isActive(jobId)) return;
      if (progress.status === "progress" && typeof progress.progress === "number") {
        const pct = 30 + Math.round(Math.min(progress.progress, 100) * 0.3);
        setProgress(pct, `加载模型 ${Math.round(progress.progress)}%`);
      } else if (progress.status === "ready") {
        setProgress(62, "模型已就绪");
      }
    },
  });

  return cachedTranscriber;
}

async function transcribeAudio(transcriber, samples) {
  const options = {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: "word",
  };

  try {
    return await transcriber(samples, options);
  } catch (error) {
    console.warn("Word timestamps unavailable, falling back to segment timestamps.", error);
    return transcriber(samples, {
      ...options,
      return_timestamps: true,
    });
  }
}

function renderDetectionFromLatest() {
  const silenceMs = readSilenceMs();
  const profile = buildEnergyProfile(latestAudio.samples, latestAudio.sampleRate);
  const matches = findMatches({
    audio: latestAudio,
    profile,
    silenceMs,
    words: latestWords,
  });

  renderMatches(matches);
}

function findMatches({ audio, profile, silenceMs, words }) {
  if (!words.length) {
    return [];
  }

  const matches = TARGET_PHRASES.flatMap((target) =>
    findTargetPhraseMatches(words, target, audio, profile, silenceMs),
  );

  return dedupeMatches(matches);
}

function findTargetPhraseMatches(words, target, audio, profile, silenceMs) {
  const matches = [];
  for (let startIndex = 0; startIndex < words.length; startIndex += 1) {
    const maxEnd = Math.min(words.length - 1, startIndex + 4);

    for (let endIndex = startIndex; endIndex <= maxEnd; endIndex += 1) {
      const joined = words
        .slice(startIndex, endIndex + 1)
        .map((word) => word.clean)
        .join("");
      const score = getTargetCandidateScore(joined, target);

      if (score === null) {
        continue;
      }

      matches.push(createMatch(words, startIndex, endIndex, target, score, audio, profile, silenceMs));
      startIndex = endIndex;
      break;
    }
  }
  return matches;
}

function createMatch(words, startIndex, endIndex, target, score, audio, profile, silenceMs) {
  const startWord = words[startIndex];
  const endWord = words[endIndex];
  const phraseStart = clampTime(startWord.start, audio.duration);
  const phraseEnd = clampTime(endWord.end || endWord.start, audio.duration);
  const audioSpeechEnd = findSpeechEnd(profile, phraseEnd, silenceMs, audio.duration);
  const transcriptSpeechEnd = findTranscriptBlockEnd(words, endIndex, silenceMs, audio.duration);
  const scriptEnd = chooseScriptEnd(phraseEnd, audioSpeechEnd, transcriptSpeechEnd);
  const rawScriptEnd = clampTime(scriptEnd, audio.duration);

  return {
    phrase: target.label,
    score,
    startIndex,
    endIndex,
    phraseStart,
    phraseEnd,
    scriptEnd: rawScriptEnd,
    videoStart: 0,
    videoEnd: audio.duration,
    cutPhraseStart: clampTime(phraseStart - CUT_OFFSET_SECONDS, audio.duration),
    cutPhraseEnd: phraseEnd,
    cutScriptEnd: clampTime(rawScriptEnd + CUT_OFFSET_SECONDS, audio.duration),
    text: words
      .slice(startIndex, endIndex + 1)
      .map((word) => word.raw)
      .join(" "),
  };
}

function getTargetCandidateScore(joined, target) {
  if (joined === target.compact) {
    return 0;
  }

  if (joined.startsWith("open")) {
    const suffixScore = getSuffixCandidateScore(joined.slice(4), target);
    return suffixScore === null ? null : suffixScore;
  }

  const fullDistance = levenshtein(joined, target.compact);
  return joined.length >= target.compact.length - 1 && joined.length <= target.compact.length + 2 && fullDistance <= 2
    ? fullDistance + 1
    : null;
}

function getSuffixCandidateScore(value, target) {
  const candidate = normalizeToken(value);
  if (!candidate || target.rejectSet.has(candidate)) return null;
  if (target.aliasSet.has(candidate)) return 0;
  if (candidate.length < target.minLength || candidate.length > target.maxLength) return null;

  const distance = levenshtein(candidate, target.suffix);
  return distance <= target.maxDistance ? distance + 1 : null;
}

function collectTimedWords(transcription, duration) {
  const chunks = Array.isArray(transcription?.chunks) ? transcription.chunks : [];
  const words = [];

  chunks.forEach((chunk) => {
    const [start, end] = Array.isArray(chunk.timestamp) ? chunk.timestamp : [];
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return;

    const tokens = splitTextTokens(chunk.text || "");
    if (!tokens.length) return;

    const safeStart = clampTime(start, duration);
    const safeEnd = clampTime(end, duration);
    const span = Math.max(0.03, safeEnd - safeStart);
    const step = span / tokens.length;

    tokens.forEach((token, index) => {
      const tokenStart = tokens.length === 1 ? safeStart : safeStart + step * index;
      const tokenEnd = tokens.length === 1 ? safeEnd : safeStart + step * (index + 1);
      const clean = normalizeToken(token);
      if (clean) {
        words.push({
          raw: token,
          clean,
          start: clampTime(tokenStart, duration),
          end: clampTime(tokenEnd, duration),
        });
      }
    });
  });

  return dedupeWords(words.sort((a, b) => a.start - b.start));
}

function dedupeWords(words) {
  const merged = [];
  words.forEach((word) => {
    const last = merged[merged.length - 1];
    if (last && last.clean === word.clean && Math.abs(last.start - word.start) < 0.45) {
      last.end = Math.max(last.end, word.end);
      return;
    }
    merged.push({ ...word });
  });
  return merged;
}

function dedupeMatches(matches) {
  const sorted = [...matches].sort((a, b) => a.phraseStart - b.phraseStart || a.score - b.score);
  const deduped = [];

  sorted.forEach((match) => {
    const last = deduped[deduped.length - 1];
    if (last && rangesOverlap(last, match)) {
      if (
        match.score < last.score ||
        (match.score === last.score && match.phraseEnd - match.phraseStart > last.phraseEnd - last.phraseStart)
      ) {
        deduped[deduped.length - 1] = match;
      }
      return;
    }
    deduped.push(match);
  });

  return deduped;
}

function rangesOverlap(a, b) {
  return a.startIndex <= b.endIndex && b.startIndex <= a.endIndex;
}

function buildEnergyProfile(samples, sampleRate) {
  const frameSize = Math.max(1, Math.round(sampleRate * 0.02));
  const frames = [];

  for (let start = 0; start < samples.length; start += frameSize) {
    let sum = 0;
    const end = Math.min(samples.length, start + frameSize);
    for (let index = start; index < end; index += 1) {
      const sample = samples[index];
      sum += sample * sample;
    }
    frames.push(Math.sqrt(sum / Math.max(1, end - start)));
  }

  const sorted = [...frames].sort((a, b) => a - b);
  const noise = percentile(sorted, 0.25);
  const peak = percentile(sorted, 0.95);
  const threshold = Math.max(0.004, noise * 2.8, peak * 0.045);

  return {
    frameDuration: frameSize / sampleRate,
    frames,
    threshold,
  };
}

function findSpeechEnd(profile, startSeconds, silenceMs, duration) {
  const silenceFramesNeeded = Math.max(1, Math.ceil((silenceMs / 1000) / profile.frameDuration));
  const startFrame = Math.max(0, Math.floor(startSeconds / profile.frameDuration));
  let silentCount = 0;
  let silenceStart = -1;

  for (let index = startFrame; index < profile.frames.length; index += 1) {
    if (profile.frames[index] < profile.threshold) {
      if (silentCount === 0) {
        silenceStart = index;
      }
      silentCount += 1;
      if (silentCount >= silenceFramesNeeded) {
        return Math.max(startSeconds, silenceStart * profile.frameDuration);
      }
    } else {
      silentCount = 0;
      silenceStart = -1;
    }
  }

  return duration;
}

function findTranscriptBlockEnd(words, phraseEndIndex, silenceMs, duration) {
  const gapSeconds = silenceMs / 1000;
  let blockEnd = words[phraseEndIndex].end;

  for (let index = phraseEndIndex + 1; index < words.length; index += 1) {
    const previous = words[index - 1];
    const current = words[index];
    if (current.start - previous.end >= gapSeconds) {
      return blockEnd;
    }
    blockEnd = current.end;
  }

  return Math.min(blockEnd, duration);
}

function chooseScriptEnd(phraseEnd, audioSpeechEnd, transcriptSpeechEnd) {
  if (transcriptSpeechEnd > phraseEnd + 0.15) {
    return transcriptSpeechEnd;
  }

  return audioSpeechEnd - phraseEnd <= 0.45 ? audioSpeechEnd : phraseEnd;
}

function splitTextTokens(text) {
  return text.match(/[a-z0-9]+(?:['-][a-z0-9]+)?/gi) || [];
}

function normalizeToken(token) {
  return String(token)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function readSilenceMs() {
  const value = Number(els.silenceInput.value);
  return Number.isFinite(value) ? Math.min(2500, Math.max(300, value)) : 750;
}

function mixToMono(audioBuffer) {
  const output = new Float32Array(audioBuffer.length);
  for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex += 1) {
    const channel = audioBuffer.getChannelData(channelIndex);
    for (let index = 0; index < channel.length; index += 1) {
      output[index] += channel[index] / audioBuffer.numberOfChannels;
    }
  }
  return output;
}

function resampleLinear(input, inputRate, outputRate) {
  if (inputRate === outputRate) {
    return new Float32Array(input);
  }

  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(input.length - 1, left + 1);
    const weight = position - left;
    output[index] = input[left] * (1 - weight) + input[right] * weight;
  }

  return output;
}

function renderMatches(matches) {
  latestMatches = matches;
  els.resultBody.innerHTML = "";
  els.resultCount.textContent = `${matches.length} 次`;
  els.copyAllButton.disabled = matches.length === 0;
  renderMatchSelector(matches);

  if (!matches.length) {
    els.resultWrap.hidden = true;
    els.emptyResult.hidden = false;
    els.emptyResult.className = "empty-result error";
    els.emptyResult.textContent = NO_MATCH_MESSAGE;
    els.copyText.value = NO_MATCH_MESSAGE;
    els.statusLine.textContent = NO_MATCH_MESSAGE;
    return;
  }

  els.emptyResult.hidden = true;
  els.resultWrap.hidden = false;

  matches.forEach((match, index) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td><span class="phrase-badge">${match.phrase}</span></td>
      <td>${formatTime(match.videoStart)}</td>
      <td>${formatTime(match.cutPhraseStart)}</td>
      <td>${formatTime(match.cutPhraseEnd)}</td>
      <td>${formatTime(match.cutScriptEnd)}</td>
      <td>${formatTime(match.videoEnd)}</td>
    `;
    els.resultBody.appendChild(tr);
  });

  els.copyText.value = matches.map((match, index) => formatSingleResult(match, index)).join("\n\n");
  window.lucide?.createIcons();
  applySelectedMatchToCutter();
}

function renderMatchSelector(matches) {
  if (!matches.length) {
    els.autofillPanel.hidden = true;
    els.matchSelect.innerHTML = "";
    setAutofillStatus("识别完成后会自动填入剪辑配置。");
    return;
  }

  els.autofillPanel.hidden = false;
  els.matchSelect.innerHTML = matches
    .map((match, index) => {
      const label = `${index + 1}. ${match.phrase} ｜ ${formatTime(match.cutPhraseStart)} - ${formatTime(match.cutScriptEnd)}`;
      return `<option value="${index}">${escapeHtml(label)}</option>`;
    })
    .join("");
  els.matchSelect.value = "0";
  setAutofillStatus(matches.length > 1 ? "默认使用第 1 条识别结果，可切换后重新填入。" : "默认使用这条识别结果自动填入。");
}

function formatSingleResult(match, index) {
  return [
    `第 ${index + 1} 次`,
    `识别内容：${match.phrase}`,
    `视频开始时间：${formatTime(match.videoStart)}`,
    "剪切用时间：",
    `关键词开始时间（前推0.5秒）：${formatTime(match.cutPhraseStart)}`,
    `关键词结束时间：${formatTime(match.cutPhraseEnd)}`,
    `口播完整结束时间（后延0.5秒）：${formatTime(match.cutScriptEnd)}`,
    `视频结束时间：${formatTime(match.videoEnd)}`,
    "原始识别时间：",
    `开始出现：${formatTime(match.phraseStart)}`,
    `关键词结束：${formatTime(match.phraseEnd)}`,
    `口播完整结束：${formatTime(match.scriptEnd)}`,
  ].join("\n");
}

function clearResults(message) {
  latestMatches = [];
  els.resultBody.innerHTML = "";
  els.resultWrap.hidden = true;
  els.autofillPanel.hidden = true;
  els.emptyResult.hidden = false;
  els.emptyResult.className = "empty-result";
  els.emptyResult.textContent = message;
  els.copyText.value = "";
  els.transcriptText.value = "";
  els.resultCount.textContent = "0 次";
  els.copyAllButton.disabled = true;
  els.statusLine.textContent = message;
}

function renderError(error) {
  setProgress(0, "分析失败");
  els.emptyResult.hidden = false;
  els.emptyResult.className = "empty-result error";
  els.emptyResult.textContent = error.message || "分析失败";
  els.resultWrap.hidden = true;
  els.copyAllButton.disabled = true;
  els.statusLine.textContent = error.message || "分析失败";
  showToast(error.message || "分析失败");
}

function setBusy(isBusy) {
  els.analyzeButton.disabled = isBusy || !selectedFile;
  els.videoInput.disabled = isBusy;
  els.modelSelect.disabled = isBusy;
}

function setProgress(percent, text) {
  els.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  els.progressText.textContent = text;
}

function isActive(jobId) {
  return jobId === activeJobId;
}

function clampTime(value, duration) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(duration, value));
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "00:00:00";

  const totalCentis = Math.max(0, Math.round(seconds * 100));
  const minutes = Math.floor(totalCentis / 6000);
  const secs = Math.floor((totalCentis % 6000) / 100);
  const centis = totalCentis % 100;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}:${String(centis).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function percentile(sortedValues, percentileValue) {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor(sortedValues.length * percentileValue)));
  return sortedValues[index];
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[a.length][b.length];
}

async function copyValue(value, message = "已复制") {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    els.copyText.focus();
    els.copyText.select();
    document.execCommand("copy");
  }
  showToast(message);
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    els.toast.classList.remove("show");
  }, 2200);
}

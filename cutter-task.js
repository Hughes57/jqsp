const state = {
  file: null,
  sourceUrl: "",
  duration: 0,
  frameRate: 0,
  start: 0,
  end: 0,
  segments: [],
  tailAudioStart: 0,
  tailAudioEnd: 0,
  tailAudioFrameRange: null,
  backendAvailable: false,
  mp4Available: false,
  tailAppendAvailable: false,
  frameProbeAvailable: false,
  tails: [],
  selectedTailId: "",
  autoSelectFirstTail: false,
  userTailChoice: false,
  isGenerating: false,
  mediaRecorder: null,
  chunks: [],
  isPreviewing: false,
  recordingTimer: null,
  progressTimer: null,
  outputUrl: "",
  loadId: 0,
};

const elements = {
  dropZone: document.querySelector("#dropZone"),
  emptyState: document.querySelector("#emptyState"),
  videoInput: document.querySelector("#videoInput"),
  pickVideoButton: document.querySelector("#pickVideoButton"),
  video: document.querySelector("#sourceVideo"),
  fileName: document.querySelector("#fileName"),
  startInput: document.querySelector("#startInput"),
  endInput: document.querySelector("#endInput"),
  startRange: document.querySelector("#startRange"),
  endRange: document.querySelector("#endRange"),
  selectionFill: document.querySelector("#selectionFill"),
  currentTime: document.querySelector("#currentTime"),
  durationTime: document.querySelector("#durationTime"),
  clipLength: document.querySelector("#clipLength"),
  segmentsSummary: document.querySelector("#segmentsSummary"),
  segmentList: document.querySelector("#segmentList"),
  addSegmentButton: document.querySelector("#addSegmentButton"),
  clearSegmentsButton: document.querySelector("#clearSegmentsButton"),
  tailSummary: document.querySelector("#tailSummary"),
  tailList: document.querySelector("#tailList"),
  tailInput: document.querySelector("#tailInput"),
  pickTailButton: document.querySelector("#pickTailButton"),
  tailAudioLength: document.querySelector("#tailAudioLength"),
  tailAudioStartInput: document.querySelector("#tailAudioStartInput"),
  tailAudioEndInput: document.querySelector("#tailAudioEndInput"),
  markTailAudioStartButton: document.querySelector("#markTailAudioStartButton"),
  markTailAudioEndButton: document.querySelector("#markTailAudioEndButton"),
  markStartButton: document.querySelector("#markStartButton"),
  markEndButton: document.querySelector("#markEndButton"),
  previewButton: document.querySelector("#previewButton"),
  trimButton: document.querySelector("#trimButton"),
  webmButton: document.querySelector("#webmButton"),
  progressFill: document.querySelector("#progressFill"),
  statusText: document.querySelector("#statusText"),
  downloadLink: document.querySelector("#downloadLink"),
};

const recorderTypes = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

const tailLibraryChannel = typeof BroadcastChannel === "undefined"
  ? null
  : new BroadcastChannel("video-cutter-tail-library");

function notifyTailLibraryChanged() {
  tailLibraryChannel?.postMessage({ type: "tails-changed" });
}

tailLibraryChannel?.addEventListener("message", (event) => {
  if (event.data?.type === "tails-changed") {
    loadTailLibrary();
  }
});

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "00:00:00";

  const boundedCentis = Math.max(0, Math.round(seconds * 100));
  const minutes = Math.floor(boundedCentis / 6000);
  const secs = Math.floor((boundedCentis % 6000) / 100);
  const centis = boundedCentis % 100;
  const minText = String(minutes).padStart(2, "0");
  const secText = String(secs).padStart(2, "0");
  const centisText = String(centis).padStart(2, "0");

  return `${minText}:${secText}:${centisText}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseTime(value) {
  const text = String(value).trim();
  if (!text) return NaN;

  if (/^\d+(\.\d+)?$/.test(text)) {
    return Number(text);
  }

  const parts = text.split(":").map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => part === "")) {
    return NaN;
  }

  const numbers = parts.map(Number);
  if (numbers.some((part) => !Number.isFinite(part) || part < 0)) {
    return NaN;
  }

  if (numbers.length === 2) {
    return numbers[0] * 60 + numbers[1];
  }

  const centisecondText = parts[2].length > 2 ? parts[2].slice(0, 2) : parts[2];
  return numbers[0] * 60 + numbers[1] + Number(centisecondText) / 100;
}

function parseCompactFilenameTime(value) {
  const text = String(value || "").trim();
  if (!/^\d{6,}$/.test(text)) return NaN;

  const compactTime = text.slice(0, 6);
  const minutes = Number(compactTime.slice(0, 2));
  const seconds = Number(compactTime.slice(2, 4));
  const centis = Number(compactTime.slice(4, 6));

  if (seconds >= 60) return NaN;
  return minutes * 60 + seconds + centis / 100;
}

function parseRawFilenameRanges(text) {
  const ranges = [];
  const pattern = /(?:第\s*)?(\d{1,9})\s*(?:帧|frames?|frame|f)?\s*(?:-|—|–|~|至|到)\s*(?:第\s*)?(\d{1,9})\s*(?:帧|frames?|frame|f)?/gi;
  let match = pattern.exec(text);

  while (match) {
    ranges.push({
      startText: match[1],
      endText: match[2],
      sourceText: match[0],
    });

    match = pattern.exec(text);
  }

  return ranges;
}

function parseColonFilenameRanges(text) {
  const ranges = [];
  const timePattern = /\d{1,3}:\d{1,2}(?::\d{1,3})?/;
  const pattern = new RegExp(
    `(${timePattern.source})\\s*(?:-|—|–|~|至|到)\\s*(${timePattern.source})`,
    "g"
  );
  let match = pattern.exec(text);

  while (match) {
    const start = parseTime(match[1]);
    const end = parseTime(match[2]);

    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      ranges.push({ start, end });
    }

    match = pattern.exec(text);
  }

  return ranges;
}

function parseSectionRanges(text) {
  const explicitFrameSection = /(?:帧|frames?|frame|fps)/i.test(text);
  const timeRanges = parseColonFilenameRanges(text);
  const frameRanges = [];

  parseRawFilenameRanges(text).forEach((range) => {
    const start = Number(range.startText);
    const end = Number(range.endText);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;

    const startTime = parseCompactFilenameTime(range.startText);
    const endTime = parseCompactFilenameTime(range.endText);
    const isCompactTime = !explicitFrameSection && Number.isFinite(startTime) && Number.isFinite(endTime);

    if (isCompactTime) {
      timeRanges.push({ start: startTime, end: endTime });
      return;
    }

    frameRanges.push({
      frameStart: start,
      frameEnd: end,
    });
  });

  return { timeRanges, frameRanges };
}

function parseFilenameTimeHints(fileName) {
  const name = String(fileName || "").replace(/\.[^.]+$/, "");
  const bracketContents = [...name.matchAll(/[（(]([^（）()]*)[）)]/g)].map((match) => match[1]).join("；");
  const source = bracketContents || name;
  const videoMatch = source.match(/视频保留\s*[:：]([\s\S]*?)(?=音轨保留\s*[:：]|$)/);
  const audioMatch = source.match(/音轨保留\s*[:：]([\s\S]*)/);
  const videoRanges = videoMatch ? parseSectionRanges(videoMatch[1]) : { timeRanges: [], frameRanges: [] };
  const audioRanges = audioMatch ? parseSectionRanges(audioMatch[1]) : { timeRanges: [], frameRanges: [] };

  return {
    videoSegments: videoRanges.timeRanges,
    videoFrameRanges: videoRanges.frameRanges,
    tailAudioRange: audioRanges.timeRanges[0] || null,
    tailAudioFrameRange: audioRanges.frameRanges[0] || null,
    hasFrameRanges: Boolean(videoRanges.frameRanges.length || audioRanges.frameRanges.length),
  };
}

function normalizeSegmentsForDuration(segments) {
  return segments
    .map((segment) => {
      const normalized = {
        start: clamp(segment.start, 0, state.duration || 0),
        end: clamp(segment.end, 0, state.duration || 0),
      };

      if (Number.isFinite(segment.frameStart) && Number.isFinite(segment.frameEnd)) {
        normalized.frameStart = segment.frameStart;
        normalized.frameEnd = segment.frameEnd;
      }

      return normalized;
    })
    .filter((segment) => segment.end > segment.start)
    .sort((a, b) => a.start - b.start);
}

function frameRangeToSegment(range, frameRate) {
  return {
    start: range.frameStart / frameRate,
    end: range.frameEnd / frameRate,
    frameStart: range.frameStart,
    frameEnd: range.frameEnd,
  };
}

function frameRangeToAudioRange(range, frameRate) {
  return {
    start: range.frameStart / frameRate,
    end: range.frameEnd / frameRate,
    frameStart: range.frameStart,
    frameEnd: range.frameEnd,
  };
}

async function probeVideoMetadata(file) {
  if (!state.backendAvailable) {
    throw new Error("按帧号识别需要从本地服务地址打开页面。");
  }

  const response = await fetch("/api/probe", {
    method: "POST",
    headers: {
      "content-type": file?.type || "application/octet-stream",
    },
    body: file,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "视频帧率读取失败。");
  }

  const fps = Number(payload.fps);
  const duration = Number(payload.duration);
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error("视频帧率读取失败。");
  }

  return {
    duration: Number.isFinite(duration) ? duration : 0,
    fps,
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function setStatus(message, progress = null) {
  elements.statusText.textContent = message;
  if (progress !== null) {
    elements.progressFill.style.width = `${clamp(progress, 0, 1) * 100}%`;
  }
}

function setDownload(url, extension = "mp4") {
  if (state.outputUrl) {
    URL.revokeObjectURL(state.outputUrl);
  }

  state.outputUrl = url;
  if (!url) {
    elements.downloadLink.removeAttribute("href");
    elements.downloadLink.classList.remove("ready");
    return;
  }

  const baseName = state.file?.name?.replace(/\.[^.]+$/, "") || "clip";
  elements.downloadLink.href = url;
  elements.downloadLink.download = `${baseName}-${formatTime(state.start).replaceAll(":", "-")}-${formatTime(state.end).replaceAll(":", "-")}.${extension}`;
  elements.downloadLink.classList.add("ready");
}

function getEffectiveSegments() {
  const source = state.segments.length ? state.segments : [{ start: state.start, end: state.end }];
  return normalizeSegmentsForDuration(source);
}

function getSegmentsDuration(segments = getEffectiveSegments()) {
  return segments.reduce((total, segment) => total + segment.end - segment.start, 0);
}

function updateButtons() {
  const hasVideo = Boolean(state.file && state.duration > 0);
  const segments = getEffectiveSegments();
  const validRange = hasVideo && segments.length > 0;
  const hasSelectedTail = Boolean(state.selectedTailId);
  const validTailAudio = !hasSelectedTail || state.tailAudioEnd > state.tailAudioStart;
  elements.previewButton.disabled = !validRange;
  elements.addSegmentButton.disabled = !hasVideo || state.end <= state.start;
  elements.clearSegmentsButton.disabled = !state.segments.length;
  elements.trimButton.disabled =
    !validRange ||
    !validTailAudio ||
    !state.backendAvailable ||
    !state.mp4Available ||
    state.isGenerating ||
    Boolean(state.mediaRecorder);
  elements.webmButton.disabled = !validRange || Boolean(state.mediaRecorder);
  elements.webmButton.classList.toggle("visible", !state.mp4Available);

  const selectedTail = state.tails.find((tail) => tail.id === state.selectedTailId);
  if (selectedTail) {
    elements.tailSummary.textContent = selectedTail.name;
  } else {
    elements.tailSummary.textContent = "不拼接尾版";
  }
}

function renderSegments() {
  if (!state.segments.length) {
    elements.segmentList.innerHTML = `<p class="tail-empty">未添加片段时，会直接使用上面的开始和结束时间。</p>`;
    elements.segmentsSummary.textContent = "使用当前时间段";
    updateButtons();
    return;
  }

  const segments = getEffectiveSegments();
  elements.segmentsSummary.textContent = `${segments.length} 段 / ${formatTime(getSegmentsDuration(segments))}`;
  elements.segmentList.innerHTML = segments
    .map((segment, index) => {
      const frameLabel = Number.isFinite(segment.frameStart) && Number.isFinite(segment.frameEnd)
        ? `第 ${segment.frameStart} 帧 - 第 ${segment.frameEnd} 帧 / `
        : "";
      return `
        <div class="segment-item">
          <span class="segment-time">${index + 1}. ${frameLabel}${formatTime(segment.start)} - ${formatTime(segment.end)}</span>
          <button class="tail-remove" type="button" data-segment-index="${index}">删除</button>
        </div>
      `;
    })
    .join("");
  updateButtons();
}

function updateTailAudioSummary(syncInputs = true) {
  const length = Math.max(0, state.tailAudioEnd - state.tailAudioStart);
  const frameLabel = state.tailAudioFrameRange
    ? ` / 第 ${state.tailAudioFrameRange.frameStart} - ${state.tailAudioFrameRange.frameEnd} 帧`
    : "";
  elements.tailAudioLength.textContent = `${formatTime(length)}${frameLabel}`;

  if (syncInputs) {
    elements.tailAudioStartInput.value = formatTime(state.tailAudioStart);
    elements.tailAudioEndInput.value = formatTime(state.tailAudioEnd);
  }

  updateButtons();
}

function renderTailList() {
  const items = [
    `<label class="tail-item ${state.selectedTailId ? "" : "selected"}">
      <input type="radio" name="tail" value="" ${state.selectedTailId ? "" : "checked"} />
      <span class="tail-name">不拼接尾版</span>
    </label>`,
  ];

  if (!state.tails.length) {
    items.push(`<p class="tail-empty">还没有保存尾版视频，可以点击右上角加号上传。</p>`);
  }

  state.tails.forEach((tail) => {
    const checked = state.selectedTailId === tail.id ? "checked" : "";
    const selected = state.selectedTailId === tail.id ? "selected" : "";
    items.push(`
      <label class="tail-item ${selected}">
        <input type="radio" name="tail" value="${escapeHtml(tail.id)}" ${checked} />
        <span>
          <span class="tail-name">${escapeHtml(tail.name)}</span>
          <span class="tail-meta">${formatBytes(tail.size)}</span>
        </span>
        <button class="tail-remove" type="button" data-tail-id="${escapeHtml(tail.id)}">删除</button>
      </label>
    `);
  });

  elements.tailList.innerHTML = items.join("");
  updateButtons();
}

function updateSelection() {
  const max = state.duration || 1;
  const left = (state.start / max) * 100;
  const right = (state.end / max) * 100;
  elements.selectionFill.style.left = `${left}%`;
  elements.selectionFill.style.width = `${Math.max(0, right - left)}%`;
  elements.clipLength.textContent = formatTime(Math.max(0, state.end - state.start));
  updateButtons();
}

function setRangeInputs() {
  elements.startRange.max = String(state.duration);
  elements.endRange.max = String(state.duration);
  elements.startRange.value = String(state.start);
  elements.endRange.value = String(state.end);
  elements.startInput.value = formatTime(state.start);
  elements.endInput.value = formatTime(state.end);
  updateSelection();
}

function applyTimes(start, end, syncInputs = true) {
  const duration = state.duration || 0;
  state.start = clamp(start, 0, duration);
  state.end = clamp(end, 0, duration);

  if (state.end < state.start) {
    [state.start, state.end] = [state.end, state.start];
  }

  if (syncInputs) {
    setRangeInputs();
  } else {
    updateSelection();
  }
}

function applyTailAudioTimes(start, end, syncInputs = true) {
  const duration = state.duration || 0;
  state.tailAudioStart = clamp(start, 0, duration);
  state.tailAudioEnd = clamp(end, 0, duration);

  if (state.tailAudioEnd < state.tailAudioStart) {
    [state.tailAudioStart, state.tailAudioEnd] = [state.tailAudioEnd, state.tailAudioStart];
  }

  updateTailAudioSummary(syncInputs);
}

function handleManualTimeInput() {
  const start = parseTime(elements.startInput.value);
  const end = parseTime(elements.endInput.value);

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    setStatus("时间格式可以写成 75、01:15 或 00:12:50；输入 00:12:500 会按 00:12:50 处理。");
    updateButtons();
    return;
  }

  applyTimes(start, end, false);
  elements.startRange.value = String(state.start);
  elements.endRange.value = String(state.end);
  elements.startInput.value = formatTime(state.start);
  elements.endInput.value = formatTime(state.end);
  setStatus("时间段已更新。", 0);
}

function handleManualTailAudioInput() {
  const start = parseTime(elements.tailAudioStartInput.value);
  const end = parseTime(elements.tailAudioEndInput.value);

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    setStatus("尾版音轨时间格式可以写成 75、01:15 或 00:12:50；输入 00:12:500 会按 00:12:50 处理。");
    updateButtons();
    return;
  }

  state.tailAudioFrameRange = null;
  applyTailAudioTimes(start, end, true);
  setStatus("尾版音轨时间段已更新。", 0);
}

function getSupportedRecorderType() {
  return recorderTypes.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function getCaptureStream(video) {
  if (typeof video.captureStream === "function") {
    return video.captureStream();
  }

  if (typeof video.mozCaptureStream === "function") {
    return video.mozCaptureStream();
  }

  return null;
}

function resetRecordingState() {
  clearTimeout(state.recordingTimer);
  clearInterval(state.progressTimer);
  state.recordingTimer = null;
  state.progressTimer = null;
  state.mediaRecorder = null;
  updateButtons();
}

async function previewClip() {
  if (state.end <= state.start) return;

  clearTimeout(state.recordingTimer);
  state.isPreviewing = true;
  elements.video.pause();
  elements.video.currentTime = state.start;
  setStatus("正在预览选中的片段。", 0);

  await elements.video.play();
  state.recordingTimer = setTimeout(() => {
    state.isPreviewing = false;
    elements.video.pause();
    elements.video.currentTime = state.start;
    setStatus("预览结束，可以开始剪辑。", 0);
  }, (state.end - state.start) * 1000);
}

async function trimMp4Clip(options = {}) {
  const segments = getEffectiveSegments();
  if (!segments.length) {
    setStatus("请至少选择一个需要保留的视频片段。");
    return;
  }

  if (!state.backendAvailable) {
    setStatus("请从本地服务地址打开页面，才能导出 MP4。");
    return;
  }

  if (!state.mp4Available) {
    setStatus("没有检测到本地 MP4 剪辑能力。下面可以先用备用 WebM 导出。");
    updateButtons();
    return;
  }

  if (state.selectedTailId && !state.tailAppendAvailable) {
    setStatus("当前环境不能拼接尾版。可以取消尾版选择后只导出剪辑片段。");
    return;
  }

  if (state.selectedTailId && state.tailAudioEnd <= state.tailAudioStart) {
    setStatus("请选择一段用于尾版的原视频音轨。");
    return;
  }

  state.isGenerating = true;
  state.isPreviewing = false;
  clearTimeout(state.recordingTimer);
  setDownload("");
  setStatus(state.selectedTailId ? "正在剪辑并拼接尾版。" : "正在上传并剪辑 MP4。", 0.08);
  updateButtons();

  const params = new URLSearchParams({
    start: String(segments[0].start),
    end: String(segments[segments.length - 1].end),
    segments: JSON.stringify(segments),
    name: state.file?.name || "clip",
  });
  if (state.selectedTailId) {
    params.set("tailId", state.selectedTailId);
    params.set("tailAudioStart", String(state.tailAudioStart));
    params.set("tailAudioEnd", String(state.tailAudioEnd));
  }

  try {
    const response = await fetch(`/api/trim?${params}`, {
      method: "POST",
      headers: {
        "content-type": state.file?.type || "application/octet-stream",
      },
      body: state.file,
      signal: options.signal,
    });

    if (!response.ok) {
      let message = "MP4 剪辑失败。";
      try {
        const payload = await response.json();
        message = payload.error || message;
      } catch {
        // Keep the generic message if the server returned non-JSON text.
      }
      throw new Error(message);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    setDownload(url, "mp4");
    setStatus(state.selectedTailId ? "完整视频已生成，可以下载。" : "MP4 剪辑完成，可以下载片段。", 1);
  } catch (error) {
    console.error(error);
    const message = error.name === "AbortError"
      ? "剪切生成超时，已跳过该视频。"
      : error.message || "MP4 剪辑失败，可以试试备用 WebM 导出。";
    setStatus(message);
    if (options.throwOnError) {
      throw new Error(message);
    }
  } finally {
    state.isGenerating = false;
    updateButtons();
  }
}

async function trimWebmClip() {
  if (state.end <= state.start) {
    setStatus("结束时间需要大于开始时间。");
    return;
  }

  if (typeof MediaRecorder === "undefined") {
    setStatus("当前浏览器不支持剪辑导出，请换用 Chrome、Edge 或 Firefox。");
    return;
  }

  const stream = getCaptureStream(elements.video);
  if (!stream) {
    setStatus("当前浏览器无法捕获视频流，请换用 Chrome、Edge 或 Firefox。");
    return;
  }

  const mimeType = getSupportedRecorderType();
  state.chunks = [];
  state.isPreviewing = false;
  clearTimeout(state.recordingTimer);
  setDownload("");
  setStatus("准备剪辑，请保持这个页面打开。", 0);

  try {
    elements.video.pause();
    elements.video.currentTime = state.start;
    await new Promise((resolve) => {
      elements.video.addEventListener("seeked", resolve, { once: true });
    });

    state.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    state.mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        state.chunks.push(event.data);
      }
    });

    state.mediaRecorder.addEventListener("stop", () => {
      const blob = new Blob(state.chunks, { type: state.mediaRecorder?.mimeType || "video/webm" });
      const url = URL.createObjectURL(blob);
      setDownload(url, "webm");
      elements.video.pause();
      elements.video.currentTime = state.start;
      setStatus("WebM 剪辑完成，可以下载片段。", 1);
      resetRecordingState();
    });

    state.mediaRecorder.start(250);
    await elements.video.play();
    updateButtons();

    const clipSeconds = state.end - state.start;
    const startedAt = performance.now();
    state.progressTimer = setInterval(() => {
      const elapsed = (performance.now() - startedAt) / 1000;
      setStatus(`正在剪辑：${formatTime(Math.min(elapsed, clipSeconds))} / ${formatTime(clipSeconds)}`, elapsed / clipSeconds);
    }, 120);

    state.recordingTimer = setTimeout(() => {
      if (state.mediaRecorder?.state === "recording") {
        state.mediaRecorder.stop();
      }
    }, clipSeconds * 1000 + 180);
  } catch (error) {
    console.error(error);
    resetRecordingState();
    setStatus("剪辑没有成功，请确认视频可以正常播放后再试。");
  }
}

function loadVideo(file) {
  if (!file) return;

  if (state.sourceUrl) {
    URL.revokeObjectURL(state.sourceUrl);
  }

  state.file = file;
  state.sourceUrl = URL.createObjectURL(file);
  state.duration = 0;
  state.frameRate = 0;
  state.start = 0;
  state.end = 0;
  state.segments = [];
  state.tailAudioStart = 0;
  state.tailAudioEnd = 0;
  state.tailAudioFrameRange = null;
  state.loadId += 1;
  setDownload("");
  renderSegments();
  setStatus("正在读取视频信息。", 0);

  elements.video.src = state.sourceUrl;
  elements.video.load();
  elements.fileName.textContent = file.name;
  elements.dropZone.classList.add("has-video");
}

elements.videoInput.addEventListener("change", (event) => {
  loadVideo(event.target.files?.[0]);
});

elements.pickVideoButton.addEventListener("click", () => {
  elements.videoInput.click();
});

elements.pickTailButton.addEventListener("click", () => {
  elements.tailInput.click();
});

elements.addSegmentButton.addEventListener("click", () => {
  if (state.end <= state.start) {
    setStatus("当前片段的结束时间需要大于开始时间。");
    return;
  }

  state.segments.push({ start: state.start, end: state.end });
  state.segments.sort((a, b) => a.start - b.start);
  renderSegments();
  setStatus("已添加当前保留片段。", 0);
});

elements.clearSegmentsButton.addEventListener("click", () => {
  state.segments = [];
  renderSegments();
  setStatus("已清空保留片段，将使用当前时间段生成。", 0);
});

elements.segmentList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-segment-index]");
  if (!button) return;

  const index = Number(button.dataset.segmentIndex);
  state.segments.splice(index, 1);
  renderSegments();
  setStatus("已删除保留片段。", 0);
});

elements.tailInput.addEventListener("change", async (event) => {
  const files = Array.from(event.target.files || []).filter((file) => file.type.startsWith("video/"));
  if (!files.length) return;

  if (!state.backendAvailable) {
    setStatus("请从本地服务地址打开页面后再上传尾版。");
    return;
  }

  elements.pickTailButton.disabled = true;
  setStatus(`正在保存 ${files.length} 个尾版视频。`, 0.2);

  try {
    for (const file of files) {
      const params = new URLSearchParams({ name: file.name });
      const response = await fetch(`/api/tails?${params}`, {
        method: "POST",
        headers: {
          "content-type": file.type || "application/octet-stream",
        },
        body: file,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `${file.name} 上传失败。`);
      }
    }

    await loadTailLibrary();
    notifyTailLibraryChanged();
    setStatus("尾版视频已保存，可以选择后生成完整视频。", 0);
  } catch (error) {
    setStatus(error.message || "尾版上传失败。");
  } finally {
    elements.pickTailButton.disabled = false;
    elements.tailInput.value = "";
  }
});

elements.tailList.addEventListener("change", (event) => {
  if (event.target.name !== "tail") return;
  state.userTailChoice = true;
  state.selectedTailId = event.target.value;
  renderTailList();
  setStatus(state.selectedTailId ? "已选择尾版，请确认尾版音轨时间段。" : "已取消尾版拼接。", 0);
});

elements.tailList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-tail-id]");
  if (!button) return;

  const id = button.dataset.tailId;
  button.disabled = true;

  try {
    const response = await fetch(`/api/tails/${id}`, { method: "DELETE" });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "删除失败。");
    }

    if (state.selectedTailId === id) {
      state.selectedTailId = "";
    }

    await loadTailLibrary();
    notifyTailLibraryChanged();
    setStatus("尾版已删除。", 0);
  } catch (error) {
    setStatus(error.message || "尾版删除失败。");
    button.disabled = false;
  }
});

elements.video.addEventListener("loadedmetadata", async () => {
  const loadId = state.loadId;
  state.duration = elements.video.duration || 0;
  state.start = 0;
  state.end = Math.min(state.duration, 10);
  state.tailAudioStart = Math.min(state.end, state.duration);
  state.tailAudioEnd = Math.min(state.duration, state.tailAudioStart + 5);
  state.tailAudioFrameRange = null;
  if (state.tailAudioEnd <= state.tailAudioStart) {
    state.tailAudioEnd = state.duration;
    state.tailAudioStart = Math.max(0, state.duration - Math.min(5, state.duration));
  }

  const filenameHints = parseFilenameTimeHints(state.file?.name);
  let frameMetadata = null;
  let frameError = "";

  if (filenameHints.hasFrameRanges) {
    setStatus("已识别到文件名帧号，正在读取视频帧率。", 0.12);
    try {
      frameMetadata = await probeVideoMetadata(state.file);
      if (loadId !== state.loadId) return;
      state.frameRate = frameMetadata.fps;
    } catch (error) {
      if (loadId !== state.loadId) return;
      frameError = error.message || "视频帧率读取失败。";
    }
  }

  const frameSegments = frameMetadata
    ? filenameHints.videoFrameRanges.map((range) => frameRangeToSegment(range, frameMetadata.fps))
    : [];
  const parsedSegments = normalizeSegmentsForDuration([
    ...filenameHints.videoSegments,
    ...frameSegments,
  ]);
  let appliedFilenameHints = false;
  let appliedFrameHints = false;

  if (parsedSegments.length) {
    state.segments = parsedSegments;
    state.start = parsedSegments[0].start;
    state.end = parsedSegments[0].end;
    appliedFilenameHints = true;
    appliedFrameHints = frameSegments.length > 0;
  }

  const audioRange = frameMetadata && filenameHints.tailAudioFrameRange
    ? frameRangeToAudioRange(filenameHints.tailAudioFrameRange, frameMetadata.fps)
    : filenameHints.tailAudioRange;

  if (audioRange) {
    const normalizedAudio = normalizeSegmentsForDuration([audioRange])[0];
    if (normalizedAudio) {
      state.tailAudioStart = normalizedAudio.start;
      state.tailAudioEnd = normalizedAudio.end;
      state.tailAudioFrameRange = Number.isFinite(normalizedAudio.frameStart)
        ? {
            frameStart: normalizedAudio.frameStart,
            frameEnd: normalizedAudio.frameEnd,
          }
        : null;
      appliedFilenameHints = true;
      appliedFrameHints = appliedFrameHints || Number.isFinite(normalizedAudio.frameStart);
    }
  }

  elements.durationTime.textContent = formatTime(state.duration);
  setRangeInputs();
  updateTailAudioSummary(true);
  renderSegments();

  const readyMessage = appliedFrameHints
    ? `已从文件名按帧号识别并填入设置，帧率约 ${state.frameRate.toFixed(3)} fps。`
    : appliedFilenameHints
      ? "已从文件名识别并填入剪切时间。"
      : frameError
        ? `识别到帧号，但${frameError}`
        : state.mp4Available
          ? "视频已载入，可以导出 MP4。"
          : "视频已载入，但没有检测到本地 MP4 剪辑能力。可以先用备用 WebM 导出。";

  if (state.mp4Available) {
    setStatus(readyMessage, 0);
  } else {
    setStatus(readyMessage, 0);
  }

  elements.video.dispatchEvent(new CustomEvent("video-cutter-metadata-ready"));
});

elements.video.addEventListener("timeupdate", () => {
  elements.currentTime.textContent = formatTime(elements.video.currentTime);

  if (state.isPreviewing && elements.video.currentTime >= state.end && state.end > state.start) {
    state.isPreviewing = false;
    elements.video.pause();
  }
});

elements.startRange.addEventListener("input", () => {
  applyTimes(Number(elements.startRange.value), state.end);
});

elements.endRange.addEventListener("input", () => {
  applyTimes(state.start, Number(elements.endRange.value));
});

elements.startInput.addEventListener("change", handleManualTimeInput);
elements.endInput.addEventListener("change", handleManualTimeInput);
elements.tailAudioStartInput.addEventListener("change", handleManualTailAudioInput);
elements.tailAudioEndInput.addEventListener("change", handleManualTailAudioInput);

elements.markStartButton.addEventListener("click", () => {
  applyTimes(elements.video.currentTime, state.end);
  setStatus("已把当前播放位置设为开始。", 0);
});

elements.markEndButton.addEventListener("click", () => {
  applyTimes(state.start, elements.video.currentTime);
  setStatus("已把当前播放位置设为结束。", 0);
});

elements.markTailAudioStartButton.addEventListener("click", () => {
  state.tailAudioFrameRange = null;
  applyTailAudioTimes(elements.video.currentTime, state.tailAudioEnd);
  setStatus("已把当前播放位置设为尾版音轨开始。", 0);
});

elements.markTailAudioEndButton.addEventListener("click", () => {
  state.tailAudioFrameRange = null;
  applyTailAudioTimes(state.tailAudioStart, elements.video.currentTime);
  setStatus("已把当前播放位置设为尾版音轨结束。", 0);
});

elements.previewButton.addEventListener("click", previewClip);
elements.trimButton.addEventListener("click", trimMp4Clip);
elements.webmButton.addEventListener("click", trimWebmClip);

["dragenter", "dragover"].forEach((eventName) => {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("dragging");
  });
});

elements.dropZone.addEventListener("drop", (event) => {
  const file = Array.from(event.dataTransfer?.files || []).find((item) => item.type.startsWith("video/"));
  loadVideo(file);
});

window.addEventListener("beforeunload", () => {
  if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
  if (state.outputUrl) URL.revokeObjectURL(state.outputUrl);
});

async function checkBackend() {
  if (location.protocol === "file:") {
    state.backendAvailable = false;
    state.mp4Available = false;
    state.frameProbeAvailable = false;
    setStatus("当前是直接打开 HTML 文件。要导出 MP4，请使用本地服务地址打开。");
    updateButtons();
    return;
  }

  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    const payload = await response.json();
    state.backendAvailable = true;
    state.mp4Available = Boolean(payload.mp4Available);
    state.tailAppendAvailable = Boolean(payload.tailAppendAvailable);
    state.frameProbeAvailable = Boolean(payload.frameProbeAvailable);

    if (state.mp4Available) {
      setStatus("本地 MP4 服务已连接，选择视频后可以导出 MP4。", 0);
    } else {
      setStatus("本地服务已连接，但没有检测到 MP4 剪辑能力。", 0);
    }
  } catch {
    state.backendAvailable = false;
    state.mp4Available = false;
    state.tailAppendAvailable = false;
    state.frameProbeAvailable = false;
    setStatus("没有连接到本地 MP4 服务。请运行 server.js 后从本地服务地址打开页面。");
  }

  updateButtons();
}

async function loadTailLibrary() {
  if (!state.backendAvailable) {
    state.tails = [];
    renderTailList();
    return;
  }

  try {
    const response = await fetch("/api/tails", { cache: "no-store" });
    const payload = await response.json();
    state.tails = Array.isArray(payload.tails) ? payload.tails : [];
    if (state.selectedTailId && !state.tails.some((tail) => tail.id === state.selectedTailId)) {
      state.selectedTailId = "";
    }
    if (state.autoSelectFirstTail && !state.userTailChoice && !state.selectedTailId && state.tails.length) {
      state.selectedTailId = state.tails[0].id;
    }
  } catch {
    state.tails = [];
  }

  renderTailList();
}

function getTaskStatus() {
  return {
    appliedSegments: state.segments.length,
    appliedTailAudio: state.tailAudioEnd > state.tailAudioStart,
    downloadName: elements.downloadLink.download || "",
    fileName: state.file?.name || "",
    hasDownload: Boolean(elements.downloadLink.href),
    hasFile: Boolean(state.file),
    isGenerating: state.isGenerating,
    selectedTailId: state.selectedTailId,
  };
}

function waitForVideoLoad(file) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      elements.video.removeEventListener("video-cutter-metadata-ready", handleLoad);
      elements.video.removeEventListener("error", handleError);
    };
    const handleLoad = () => {
      cleanup();
      resolve(getTaskStatus());
    };
    const handleError = () => {
      cleanup();
      reject(new Error("视频读取失败。"));
    };

    elements.video.addEventListener("video-cutter-metadata-ready", handleLoad);
    elements.video.addEventListener("error", handleError);
    loadVideo(file);
  });
}

function applyAutoCutterConfig(config = {}) {
  if (!state.file || !state.duration) {
    throw new Error("请先载入主视频，再自动填入剪辑配置。");
  }

  const normalizedSegments = normalizeSegmentsForDuration(Array.isArray(config.videoSegments) ? config.videoSegments : []);
  if (!normalizedSegments.length) {
    throw new Error("没有可用的自动保留片段。");
  }

  state.segments = normalizedSegments;
  state.start = normalizedSegments[0].start;
  state.end = normalizedSegments[0].end;
  setRangeInputs();
  renderSegments();

  let appliedTailAudio = false;
  const audioRange = config.tailAudioRange || null;
  if (audioRange && Number.isFinite(Number(audioRange.start)) && Number.isFinite(Number(audioRange.end)) && Number(audioRange.end) > Number(audioRange.start)) {
    state.tailAudioFrameRange = null;
    applyTailAudioTimes(Number(audioRange.start), Number(audioRange.end), true);
    appliedTailAudio = true;
  } else {
    updateTailAudioSummary(true);
  }

  const warningText = Array.isArray(config.warnings) && config.warnings.length
    ? ` ${config.warnings.join(" ")}`
    : "";
  const sourceLabel = config.sourceLabel ? `“${config.sourceLabel}”` : "识别结果";
  setStatus(`已根据${sourceLabel}自动填入 ${normalizedSegments.length} 个保留片段。${warningText}`, warningText ? 0.5 : 0);
  updateButtons();

  return {
    ...getTaskStatus(),
    appliedSegments: normalizedSegments.length,
    appliedTailAudio,
  };
}

const bootPromise = checkBackend().then(loadTailLibrary);

window.videoCutterTask = {
  async applyAutoConfig(config = {}) {
    await bootPromise;
    return applyAutoCutterConfig(config);
  },
  async download() {
    if (!elements.downloadLink.href) return false;
    elements.downloadLink.click();
    return true;
  },
  async generate(options = {}) {
    await bootPromise;
    let controller = null;
    let timer = 0;

    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      controller = new AbortController();
      timer = window.setTimeout(() => controller.abort(), options.timeoutMs);
    }

    try {
      await trimMp4Clip({ signal: controller?.signal, throwOnError: true });
    } finally {
      if (timer) window.clearTimeout(timer);
    }

    return getTaskStatus();
  },
  getStatus: getTaskStatus,
  async loadFile(file, options = {}) {
    state.autoSelectFirstTail = Boolean(options.autoSelectFirstTail);
    await bootPromise;
    if (state.autoSelectFirstTail && !state.userTailChoice && !state.selectedTailId && state.tails.length) {
      state.selectedTailId = state.tails[0].id;
      renderTailList();
    }
    return waitForVideoLoad(file);
  },
  async refreshTails(options = {}) {
    if (options.autoSelectFirstTail !== undefined) {
      state.autoSelectFirstTail = Boolean(options.autoSelectFirstTail);
    }
    await bootPromise;
    await loadTailLibrary();
    return getTaskStatus();
  },
};

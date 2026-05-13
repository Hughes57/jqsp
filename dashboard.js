import {
  DEFAULT_MODEL_ID,
  DEFAULT_SILENCE_MS,
  NO_MATCH_MESSAGE,
  analyzeVideoFile,
  buildCutterConfig,
  escapeHtml,
  formatBytes,
  formatSingleResult,
  formatTime,
} from "./detector-core.js";

const RECOGNITION_TIMEOUT_MS = 10 * 60 * 1000;
const CUT_TIMEOUT_MS = 12 * 60 * 1000;

const taskStack = document.querySelector("#taskStack");
const taskTemplate = document.querySelector("#taskTemplate");
const addTaskButton = document.querySelector("#addTaskButton");
const batchUploadButton = document.querySelector("#batchUploadButton");
const batchVideoInput = document.querySelector("#batchVideoInput");
const recognizeAllButton = document.querySelector("#recognizeAllButton");
const generateAllButton = document.querySelector("#generateAllButton");
const downloadAllButton = document.querySelector("#downloadAllButton");
const batchStatus = document.querySelector("#batchStatus");

const tasks = [];
let taskCount = 0;
let isBatchRecognizing = false;
let isBatchGenerating = false;
let isBatchDownloading = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, message) {
  let timeoutId = 0;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    window.clearTimeout(timeoutId);
  });
}

function setBatchStatus(message) {
  batchStatus.textContent = message;
}

function setTaskStatus(task, message, state = "idle") {
  task.statusElement.textContent = message;
  task.card.dataset.taskState = state;
}

function setRecognitionProgress(task, percent, text) {
  task.recognitionProgress.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  task.recognitionTitle.textContent = text;
}

function resizeFrame(frame) {
  try {
    const doc = frame.contentDocument;
    if (!doc) return;

    const height = Math.max(
      doc.body.scrollHeight,
      doc.documentElement.scrollHeight,
      860
    );
    frame.style.height = `${height}px`;
  } catch {
    frame.style.height = "1100px";
  }
}

function mergeTaskStatus(task, status) {
  if (!status) return;

  task.fileName = status.fileName || task.fileName;
  task.downloadName = status.downloadName || task.downloadName;
  task.hasFile = Boolean(status.hasFile);
  task.hasDownload = Boolean(status.hasDownload);
  task.isTaskGenerating = Boolean(status.isGenerating);
}

function describeTask(task) {
  if (task.readyError) return task.readyError;
  if (task.busyLabel) return task.busyLabel;
  if (task.errorMessage) return task.errorMessage;
  if (task.isTaskGenerating) return "任务内正在生成";
  if (task.hasDownload) return `剪切完成：${task.downloadName || task.fileName || "完整视频"}`;
  if (task.recognitionState === "done") return `识别完成：${task.matches.length} 条口播`;
  if (task.recognitionState === "empty") return NO_MATCH_MESSAGE;
  if (task.recognitionState === "running") return "正在识别口播";
  if (task.hasFile) return `等待识别：${task.fileName || "视频"}`;
  return "等待上传视频";
}

function getTaskVisualState(task) {
  if (task.readyError || task.errorMessage || task.recognitionState === "error") return "error";
  if (task.busyLabel || task.isTaskGenerating || task.recognitionState === "running") return "running";
  if (task.hasDownload) return "done";
  if (task.recognitionState === "done" || task.hasFile) return "ready";
  return "idle";
}

function syncTaskSummary(task, shouldUpdateText = true) {
  if (task.api && !task.readyError) {
    try {
      mergeTaskStatus(task, task.api.getStatus());
    } catch {
      // The iframe may be between reload states; the next polling pass will recover.
    }
  }

  const taskBusy = Boolean(task.busyLabel || task.isTaskGenerating || task.recognitionState === "running");
  const disabled = isBusy() || taskBusy;
  task.downloadOneButton.disabled = !task.hasDownload || disabled;
  task.generateOneButton.disabled = !canGenerateTask(task) || disabled;
  task.recognizeOneButton.disabled = !task.file || disabled;
  task.applyMatchButton.disabled = !task.matches.length || !task.file || disabled;
  task.copyResultButton.disabled = !task.matches.length;
  task.matchSelect.disabled = !task.matches.length || disabled;
  task.pickFileButton.disabled = disabled;

  if (shouldUpdateText) {
    setTaskStatus(task, describeTask(task), getTaskVisualState(task));
  }
}

function isBusy() {
  return isBatchRecognizing || isBatchGenerating || isBatchDownloading;
}

function canGenerateTask(task) {
  return Boolean(task.hasFile && task.matches.length && task.appliedMatchIndex >= 0 && !task.readyError);
}

function updateBulkButtons() {
  const busy = isBusy();
  const hasRecognizableTask = tasks.some((task) => task.file && !task.readyError);
  const hasGeneratableTask = tasks.some((task) => canGenerateTask(task));
  const hasDownloadableTask = tasks.some((task) => task.hasDownload && !task.readyError);

  recognizeAllButton.disabled = busy || !hasRecognizableTask;
  generateAllButton.disabled = busy || !hasGeneratableTask;
  downloadAllButton.disabled = busy || !hasDownloadableTask;
  addTaskButton.disabled = busy;
  batchUploadButton.disabled = busy;

  tasks.forEach((task) => syncTaskSummary(task, false));
}

function renumberTasks() {
  tasks.forEach((task, index) => {
    task.card.querySelector("[data-task-number]").textContent = String(index + 1);
    task.removeButton.disabled = tasks.length === 1 || isBusy();
  });
}

function waitForTaskApi(frame) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();

    function check() {
      const api = frame.contentWindow?.videoCutterTask;
      if (api) {
        resolve(api);
        return;
      }

      if (performance.now() - startedAt > 7000) {
        reject(new Error("任务页面初始化失败"));
        return;
      }

      setTimeout(check, 50);
    }

    check();
  });
}

function removeTask(task, options = {}) {
  const { ensureOne = true } = options;
  task.removed = true;
  task.recognitionRunId += 1;
  clearInterval(task.resizeInterval);
  if (task.objectUrl) URL.revokeObjectURL(task.objectUrl);
  task.card.remove();

  const index = tasks.indexOf(task);
  if (index >= 0) tasks.splice(index, 1);

  if (ensureOne && !tasks.length) {
    addTask();
    return;
  }

  renumberTasks();
  updateBulkButtons();
}

function addTask(file = null, options = {}) {
  const { autoSelectFirstTail = true } = options;
  taskCount += 1;

  const fragment = taskTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".task-card");
  const frame = fragment.querySelector(".task-frame");
  const removeButton = fragment.querySelector(".task-remove");
  const statusElement = fragment.querySelector("[data-task-status]");
  const fileNameElement = fragment.querySelector("[data-file-name]");
  const fileMetaElement = fragment.querySelector("[data-file-meta]");
  const pickFileButton = fragment.querySelector("[data-pick-file]");
  const taskFileInput = fragment.querySelector("[data-task-file-input]");
  const recognizeOneButton = fragment.querySelector("[data-recognize-one]");
  const generateOneButton = fragment.querySelector("[data-generate-one]");
  const downloadOneButton = fragment.querySelector("[data-download-one]");
  const videoPreview = fragment.querySelector("[data-video-preview]");
  const recognitionTitle = fragment.querySelector("[data-recognition-title]");
  const recognitionMessage = fragment.querySelector("[data-recognition-message]");
  const recognitionProgress = fragment.querySelector("[data-recognition-progress]");
  const recognitionTableWrap = fragment.querySelector("[data-recognition-table-wrap]");
  const recognitionBody = fragment.querySelector("[data-recognition-body]");
  const matchSelect = fragment.querySelector("[data-match-select]");
  const applyMatchButton = fragment.querySelector("[data-apply-match]");
  const copyResultButton = fragment.querySelector("[data-copy-result]");

  const task = {
    api: null,
    applyMatchButton,
    appliedMatchIndex: -1,
    busyLabel: "",
    card,
    copyResultButton,
    downloadName: "",
    downloadOneButton,
    errorMessage: "",
    file: null,
    fileMetaElement,
    fileName: "",
    fileNameElement,
    frame,
    generateOneButton,
    hasDownload: false,
    hasFile: false,
    isTaskGenerating: false,
    matchSelect,
    matches: [],
    objectUrl: "",
    pickFileButton,
    ready: null,
    readyError: "",
    recognitionBody,
    recognitionMessage,
    recognitionProgress,
    recognitionRunId: 0,
    recognitionState: "idle",
    recognitionTableWrap,
    recognitionTitle,
    recognizeOneButton,
    removeButton,
    resizeInterval: 0,
    selectedMatchIndex: 0,
    statusElement,
    taskFileInput,
    transcriptText: "",
    videoPreview,
  };

  frame.src = `./task.html?task=${taskCount}`;
  resetRecognitionView(task, "等待上传视频。");
  setTaskStatus(task, file ? `准备载入：${file.name}` : "等待上传视频", file ? "running" : "idle");

  task.ready = new Promise((resolve) => {
    frame.addEventListener(
      "load",
      async () => {
        if (task.removed) {
          resolve(task);
          return;
        }

        resizeFrame(frame);
        task.resizeInterval = setInterval(() => {
          resizeFrame(frame);
          syncTaskSummary(task, !task.busyLabel);
          updateBulkButtons();
        }, 1200);

        try {
          task.api = await waitForTaskApi(frame);
          await task.api.refreshTails({ autoSelectFirstTail });
          if (file) {
            await setTaskFile(task, file, { autoSelectFirstTail, loadIntoCutter: true });
          } else {
            mergeTaskStatus(task, task.api.getStatus());
          }

          syncTaskSummary(task);
        } catch (error) {
          task.readyError = error.message || "任务页面初始化失败";
          setTaskStatus(task, task.readyError, "error");
        }

        updateBulkButtons();
        resolve(task);
      },
      { once: true }
    );
  });

  pickFileButton.addEventListener("click", () => taskFileInput.click());
  taskFileInput.addEventListener("change", async () => {
    const [pickedFile] = taskFileInput.files || [];
    taskFileInput.value = "";
    if (!pickedFile) return;
    if (!pickedFile.type.startsWith("video/")) {
      setTaskError(task, "请选择视频文件。");
      return;
    }

    await task.ready;
    await setTaskFile(task, pickedFile, { autoSelectFirstTail: true, loadIntoCutter: true });
    await recognizeTask(task, { fromBatch: false });
  });
  recognizeOneButton.addEventListener("click", () => recognizeTask(task, { fromBatch: false }));
  generateOneButton.addEventListener("click", () => generateTask(task, { fromBatch: false }));
  downloadOneButton.addEventListener("click", () => downloadTask(task));
  applyMatchButton.addEventListener("click", () => applySelectedMatchToTask(task));
  matchSelect.addEventListener("change", () => applySelectedMatchToTask(task));
  copyResultButton.addEventListener("click", () => copyTaskResults(task));
  removeButton.addEventListener("click", () => removeTask(task));

  tasks.push(task);
  taskStack.appendChild(fragment);
  renumberTasks();
  updateBulkButtons();

  return task;
}

async function setTaskFile(task, file, options = {}) {
  const { autoSelectFirstTail = true, loadIntoCutter = true } = options;
  task.file = file;
  task.fileName = file.name;
  task.hasFile = true;
  task.hasDownload = false;
  task.downloadName = "";
  task.errorMessage = "";
  task.matches = [];
  task.appliedMatchIndex = -1;
  task.selectedMatchIndex = 0;
  task.recognitionState = "idle";
  task.recognitionRunId += 1;

  if (task.objectUrl) URL.revokeObjectURL(task.objectUrl);
  task.objectUrl = URL.createObjectURL(file);
  task.videoPreview.src = task.objectUrl;
  task.fileNameElement.textContent = file.name;
  task.fileMetaElement.textContent = formatBytes(file.size);
  resetRecognitionView(task, "等待识别口播。");

  if (loadIntoCutter && task.api) {
    setTaskStatus(task, `正在载入：${file.name}`, "running");
    mergeTaskStatus(task, await task.api.loadFile(file, { autoSelectFirstTail }));
  }

  syncTaskSummary(task);
  updateBulkButtons();
}

function resetRecognitionView(task, message) {
  task.recognitionTitle.textContent = "等待识别";
  task.recognitionMessage.textContent = message;
  task.recognitionProgress.style.width = "0%";
  task.recognitionBody.innerHTML = "";
  task.recognitionTableWrap.hidden = true;
  task.matchSelect.innerHTML = "";
  task.matchSelect.disabled = true;
  task.applyMatchButton.disabled = true;
  task.copyResultButton.disabled = true;
}

function setTaskError(task, message) {
  task.errorMessage = message;
  task.recognitionState = "error";
  task.busyLabel = "";
  task.recognitionTitle.textContent = "处理失败";
  task.recognitionMessage.textContent = message;
  setTaskStatus(task, message, "error");
  updateBulkButtons();
}

async function collectReadyTasks() {
  await Promise.all(tasks.map((task) => task.ready));
  tasks.forEach((task) => syncTaskSummary(task, false));
  updateBulkButtons();
  return tasks;
}

async function handleBatchUpload(event) {
  const files = Array.from(event.target.files || []).filter((file) => file.type.startsWith("video/"));
  batchVideoInput.value = "";
  if (!files.length) return;

  if (tasks.length === 1 && !tasks[0].file && !tasks[0].hasDownload) {
    removeTask(tasks[0], { ensureOne: false });
  }

  setBatchStatus(`正在创建 ${files.length} 个视频处理任务。`);
  const newTasks = files.map((file) => addTask(file, { autoSelectFirstTail: true }));
  await Promise.all(newTasks.map((task) => task.ready));

  const readyCount = newTasks.filter((task) => task.file && !task.readyError).length;
  setBatchStatus(`已创建 ${readyCount} 个任务，开始按顺序识别口播。`);
  updateBulkButtons();
  await recognizeTasks(newTasks);
}

async function recognizeTasks(taskList = tasks) {
  if (isBatchRecognizing) return;

  isBatchRecognizing = true;
  setBatchStatus("正在按上传顺序识别口播。");
  updateBulkButtons();
  renumberTasks();

  let successCount = 0;
  let emptyCount = 0;
  let failedCount = 0;

  try {
    await collectReadyTasks();
    const queue = taskList.filter((task) => task.file && !task.readyError);

    for (let index = 0; index < queue.length; index += 1) {
      const task = queue[index];
      task.busyLabel = `正在识别 ${index + 1}/${queue.length}`;
      setBatchStatus(`正在识别第 ${index + 1} / ${queue.length} 个视频。`);
      syncTaskSummary(task);

      const result = await recognizeTask(task, { fromBatch: true });
      if (result === "done") successCount += 1;
      if (result === "empty") emptyCount += 1;
      if (result === "error") failedCount += 1;

      task.busyLabel = "";
      syncTaskSummary(task);
      resizeFrame(task.frame);
      updateBulkButtons();
      await sleep(120);
    }
  } finally {
    isBatchRecognizing = false;
    setBatchStatus(`识别完成：成功 ${successCount} 个，未检测到 ${emptyCount} 个，失败 ${failedCount} 个。`);
    updateBulkButtons();
    renumberTasks();
  }
}

async function recognizeTask(task, options = {}) {
  const { fromBatch = false } = options;
  if (!task.file || task.readyError) return "error";

  const runId = task.recognitionRunId + 1;
  task.recognitionRunId = runId;
  task.errorMessage = "";
  task.matches = [];
  task.appliedMatchIndex = -1;
  task.selectedMatchIndex = 0;
  task.recognitionState = "running";
  task.hasDownload = false;
  resetRecognitionView(task, "正在提取音轨。");
  setRecognitionProgress(task, 3, "正在识别口播");
  setTaskStatus(task, fromBatch ? task.busyLabel : "正在识别口播", "running");
  updateBulkButtons();

  try {
    const result = await withTimeout(
      analyzeVideoFile(task.file, {
        modelId: DEFAULT_MODEL_ID,
        silenceMs: DEFAULT_SILENCE_MS,
        isActive: () => task.recognitionRunId === runId && !task.removed,
        onProgress: (percent, text) => {
          if (task.recognitionRunId !== runId || task.removed) return;
          setRecognitionProgress(task, percent, text);
          task.recognitionMessage.textContent = text;
        },
      }),
      RECOGNITION_TIMEOUT_MS,
      "口播识别超时，已跳过该视频。"
    );

    if (!result || task.recognitionRunId !== runId || task.removed) return "error";

    task.matches = result.matches;
    task.transcriptText = result.transcriptText;
    renderRecognitionResults(task);

    if (!task.matches.length) {
      task.recognitionState = "empty";
      task.recognitionTitle.textContent = "未检测到";
      task.recognitionMessage.textContent = NO_MATCH_MESSAGE;
      setTaskStatus(task, NO_MATCH_MESSAGE, "ready");
      return "empty";
    }

    task.recognitionState = "done";
    task.recognitionTitle.textContent = `识别到 ${task.matches.length} 条`;
    task.recognitionMessage.textContent = "默认使用第 1 条结果，已尝试自动填入剪辑参数。";
    await applyMatchToTask(task, 0);
    setTaskStatus(task, `识别完成：${task.matches.length} 条口播`, "ready");
    return "done";
  } catch (error) {
    if (task.recognitionRunId === runId) {
      task.recognitionRunId += 1;
      setTaskError(task, error.message || "口播识别失败。");
    }
    return "error";
  } finally {
    if (task.recognitionRunId === runId && !task.removed) {
      task.busyLabel = "";
      syncTaskSummary(task);
      updateBulkButtons();
    }
  }
}

function renderRecognitionResults(task) {
  task.recognitionBody.innerHTML = "";
  task.matchSelect.innerHTML = "";
  task.recognitionTableWrap.hidden = task.matches.length === 0;

  if (!task.matches.length) {
    task.copyResultButton.disabled = true;
    task.matchSelect.disabled = true;
    task.applyMatchButton.disabled = true;
    return;
  }

  task.matches.forEach((match, index) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td><span class="phrase-badge">${escapeHtml(match.phrase)}</span></td>
      <td>${formatTime(match.videoStart)}</td>
      <td>${formatTime(match.cutPhraseStart)}</td>
      <td>${formatTime(match.cutPhraseEnd)}</td>
      <td>${formatTime(match.cutScriptEnd)}</td>
      <td>${formatTime(match.videoEnd)}</td>
    `;
    task.recognitionBody.appendChild(tr);
  });

  task.matchSelect.innerHTML = task.matches
    .map((match, index) => {
      const label = `${index + 1}. ${match.phrase} ｜ ${formatTime(match.cutPhraseStart)} - ${formatTime(match.cutScriptEnd)}`;
      return `<option value="${index}">${escapeHtml(label)}</option>`;
    })
    .join("");
  task.matchSelect.value = "0";
  task.matchSelect.disabled = false;
  task.applyMatchButton.disabled = false;
  task.copyResultButton.disabled = false;
}

async function applySelectedMatchToTask(task) {
  const index = Number(task.matchSelect.value || 0);
  await applyMatchToTask(task, index);
  syncTaskSummary(task);
  updateBulkButtons();
}

async function applyMatchToTask(task, index) {
  const match = task.matches[index] || task.matches[0];
  if (!match) return false;

  const config = buildCutterConfig(match);
  if (!config.videoSegments.length) {
    task.recognitionMessage.textContent = "没有可用的保留片段，未写入剪辑配置。";
    task.appliedMatchIndex = -1;
    return false;
  }

  await task.ready;
  if (!task.api) {
    throw new Error("剪辑器还没有准备好。");
  }

  const status = await task.api.applyAutoConfig({
    sourceLabel: match.phrase,
    tailAudioRange: config.tailAudioRange,
    videoSegments: config.videoSegments,
    warnings: config.warnings,
  });

  task.selectedMatchIndex = index;
  task.appliedMatchIndex = index;
  task.matchSelect.value = String(index);
  mergeTaskStatus(task, status);

  const warningText = config.warnings.length ? ` ${config.warnings.join(" ")}` : "";
  task.recognitionMessage.textContent = `已使用第 ${index + 1} 条“${match.phrase}”填入 ${status?.appliedSegments ?? config.videoSegments.length} 个保留片段。${warningText}`;
  return true;
}

async function generateAllTasks() {
  if (isBatchGenerating) return;

  isBatchGenerating = true;
  setBatchStatus("正在按顺序剪切生成全部视频。");
  updateBulkButtons();
  renumberTasks();

  let successCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  try {
    await collectReadyTasks();
    const queue = tasks.filter((task) => canGenerateTask(task));

    for (let index = 0; index < queue.length; index += 1) {
      const task = queue[index];
      task.busyLabel = `正在剪切 ${index + 1}/${queue.length}`;
      setBatchStatus(`正在剪切第 ${index + 1} / ${queue.length} 个视频。`);
      syncTaskSummary(task);

      const ok = await generateTask(task, { fromBatch: true });
      if (ok) successCount += 1;
      else failedCount += 1;

      task.busyLabel = "";
      syncTaskSummary(task);
      resizeFrame(task.frame);
      updateBulkButtons();
      await sleep(120);
    }

    skippedCount = tasks.filter((task) => task.file && !canGenerateTask(task) && !task.readyError).length;
  } finally {
    isBatchGenerating = false;
    setBatchStatus(`剪切完成：成功 ${successCount} 个，失败 ${failedCount} 个，跳过 ${skippedCount} 个。`);
    updateBulkButtons();
    renumberTasks();
  }
}

async function generateTask(task, options = {}) {
  const { fromBatch = false } = options;
  if (!canGenerateTask(task) || !task.api) return false;

  task.errorMessage = "";
  task.busyLabel = fromBatch ? task.busyLabel : "正在剪切";
  setTaskStatus(task, task.busyLabel || "正在剪切", "running");
  updateBulkButtons();

  try {
    const status = await withTimeout(
      task.api.generate({ timeoutMs: CUT_TIMEOUT_MS }),
      CUT_TIMEOUT_MS + 1000,
      "剪切生成超时，已跳过该视频。"
    );
    mergeTaskStatus(task, status);

    if (!task.hasDownload) {
      throw new Error("剪切完成但没有生成可下载文件。");
    }

    setTaskStatus(task, `剪切完成：${task.downloadName || task.fileName}`, "done");
    return true;
  } catch (error) {
    setTaskError(task, error.message || "剪切生成失败。");
    return false;
  } finally {
    task.busyLabel = "";
    syncTaskSummary(task);
    updateBulkButtons();
  }
}

async function downloadAllTasks() {
  if (isBatchDownloading) return;

  isBatchDownloading = true;
  setBatchStatus("正在按顺序下载已生成的视频。");
  updateBulkButtons();
  renumberTasks();

  let downloadCount = 0;

  try {
    await collectReadyTasks();
    const queue = tasks.filter((task) => task.hasDownload && task.api && !task.readyError);

    for (let index = 0; index < queue.length; index += 1) {
      const task = queue[index];
      task.busyLabel = `正在下载 ${index + 1}/${queue.length}`;
      setTaskStatus(task, task.busyLabel, "running");
      setBatchStatus(`正在下载第 ${index + 1} / ${queue.length} 个视频。`);

      const didDownload = await downloadTask(task);
      if (didDownload) downloadCount += 1;

      task.busyLabel = "";
      syncTaskSummary(task);
      await sleep(650);
    }
  } finally {
    isBatchDownloading = false;
    setBatchStatus(`已创建 ${downloadCount} 个下载任务。`);
    updateBulkButtons();
    renumberTasks();
  }
}

async function downloadTask(task) {
  if (!task.api || !task.hasDownload) return false;
  const didDownload = await task.api.download();
  syncTaskSummary(task);
  return didDownload;
}

async function copyTaskResults(task) {
  if (!task.matches.length) return;
  const value = task.matches.map((match, index) => formatSingleResult(match, index)).join("\n\n");
  try {
    await navigator.clipboard.writeText(value);
    task.recognitionMessage.textContent = "识别结果已复制。";
  } catch {
    task.recognitionMessage.textContent = "复制失败，请从表格中手动选择。";
  }
}

addTaskButton.addEventListener("click", () => addTask());
batchUploadButton.addEventListener("click", () => batchVideoInput.click());
batchVideoInput.addEventListener("change", handleBatchUpload);
recognizeAllButton.addEventListener("click", () => recognizeTasks(tasks));
generateAllButton.addEventListener("click", generateAllTasks);
downloadAllButton.addEventListener("click", downloadAllTasks);

addTask();

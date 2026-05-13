const { accessSync, constants, createReadStream, createWriteStream, promises: fs } = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT || 4287);
const ROOT = __dirname;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;
const SWIFT_TRIMMER = path.join(ROOT, ".bin", "trim-av");
const SWIFT_COMPOSER = path.join(ROOT, ".bin", "compose-av");
const SWIFT_PROBE = path.join(ROOT, ".bin", "probe-av");
const SWIFT_RUNNER = path.join(ROOT, "swift-runner.js");
const DATA_DIR = path.join(ROOT, "data");
const TAIL_DIR = path.join(DATA_DIR, "tails");
const TAIL_INDEX = path.join(TAIL_DIR, "index.json");
const TOOL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_MS || 30 * 60 * 1000);
const availabilityCache = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function commandAvailable(command, args = ["--version"], cacheKey = command) {
  if (availabilityCache.has(cacheKey)) {
    return availabilityCache.get(cacheKey);
  }

  const result = spawnSync(command, args, { stdio: "ignore" });
  const available = result.status === 0;
  availabilityCache.set(cacheKey, available);
  return available;
}

function ffmpegAvailable() {
  return commandAvailable("ffmpeg", ["-version"], "ffmpeg");
}

function swiftAvailable() {
  return commandAvailable("swiftc", ["--version"], "swiftc");
}

function ffprobeAvailable() {
  return commandAvailable("ffprobe", ["-version"], "ffprobe");
}

function avconvertAvailable() {
  if (availabilityCache.has("avconvert")) {
    return availabilityCache.get("avconvert");
  }

  const result = spawnSync("avconvert", ["-h"], { stdio: "ignore" });
  const available = !result.error;
  availabilityCache.set("avconvert", available);
  return available;
}

function executableAvailable(filePath) {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function rejectOnToolTimeout(childProcess, reject, toolName) {
  const timeout = setTimeout(() => {
    childProcess.kill("SIGKILL");
    reject(new Error(`${toolName} 运行超时，请重新尝试或缩短视频片段。`));
  }, TOOL_TIMEOUT_MS);

  return () => clearTimeout(timeout);
}

function parseSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : NaN;
}

function safeBaseName(fileName) {
  return String(fileName || "clip")
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "clip";
}

function safeDisplayName(fileName) {
  return String(fileName || "尾版视频").replace(/[\\/]/g, "").trim().slice(0, 120) || "尾版视频";
}

function extensionFromContentType(contentType) {
  if (contentType.includes("quicktime")) return ".mov";
  if (contentType.includes("webm")) return ".webm";
  if (contentType.includes("x-matroska")) return ".mkv";
  return ".mp4";
}

function streamRequestToFile(request, targetPath) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const output = createWriteStream(targetPath);

    request.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES) {
        request.destroy(new Error("上传文件太大"));
      }
    });

    request.on("error", reject);
    output.on("error", reject);
    output.on("finish", resolve);
    request.pipe(output);
  });
}

function runFfmpeg(inputPath, outputPath, start, duration) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-y",
      "-ss",
      String(start),
      "-t",
      String(duration),
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      outputPath,
    ];

    const process = spawn("ffmpeg", args);
    let stderr = "";

    process.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) {
        stderr = stderr.slice(-8000);
      }
    });

    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr || `ffmpeg 退出码 ${code}`));
    });
  });
}

function runAvconvert(inputPath, outputPath, start, duration) {
  return new Promise((resolve, reject) => {
    const args = [
      "--source",
      inputPath,
      "--preset",
      "PresetHighestQuality",
      "--output",
      outputPath,
      "--replace",
      "--start",
      String(start),
      "--duration",
      String(duration),
      "--disableMetadataFilter",
    ];

    const process = spawn("avconvert", args);
    let stderr = "";

    process.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) {
        stderr = stderr.slice(-8000);
      }
    });

    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr || `avconvert 退出码 ${code}`));
    });
  });
}

async function compileSwiftTool(sourceName, outputPath) {
  try {
    await fs.access(outputPath, constants.X_OK);
    return;
  } catch {
    // Compile from source below when the shipped binary is missing or not executable.
  }

  if (!swiftAvailable()) {
    throw new Error("没有检测到 swiftc，无法使用 macOS 原生视频工具。");
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  await new Promise((resolve, reject) => {
    const compiler = spawn("swiftc", [sourceName, "-o", outputPath], { cwd: ROOT });
    let stderr = "";

    compiler.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    compiler.on("error", reject);
    compiler.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr || `swiftc 退出码 ${code}`));
    });
  });
}

async function ensureSwiftTrimmer() {
  await compileSwiftTool("trim-av.swift", SWIFT_TRIMMER);
}

async function ensureSwiftComposer() {
  await compileSwiftTool("compose-av.swift", SWIFT_COMPOSER);
}

async function ensureSwiftProbe() {
  await compileSwiftTool("probe-av.swift", SWIFT_PROBE);
}

function runSwiftTool(toolPath, args, toolName) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(process.execPath, [SWIFT_RUNNER, toolPath, ...args], {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        TOOL_TIMEOUT_MS: String(TOOL_TIMEOUT_MS),
      },
    });
    let stderr = "";
    const clearToolTimeout = rejectOnToolTimeout(childProcess, reject, toolName);

    childProcess.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) {
        stderr = stderr.slice(-8000);
      }
    });

    childProcess.on("error", (error) => {
      clearToolTimeout();
      reject(error);
    });
    childProcess.on("close", (code) => {
      clearToolTimeout();
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `${toolName} 退出码 ${code}`));
    });
  });
}

function runSwiftTrimmer(inputPath, outputPath, start, duration) {
  return runSwiftTool(
    SWIFT_TRIMMER,
    [inputPath, outputPath, String(start), String(duration)],
    "AVFoundation 剪辑器"
  );
}

function runSwiftComposer(inputPath, tailPath, outputPath, segments, tailAudioStart, tailAudioEnd) {
  return runSwiftTool(
    SWIFT_COMPOSER,
    [
      inputPath,
      tailPath || "none",
      outputPath,
      JSON.stringify(segments),
      String(tailAudioStart),
      String(tailAudioEnd),
    ],
    "AVFoundation 拼接器"
  );
}

function parseFrameRate(value) {
  const text = String(value || "").trim();
  if (!text || text === "0/0") return NaN;

  if (text.includes("/")) {
    const [numerator, denominator] = text.split("/").map(Number);
    return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
      ? numerator / denominator
      : NaN;
  }

  const fps = Number(text);
  return Number.isFinite(fps) && fps > 0 ? fps : NaN;
}

function normalizeProbePayload(payload) {
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const stream = streams[0] || {};
  const fps = parseFrameRate(stream.avg_frame_rate) || parseFrameRate(stream.r_frame_rate);
  const streamDuration = Number(stream.duration);
  const formatDuration = Number(payload.format?.duration);
  const duration = Number.isFinite(streamDuration) && streamDuration > 0
    ? streamDuration
    : formatDuration;

  if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("无法读取视频帧率。");
  }

  return { fps, duration };
}

function runFfprobe(inputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=avg_frame_rate,r_frame_rate,duration:format=duration",
      "-of",
      "json",
      inputPath,
    ];

    const process = spawn("ffprobe", args);
    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    process.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) {
        stderr = stderr.slice(-8000);
      }
    });

    process.on("error", reject);
    process.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `ffprobe 退出码 ${code}`));
        return;
      }

      try {
        resolve(normalizeProbePayload(JSON.parse(stdout)));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function runSwiftProbe(inputPath) {
  return new Promise((resolve, reject) => {
    const process = spawn(SWIFT_PROBE, [inputPath]);
    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    process.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) {
        stderr = stderr.slice(-8000);
      }
    });

    process.on("error", reject);
    process.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `AVFoundation 信息读取器退出码 ${code}`));
        return;
      }

      try {
        const payload = JSON.parse(stdout);
        const fps = Number(payload.fps);
        const duration = Number(payload.duration);
        if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(duration) || duration <= 0) {
          throw new Error("无法读取视频帧率。");
        }
        resolve({ fps, duration });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function probeVideo(inputPath) {
  if (ffprobeAvailable()) {
    return runFfprobe(inputPath);
  }

  await ensureSwiftProbe();
  return runSwiftProbe(inputPath);
}

function nativeMp4Available() {
  return ffmpegAvailable() || avconvertAvailable() || executableAvailable(SWIFT_TRIMMER) || swiftAvailable();
}

function tailAppendAvailable() {
  return executableAvailable(SWIFT_COMPOSER) || swiftAvailable();
}

function frameProbeAvailable() {
  return ffprobeAvailable() || executableAvailable(SWIFT_PROBE) || swiftAvailable();
}

function normalizeSegments(rawSegments, fallbackStart, fallbackEnd) {
  let segments = [];

  if (rawSegments) {
    try {
      const parsed = JSON.parse(rawSegments);
      if (Array.isArray(parsed)) {
        segments = parsed;
      }
    } catch {
      return [];
    }
  } else {
    segments = [{ start: fallbackStart, end: fallbackEnd }];
  }

  return segments
    .map((segment) => ({
      start: Number(segment.start),
      end: Number(segment.end),
    }))
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start >= 0 && segment.end > segment.start)
    .sort((a, b) => a.start - b.start);
}

function totalSegmentDuration(segments) {
  return segments.reduce((total, segment) => total + segment.end - segment.start, 0);
}

async function ensureTailStorage() {
  await fs.mkdir(TAIL_DIR, { recursive: true });
  try {
    await fs.access(TAIL_INDEX);
  } catch {
    await fs.writeFile(TAIL_INDEX, "[]");
  }
}

async function readTailIndex() {
  await ensureTailStorage();
  try {
    const contents = await fs.readFile(TAIL_INDEX, "utf8");
    const tails = JSON.parse(contents);
    return Array.isArray(tails) ? tails : [];
  } catch {
    return [];
  }
}

async function writeTailIndex(tails) {
  await ensureTailStorage();
  await fs.writeFile(TAIL_INDEX, JSON.stringify(tails, null, 2));
}

async function findTail(id) {
  const tails = await readTailIndex();
  return tails.find((tail) => tail.id === id);
}

async function handleListTails(response) {
  sendJson(response, 200, { tails: await readTailIndex() });
}

async function handleUploadTail(request, response, requestUrl) {
  const contentType = request.headers["content-type"] || "";
  if (!contentType.startsWith("video/")) {
    sendJson(response, 400, { error: "请上传视频格式的尾版文件。" });
    return;
  }

  const id = randomUUID();
  const originalName = safeDisplayName(requestUrl.searchParams.get("name"));
  const extension = extensionFromContentType(contentType);
  const storedName = `${id}${extension}`;
  const storedPath = path.join(TAIL_DIR, storedName);

  try {
    await ensureTailStorage();
    await streamRequestToFile(request, storedPath);
    const stat = await fs.stat(storedPath);
    const tails = await readTailIndex();
    const tail = {
      id,
      name: originalName,
      file: storedName,
      size: stat.size,
      type: contentType,
      createdAt: new Date().toISOString(),
    };
    tails.unshift(tail);
    await writeTailIndex(tails);
    sendJson(response, 201, { tail });
  } catch (error) {
    fs.rm(storedPath, { force: true }).catch(() => {});
    sendJson(response, 500, { error: "尾版上传失败。", detail: error.message });
  }
}

async function handleDeleteTail(response, id) {
  const tails = await readTailIndex();
  const target = tails.find((tail) => tail.id === id);

  if (!target) {
    sendJson(response, 404, { error: "没有找到这个尾版。" });
    return;
  }

  await fs.rm(path.join(TAIL_DIR, target.file), { force: true });
  await writeTailIndex(tails.filter((tail) => tail.id !== id));
  sendJson(response, 200, { ok: true });
}

async function handleProbe(request, response) {
  if (!frameProbeAvailable()) {
    sendJson(response, 503, {
      error: "没有检测到 ffprobe 或 macOS Swift 工具链，暂时无法按帧数识别。",
    });
    return;
  }

  const contentType = request.headers["content-type"] || "";
  const extension = extensionFromContentType(contentType);
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-cutter-probe-"));
  const inputPath = path.join(jobDir, `input${extension}`);

  try {
    await streamRequestToFile(request, inputPath);
    const metadata = await probeVideo(inputPath);
    sendJson(response, 200, metadata);
  } catch (error) {
    sendJson(response, 500, {
      error: "视频帧率读取失败，暂时无法按帧号自动换算。",
      detail: error.message,
    });
  } finally {
    fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function handleTrim(request, response, requestUrl) {
  if (!nativeMp4Available()) {
    sendJson(response, 503, {
      error: "没有检测到 ffmpeg 或 macOS Swift 工具链，暂时无法导出 MP4。",
    });
    return;
  }

  const start = parseSeconds(requestUrl.searchParams.get("start"));
  const end = parseSeconds(requestUrl.searchParams.get("end"));
  const segments = normalizeSegments(requestUrl.searchParams.get("segments"), start, end);
  const tailId = requestUrl.searchParams.get("tailId") || "";
  const tailAudioStart = parseSeconds(requestUrl.searchParams.get("tailAudioStart"));
  const tailAudioEnd = parseSeconds(requestUrl.searchParams.get("tailAudioEnd"));

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !segments.length) {
    sendJson(response, 400, { error: "开始和结束时间不正确。" });
    return;
  }

  let tail = null;
  let tailPath = "";
  if (tailId) {
    tail = await findTail(tailId);
    if (!tail) {
      sendJson(response, 404, { error: "没有找到选择的尾版视频。" });
      return;
    }

    if (!tailAppendAvailable()) {
      sendJson(response, 503, { error: "当前环境不能拼接尾版视频。" });
      return;
    }

    if (!Number.isFinite(tailAudioStart) || !Number.isFinite(tailAudioEnd) || tailAudioEnd <= tailAudioStart) {
      sendJson(response, 400, { error: "尾版音轨时间段不正确。" });
      return;
    }

    tailPath = path.join(TAIL_DIR, tail.file);
  }

  const clipDuration = totalSegmentDuration(segments);
  const name = safeBaseName(requestUrl.searchParams.get("name"));
  const contentType = request.headers["content-type"] || "";
  const extension = extensionFromContentType(contentType);
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-cutter-"));
  const inputPath = path.join(jobDir, `input${extension}`);
  const outputPath = path.join(jobDir, `${name}-${start.toFixed(1)}-${end.toFixed(1)}.mp4`);

  try {
    await streamRequestToFile(request, inputPath);
    if (tailPath || segments.length > 1) {
      await ensureSwiftComposer();
      await runSwiftComposer(inputPath, tailPath, outputPath, segments, tailAudioStart || 0, tailAudioEnd || 0);
    } else if (ffmpegAvailable()) {
      await runFfmpeg(inputPath, outputPath, start, clipDuration);
    } else if (avconvertAvailable()) {
      await runAvconvert(inputPath, outputPath, start, clipDuration);
    } else {
      await ensureSwiftTrimmer();
      await runSwiftTrimmer(inputPath, outputPath, start, clipDuration);
    }

    const stat = await fs.stat(outputPath);
    const downloadName = tail
      ? `${name}-${start.toFixed(1)}-${end.toFixed(1)}-${safeBaseName(tail.name)}.mp4`
      : `${name}-${start.toFixed(1)}-${end.toFixed(1)}.mp4`;
    response.writeHead(200, {
      "content-type": "video/mp4",
      "content-length": stat.size,
      "content-disposition": `attachment; filename="${downloadName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
      "cache-control": "no-store",
    });

    const stream = createReadStream(outputPath);
    stream.pipe(response);
    stream.on("close", () => {
      fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    });
  } catch (error) {
    fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    sendJson(response, 500, {
      error: tailPath ? "MP4 剪辑或尾版拼接失败，请确认两个视频都可以正常播放。" : "MP4 剪辑失败，请确认视频文件可以正常播放。",
      detail: error.message,
    });
  }
}

async function serveStatic(request, response, requestUrl) {
  const pathname = decodeURIComponent(requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname);
  const filePath = path.normalize(path.join(ROOT, pathname));

  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    response.writeHead(200, {
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : file);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && requestUrl.pathname === "/api/status") {
    sendJson(response, 200, {
      ffmpegAvailable: ffmpegAvailable(),
      ffprobeAvailable: ffprobeAvailable(),
      avconvertAvailable: avconvertAvailable(),
      swiftAvailable: swiftAvailable(),
      mp4Available: nativeMp4Available(),
      tailAppendAvailable: tailAppendAvailable(),
      frameProbeAvailable: frameProbeAvailable(),
    });
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/tails") {
    handleListTails(response);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/tails") {
    handleUploadTail(request, response, requestUrl);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/probe") {
    handleProbe(request, response);
    return;
  }

  if (request.method === "DELETE" && requestUrl.pathname.startsWith("/api/tails/")) {
    handleDeleteTail(response, requestUrl.pathname.split("/").pop());
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/trim") {
    handleTrim(request, response, requestUrl);
    return;
  }

  if (request.method === "GET" || request.method === "HEAD") {
    serveStatic(request, response, requestUrl);
    return;
  }

  response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
  response.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`目标口播剪辑器已启动：http://localhost:${PORT}`);
  const hasFfmpeg = ffmpegAvailable();
  const hasAvconvert = avconvertAvailable();
  const hasSwift = swiftAvailable();
  const hasNativeTrimmer = executableAvailable(SWIFT_TRIMMER);
  const hasNativeComposer = executableAvailable(SWIFT_COMPOSER);
  const hasNativeProbe = executableAvailable(SWIFT_PROBE);

  if (hasFfmpeg) {
    console.log("已检测到 ffmpeg，可以导出 MP4。");
  } else if (hasAvconvert) {
    console.log("未检测到 ffmpeg，将使用 macOS avconvert 导出 MP4。");
  } else if (hasNativeTrimmer) {
    console.log("未检测到 ffmpeg，将使用项目内 macOS 原生工具导出 MP4。");
  } else if (hasSwift) {
    console.log("未检测到 ffmpeg，将使用 macOS AVFoundation 导出 MP4。");
  } else {
    console.log("未检测到 ffmpeg 或 Swift 工具链，MP4 导出暂不可用。");
  }

  if (hasNativeComposer || hasSwift) {
    console.log("尾版拼接能力可用。");
  } else {
    console.log("未检测到尾版拼接工具或 Swift 工具链，尾版拼接暂不可用。");
  }

  if (ffprobeAvailable() || hasNativeProbe || hasSwift) {
    console.log("按帧号识别能力可用。");
  } else {
    console.log("未检测到帧率读取工具或 Swift 工具链，按帧号识别暂不可用。");
  }
});

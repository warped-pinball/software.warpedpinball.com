// Orchestration + UI for the Warped Pinball Vector browser flasher.
// Two independent operations:
//   1. Erase & flash firmware  (WebUSB / PICOBOOT)
//   2. Update software         (Web Serial / MicroPython raw REPL)
// They share board detection but can be run separately.

import {
  VENDOR_ID,
  BOOTLOADER_PIDS,
  BOOTLOADER_USB_FILTERS,
  RUNNING_USB_FILTERS,
  FIRMWARE_BASE,
  FIRMWARE_MANIFEST_URL,
  SOFTWARE_UPDATE_URL,
  SOFTWARE_LATEST_URL,
  PROCESSOR_BOARD_NAMES,
  SYSTEM_LABELS,
} from "./constants.js";
import { SerialBoard, parseUpdateFile } from "./board.js";
import { PicobootDevice } from "./picoboot.js";

// ---- DOM helpers ------------------------------------------------------
const $ = (id) => document.getElementById(id);
const el = {
  unsupported: $("unsupported"),
  unsupportedDetail: $("unsupported-detail"),
  app: $("app"),
  steps: $("steps"),
  progressWrap: $("progress-wrap"),
  progress: $("progress"),
  progressLabel: $("progress-label"),
  progressPct: $("progress-pct"),
  operations: $("operations"),
  detected: $("detected"),
  badgeBoard: $("badge-board"),
  badgeSystem: $("badge-system"),
  softwareSelect: $("software-select"),
  firmwareNote: $("firmware-note"),
  bootStatus: $("boot-status"),
  bootStatusText: $("boot-status-text"),
  btnConnect: $("btn-connect"),
  btnEnterBoot: $("btn-enter-boot"),
  btnFlashFw: $("btn-flash-fw"),
  btnFlashSw: $("btn-flash-sw"),
  btnAuthorize: $("btn-authorize"),
  btnRetry: $("btn-retry"),
  statusAlert: $("status-alert"),
  statusText: $("status-text"),
  log: $("log"),
};

let manifest = null;
let state = null; // detected board context
let busy = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg, kind = "") {
  const line = document.createElement("div");
  line.className =
    "log-line " +
    (kind === "error" ? "text-error" : kind === "ok" ? "text-success" : "text-base-content/80");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  el.log.appendChild(line);
  el.log.scrollTop = el.log.scrollHeight;
}

// Render a list of [id, label] steps with one current + already-done.
function renderSteps(stepsArr, current = null, done = []) {
  el.steps.innerHTML = "";
  for (const [id, label] of stepsArr) {
    const li = document.createElement("li");
    const isDone = done.includes(id);
    const isCurrent = id === current;
    li.className = "step " + (isDone || isCurrent ? "step-primary" : "step-pending");
    li.textContent = label + (isCurrent ? " …" : isDone ? " ✓" : "");
    el.steps.appendChild(li);
  }
}
function clearSteps() {
  el.steps.innerHTML = "";
}

function setStatus(msg, kind = "info") {
  el.statusAlert.className = `alert mt-4 alert-${kind}`;
  el.statusText.textContent = msg;
  el.statusAlert.classList.remove("hidden");
}

function showProgress(label) {
  el.progressLabel.textContent = label;
  el.progress.value = 0;
  el.progressPct.textContent = "0%";
  el.progressWrap.classList.remove("hidden");
}
function setProgress(value, total) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  el.progress.value = pct;
  el.progressPct.textContent = `${pct}%`;
}
function hideProgress() {
  el.progressWrap.classList.add("hidden");
}

function updateButtons() {
  const haveBoard = !!state;
  const fwAvail = haveBoard && !!state.firmwareFile;
  el.btnConnect.disabled = busy;
  el.btnEnterBoot.disabled = busy || !fwAvail;
  el.btnFlashFw.disabled = busy || !fwAvail || !state.pico;
  el.btnFlashSw.disabled = busy || !haveBoard;
}
function setBusy(b) {
  busy = b;
  updateButtons();
}

function setBootStatus(msg, kind = "info") {
  if (!msg) {
    el.bootStatus.classList.add("hidden");
    return;
  }
  el.bootStatus.className = `alert mt-3 alert-${kind}`;
  el.bootStatusText.textContent = msg;
  el.bootStatus.classList.remove("hidden");
}

// ---- Feature detection ------------------------------------------------
function checkSupport() {
  const hasUsb = "usb" in navigator;
  const hasSerial = "serial" in navigator;
  if (hasUsb && hasSerial) return true;

  const ua = navigator.userAgent;
  let detail =
    "Flashing needs the WebUSB and Web Serial APIs, which are only available in " +
    "Chromium-based browsers on desktop (Chrome, Edge, Brave, Opera) or Android Chrome.";
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) {
    detail =
      "iPhone and iPad can’t do this — every iOS browser is forced onto Apple’s WebKit engine, " +
      "which has no WebUSB or Web Serial support. Please use a desktop computer running Chrome, Edge, Brave, or Opera.";
  } else if (/Firefox/.test(ua)) {
    detail = "Firefox does not support WebUSB or Web Serial. Please use Chrome, Edge, Brave, or Opera.";
  } else if (/Safari/.test(ua) && !/Chrome/.test(ua)) {
    detail = "Safari does not support WebUSB or Web Serial. Please use Chrome, Edge, Brave, or Opera.";
  }
  el.unsupportedDetail.textContent = detail;
  el.unsupported.classList.remove("hidden");
  return false;
}

// ---- WebUSB bootloader acquisition -----------------------------------
function isBootloader(dev) {
  return dev.vendorId === VENDOR_ID && Object.values(BOOTLOADER_PIDS).includes(dev.productId);
}
async function getAuthorizedBootloader() {
  const devices = await navigator.usb.getDevices();
  return devices.find(isBootloader) || null;
}
function waitForAuthorizedBootloader(timeout) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (d) => {
      if (settled) return;
      settled = true;
      navigator.usb.removeEventListener("connect", onConnect);
      clearTimeout(timer);
      clearInterval(poll);
      resolve(d);
    };
    const onConnect = (e) => isBootloader(e.device) && finish(e.device);
    navigator.usb.addEventListener("connect", onConnect);
    const poll = setInterval(() => getAuthorizedBootloader().then((d) => d && finish(d)), 500);
    const timer = setTimeout(() => finish(null), timeout);
    getAuthorizedBootloader().then((d) => d && finish(d));
  });
}
async function acquireBootloader(timeout = 8000) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const device = await waitForAuthorizedBootloader(attempt === 0 ? timeout : 4000);
    if (!device) break;
    try {
      await sleep(300); // let the OS finish binding the just-connected device
      const pico = new PicobootDevice(device);
      await pico.open();
      return pico;
    } catch {
      await sleep(800);
    }
  }
  return acquireBootloaderManually();
}
async function acquireBootloaderManually() {
  setStatus(
    "The board is in bootloader mode but needs USB permission. Click “Grant USB access to the bootloader”, " +
      "then choose the device whose name starts with RP (e.g. “RP2 Boot”).",
    "warning",
  );
  el.btnAuthorize.classList.remove("hidden");
  const device = await new Promise((resolve, reject) => {
    el.btnAuthorize.onclick = async () => {
      try {
        const d = await navigator.usb.requestDevice({ filters: BOOTLOADER_USB_FILTERS });
        el.btnAuthorize.classList.add("hidden");
        resolve(d);
      } catch {
        reject(new Error("USB permission was not granted. Click “Start over” to try again."));
      }
    };
  });
  const pico = new PicobootDevice(device);
  await pico.open();
  return pico;
}

// ---- Manifest / firmware / software metadata --------------------------
async function loadManifest() {
  const res = await fetch(FIRMWARE_MANIFEST_URL, { cache: "no-cache" });
  if (!res.ok) throw new Error("Could not load the firmware manifest.");
  return res.json();
}
async function fetchFirmwareUf2(filename) {
  const res = await fetch(`${FIRMWARE_BASE}/${filename}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Could not download firmware image ${filename}.`);
  return res.arrayBuffer();
}
async function fetchSoftwareLatest(product) {
  try {
    const res = await fetch(SOFTWARE_LATEST_URL(product), { cache: "no-cache" });
    if (res.ok) return res.json();
  } catch {
    /* ignore */
  }
  return null;
}
async function fetchSoftwareUpdate(product) {
  const res = await fetch(SOFTWARE_UPDATE_URL(product), { cache: "no-cache" });
  if (!res.ok) {
    throw new Error(
      `No software update is published for ${SYSTEM_LABELS[product] || product} yet.`,
    );
  }
  return res.text();
}

// Open a connection to the running board, preferring no extra prompt.
async function openRunningBoard(timeout = 15000) {
  const candidates = [];
  if (state && state.port) candidates.push(state.port);
  for (const p of await navigator.serial.getPorts()) {
    if (!candidates.includes(p)) candidates.push(p);
  }
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const port of candidates) {
      const board = new SerialBoard(port);
      try {
        await board.open();
        return board;
      } catch {
        await board.close().catch(() => {});
      }
    }
    // refresh the authorized port list (board may still be re-enumerating)
    for (const p of await navigator.serial.getPorts()) {
      if (!candidates.includes(p)) candidates.push(p);
    }
    await sleep(500);
  }
  const port = await navigator.serial.requestPort({ filters: RUNNING_USB_FILTERS });
  const board = new SerialBoard(port);
  await board.open();
  return board;
}

// ---- Connect & detect -------------------------------------------------
async function connectAndDetect() {
  setBusy(true);
  clearSteps();
  el.statusAlert.classList.add("hidden");
  try {
    const port = await navigator.serial.requestPort({ filters: RUNNING_USB_FILTERS });
    const board = new SerialBoard(port);
    log("Opening serial connection…");
    await board.open();
    log("Identifying board…");
    const info = await board.identify();
    await board.close();

    if (!info.processor) {
      throw new Error(
        "Couldn’t read the board’s identity. Make sure the machine is off, the board is running " +
          "(not already in bootloader), and you’re using a data USB cable.",
      );
    }

    const system = info.system || (info.processor === "rp2040" ? "sys11" : null);
    state = { port, processor: info.processor, system, pico: null };
    setBootStatus("");

    const boardName = PROCESSOR_BOARD_NAMES[info.processor] || "Unknown board";
    el.badgeBoard.textContent = boardName;
    el.badgeSystem.textContent = SYSTEM_LABELS[system] || system || "Unknown system";
    el.detected.classList.remove("hidden");
    log(`Detected ${boardName}${system ? ` (${SYSTEM_LABELS[system] || system})` : ""}.`, "ok");

    await prepareTargets();
    el.operations.classList.remove("hidden");
    el.btnConnect.textContent = "Re-detect board";
    setStatus("Board detected. Choose what you’d like to do below.", "success");
  } catch (err) {
    handleError(err);
  } finally {
    setBusy(false);
  }
}

async function prepareTargets() {
  const sys = manifest.systems[state.system];
  if (!sys) {
    el.firmwareNote.textContent =
      `⚠️ No firmware image is bundled for “${SYSTEM_LABELS[state.system] || state.system}” yet, ` +
      "so firmware flashing is unavailable for this board.";
    state.firmwareFile = null;
    state.firmwareProcessor = null;
  } else {
    state.firmwareFile = sys.uf2;
    state.firmwareProcessor = sys.processor;
    el.firmwareNote.textContent = `Firmware image: ${sys.uf2} (${PROCESSOR_BOARD_NAMES[sys.processor]}).`;
  }
  updateButtons();

  el.softwareSelect.innerHTML = "";
  const latest = await fetchSoftwareLatest(state.system);
  const optLatest = document.createElement("option");
  optLatest.value = "latest";
  optLatest.textContent = latest ? `Latest production — v${latest.version}` : "Latest production";
  el.softwareSelect.appendChild(optLatest);
  const optCustom = document.createElement("option");
  optCustom.value = "custom";
  optCustom.textContent = "Upload my own update.json…";
  el.softwareSelect.appendChild(optCustom);

  state.customSoftware = null;
  el.softwareSelect.onchange = async () => {
    if (el.softwareSelect.value === "custom") {
      const file = await pickFile(".json");
      if (file) {
        state.customSoftware = await file.text();
        log(`Loaded custom update file: ${file.name}`);
      } else {
        el.softwareSelect.value = "latest";
      }
    } else {
      state.customSoftware = null;
    }
  };
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

// ---- Operation 1a: enter bootloader mode & detect ---------------------
async function runEnterBoot() {
  if (busy || !state || !state.firmwareFile) return;
  setBusy(true);
  el.btnRetry.classList.add("hidden");
  clearSteps();
  try {
    // Drop any previous bootloader handle.
    if (state.pico) {
      await state.pico.close().catch(() => {});
      state.pico = null;
      updateButtons();
    }

    // Trigger a reset over serial if we have a running board to talk to.
    if (state.port) {
      setBootStatus("Resetting the board into its bootloader…", "info");
      log("Reopening serial to trigger the bootloader…");
      try {
        const board = new SerialBoard(state.port);
        await board.open();
        await board.enterBootloader();
        await board.close().catch(() => {});
        log("Reset command sent.");
      } catch (e) {
        log(`Could not reset over serial (${e.message}). If the board is already in BOOTSEL, continuing…`);
      }
    } else {
      setBootStatus("Waiting for a board in bootloader mode…", "info");
    }

    log("Waiting for the bootloader USB device…");
    const pico = await acquireBootloader(20000);
    const pid = pico.device.productId;
    const proc = pico.processor;
    log(`Bootloader device: VID 0x${VENDOR_ID.toString(16)} PID 0x${pid.toString(16).padStart(4, "0")} (${proc || "unknown"}).`, "ok");

    // Validate communication with a control transfer (no bulk endpoints), so
    // detection is confirmed independently of the UF2 write path.
    const status = await pico.getCommandStatus();
    log(`PICOBOOT responding (status code ${status.statusCode}, in-progress ${status.inProgress}).`, "ok");

    state.pico = pico;
    state.bootProcessor = proc || state.processor;

    if (state.firmwareProcessor && proc && state.firmwareProcessor !== proc) {
      setBootStatus(
        `⚠️ Board is a ${PROCESSOR_BOARD_NAMES[proc]} bootloader, but the firmware targets ` +
          `${PROCESSOR_BOARD_NAMES[state.firmwareProcessor]}. Flashing will be refused — re-detect the board.`,
        "warning",
      );
    } else {
      setBootStatus(
        `✅ Detected ${proc ? PROCESSOR_BOARD_NAMES[proc] + " " : ""}bootloader and PICOBOOT is responding. ` +
          "Click “2. Erase & flash firmware”.",
        "success",
      );
    }
    updateButtons();
  } catch (err) {
    handleError(err, true);
  } finally {
    setBusy(false);
  }
}

// ---- Operation 1b: erase & flash firmware -----------------------------
const FW_STEPS = [
  ["erase", "Erase board"],
  ["firmware", "Flash firmware"],
  ["done", "Reboot"],
];

async function runFirmware() {
  if (busy || !state || !state.firmwareFile || !state.pico) return;
  setBusy(true);
  el.btnRetry.classList.add("hidden");
  const done = [];
  try {
    log("Downloading firmware images…");
    renderSteps(FW_STEPS, "erase");
    const nukeBuf = await fetchFirmwareUf2(manifest.nuke);
    const firmwareBuf = await fetchFirmwareUf2(state.firmwareFile);

    const proc = state.bootProcessor || state.processor;
    let pico = state.pico;

    // Erase (nuke.uf2) using the already-validated bootloader handle.
    setStatus("Erasing the board…", "info");
    showProgress("Erasing the board");
    log("Flashing nuke.uf2 to erase the board…");
    await pico.flashUf2(nukeBuf, proc, setProgress);
    log("Running flash-erase…");
    await pico.reboot(proc); // run nuke -> wipes flash -> back to bootloader
    await pico.close().catch(() => {});
    state.pico = null;
    done.push("erase");

    await sleep(2000);
    renderSteps(FW_STEPS, "firmware", done);
    hideProgress();
    log("Waiting for the board to re-enter the bootloader…");
    pico = await acquireBootloader(20000);

    // Flash firmware.
    setStatus("Flashing firmware…", "info");
    showProgress("Flashing firmware");
    log(`Flashing ${state.firmwareFile}…`);
    await pico.flashUf2(firmwareBuf, state.firmwareProcessor || proc, setProgress);
    log("Rebooting into the new firmware…");
    await pico.reboot(state.firmwareProcessor || proc);
    await pico.close().catch(() => {});
    hideProgress();
    done.push("firmware");

    // Optional silent verify.
    renderSteps(FW_STEPS, "done", done);
    await sleep(1500);
    const verify = await openRunningBoardSilent(20000);
    if (verify) {
      const info = await verify.identify().catch(() => null);
      await verify.close().catch(() => {});
      if (info && info.processor) log(`Board is back online: ${PROCESSOR_BOARD_NAMES[info.processor]}.`, "ok");
    }
    done.push("done");
    renderSteps(FW_STEPS, null, done);
    setBootStatus("");
    setStatus(
      "✅ Firmware flashed. You can now Update software, or unplug and power your machine back on.",
      "success",
    );
    log("Firmware flash complete.", "ok");
  } catch (err) {
    hideProgress();
    handleError(err, true);
  } finally {
    setBusy(false);
  }
}

// ---- Operation 2: update software -------------------------------------
const SW_STEPS = [
  ["connect", "Connect"],
  ["software", "Install software"],
  ["restart", "Restart"],
];

async function runSoftware() {
  if (busy || !state) return;
  setBusy(true);
  el.btnRetry.classList.add("hidden");
  const done = [];
  try {
    let softwareText = state.customSoftware;
    if (!softwareText) {
      log("Downloading software update…");
      softwareText = await fetchSoftwareUpdate(state.system);
    }

    renderSteps(SW_STEPS, "connect");
    setStatus("Connecting to the board…", "info");
    log("Opening serial connection to the running board…");
    const board = await openRunningBoard();
    done.push("connect");

    renderSteps(SW_STEPS, "software", done);
    const { meta, files } = parseUpdateFile(softwareText);
    log(`Update format ${meta.update_file_format}, ${files.length} files. Comparing with the board…`);
    setStatus("Installing software…", "info");
    showProgress("Installing software");
    await board.writeUpdate(files, (sentN, totalN, name) => {
      setProgress(sentN, totalN);
      log(`Uploading (${sentN}/${totalN}): ${name}`);
    });
    hideProgress();
    done.push("software");

    renderSteps(SW_STEPS, "restart", done);
    log("Restarting the board…");
    await board.restart();
    await board.close().catch(() => {});
    done.push("restart");
    renderSteps(SW_STEPS, null, done);
    setStatus("✅ Software updated. You can unplug the board and power your machine back on.", "success");
    log("Software update complete.", "ok");
  } catch (err) {
    hideProgress();
    handleError(err, true);
  } finally {
    setBusy(false);
  }
}

// Try to reopen the running board without prompting; returns null on failure.
async function openRunningBoardSilent(timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const port of await navigator.serial.getPorts()) {
      const board = new SerialBoard(port);
      try {
        await board.open();
        return board;
      } catch {
        await board.close().catch(() => {});
      }
    }
    await sleep(500);
  }
  return null;
}

// ---- Errors / reset ---------------------------------------------------
function handleError(err, fatal = false) {
  console.error(err);
  const msg = err && err.message ? err.message : String(err);
  if (/No port selected|No device selected|cancelled|aborted/i.test(msg)) {
    setStatus("Cancelled. You can try again when ready.", "warning");
    log("Cancelled.", "");
    return;
  }
  log(msg, "error");
  if (fatal) {
    setStatus(msg + " Your board is safe — leave it plugged in and try again.", "error");
    el.btnRetry.classList.remove("hidden");
    el.btnRetry.textContent = "Start over";
  } else {
    setStatus(msg, "error");
  }
}

function resetUi() {
  if (state && state.pico) state.pico.close().catch(() => {});
  state = null;
  el.operations.classList.add("hidden");
  el.detected.classList.add("hidden");
  el.btnAuthorize.classList.add("hidden");
  el.btnRetry.classList.add("hidden");
  el.btnConnect.textContent = "Connect & detect board";
  el.statusAlert.classList.add("hidden");
  setBootStatus("");
  hideProgress();
  clearSteps();
  setBusy(false);
}

// ---- Init -------------------------------------------------------------
async function init() {
  if (!checkSupport()) return;
  el.app.classList.remove("hidden");
  try {
    manifest = await loadManifest();
  } catch {
    setStatus("Couldn’t load firmware data. Please refresh and try again.", "error");
    return;
  }
  el.btnConnect.onclick = connectAndDetect;
  el.btnEnterBoot.onclick = runEnterBoot;
  el.btnFlashFw.onclick = runFirmware;
  el.btnFlashSw.onclick = runSoftware;
  el.btnRetry.onclick = resetUi;
  setBusy(false);
}

init();

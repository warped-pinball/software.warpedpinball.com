// Orchestration + UI for the Warped Pinball Vector browser flasher.
// Ties together Web Serial (board detection / software push) and WebUSB
// PICOBOOT (erase + firmware flash).

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
  detected: $("detected"),
  badgeBoard: $("badge-board"),
  badgeSystem: $("badge-system"),
  softwareSelect: $("software-select"),
  firmwareNote: $("firmware-note"),
  btnConnect: $("btn-connect"),
  btnFlash: $("btn-flash"),
  btnAuthorize: $("btn-authorize"),
  btnRetry: $("btn-retry"),
  statusAlert: $("status-alert"),
  statusText: $("status-text"),
  log: $("log"),
};

const STEPS = [
  ["connect", "Connect & detect board"],
  ["erase", "Erase the board"],
  ["firmware", "Flash firmware"],
  ["software", "Install software"],
  ["verify", "Verify & restart"],
];

let manifest = null;
let state = null; // current flashing context

function log(msg, kind = "") {
  const line = document.createElement("div");
  line.className = "log-line " + (kind === "error" ? "text-error" : kind === "ok" ? "text-success" : "text-base-content/80");
  const ts = new Date().toLocaleTimeString();
  line.textContent = `[${ts}] ${msg}`;
  el.log.appendChild(line);
  el.log.scrollTop = el.log.scrollHeight;
}

function renderSteps(current = null, done = []) {
  el.steps.innerHTML = "";
  for (const [id, label] of STEPS) {
    const li = document.createElement("li");
    const isDone = done.includes(id);
    const isCurrent = id === current;
    li.className = "step " + (isDone || isCurrent ? "step-primary" : "step-pending");
    li.textContent = label + (isCurrent ? " …" : isDone ? " ✓" : "");
    el.steps.appendChild(li);
  }
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ---- USB device acquisition ------------------------------------------
function isBootloader(dev) {
  return dev.vendorId === VENDOR_ID && Object.values(BOOTLOADER_PIDS).includes(dev.productId);
}

async function getAuthorizedBootloader() {
  const devices = await navigator.usb.getDevices();
  return devices.find(isBootloader) || null;
}

// Wait for the board to appear as a ROM bootloader we already have permission
// for. Resolves with the device, or null if it doesn't show up in `timeout`.
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
    const onConnect = (e) => {
      if (isBootloader(e.device)) finish(e.device);
    };
    navigator.usb.addEventListener("connect", onConnect);
    const poll = setInterval(() => getAuthorizedBootloader().then((d) => d && finish(d)), 500);
    const timer = setTimeout(() => finish(null), timeout);
    getAuthorizedBootloader().then((d) => d && finish(d));
  });
}

// Acquire the bootloader device, prompting for permission only if we don't
// already have it. Returns an open PicobootDevice.
async function acquireBootloader(timeout = 8000) {
  // Retry the open a couple of times: right after a reset the previous (now
  // disconnected) device handle can briefly linger.
  for (let attempt = 0; attempt < 3; attempt++) {
    const device = await waitForAuthorizedBootloader(attempt === 0 ? timeout : 4000);
    if (!device) break;
    try {
      const pico = new PicobootDevice(device);
      await pico.open();
      return pico;
    } catch (e) {
      await sleep(800);
    }
  }
  return acquireBootloaderManually();
}

async function acquireBootloaderManually() {
  // First time on this origin: we need a user gesture to grant USB access.
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
      } catch (err) {
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
      `No software update is published for ${SYSTEM_LABELS[product] || product} yet. ` +
        "Firmware was flashed; you can update software later over WiFi.",
    );
  }
  return res.text();
}

// ---- Phase 0: connect & detect ---------------------------------------
async function connectAndDetect() {
  el.btnConnect.disabled = true;
  renderSteps("connect");
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
    state = { port, processor: info.processor, system };

    const boardName = PROCESSOR_BOARD_NAMES[info.processor] || "Unknown board";
    el.badgeBoard.textContent = boardName;
    el.badgeSystem.textContent = SYSTEM_LABELS[system] || system || "Unknown system";
    el.detected.classList.remove("hidden");
    log(`Detected ${boardName}${system ? ` (${SYSTEM_LABELS[system] || system})` : ""}.`, "ok");

    await prepareTargets();
    renderSteps(null, ["connect"]);
    el.btnConnect.classList.add("hidden");
    el.btnFlash.classList.remove("hidden");
    setStatus("Board detected. Review the version below, then click “Update my Vector”.", "success");
  } catch (err) {
    el.btnConnect.disabled = false;
    handleError(err);
  }
}

// Resolve which firmware image and software version we'll install, and fill
// the version selector.
async function prepareTargets() {
  const sys = manifest.systems[state.system];
  if (!sys) {
    el.firmwareNote.textContent =
      `No firmware image is bundled for “${SYSTEM_LABELS[state.system] || state.system}”. ` +
      "Software will still be updated over serial.";
    state.firmwareFile = null;
    state.firmwareProcessor = null;
  } else {
    state.firmwareFile = sys.uf2;
    state.firmwareProcessor = sys.processor;
    el.firmwareNote.textContent = `Firmware image: ${sys.uf2} (${PROCESSOR_BOARD_NAMES[sys.processor]}).`;
  }

  // Software version options. We host the latest production update.json
  // same-origin; users wanting a specific older build can supply their own file.
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

  state.softwareVersion = latest ? latest.version : "latest";
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

// ---- Full flash flow --------------------------------------------------
async function runFlash() {
  el.btnFlash.disabled = true;
  el.btnRetry.classList.add("hidden");
  const done = ["connect"];

  try {
    // Pre-load everything we'll need so a slow network can't interrupt mid-flash.
    let nukeBuf = null;
    let firmwareBuf = null;
    if (state.firmwareFile) {
      renderSteps("erase", done);
      log("Downloading firmware images…");
      nukeBuf = await fetchFirmwareUf2(manifest.nuke);
      firmwareBuf = await fetchFirmwareUf2(state.firmwareFile);
    }

    let softwareText = null;
    if (state.customSoftware) {
      softwareText = state.customSoftware;
    } else {
      try {
        softwareText = await fetchSoftwareUpdate(state.system);
      } catch (e) {
        log(e.message, "error");
      }
    }

    // ---- Reset into the ROM bootloader ----
    if (state.firmwareFile) {
      setStatus("Resetting the board into its bootloader…", "info");
      log("Reopening serial to trigger the bootloader…");
      const board = new SerialBoard(state.port);
      await board.open();
      await board.enterBootloader();
      await board.close().catch(() => {});
      log("Reset command sent; waiting for the bootloader to appear…");

      // ---- Erase (nuke.uf2) ----
      renderSteps("erase", done);
      let pico = await acquireBootloader();
      setStatus("Board is in bootloader mode. Erasing…", "info");
      showProgress("Erasing the board");
      log("Flashing nuke.uf2 to erase the board…");
      await pico.flashUf2(nukeBuf, state.processor, setProgress);
      log("Running flash-erase…");
      await pico.reboot(state.processor); // run nuke -> wipes flash -> back to bootloader
      await pico.close();
      done.push("erase");

      // nuke wipes flash and returns to the bootloader; wait for re-enumeration.
      await sleep(2000);
      renderSteps("firmware", done);
      hideProgress();
      log("Waiting for the board to re-enter the bootloader…");
      pico = await acquireBootloader(20000);

      // ---- Flash firmware ----
      setStatus("Flashing firmware…", "info");
      showProgress("Flashing firmware");
      log(`Flashing ${state.firmwareFile}…`);
      await pico.flashUf2(firmwareBuf, state.firmwareProcessor || state.processor, setProgress);
      log("Rebooting into the new firmware…");
      await pico.reboot(state.firmwareProcessor || state.processor);
      await pico.close();
      hideProgress();
      done.push("firmware");
    } else {
      done.push("erase", "firmware");
    }

    // ---- Software update over serial ----
    if (softwareText) {
      renderSteps("software", done);
      setStatus("Waiting for the board to restart, then installing software…", "info");
      log("Waiting for the board’s serial port to come back…");
      const board = await reconnectSerial();
      const { meta, files } = parseUpdateFile(softwareText);
      log(`Update format ${meta.update_file_format}, ${files.length} files. Comparing with the board…`);
      showProgress("Installing software");
      await board.writeUpdate(files, (sentN, totalN, name) => {
        setProgress(sentN, totalN);
        log(`Uploading (${sentN}/${totalN}): ${name}`);
      });
      hideProgress();
      log("Restarting the board…");
      await board.restart();
      await board.close().catch(() => {});
      done.push("software");
    } else {
      done.push("software");
    }

    // ---- Verify ----
    renderSteps("verify", done);
    log("Verifying the board came back up…");
    await sleep(1500);
    const verify = await reconnectSerial(20000).catch(() => null);
    if (verify) {
      const info = await verify.identify().catch(() => null);
      await verify.close().catch(() => {});
      if (info && info.processor) {
        log(`Board is back online: ${PROCESSOR_BOARD_NAMES[info.processor]}.`, "ok");
      }
    }
    done.push("verify");
    renderSteps(null, done);
    setStatus("✅ Done! Your Vector board has been updated. You can unplug it and power your machine back on.", "success");
    log("All done.", "ok");
    el.btnRetry.classList.remove("hidden");
    el.btnRetry.textContent = "Flash another board";
  } catch (err) {
    hideProgress();
    handleError(err, true);
  }
}

// Reconnect to the running board over serial without prompting when possible
// (Web Serial remembers previously-granted ports).
async function reconnectSerial(timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ports = await navigator.serial.getPorts();
    for (const port of ports) {
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
  // Couldn't reopen automatically — ask the user to pick it.
  const port = await navigator.serial.requestPort({ filters: RUNNING_USB_FILTERS });
  const board = new SerialBoard(port);
  await board.open();
  return board;
}

function handleError(err, fatal = false) {
  console.error(err);
  const msg = err && err.message ? err.message : String(err);
  // A user dismissing the chooser is not really an error.
  if (/No port selected|No device selected|cancelled|aborted/i.test(msg)) {
    setStatus("Cancelled. Click “Connect & detect board” to try again.", "warning");
  } else {
    setStatus(msg, "error");
  }
  log(msg, "error");
  if (fatal) {
    setStatus(
      msg + " Your board is safe — leave it plugged in. Click “Start over” to retry.",
      "error",
    );
    el.btnRetry.classList.remove("hidden");
    el.btnRetry.textContent = "Start over";
  }
}

function resetUi() {
  state = null;
  el.detected.classList.add("hidden");
  el.btnFlash.classList.add("hidden");
  el.btnFlash.disabled = false;
  el.btnAuthorize.classList.add("hidden");
  el.btnRetry.classList.add("hidden");
  el.btnConnect.classList.remove("hidden");
  el.btnConnect.disabled = false;
  el.statusAlert.classList.add("hidden");
  hideProgress();
  renderSteps();
}

// ---- Init -------------------------------------------------------------
async function init() {
  if (!checkSupport()) return;
  el.app.classList.remove("hidden");
  renderSteps();
  try {
    manifest = await loadManifest();
  } catch (err) {
    setStatus("Couldn’t load firmware data. Please refresh and try again.", "error");
    return;
  }
  el.btnConnect.onclick = connectAndDetect;
  el.btnFlash.onclick = runFlash;
  el.btnRetry.onclick = resetUi;
}

init();

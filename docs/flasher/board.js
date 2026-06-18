// Web Serial layer for talking to a running Vector board (MicroPython raw REPL).
// Mirrors the desktop TrenchCoat "Ray" class: detect the processor / system,
// reset into the ROM bootloader, and push a software update.json over serial.

const CTRL_A = "\x01"; // enter raw REPL
const CTRL_B = "\x02"; // exit raw REPL
const CTRL_C = "\x03"; // interrupt
const CTRL_D = "\x04"; // execute / EOT
const COMMAND_CHUNK_SIZE = 5000;

/**
 * A simple live serial monitor: opens the port in normal mode (no raw REPL) and
 * streams decoded text to a callback, with optional writes back to the board.
 * Kept separate from SerialBoard, which drives the raw-REPL command protocol.
 */
export class SerialMonitor {
  /** @param {SerialPort} port @param {(text:string)=>void} onData */
  constructor(port, onData) {
    this.port = port;
    this.onData = onData;
    this.reader = null;
    this.writer = null;
    this._decoder = new TextDecoder();
    this._encoder = new TextEncoder();
    this._running = false;
  }

  async start(baudRate = 115200) {
    await this.port.open({ baudRate });
    // Assert DTR/RTS — some USB-CDC stacks won't emit output until a terminal
    // raises these signals.
    await this.port.setSignals({ dataTerminalReady: true, requestToSend: true }).catch(() => {});
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this._running = true;
    this._loop();
  }

  async _loop() {
    try {
      while (this._running) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length) this.onData(this._decoder.decode(value, { stream: true }));
      }
    } catch {
      /* reader cancelled or device removed */
    }
  }

  async send(text) {
    if (this.writer) await this.writer.write(this._encoder.encode(text));
  }

  async stop() {
    this._running = false;
    try {
      if (this.reader) {
        await this.reader.cancel().catch(() => {});
        this.reader.releaseLock();
      }
    } catch {
      /* ignore */
    }
    try {
      if (this.writer) this.writer.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      await this.port.close();
    } catch {
      /* ignore */
    }
    this.reader = this.writer = null;
  }
}

export class SerialBoard {
  /** @param {SerialPort} port */
  constructor(port) {
    this.port = port;
    this.reader = null;
    this.writer = null;
    this._rx = "";
    this._decoder = new TextDecoder();
    this._encoder = new TextEncoder();
    this._waiters = [];
    this._keepReading = false;
  }

  async open(baudRate = 115200) {
    await this.port.open({ baudRate });
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this._keepReading = true;
    this._pump();
    await this.enterRawRepl();
  }

  async close() {
    this._keepReading = false;
    try {
      if (this.reader) {
        await this.reader.cancel().catch(() => {});
        this.reader.releaseLock();
      }
    } catch {
      /* ignore */
    }
    try {
      if (this.writer) this.writer.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      await this.port.close();
    } catch {
      /* ignore */
    }
    this.reader = this.writer = null;
  }

  async _pump() {
    try {
      while (this._keepReading) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length) {
          this._rx += this._decoder.decode(value, { stream: true });
          this._waiters.forEach((w) => w());
        }
      }
    } catch {
      /* reader cancelled or port lost */
    }
  }

  async _write(text) {
    await this.writer.write(this._encoder.encode(text));
  }

  _readUntil(predicate, timeout = 8000) {
    if (predicate(this._rx)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for the board to respond."));
      }, timeout);
      const check = () => {
        if (predicate(this._rx)) {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this._waiters = this._waiters.filter((w) => w !== check);
      };
      this._waiters.push(check);
    });
  }

  async enterRawRepl() {
    this._rx = "";
    await this._write(CTRL_C + CTRL_C); // interrupt any running program
    await new Promise((r) => setTimeout(r, 100));
    await this._write(CTRL_A); // enter raw REPL
    await this._readUntil((s) => s.includes("raw REPL") || s.includes(">"), 3000);
  }

  /**
   * Run code on the board in raw REPL and return {output, error}. Raw-REPL
   * replies are "OK" + stdout + \x04 + stderr + \x04 + ">".
   */
  async exec(code, timeout = 15000) {
    this._rx = "";
    await this._write(code + CTRL_D);
    // Wait for both \x04 terminators (end of stdout and stderr).
    await this._readUntil((s) => s.split(CTRL_D).length >= 3, timeout);
    const afterOk = this._rx.slice(this._rx.indexOf("OK") + 2);
    const parts = afterOk.split(CTRL_D);
    const output = parts[0] || "";
    const error = (parts[1] || "").trim();
    if (error) {
      throw new Error(`Board error:\n${error}`);
    }
    return output;
  }

  // Run a script that prints a single value wrapped in <<< >>> markers.
  async _execValue(code, timeout = 5000) {
    const out = await this.exec(code, timeout);
    const start = out.indexOf("<<<");
    const end = out.lastIndexOf(">>>");
    if (start === -1 || end === -1 || end <= start) return "";
    return out.slice(start + 3, end).trim();
  }

  async detectProcessor() {
    const code = [
      "import os",
      "try:",
      "    _m = os.uname().machine",
      "except Exception:",
      "    _m = ''",
      "print('<<<' + _m + '>>>')",
    ].join("\n");
    const machine = (await this._execValue(code)).toUpperCase();
    if (machine.includes("RP2350")) return "rp2350";
    if (machine.includes("RP2040")) return "rp2040";
    return null;
  }

  async detectSystem() {
    const code = [
      "try:",
      "    import systemConfig",
      "    _s = systemConfig.vectorSystem",
      "except Exception:",
      "    _s = ''",
      "print('<<<' + str(_s) + '>>>')",
    ].join("\n");
    const system = await this._execValue(code);
    return system || null;
  }

  /**
   * Identify the connected board. A Pico W (RP2040) always runs the legacy
   * System 9 / 11 firmware, so its system probe is skipped.
   */
  async identify() {
    const processor = await this.detectProcessor();
    let system = null;
    if (processor === "rp2350") {
      system = await this.detectSystem();
    } else if (processor === "rp2040") {
      system = "sys11";
    }
    return { processor, system };
  }

  // Reset the board into the ROM (BOOTSEL) bootloader. We're in raw REPL, so
  // code only runs on Ctrl-D; the board resets before replying, so this is
  // fire-and-forget.
  async enterBootloader() {
    await this._write("import machine\nmachine.bootloader()\n" + CTRL_D);
    await new Promise((r) => setTimeout(r, 300));
  }

  async restart() {
    await this._write("import machine\nmachine.reset()\n" + CTRL_D);
    await new Promise((r) => setTimeout(r, 300));
  }

  // ---- Software update over serial -------------------------------------

  /** Get {path: sha256hex} for every file on the board. */
  async sha256Index() {
    const code = [
      "import os, hashlib, json, binascii",
      "files = {}",
      "def _walk(path):",
      "    try:",
      "        for entry in os.listdir(path):",
      "            full = path + '/' + entry if path != '/' else '/' + entry",
      "            try:",
      "                if os.stat(full)[0] & 0x4000:",
      "                    _walk(full)",
      "                else:",
      "                    h = hashlib.sha256()",
      "                    with open(full, 'rb') as f:",
      "                        while True:",
      "                            c = f.read(1024)",
      "                            if not c:",
      "                                break",
      "                            h.update(c)",
      "                    files[full] = binascii.hexlify(h.digest()).decode('utf-8')",
      "            except Exception as e:",
      "                files[full] = 'err'",
      "    except Exception as e:",
      "        pass",
      "_walk('/')",
      "print('<<<' + json.dumps(files) + '>>>')",
    ].join("\n");
    const raw = await this._execValue(code, 60000);
    if (!raw) return {};
    return JSON.parse(raw);
  }

  /**
   * Push a parsed software update to the board, skipping files already present
   * with a matching hash. Reports progress per file.
   * @param {{filename:string, metadata:object, base64:string}[]} files
   * @param {(done:number,total:number,name:string)=>void} onProgress
   */
  async writeUpdate(files, onProgress = () => {}) {
    // Normalize leading slash and compute expected hashes.
    for (const f of files) {
      if (!f.filename.startsWith("/")) f.filename = "/" + f.filename;
      f.expectedHash = await sha256Hex(base64ToBytes(f.base64));
    }

    const boardIndex = await this.sha256Index();
    const required = new Set();
    for (const f of files) {
      if (boardIndex[f.filename] !== f.expectedHash) required.add(f.filename);
    }

    // Files to send: changed files, plus any executable (run-once) files.
    const toSend = files.filter((f) => required.has(f.filename) || f.metadata.execute);

    // Build the transfer script as a list of lines.
    const lines = [
      "import os, binascii, hashlib",
      "f = None",
      "hash_checks = []",
      "def w(data):",
      "    global f",
      "    f.write(binascii.a2b_base64(data))",
      "    f.flush()",
      "def hc(path, expected):",
      "    try:",
      "        h = hashlib.sha256()",
      "        with open(path, 'rb') as ff:",
      "            while True:",
      "                c = ff.read(1024)",
      "                if not c:",
      "                    break",
      "                h.update(c)",
      "        digest = binascii.hexlify(h.digest()).decode('utf-8')",
      "    except Exception:",
      "        digest = ''",
      "    hash_checks.append((path, digest == expected))",
      "def mdir(path):",
      "    try:",
      "        os.mkdir(path)",
      "    except OSError:",
      "        pass",
      "def runfile(path):",
      "    mod = path.replace('/', '.').replace('.py', '')",
      "    if mod.startswith('.'):",
      "        mod = mod[1:]",
      "    try:",
      "        m = __import__(mod)",
      "        if hasattr(m, 'main'):",
      "            m.main()",
      "    except Exception as e:",
      "        print('Error executing', path, e)",
      "    try:",
      "        os.remove(path)",
      "    except OSError:",
      "        pass",
    ];

    for (const f of toSend) {
      const dir = f.filename.slice(0, f.filename.lastIndexOf("/"));
      if (dir && dir !== "") lines.push(`mdir('${dir}')`);
      lines.push(`f = open('${f.filename}', 'wb')`);
      const chunkSize = COMMAND_CHUNK_SIZE - 20;
      for (let i = 0; i < f.base64.length; i += chunkSize) {
        lines.push(`w('${f.base64.slice(i, i + chunkSize)}')`);
      }
      lines.push("f.close()");
      lines.push(`hc('${f.filename}', '${f.expectedHash}')`);
      if (f.metadata.execute) lines.push(`runfile('${f.filename}')`);
    }

    // Send the script in COMMAND_CHUNK_SIZE-sized blocks. Globals persist across
    // raw-REPL execs, so the helper definitions stay in scope for later blocks.
    let block = [];
    let blockLen = 0;
    let sent = 0;
    const flushBlock = async () => {
      if (!block.length) return;
      await this.exec(block.join("\n"), 30000);
      block = [];
      blockLen = 0;
    };
    for (const line of lines) {
      if (blockLen + line.length > COMMAND_CHUNK_SIZE) {
        await flushBlock();
      }
      block.push(line);
      blockLen += line.length + 1;
      // Progress: count file-open boundaries as we go.
      if (line.startsWith("f = open(")) {
        sent += 1;
        const name = line.slice(9).split("'")[1];
        onProgress(sent, toSend.length, name);
      }
    }
    await flushBlock();

    // Verify every uploaded file hashed correctly.
    const result = await this._execValue(
      "print('<<<' + str([c[0] for c in hash_checks if not c[1]]) + '>>>')",
      30000,
    );
    if (result && result !== "[]") {
      throw new Error(`These files failed to verify on the board: ${result}`);
    }
    return { sentCount: toSend.length, totalCount: files.length };
  }
}

// ---- helpers ----------------------------------------------------------

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Parse a Vector update.json. The first line is JSON metadata; each following
 * line is `filename{file-metadata}base64contents`; the final line is an empty
 * filename carrying the signature. Returns {meta, files}.
 */
export function parseUpdateFile(text) {
  const rawLines = text.split(/\r?\n/);
  const meta = JSON.parse(rawLines[0]);
  const files = [];
  for (let i = 1; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    if (!line) continue;
    const braceOpen = line.indexOf("{");
    const braceClose = line.indexOf("}");
    if (braceOpen === -1 || braceClose === -1) continue;
    const filename = line.slice(0, braceOpen);
    if (filename === "") continue; // signature line
    const metadata = JSON.parse(line.slice(braceOpen, braceClose + 1));
    const base64 = line.slice(braceClose + 1).trim();
    files.push({ filename, metadata, base64 });
  }
  return { meta, files };
}

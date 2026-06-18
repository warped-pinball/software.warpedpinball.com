// PICOBOOT protocol over WebUSB. Talks to the RP2040 / RP2350 ROM (BOOTSEL)
// bootloader to erase and program flash. Based on the "PICOBOOT interface"
// section of the RP2040 and RP2350 datasheets and the pico-sdk picoboot headers.

import {
  PICOBOOT,
  FLASH_XIP_BASE,
  FLASH_SECTOR_SIZE,
  FLASH_WRITE_CHUNK,
} from "./constants.js";
import { parseUf2, coalesceBlocks, assertUf2MatchesProcessor } from "./uf2.js";

const CMD_PACKET_SIZE = 32;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class PicobootDevice {
  /** @param {USBDevice} device */
  constructor(device) {
    this.device = device;
    this.interfaceNumber = null;
    this.epIn = null;
    this.epOut = null;
    this.token = 1;
    this._ackLen = 64; // bulk IN max packet size (refined on open)
    this._skipBulkAck = false; // set if the bulk ZLP ack proves unreliable
  }

  async open() {
    const dev = this.device;
    if (!dev.opened) await dev.open();
    if (dev.configuration === null) await dev.selectConfiguration(1);

    // Find the PICOBOOT vendor interface (class 0xFF) with its two bulk endpoints.
    let found = null;
    for (const iface of dev.configuration.interfaces) {
      const alt = iface.alternates.find((a) => a.interfaceClass === 0xff);
      if (alt) {
        found = { number: iface.interfaceNumber, alt };
        break;
      }
    }
    if (!found) {
      throw new Error("Could not find the PICOBOOT interface on the bootloader device.");
    }

    this.interfaceNumber = found.number;
    await dev.claimInterface(this.interfaceNumber);
    // Only select a non-default alternate setting if the interface actually has
    // one; calling this needlessly can reset the endpoints on some platforms.
    if (found.alt.alternateSetting !== 0) {
      try {
        await dev.selectAlternateInterface(this.interfaceNumber, found.alt.alternateSetting);
      } catch {
        /* ignore */
      }
    }

    for (const ep of found.alt.endpoints) {
      if (ep.type !== "bulk") continue;
      if (ep.direction === "in") {
        this.epIn = ep.endpointNumber;
        if (ep.packetSize) this._ackLen = ep.packetSize;
      }
      if (ep.direction === "out") this.epOut = ep.endpointNumber;
    }
    if (this.epIn == null || this.epOut == null) {
      throw new Error("PICOBOOT interface is missing its bulk endpoints.");
    }

    await this.resetInterface();
    // Clear any stale halt left on the bulk endpoints from a previous session,
    // which otherwise surfaces as a generic "transfer error" on the first ack.
    try {
      await this.device.clearHalt("in", this.epIn);
      await this.device.clearHalt("out", this.epOut);
    } catch {
      /* not all platforms allow clearHalt; ignore */
    }
    // A just-re-enumerated bootloader can need a moment before the OS finishes
    // binding the WinUSB/libusb driver; the first transfer otherwise errors.
    await sleep(150);
  }

  async close() {
    try {
      if (this.interfaceNumber != null) await this.device.releaseInterface(this.interfaceNumber);
    } catch {
      /* ignore */
    }
    try {
      if (this.device.opened) await this.device.close();
    } catch {
      /* ignore */
    }
  }

  async resetInterface() {
    await this.device.controlTransferOut({
      requestType: "vendor",
      recipient: "interface",
      request: PICOBOOT.IF_RESET,
      value: 0,
      index: this.interfaceNumber,
    });
  }

  // Query PICOBOOT command status over a control transfer. This is a robust way
  // to confirm we can actually talk to the bootloader (it does not touch the
  // bulk endpoints). Returns the parsed 16-byte status, or throws on failure.
  async getCommandStatus() {
    const r = await this.device.controlTransferIn(
      {
        requestType: "vendor",
        recipient: "interface",
        request: PICOBOOT.IF_CMD_STATUS,
        value: 0,
        index: this.interfaceNumber,
      },
      16,
    );
    if (r.status !== "ok" || !r.data || r.data.byteLength < 16) {
      throw new Error("Bootloader did not return a valid status.");
    }
    return {
      token: r.data.getUint32(0, true),
      statusCode: r.data.getUint32(4, true),
      cmdId: r.data.getUint8(8),
      inProgress: r.data.getUint8(9),
    };
  }

  // Friendly processor name for the connected bootloader, from its product id.
  get processor() {
    if (this.device.productId === 0x000f) return "rp2350";
    if (this.device.productId === 0x0003) return "rp2040";
    return null;
  }

  // Build a 32-byte PICOBOOT command packet. Returns {buf, token}.
  _packet(cmdId, transferLength, argsBytes) {
    const token = this.token++ >>> 0;
    const buf = new ArrayBuffer(CMD_PACKET_SIZE);
    const view = new DataView(buf);
    view.setUint32(0, PICOBOOT.CMD_MAGIC, true);
    view.setUint32(4, token, true);
    view.setUint8(8, cmdId);
    view.setUint8(9, argsBytes ? argsBytes.length : 0);
    view.setUint16(10, 0, true); // reserved
    view.setUint32(12, transferLength >>> 0, true);
    if (argsBytes) new Uint8Array(buf, 16).set(argsBytes);
    return { buf, token };
  }

  /**
   * Issue a PICOBOOT command. After the data stage, the protocol uses a
   * zero-length-packet ack in the opposite direction. Some bootroms (notably
   * RP2350) don't ack no-data commands the way the bulk handshake expects, so
   * if the bulk ack errors we recover the endpoint and confirm completion over
   * the control-transfer status channel instead.
   */
  async _command(cmdId, { args = null, dataOut = null, readLength = 0, name = "command" } = {}) {
    const isReadCmd = (cmdId & 0x80) !== 0;
    const transferLength = isReadCmd ? readLength : dataOut ? dataOut.length : 0;

    const { buf: packet, token } = this._packet(cmdId, transferLength, args);
    try {
      await this.device.transferOut(this.epOut, packet);
    } catch (e) {
      throw new Error(`PICOBOOT ${name}: failed to send command on EP OUT ${this.epOut} — ${e.message}`);
    }

    let result = null;
    if (isReadCmd) {
      if (readLength > 0) {
        const r = await this.device.transferIn(this.epIn, readLength);
        result = r.data;
      }
      await this._ack("out", name, token); // IN-data command -> ack is a ZLP OUT
    } else {
      if (dataOut && dataOut.length) {
        try {
          await this.device.transferOut(this.epOut, dataOut);
        } catch (e) {
          throw new Error(
            `PICOBOOT ${name}: failed to send ${dataOut.length} data bytes on EP OUT ${this.epOut} — ${e.message}`,
          );
        }
      }
      await this._ack("in", name, token); // OUT/no-data command -> ack is a ZLP IN
    }
    return result;
  }

  // Perform the command acknowledgement. Prefer the bulk ZLP; on failure fall
  // back to the control-transfer status check (and remember to skip the bulk
  // ack from then on, so we don't stall the endpoint on every command).
  async _ack(direction, name, token) {
    if (!this._skipBulkAck) {
      try {
        if (direction === "in") {
          await this.device.transferIn(this.epIn, this._ackLen);
        } else {
          await this.device.transferOut(this.epOut, new Uint8Array(0));
        }
        return;
      } catch (e) {
        this._skipBulkAck = true;
        // Clear a possible stall left on the endpoint before we continue.
        await this.device.clearHalt(direction, direction === "in" ? this.epIn : this.epOut).catch(() => {});
        await this._confirmViaStatus(name, token, e);
        return;
      }
    }
    await this._confirmViaStatus(name, token, null);
  }

  // Poll command status (control transfer) until our command (matched by token)
  // finishes.
  async _confirmViaStatus(name, token, ackErr) {
    for (let i = 0; i < 400; i++) {
      let st;
      try {
        st = await this.getCommandStatus();
      } catch (e) {
        throw new Error(
          `PICOBOOT ${name}: ack failed (${ackErr ? ackErr.message : "n/a"}) and status read failed — ${e.message}`,
        );
      }
      // Wait until our command (token) is the one reported as finished.
      if (st.inProgress === 0 && st.token === token) {
        if (st.statusCode !== 0) {
          throw new Error(`PICOBOOT ${name}: bootloader reported status code ${st.statusCode}`);
        }
        return;
      }
      await sleep(5);
    }
    throw new Error(`PICOBOOT ${name}: timed out waiting for completion`);
  }

  _u32Args(values) {
    const buf = new ArrayBuffer(values.length * 4);
    const view = new DataView(buf);
    values.forEach((v, i) => view.setUint32(i * 4, v >>> 0, true));
    return new Uint8Array(buf);
  }

  // Use plain EXCLUSIVE (not EXCLUSIVE_AND_EJECT): ejecting the mass-storage
  // volume mid-session can disrupt the USB connection and break the next
  // transfer. We never use the drive path anyway.
  async exclusiveAccess(mode = PICOBOOT.EXCLUSIVE) {
    await this._command(PICOBOOT.EXCLUSIVE_ACCESS, { args: new Uint8Array([mode]), name: "exclusive-access" });
  }

  async exitXip() {
    await this._command(PICOBOOT.EXIT_XIP, { name: "exit-xip" });
  }

  async flashErase(addr, size) {
    await this._command(PICOBOOT.FLASH_ERASE, { args: this._u32Args([addr, size]), name: "flash-erase" });
  }

  async flashWrite(addr, data) {
    await this._command(PICOBOOT.WRITE, {
      args: this._u32Args([addr, data.length]),
      dataOut: data,
      name: "flash-write",
    });
  }

  async reboot(processor, delayMs = 200) {
    if (processor === "rp2350") {
      await this._command(PICOBOOT.REBOOT2, {
        args: this._u32Args([PICOBOOT.REBOOT2_FLAG_REBOOT_TYPE_NORMAL, delayMs, 0, 0]),
        name: "reboot2",
      });
    } else {
      // RP2040 REBOOT with pc=0, sp=0 performs a normal boot from flash.
      await this._command(PICOBOOT.REBOOT, { args: this._u32Args([0, 0, delayMs]), name: "reboot" });
    }
  }

  // Human-readable description of the claimed interface and endpoints, for logs.
  describe() {
    return (
      `iface ${this.interfaceNumber}, EP IN ${this.epIn} (${this._ackLen}B), ` +
      `EP OUT ${this.epOut}, PID 0x${this.device.productId.toString(16).padStart(4, "0")}`
    );
  }

  /**
   * Erase + program a parsed UF2 image. Reports byte-level progress.
   * @param {ArrayBuffer|Uint8Array} uf2Buffer
   * @param {string} processor "rp2040" | "rp2350" (for family-id validation)
   * @param {(written:number, total:number)=>void} onProgress
   */
  async flashUf2(uf2Buffer, processor, onProgress = () => {}, onLog = () => {}) {
    const { blocks, families, totalBytes } = parseUf2(uf2Buffer);
    assertUf2MatchesProcessor(families, processor);

    const segments = coalesceBlocks(blocks);

    // Claim the flash and leave XIP.
    await this.exclusiveAccess();
    await this.exitXip();
    if (this._skipBulkAck) {
      onLog("Bulk ack not supported by this bootloader; using control-transfer status acks.");
    }

    // Erase every 4 KB sector touched by the image, each exactly once.
    const erased = new Set();
    for (const seg of segments) {
      const first = Math.floor((seg.address - FLASH_XIP_BASE) / FLASH_SECTOR_SIZE);
      const last = Math.floor((seg.address + seg.data.length - 1 - FLASH_XIP_BASE) / FLASH_SECTOR_SIZE);
      for (let s = first; s <= last; s++) {
        if (erased.has(s)) continue;
        erased.add(s);
        await this.flashErase(FLASH_XIP_BASE + s * FLASH_SECTOR_SIZE, FLASH_SECTOR_SIZE);
      }
    }

    // Program each segment in chunks.
    let written = 0;
    for (const seg of segments) {
      for (let off = 0; off < seg.data.length; off += FLASH_WRITE_CHUNK) {
        const chunk = seg.data.subarray(off, off + FLASH_WRITE_CHUNK);
        await this.flashWrite(seg.address + off, chunk);
        written += chunk.length;
        onProgress(written, totalBytes);
      }
    }

    return { totalBytes };
  }
}

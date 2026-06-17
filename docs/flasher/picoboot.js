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

export class PicobootDevice {
  /** @param {USBDevice} device */
  constructor(device) {
    this.device = device;
    this.interfaceNumber = null;
    this.epIn = null;
    this.epOut = null;
    this.token = 1;
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

    for (const ep of found.alt.endpoints) {
      if (ep.type !== "bulk") continue;
      if (ep.direction === "in") this.epIn = ep.endpointNumber;
      if (ep.direction === "out") this.epOut = ep.endpointNumber;
    }
    if (this.epIn == null || this.epOut == null) {
      throw new Error("PICOBOOT interface is missing its bulk endpoints.");
    }

    await this.resetInterface();
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

  // Build a 32-byte PICOBOOT command packet.
  _packet(cmdId, transferLength, argsBytes) {
    const buf = new ArrayBuffer(CMD_PACKET_SIZE);
    const view = new DataView(buf);
    view.setUint32(0, PICOBOOT.CMD_MAGIC, true);
    view.setUint32(4, this.token++ >>> 0, true);
    view.setUint8(8, cmdId);
    view.setUint8(9, argsBytes ? argsBytes.length : 0);
    view.setUint16(10, 0, true); // reserved
    view.setUint32(12, transferLength >>> 0, true);
    if (argsBytes) new Uint8Array(buf, 16).set(argsBytes);
    return buf;
  }

  /**
   * Issue a PICOBOOT command. Handles the data stage and the zero-length-packet
   * acknowledgement handshake in the opposite direction.
   */
  async _command(cmdId, { args = null, dataOut = null, readLength = 0 } = {}) {
    const isReadCmd = (cmdId & 0x80) !== 0;
    const transferLength = isReadCmd ? readLength : dataOut ? dataOut.length : 0;

    const packet = this._packet(cmdId, transferLength, args);
    await this.device.transferOut(this.epOut, packet);

    let result = null;
    if (isReadCmd) {
      if (readLength > 0) {
        const r = await this.device.transferIn(this.epIn, readLength);
        result = r.data;
      }
      // Acknowledge an IN-data command with a zero-length OUT packet.
      await this.device.transferOut(this.epOut, new Uint8Array(0));
    } else {
      if (dataOut && dataOut.length) {
        await this.device.transferOut(this.epOut, dataOut);
      }
      // Acknowledge an OUT/no-data command with a zero-length IN packet.
      await this.device.transferIn(this.epIn, 1);
    }
    return result;
  }

  _u32Args(values) {
    const buf = new ArrayBuffer(values.length * 4);
    const view = new DataView(buf);
    values.forEach((v, i) => view.setUint32(i * 4, v >>> 0, true));
    return new Uint8Array(buf);
  }

  async exclusiveAccess(mode = PICOBOOT.EXCLUSIVE_AND_EJECT) {
    await this._command(PICOBOOT.EXCLUSIVE_ACCESS, { args: new Uint8Array([mode]) });
  }

  async exitXip() {
    await this._command(PICOBOOT.EXIT_XIP);
  }

  async flashErase(addr, size) {
    await this._command(PICOBOOT.FLASH_ERASE, { args: this._u32Args([addr, size]) });
  }

  async flashWrite(addr, data) {
    await this._command(PICOBOOT.WRITE, {
      args: this._u32Args([addr, data.length]),
      dataOut: data,
    });
  }

  async reboot(processor, delayMs = 200) {
    if (processor === "rp2350") {
      await this._command(PICOBOOT.REBOOT2, {
        args: this._u32Args([PICOBOOT.REBOOT2_FLAG_REBOOT_TYPE_NORMAL, delayMs, 0, 0]),
      });
    } else {
      // RP2040 REBOOT with pc=0, sp=0 performs a normal boot from flash.
      await this._command(PICOBOOT.REBOOT, { args: this._u32Args([0, 0, delayMs]) });
    }
  }

  /**
   * Erase + program a parsed UF2 image. Reports byte-level progress.
   * @param {ArrayBuffer|Uint8Array} uf2Buffer
   * @param {string} processor "rp2040" | "rp2350" (for family-id validation)
   * @param {(written:number, total:number)=>void} onProgress
   */
  async flashUf2(uf2Buffer, processor, onProgress = () => {}) {
    const { blocks, families, totalBytes } = parseUf2(uf2Buffer);
    assertUf2MatchesProcessor(families, processor);

    const segments = coalesceBlocks(blocks);

    await this.exclusiveAccess();
    await this.exitXip();

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

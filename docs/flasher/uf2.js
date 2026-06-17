// Minimal UF2 parser. A UF2 file is a flat sequence of 512-byte blocks; each
// block carries up to 256 bytes of payload plus the absolute flash address to
// write it to. See https://github.com/microsoft/uf2 for the format.

import {
  UF2_MAGIC_START0,
  UF2_MAGIC_START1,
  UF2_MAGIC_END,
  UF2_FLAG_NOT_MAIN_FLASH,
  UF2_FLAG_FAMILY_ID_PRESENT,
  UF2_FAMILY,
  UF2_FAMILIES_RP2350,
} from "./constants.js";

const BLOCK_SIZE = 512;

/**
 * Parse a UF2 image.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {{blocks: {address:number, data:Uint8Array}[], families:Set<number>, totalBytes:number}}
 */
export function parseUf2(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length === 0 || bytes.length % BLOCK_SIZE !== 0) {
    throw new Error("That does not look like a UF2 file (size is not a multiple of 512 bytes).");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blocks = [];
  const families = new Set();
  let totalBytes = 0;

  for (let offset = 0; offset < bytes.length; offset += BLOCK_SIZE) {
    const start0 = view.getUint32(offset + 0, true);
    const start1 = view.getUint32(offset + 4, true);
    const end = view.getUint32(offset + BLOCK_SIZE - 4, true);
    if (start0 !== UF2_MAGIC_START0 || start1 !== UF2_MAGIC_START1 || end !== UF2_MAGIC_END) {
      throw new Error(`Corrupt UF2: bad magic in block at offset ${offset}.`);
    }

    const flags = view.getUint32(offset + 8, true);
    const targetAddr = view.getUint32(offset + 12, true);
    const payloadSize = view.getUint32(offset + 16, true);
    const familyOrFlags = view.getUint32(offset + 28, true);

    if (flags & UF2_FLAG_FAMILY_ID_PRESENT) {
      families.add(familyOrFlags >>> 0);
    }

    // Blocks flagged "not for main flash" carry metadata, not program data.
    if (flags & UF2_FLAG_NOT_MAIN_FLASH) {
      continue;
    }
    if (payloadSize > 476) {
      throw new Error(`Corrupt UF2: payload size ${payloadSize} too large in block at offset ${offset}.`);
    }

    const data = bytes.slice(offset + 32, offset + 32 + payloadSize);
    blocks.push({ address: targetAddr >>> 0, data });
    totalBytes += payloadSize;
  }

  if (blocks.length === 0) {
    throw new Error("UF2 contains no flashable data.");
  }

  blocks.sort((a, b) => a.address - b.address);
  return { blocks, families, totalBytes };
}

/**
 * Determine which processor a UF2's family ids indicate.
 * @returns {"rp2040"|"rp2350"|"universal"|null}
 */
export function uf2TargetProcessor(families) {
  const hasRp2350 = [...families].some((f) => UF2_FAMILIES_RP2350.has(f));
  if (hasRp2350) return "rp2350";
  const hasAbsolute = families.has(UF2_FAMILY.absolute);
  if (hasAbsolute) return "universal"; // accepted by both bootroms (e.g. nuke)
  if (families.has(UF2_FAMILY.rp2040)) return "rp2040";
  return null;
}

/**
 * Throw a clear error if the UF2 cannot be safely flashed to `processor`.
 * A "universal" image (e.g. the flash-nuke) is accepted on either chip.
 */
export function assertUf2MatchesProcessor(families, processor) {
  const target = uf2TargetProcessor(families);
  if (target === null) {
    throw new Error("This UF2 has no recognizable Raspberry Pi family id; refusing to flash it.");
  }
  if (target === "universal") return;
  if (target !== processor) {
    const nice = { rp2040: "Pico W (RP2040)", rp2350: "Pico 2 W (RP2350)" };
    throw new Error(
      `This firmware is built for ${nice[target] || target} but the connected board is ` +
        `${nice[processor] || processor}. Refusing to flash a mismatched image.`,
    );
  }
}

/**
 * Coalesce sorted UF2 blocks into contiguous (address, data) segments so we can
 * erase and write in large chunks instead of one 256-byte page at a time.
 * @returns {{address:number, data:Uint8Array}[]}
 */
export function coalesceBlocks(blocks) {
  const segments = [];
  let current = null;
  let chunks = [];

  const flush = () => {
    if (!current) return;
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      merged.set(c, pos);
      pos += c.length;
    }
    segments.push({ address: current.address, data: merged });
  };

  for (const block of blocks) {
    if (current && block.address === current.next) {
      chunks.push(block.data);
      current.next += block.data.length;
    } else {
      flush();
      current = { address: block.address, next: block.address + block.data.length };
      chunks = [block.data];
    }
  }
  flush();
  return segments;
}

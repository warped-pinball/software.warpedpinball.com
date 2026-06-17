// Central configuration for the Warped Pinball Vector browser flasher.
// All board-specific IDs, USB identifiers and protocol magic numbers live here
// so they are easy to find and change in one place.

export const VENDOR_ID = 0x2e8a; // Raspberry Pi (all Pico silicon + Vector firmware)

// The running Vector firmware enumerates a USB CDC serial port under the
// Raspberry Pi vendor id. We match on the vendor id alone (the ROM bootloader
// enumerates separately, see BOOTLOADER_* below), which mirrors how the desktop
// TrenchCoat tool detects boards.
export const RUNNING_USB_FILTERS = [{ usbVendorId: VENDOR_ID }];

// ROM (BOOTSEL) bootloader USB identities. The board re-enumerates as one of
// these after we reset it into the bootloader; that is the device we talk
// PICOBOOT to over WebUSB.
export const BOOTLOADER_PIDS = {
  rp2040: 0x0003, // RP2040 ROM bootloader (Pico W)
  rp2350: 0x000f, // RP2350 ROM bootloader (Pico 2 W)
};
export const BOOTLOADER_USB_FILTERS = Object.values(BOOTLOADER_PIDS).map((pid) => ({
  vendorId: VENDOR_ID,
  productId: pid,
}));

// Flash geometry, shared by RP2040 and RP2350.
export const FLASH_XIP_BASE = 0x10000000;
export const FLASH_SECTOR_SIZE = 4096; // erase granularity
export const FLASH_PAGE_SIZE = 256; // program granularity / UF2 payload size
export const FLASH_WRITE_CHUNK = 4096; // bytes per PICOBOOT WRITE command

// UF2 block magic numbers.
export const UF2_MAGIC_START0 = 0x0a324655; // "UF2\n"
export const UF2_MAGIC_START1 = 0x9e5d5157;
export const UF2_MAGIC_END = 0x0ab16f30;
export const UF2_FLAG_NOT_MAIN_FLASH = 0x00000001;
export const UF2_FLAG_FAMILY_ID_PRESENT = 0x00002000;

// UF2 family ids, used to confirm an image targets the connected processor.
export const UF2_FAMILY = {
  rp2040: 0xe48bff56,
  absolute: 0xe48bff57, // address-absolute; accepted by both bootroms (e.g. nuke)
  rp2350_arm_s: 0xe48bff59,
  rp2350_riscv: 0xe48bff5a,
  rp2350_arm_ns: 0xe48bff5b,
};
export const UF2_FAMILIES_RP2350 = new Set([
  UF2_FAMILY.rp2350_arm_s,
  UF2_FAMILY.rp2350_riscv,
  UF2_FAMILY.rp2350_arm_ns,
]);

// PICOBOOT protocol (RP2040 datasheet §2.8.5, RP2350 datasheet §5.6).
export const PICOBOOT = {
  CMD_MAGIC: 0x431fd10b,
  // Vendor interface control requests.
  IF_RESET: 0x41,
  IF_CMD_STATUS: 0x42,
  // Command ids. The 0x80 bit marks a device->host data phase.
  EXCLUSIVE_ACCESS: 0x01,
  REBOOT: 0x02,
  FLASH_ERASE: 0x03,
  READ: 0x84,
  WRITE: 0x05,
  EXIT_XIP: 0x06,
  ENTER_CMD_XIP: 0x07,
  REBOOT2: 0x0a,
  // REBOOT2 flags.
  REBOOT2_FLAG_REBOOT_TYPE_NORMAL: 0x0,
  REBOOT2_FLAG_NO_RETURN_ON_SUCCESS: 0x100,
  // EXCLUSIVE_ACCESS modes.
  EXCLUSIVE: 0x1,
  EXCLUSIVE_AND_EJECT: 0x2,
};

// Where the site serves firmware UF2 images and their manifest from.
export const FIRMWARE_BASE = "./firmware";
export const FIRMWARE_MANIFEST_URL = `${FIRMWARE_BASE}/manifest.json`;

// Where the latest production software update.json lives per product. Synced
// into the repo by scripts/generate.py so it is served same-origin (GitHub
// release downloads do not send CORS headers).
export const SOFTWARE_UPDATE_URL = (product) => `./vector/${product}/update.json`;
export const SOFTWARE_LATEST_URL = (product) => `./vector/${product}/latest.json`;

// Friendly names per detected processor.
export const PROCESSOR_BOARD_NAMES = {
  rp2040: "Pico W",
  rp2350: "Pico 2 W",
};

// Friendly labels per Vector system id.
export const SYSTEM_LABELS = {
  sys11: "System 9 / 11",
  wpc: "WPC",
  em: "EM",
  data_east: "Data East",
  whitestar: "Whitestar",
  classic: "Classic",
};

// A Pico W (RP2040) always runs the legacy System 9 / 11 firmware; it has no
// systemConfig to probe.
export const RP2040_DEFAULT_SYSTEM = "sys11";

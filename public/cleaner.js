"use strict";

window.Clearstamp = (() => {
  const ascii = (bytes, start, length) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  const viewOf = (bytes) =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (message) => {
    throw new Error(message);
  };

  function needsOrientation(bytes, start, end) {
    try {
      const little = ascii(bytes, start, 2) === "II";
      if (!little && ascii(bytes, start, 2) !== "MM") return true;
      const tiff = viewOf(bytes.subarray(start, end));
      if (tiff.getUint16(2, little) !== 42) return true;
      const directory = tiff.getUint32(4, little);
      const count = tiff.getUint16(directory, little);
      for (let index = 0; index < count; index++) {
        const item = directory + 2 + index * 12;
        if (tiff.getUint16(item, little) === 274) {
          return tiff.getUint16(item + 8, little) !== 1;
        }
      }
      return false;
    } catch {
      return true;
    }
  }

  function jpeg(bytes, start = 0) {
    const view = viewOf(bytes);
    const parts = [bytes.subarray(start, start + 2)];
    let offset = start + 2;
    let width = 0;
    let height = 0;
    let exif = false;
    let scanning = false;
    while (offset < bytes.length) {
      if (scanning) {
        const scanStart = offset;
        while (offset + 1 < bytes.length) {
          if (
            bytes[offset] === 255 &&
            bytes[offset + 1] !== 0 &&
            !(bytes[offset + 1] >= 208 && bytes[offset + 1] <= 215)
          )
            break;
          offset += bytes[offset] === 255 ? 2 : 1;
        }
        parts.push(bytes.subarray(scanStart, offset));
        scanning = false;
      }
      const markerStart = offset;
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 && width && height) {
        parts.push(bytes.subarray(markerStart, offset));
        return { parts, end: offset, width, height, exif };
      }
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      const end = offset + length;
      if (length < 2 || end > bytes.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker) &&
        length >= 8
      ) {
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
      }
      if (marker === 225 && ascii(bytes, offset + 2, 6) === "Exif\0\0") {
        exif ||= needsOrientation(bytes, offset + 8, end);
      }
      const colorProfile =
        marker === 226 && ascii(bytes, offset + 2, 12) === "ICC_PROFILE\0";
      const adobeColor =
        marker === 238 &&
        length === 14 &&
        ascii(bytes, offset + 2, 5) === "Adobe";
      if (
        !((marker >= 224 && marker <= 239) || marker === 254) ||
        colorProfile ||
        adobeColor
      ) {
        parts.push(bytes.subarray(markerStart, end));
      }
      scanning = marker === 218;
      offset = end;
    }
    fail("Invalid or unsupported JPEG.");
  }

  function png(bytes) {
    const view = viewOf(bytes);
    const parts = [bytes.subarray(0, 8)];
    const retained = new Set([
      "IHDR",
      "PLTE",
      "IDAT",
      "IEND",
      "tRNS",
      "cHRM",
      "gAMA",
      "iCCP",
      "sBIT",
      "sRGB",
      "cICP",
      "bKGD",
      "acTL",
      "fcTL",
      "fdAT",
    ]);
    let exif = false;
    let animated = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset);
      const type = ascii(bytes, offset + 4, 4);
      const end = offset + 12 + length;
      if (end > bytes.length) break;
      if (type === "eXIf")
        exif ||= needsOrientation(bytes, offset + 8, end - 4);
      if (type === "acTL") animated = true;
      if (retained.has(type) || /^[A-Z]/.test(type))
        parts.push(bytes.subarray(offset, end));
      if (type === "IEND") return { parts, exif, animated };
      offset = end;
    }
    fail("Invalid PNG.");
  }

  function webp(bytes) {
    const view = viewOf(bytes);
    const header = bytes.slice(0, 12);
    const parts = [header];
    const retained = new Set([
      "VP8 ",
      "VP8L",
      "VP8X",
      "ALPH",
      "ICCP",
      "ANIM",
      "ANMF",
    ]);
    let size = 12;
    let exif = false;
    let animated = false;
    const limit = view.getUint32(4, true) + 8;
    if (limit > bytes.length) fail("Truncated WebP.");
    let offset = 12;
    for (; offset + 8 <= limit;) {
      const type = ascii(bytes, offset, 4);
      const length = view.getUint32(offset + 4, true);
      const end = offset + 8 + length + (length % 2);
      if (end > limit) fail("Invalid WebP chunk.");
      if (type === "EXIF") {
        const prefix = ascii(bytes, offset + 8, 6) === "Exif\0\0" ? 6 : 0;
        exif ||= needsOrientation(
          bytes,
          offset + 8 + prefix,
          offset + 8 + length,
        );
      }
      if (type === "ANIM") animated = true;
      if (retained.has(type)) {
        const chunk = bytes.subarray(offset, end);
        if (type === "VP8X") {
          if (length !== 10) fail("Invalid WebP header.");
          const fixed = chunk.slice();
          fixed[8] &= ~(8 | 4);
          parts.push(fixed);
        } else if (type === "ANMF") {
          let cursor = offset + 24;
          while (cursor + 8 <= end) {
            const kind = ascii(bytes, cursor, 4);
            const count = view.getUint32(cursor + 4, true);
            if (!["ALPH", "VP8 ", "VP8L"].includes(kind))
              fail("Unsupported WebP animation chunk.");
            cursor += 8 + count + (count % 2);
          }
          if (cursor !== end) fail("Invalid WebP animation.");
          parts.push(chunk);
        } else {
          parts.push(chunk);
        }
        size += chunk.length;
      }
      offset = end;
    }
    if (offset !== limit || parts.length === 1) fail("Invalid WebP.");
    viewOf(header).setUint32(4, size - 8, true);
    return { parts, exif, animated };
  }

  const extensions = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/avif": "avif",
  };

  function imageType(bytes) {
    if (bytes[0] === 255 && bytes[1] === 216) return "image/jpeg";
    if (ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP")
      return "image/webp";
    if (bytes.length >= 16 && ascii(bytes, 4, 4) === "ftyp") {
      const end = Math.min(viewOf(bytes).getUint32(0), bytes.length, 256);
      const brands = [ascii(bytes, 8, 4)];
      for (let i = 16; i + 4 <= end; i += 4) brands.push(ascii(bytes, i, 4));
      if (brands.includes("avis")) fail("Animated AVIF is unsupported.");
      if (brands.includes("avif")) return "image/avif";
    }
    fail("Choose a valid JPEG, PNG, WebP or AVIF.");
  }

  async function encodeImage(source, target) {
    const image = await createImageBitmap(source);
    const canvas = document.createElement("canvas");
    try {
      if (image.width * image.height > 64_000_000)
        fail("This image exceeds the 64 megapixel export limit.");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d", {
        alpha: target !== "image/jpeg",
      });
      if (!context) fail("This browser could not create the export canvas.");
      if (target === "image/jpeg") {
        context.fillStyle = "white";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.drawImage(image, 0, 0);
      const result = await new Promise((resolve) =>
        canvas.toBlob(resolve, target, 0.96),
      );
      if (!result) fail("Browser image export failed.");
      return result;
    } finally {
      image.close();
      canvas.width = canvas.height = 0;
    }
  }

  async function cleanImage(bytes, options) {
    const type = imageType(bytes);
    const parser = { "image/jpeg": jpeg, "image/png": png, "image/webp": webp }[
      type
    ];
    const parsed = parser?.(bytes);
    const target = options.format === "original" ? type : options.format;
    const preserve =
      options.lossless && target === type && parsed && !parsed.exif;
    if (parsed?.animated && !preserve)
      fail(
        "Use same format and preserve quality for animated images without EXIF.",
      );
    if (preserve) {
      return {
        blob: new Blob(parsed.parts, { type }),
        ext: extensions[type],
        note: "Original image encoding preserved",
      };
    }
    const blob = await encodeImage(new Blob([bytes], { type }), target);
    const fallback = blob.type !== target;
    if (fallback && options.format !== "original")
      fail("This browser cannot export that format. Choose PNG.");
    return {
      blob,
      ext: extensions[blob.type],
      note: fallback
        ? "Exported as PNG (browser format fallback)"
        : "Exported from decoded pixels",
    };
  }

  function cleanVideo(bytes, file) {
    const view = viewOf(bytes);
    const groups = new Set(["moov", "trak", "mdia", "minf", "stbl"]);
    const removable = new Set(["udta", "meta", "XMP_", "loci", "©xyz"]);
    const metadataUUIDs = new Set([
      "be7acfcb97a942e89c71999491e3afac",
      "d8fec3d61b0e483c92975828877ec481",
    ]);
    let movie = false;
    let count = 0;
    function walk(start, limit, depth) {
      if (depth > 8) fail("Unsupported video container structure.");
      for (let offset = start; offset < limit;) {
        if (offset + 8 > limit) fail("Invalid MP4/MOV container.");
        let length = view.getUint32(offset);
        let header = 8;
        const type = ascii(bytes, offset + 4, 4);
        if (length === 1) {
          if (offset + 16 > limit) fail("Invalid extended video box.");
          length = Number(view.getBigUint64(offset + 8));
          header = 16;
        } else if (length === 0) {
          length = limit - offset;
        }
        if (
          !Number.isSafeInteger(length) ||
          length < header ||
          offset + length > limit
        )
          fail("Invalid video box size.");
        const end = offset + length;
        if (type === "moov" && depth === 0) movie = true;
        if (["mvhd", "tkhd", "mdhd"].includes(type)) {
          const start = offset + header;
          const version = bytes[start];
          const timeEnd = start + 4 + (version === 1 ? 16 : 8);
          if (version > 1 || timeEnd > end)
            fail("Invalid video timestamp fields.");
          if (bytes.subarray(start + 4, timeEnd).some(Boolean)) {
            bytes.fill(0, start + 4, timeEnd);
            count++;
          }
        }
        if (type === "cmov")
          fail("Compressed QuickTime headers are unsupported.");
        const uuid =
          type === "uuid" && length >= header + 16
            ? Array.from(
                bytes.subarray(offset + header, offset + header + 16),
                (byte) => byte.toString(16).padStart(2, "0"),
              ).join("")
            : "";
        if (removable.has(type) || metadataUUIDs.has(uuid)) {
          bytes.set([102, 114, 101, 101], offset + 4);
          bytes.fill(0, offset + header, end);
          count++;
        } else if (groups.has(type)) {
          walk(offset + header, end, depth + 1);
        }
        offset = end;
      }
    }
    walk(0, bytes.length, 0);
    if (!movie) fail("Choose a valid MP4 or MOV with a movie header.");
    const ext = /\.mov$/i.test(file.name) ? "mov" : "mp4";
    return {
      blob: new Blob([bytes], {
        type: ext === "mov" ? "video/quicktime" : "video/mp4",
      }),
      ext,
      note: count
        ? `${count} metadata ${count === 1 ? "box" : "boxes"} cleared · original tracks preserved`
        : "No supported metadata boxes found",
    };
  }

  async function cleanPDF(bytes) {
    const { PDFDocument, PDFDict, PDFName } = window.PDFLib;
    if (!/%PDF-/.test(ascii(bytes, 0, 32))) fail("Choose a valid PDF.");
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const metadata = PDFName.of("Metadata");
    const remove = new Set();
    if (pdf.context.trailerInfo.Info) remove.add(pdf.context.trailerInfo.Info);
    delete pdf.context.trailerInfo.Info;
    delete pdf.context.trailerInfo.ID;
    for (const [, object] of pdf.context.enumerateIndirectObjects()) {
      const dict = object instanceof PDFDict ? object : object.dict;
      const entry = dict?.get(metadata);
      if (entry) {
        if (entry instanceof window.PDFLib.PDFRef) remove.add(entry);
        dict.delete(metadata);
      }
    }
    for (const ref of remove) pdf.context.delete(ref);
    const result = await pdf.save({
      addDefaultPage: false,
      updateFieldAppearances: false,
    });
    return {
      blob: new Blob([result], { type: "application/pdf" }),
      ext: "pdf",
      note: "Document properties and XML metadata cleared",
    };
  }

  async function cleanRAW(bytes) {
    let largest;
    for (let i = 0; i + 3 < bytes.length; i++) {
      if (bytes[i] !== 255 || bytes[i + 1] !== 216 || bytes[i + 2] !== 255)
        continue;
      let candidate;
      try {
        candidate = jpeg(bytes, i);
      } catch {
        continue;
      }
      if (
        !largest ||
        candidate.width * candidate.height > largest.width * largest.height
      ) {
        largest = { ...candidate, start: i };
      }
      i = candidate.end - 1;
    }
    if (!largest) fail("This RAW file has no readable embedded JPEG preview.");
    const preview = bytes.subarray(largest.start, largest.end);
    const result = await cleanImage(preview, {
      format: "original",
      lossless: true,
    });
    return { ...result, note: "Clean JPEG exported from the embedded preview" };
  }

  async function clean(file, mode, options, onStage) {
    await onStage?.(0);
    const bytes = new Uint8Array(await file.arrayBuffer());
    await onStage?.(1);
    if (mode === "image") return cleanImage(bytes, options);
    if (mode === "video") return cleanVideo(bytes, file);
    if (mode === "pdf") return cleanPDF(bytes);
    if (mode === "raw") return cleanRAW(bytes);
    fail("Unknown cleaning mode.");
  }

  return { clean };
})();

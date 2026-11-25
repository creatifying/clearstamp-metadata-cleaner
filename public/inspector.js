"use strict";

window.ImageInspector = (() => {
  const element = (id) => document.getElementById(id);
  const dialog = element("inspect-dialog");
  const status = element("inspect-status");
  const result = element("inspect-result");
  const groupNames = {
    exif: "EXIF",
    gps: "GPS location",
    xmp: "XMP",
    iptc: "IPTC",
    pngText: "PNG text",
    file: "File details",
    pngFile: "PNG details",
    riff: "WebP details",
    tiff: "TIFF",
  };
  const generator =
    /\b(?:DALL[ -]?E|Midjourney|Stable Diffusion|Automatic1111|ComfyUI|Adobe Firefly|Google Imagen|Nano Banana|FLUX\.1|OpenAI Image Generation)\b/i;
  let report;
  let requestId = 0;

  function display(value) {
    if (value == null || typeof value === "function") return "";
    if (typeof value === "object") {
      try {
        return JSON.stringify(value).slice(0, 2400);
      } catch {
        return "";
      }
    }
    return String(value).slice(0, 2400);
  }

  function groupsFrom(tags) {
    const groups = {};
    for (const [key, name] of Object.entries(groupNames)) {
      const entries = Object.entries(tags[key] || {}).filter(
        ([label]) => !label.startsWith("_"),
      );
      const rows = entries
        .map(([label, tag]) => [
          label,
          typeof tag === "object" && tag !== null
            ? display(tag.description ?? tag.value ?? tag)
            : display(tag),
        ])
        .filter(([, value]) => value.trim());
      if (rows.length) groups[name] = Object.fromEntries(rows);
    }
    return groups;
  }

  function credentialMarker(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const text = (start, length) =>
      String.fromCharCode(...bytes.subarray(start, start + length));
    if (bytes[0] === 255 && bytes[1] === 216) {
      for (let i = 2; i + 4 <= bytes.length && bytes[i] === 255;) {
        while (bytes[i + 1] === 255) i++;
        const type = bytes[i + 1];
        if (type === 218 || type === 217 || i + 4 > bytes.length) break;
        const size = view.getUint16(i + 2);
        if (size < 2 || i + 2 + size > bytes.length) break;
        if (type === 235 && size >= 20 && text(i + 4, 2) === "JP") {
          const header = new TextDecoder().decode(
            bytes.subarray(i + 4, Math.min(i + 2 + size, i + 260)),
          );
          if (header.includes("jumb") && header.includes("c2pa")) return true;
        }
        i += 2 + size;
      }
    } else if (text(1, 3) === "PNG") {
      for (let i = 8; i + 12 <= bytes.length;) {
        if (text(i + 4, 4) === "caBX") return true;
        i += 12 + view.getUint32(i);
      }
    } else if (text(0, 4) === "RIFF" && text(8, 4) === "WEBP") {
      for (let i = 12; i + 8 <= bytes.length;) {
        if (text(i, 4) === "C2PA") return true;
        const size = view.getUint32(i + 4, true);
        i += 8 + size + (size % 2);
      }
    } else if (text(4, 4) === "ftyp") {
      for (let i = 0; i + 8 <= bytes.length;) {
        const size = view.getUint32(i);
        if (size < 8 || i + size > bytes.length) break;
        if (
          text(i + 4, 4) === "uuid" &&
          size >= 24 &&
          Array.from(bytes.subarray(i + 8, i + 24), (n) =>
            n.toString(16).padStart(2, "0"),
          ).join("") === "d8fec3d61b0e483c92975828877ec481"
        )
          return true;
        i += size;
      }
    }
    return false;
  }

  function analyze(groups, buffer) {
    const signals = new Set();
    for (const group of ["EXIF", "XMP", "IPTC", "PNG text"]) {
      for (const [name, value] of Object.entries(groups[group] || {})) {
        const source = value.match(
          /(?:trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia)/i,
        );
        const nameMatch = value.match(generator);
        if (source && /digital.?source.?type/i.test(name)) {
          signals.add(`Declared AI digital source type · ${group}`);
        }
        if (
          nameMatch &&
          /software|creator.?tool|generator|source|model|processing.?software/i.test(
            name,
          )
        ) {
          signals.add(`${nameMatch[0]} in ${group} · ${name}`);
        }
        if (
          /(?:^|[\n,])\s*(?:Steps|Sampler|CFG scale|Seed):/i.test(value) &&
          (value.match(/(?:Steps|Sampler|CFG scale|Seed):/gi) || []).length >= 2
        ) {
          signals.add(`Generation settings in ${group} · ${name}`);
        }
        if (
          group === "PNG text" &&
          /^(prompt|workflow)$/i.test(name) &&
          /"(?:class_type|KSampler|CLIPTextEncode)"\s*:/i.test(value)
        ) {
          signals.add("ComfyUI-style workflow in PNG text");
        }
      }
    }
    return { signals: [...signals], credential: credentialMarker(buffer) };
  }

  function render(data) {
    element("inspect-name").textContent = data.name;
    const { signals, credential } = data;
    element("verdict").dataset.signals = String(signals.length > 0);
    element("verdict-title").textContent = signals.length
      ? "Embedded AI signals found"
      : "No embedded AI signals found";
    element("verdict-text").textContent = signals.length
      ? "These tags suggest AI generation or editing. Metadata can be changed."
      : "Image origin is undetermined. AI-generated images can have no readable tags.";
    const list = element("verdict-signals");
    list.replaceChildren();
    for (const signal of [
      ...signals,
      ...(credential
        ? ["Content Credentials marker found · signature not verified"]
        : []),
    ]) {
      const item = document.createElement("li");
      item.textContent = signal;
      list.append(item);
    }
    const target = element("inspect-tags");
    target.replaceChildren();
    for (const [name, rows] of Object.entries(data.groups)) {
      const section = document.createElement("details");
      section.open = name === "EXIF" || name === "GPS location";
      const heading = document.createElement("summary");
      heading.textContent = `${name} · ${Object.keys(rows).length} fields`;
      const entries = document.createElement("dl");
      for (const [label, value] of Object.entries(rows)) {
        const key = document.createElement("dt");
        const text = document.createElement("dd");
        key.textContent = label;
        text.textContent = value;
        entries.append(key, text);
      }
      section.append(heading, entries);
      target.append(section);
    }
    if (target.childElementCount === 0)
      target.textContent = "No readable tags found.";
    result.hidden = false;
  }

  async function inspect(file, name = file.name) {
    const id = ++requestId;
    if (!dialog.open) dialog.showModal();
    report = null;
    result.hidden = true;
    status.textContent = "Reading metadata…";
    try {
      if (!file.size || file.size > 50 * 1024 * 1024)
        throw new Error("Choose a non-empty image up to 50 MB.");
      const buffer = await file.arrayBuffer();
      const tags = await ExifReader.load(buffer, {
        expanded: true,
        async: true,
      });
      if (id !== requestId) return;
      const groups = groupsFrom(tags);
      report = { name, groups, ...analyze(groups, buffer) };
      render(report);
      status.textContent = "Inspection complete.";
    } catch (error) {
      if (id !== requestId) return;
      status.textContent =
        error.name === "UnsupportedFormatError"
          ? "This image format could not be read."
          : error.message || "Unable to inspect this image.";
    }
  }

  element("inspect-copy").addEventListener("click", () => {
    if (!report) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "clearstamp-metadata-report.json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });

  return { inspect };
})();

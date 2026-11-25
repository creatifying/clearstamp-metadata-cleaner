"use strict";

const get = (id) => document.getElementById(id);
const limits = { image: 50, video: 200, pdf: 50, raw: 100 };
const modes = {
  image: {
    title: "Drop images here",
    formats: "JPG, PNG, WebP, AVIF",
    accept: ".jpg,.jpeg,.png,.webp,.avif",
  },
  video: {
    title: "Drop videos here",
    formats: "MP4, MOV",
    accept: ".mp4,.mov",
    note: "Clears common container tags. Embedded data tracks and encoder-level markers may remain.",
  },
  pdf: {
    title: "Drop PDFs here",
    formats: "PDF",
    accept: ".pdf",
    note: "Clears document properties and XML metadata. Page content, attachments and embedded images are retained.",
  },
  raw: {
    title: "Drop RAW photos here",
    formats: "CR2, CR3, NEF, ARW, DNG and more",
    accept: ".cr2,.cr3,.nef,.arw,.dng,.raf,.orf,.rw2,.pef,.srw,.raw",
    note: "Exports a clean JPEG from the best embedded preview. The original RAW file stays intact.",
  },
};
const controls = [...document.querySelectorAll("[data-mode]")];
const input = get("files");
const records = [];
let mode = "image";
let busy = false;

function say(message) {
  get("status").textContent = message;
}

function refreshOutputNames() {
  const pattern = get("filename").value.trim() || "{name}-clean";
  const used = new Set();
  for (const [index, record] of records.entries()) {
    if (!record.blob) continue;
    const original = record.file.name.replace(/\.[^.]+$/, "");
    const expanded = pattern.replace(/\{name\}|\{n\}/g, (token) =>
      token === "{name}" ? original : String(index + 1),
    );
    const extension = `.${record.extension}`;
    const stem =
      Array.from(
        expanded
          .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_")
          .replace(/^\.+|[. ]+$/g, ""),
      )
        .slice(0, 56)
        .join("") || "file";
    const base = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)
      ? `_${stem}`
      : stem;
    let unique = base + extension;
    for (let suffix = 2; used.has(unique.toLowerCase()); suffix++) {
      unique = `${base}-${suffix}${extension}`;
    }
    used.add(unique.toLowerCase());
    record.outputName = unique;
  }
}

function update() {
  refreshOutputNames();
  const items = get("items");
  items.replaceChildren();
  for (const record of records) {
    const row = document.createElement("li");
    const info = document.createElement("div");
    const name = document.createElement("strong");
    const caption = document.createElement("small");
    name.textContent = record.file.name;
    caption.textContent =
      record.note ||
      `${(record.file.size / 1024 / 1024).toFixed(2)} MB · Ready`;
    info.append(name, caption);
    row.append(info);
    const rowActions = document.createElement("div");
    rowActions.className = "row-actions";
    if (mode === "image" && !busy) {
      const addInspection = (label, file, filename) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", () => {
          void ImageInspector.inspect(file, filename);
        });
        rowActions.append(button);
      };
      addInspection("Inspect original", record.file, record.file.name);
      if (record.blob)
        addInspection("Inspect cleaned", record.blob, record.outputName);
    }
    if (record.url) {
      const anchor = document.createElement("a");
      anchor.href = record.url;
      anchor.download = record.outputName;
      anchor.textContent = "Download";
      anchor.setAttribute("aria-label", `Download ${record.outputName}`);
      rowActions.append(anchor);
    }
    row.append(rowActions);
    items.append(row);
  }
  get("queue").hidden = records.length === 0;
  get("zip").hidden = records.filter((record) => record.blob).length < 2;
  for (const control of [
    ...controls,
    get("browse"),
    get("run"),
    get("clear"),
    get("zip"),
    get("format"),
    get("filename"),
  ]) {
    control.disabled = busy;
  }
  get("lossless").disabled = busy || get("format").value !== "original";
}

function reset() {
  for (const { url } of records) if (url) URL.revokeObjectURL(url);
  records.length = 0;
  get("processing").hidden = true;
  input.value = "";
  say("");
}

function chooseMode(value) {
  if (busy || (mode === value && input.accept)) return;
  reset();
  mode = value;
  const settings = modes[mode];
  for (const control of controls)
    control.setAttribute("aria-pressed", String(control.dataset.mode === mode));
  input.accept = settings.accept;
  get("drop-title").textContent = settings.title;
  get("formats").textContent =
    `${settings.formats} · up to ${limits[mode]} MB each`;
  get("mode-note").textContent = settings.note || "";
  get("options").hidden = mode !== "image";
  update();
}

function addFiles(files) {
  if (busy) return;
  const errors = [];
  const extensions = modes[mode].accept.split(",");
  let batchSize = records.reduce((sum, record) => sum + record.file.size, 0);
  for (const file of files) {
    const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];
    if (!extensions.includes(extension)) {
      errors.push(`${file.name} does not match this tool.`);
    } else if (!file.size || file.size > limits[mode] * 1024 * 1024) {
      errors.push(
        `${file.name} is empty or exceeds the ${limits[mode]} MB limit.`,
      );
    } else if (
      records.length >= 30 ||
      batchSize + file.size > 250 * 1024 * 1024
    ) {
      errors.push("This batch reached the 30-file or 250 MB browser limit.");
      break;
    } else {
      records.push({ file });
      batchSize += file.size;
    }
  }
  update();
  say(errors.join(" "));
}

input.addEventListener("change", () => {
  addFiles(input.files);
  input.value = "";
});
get("browse").addEventListener("click", () => input.click());
for (const control of controls)
  control.addEventListener("click", () => chooseMode(control.dataset.mode));
get("instagram-tool").addEventListener("click", () => chooseMode("image"));
for (const link of document.querySelectorAll("[data-open-mode]")) {
  link.addEventListener("click", () => chooseMode(link.dataset.openMode));
}
get("format").addEventListener("change", update);
get("filename").addEventListener("input", update);
get("clear").addEventListener("click", () => {
  reset();
  update();
});
const drop = get("drop");
for (const type of ["dragenter", "dragover"])
  drop.addEventListener(type, (event) => {
    event.preventDefault();
    if (!busy) drop.classList.add("drag");
  });
drop.addEventListener("dragleave", (event) => {
  if (!drop.contains(event.relatedTarget)) drop.classList.remove("drag");
});
drop.addEventListener("drop", (event) => {
  event.preventDefault();
  drop.classList.remove("drag");
  addFiles(event.dataTransfer.files);
});
window.addEventListener("dragover", (event) => {
  if (Array.from(event.dataTransfer.types).includes("Files"))
    event.preventDefault();
});
window.addEventListener("drop", (event) => {
  if (event.dataTransfer.files.length) event.preventDefault();
});

const stageTitles = ["Reading file", "Cleaning metadata", "Preparing download"];
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

async function showStage(stage, index, filename) {
  const panel = get("processing");
  panel.hidden = false;
  panel.classList.add("is-working");
  get("processing-title").textContent = stageTitles[stage];
  get("processing-file").textContent = filename;
  get("processing-progress").value =
    ((index + stage / 3) / records.length) * 100;
  for (const [step, item] of [...get("processing-steps").children].entries()) {
    item.dataset.state = step === stage ? "active" : step < stage ? "done" : "";
  }
  const delay = !reducedMotion.matches && records.length <= 3 ? 155 : 0;
  await new Promise((resolve) => setTimeout(resolve, delay));
}

get("run").addEventListener("click", async () => {
  busy = true;
  update();
  const options = {
    format: get("format").value,
    lossless: get("lossless").checked,
  };
  let success = 0;
  try {
    for (const [index, record] of records.entries()) {
      say(`Cleaning ${index + 1} of ${records.length}…`);
      if (record.url) URL.revokeObjectURL(record.url);
      delete record.url;
      delete record.blob;
      try {
        const stage = (step) => showStage(step, index, record.file.name);
        const result = await Clearstamp.clean(
          record.file,
          mode,
          options,
          stage,
        );
        await stage(2);
        record.blob = result.blob;
        record.url = URL.createObjectURL(result.blob);
        record.extension = result.ext;
        record.note = result.note;
        success++;
      } catch (error) {
        record.note =
          error instanceof Error ? error.message : "Could not clean this file.";
      }
      update();
    }
    get("processing-title").textContent =
      success === records.length ? "Cleaning complete" : "Batch finished";
    get("processing-file").textContent =
      `${success} of ${records.length} files ready`;
    get("processing-progress").value = 100;
    for (const item of get("processing-steps").children) {
      item.dataset.state = success === records.length ? "done" : "";
    }
    say(`${success} of ${records.length} files ready to download.`);
  } finally {
    get("processing").classList.remove("is-working");
    busy = false;
    update();
  }
});

get("zip").addEventListener("click", async () => {
  busy = true;
  update();
  say("Preparing ZIP…");
  try {
    const zipped = Object.create(null);
    for (const record of records.filter((item) => item.blob)) {
      zipped[record.outputName] = new Uint8Array(
        await record.blob.arrayBuffer(),
      );
    }
    const bytes = await new Promise((resolve, reject) =>
      fflate.zip(zipped, { level: 0 }, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }),
    );
    const url = URL.createObjectURL(
      new Blob([bytes], { type: "application/zip" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "clearstamp-clean-files.zip";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    say("ZIP download started.");
  } catch {
    say("ZIP creation failed. Individual downloads are still available.");
  } finally {
    busy = false;
    update();
  }
});

chooseMode("image");

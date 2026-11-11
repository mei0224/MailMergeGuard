/* MailMerge Guard — browser-only PDF splitting + recipient verification.
   Runtime dependencies: PDF-Lib, Papa Parse, JSZip, Mozilla PDF.js.
   No selected input files are intentionally sent to a server by this code. */
"use strict";

const PDFJS_MODULE = "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.7.284/build/pdf.mjs";
const PDFJS_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.7.284/build/pdf.worker.mjs";
const MAX_PDF_SIZE = 20 * 1024 * 1024;
const MAX_CSV_SIZE = 1 * 1024 * 1024;
const MAX_PAGES = 250;
const MAX_RECORDS = 250;

const els = Object.fromEntries([
    "pdfInput", "csvInput", "pdfHint", "csvHint", "filenameColumn", "verifyColumn", "pagesPer",
    "prefix", "verifyToggle", "analyzeBtn", "status", "demoBtn", "resultsPanel", "resultRows",
    "resultCount", "totalCount", "matchedCount", "reviewCount", "resultsIntro", "reviewArea",
    "reviewConfirm", "downloadZipBtn", "downloadReportBtn", "previewDialog", "previewCanvas",
    "previewTitle", "previewSubtitle", "closePreview"
].map(id => [id, document.getElementById(id)]));

let selectedPdf = null;
let selectedCsv = null;
let csvParsed = null;
let analysis = null;
let pdfjsLib = null;
let pdfjsDoc = null;
let busy = false;

function status(message, kind = "") {
    els.status.textContent = message;
    els.status.className = `status ${kind}`.trim();
}

function hideAnalysis() {
    analysis = null;
    els.resultsPanel.hidden = true;
    els.reviewConfirm.checked = false;
    els.downloadZipBtn.disabled = true;
}

function assertFile(file, type) {
    if (!file) throw new Error(`Choose a ${type.toUpperCase()} file first.`);
    if (!new RegExp(`\\.${type}$`, "i").test(file.name)) {
        throw new Error(`The file must have a .${type} extension.`);
    }
    if (!file.size) throw new Error(`${type.toUpperCase()} file is empty.`);
    if (file.size > (type === "pdf" ? MAX_PDF_SIZE : MAX_CSV_SIZE)) {
        throw new Error(`${type.toUpperCase()} file is too large (${type === "pdf" ? "20 MB" : "1 MB"} maximum).`);
    }
}

function safeName(value) {
    // Strip path separators, control characters, Windows-reserved characters,
    // trailing dots/spaces, and reserved device names. Do not silently accept an empty name.
    let result = String(value ?? "")
        .normalize("NFKC")
        .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, "_")
        .replace(/\s+/g, " ")
        .trim().replace(/^[. ]+|[. ]+$/g, "")
        .slice(0, 105).replace(/[. ]+$/g, "");
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(result)) result = "file_" + result;
    return result;
}

function nameInText(name, text) {
    const compact = str => String(str ?? "").normalize("NFKC").toLocaleLowerCase("en")
        .replace(/[\s\u00a0.,·•:;\u200b\u200c\u200d]/g, "");
    const target = compact(name);
    return target.length >= 3 && compact(text).includes(target);
}

function cleanCsvReportValue(value) {
    const s = String(value ?? "");
    // Formula values must not become executable when report opened in spreadsheets.
    return /^[\s\uFEFF]*[=+\-@]/u.test(s) || /^[\t\r\n]/u.test(s) ? "'" + s : s;
}

function createCsvReport(rows) {
    const header = ["Row", "Filename", "Recipient", "PDF Pages", "Check Result", "Details"];
    const records = rows.map(record => [
        record.index + 1, record.filename + ".pdf", record.recipient,
        `${record.start + 1}-${record.end + 1}`, record.code, record.details
    ].map(cleanCsvReportValue));
    return "\uFEFF" + Papa.unparse([header, ...records], {quotes: true, newline: "\r\n", escapeFormulae: true});
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function parseCsvString(source) {
    if (typeof Papa === "undefined") throw new Error("CSV library failed to load. Connect to the internet and reload the page.");
    const parsed = Papa.parse(source.replace(/^\uFEFF/, ""), {
        header: false, delimiter: ",", dynamicTyping: false, skipEmptyLines: "greedy"
    });
    if (parsed.errors.length) {
        const error = parsed.errors[0];
        throw new Error(`Invalid CSV near row ${(error.row ?? 0) + 1}: ${error.message}`);
    }
    if (parsed.data.length < 2) throw new Error("CSV needs a header row and at least one recipient.");
    const headers = parsed.data[0].map(v => String(v).trim());
    if (headers.some(v => !v)) throw new Error("Every CSV column must have a header.");
    if (new Set(headers.map(v => v.toLowerCase())).size !== headers.length) throw new Error("CSV headers must be unique.");
    const rows = parsed.data.slice(1);
    if (rows.length > MAX_RECORDS) throw new Error(`Maximum ${MAX_RECORDS} recipients per job.`);
    for (let i = 0; i < rows.length; i++) {
        if (rows[i].length !== headers.length) {
            throw new Error(`CSV row ${i + 2} has ${rows[i].length} columns; expected ${headers.length}.`);
        }
    }
    return {headers, rows};
}

function refreshColumns() {
    const headers = csvParsed?.headers ?? [];
    for (const field of [els.filenameColumn, els.verifyColumn]) {
        field.replaceChildren();
        for (let i = 0; i < headers.length; i++) {
            const opt = document.createElement("option");
            opt.value = String(i);
            opt.textContent = headers[i];
            field.appendChild(opt);
        }
        if (!headers.length) {
            const opt = document.createElement("option");
            opt.textContent = "Upload a CSV first";
            field.appendChild(opt);
        }
        field.disabled = !headers.length;
    }
    if (headers.length) {
        const preferred = headers.findIndex(h => /^(name|recipient|fullname|full name|student name)$/i.test(h));
        els.filenameColumn.value = String(preferred < 0 ? 0 : preferred);
        els.verifyColumn.value = els.filenameColumn.value;
    }
}

async function selectCsv(file) {
    hideAnalysis();
    selectedCsv = file;
    csvParsed = null;
    els.csvHint.textContent = file ? file.name : "With a header row · Up to 1 MB";
    if (!file) { refreshColumns(); return; }
    try {
        assertFile(file, "csv");
        csvParsed = parseCsvString(await file.text());
        refreshColumns();
        status(`CSV ready: ${csvParsed.rows.length} recipients.`, "success");
    } catch (error) {
        refreshColumns();
        status(error.message, "error");
    }
}

function selectPdf(file) {
    hideAnalysis();
    selectedPdf = file;
    els.pdfHint.textContent = file ? file.name : "Multi-page PDF · Up to 20 MB";
    if (file) {
        try { assertFile(file, "pdf"); status("PDF ready. Analyze when both files are selected."); }
        catch (error) { status(error.message, "error"); }
    }
}

async function getPdfJs() {
    if (!pdfjsLib) {
        try {
            pdfjsLib = await import(PDFJS_MODULE);
            pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        } catch (error) {
            pdfjsLib = null;
            throw new Error("PDF text library could not load. Connect to the internet and reload the page.");
        }
    }
    return pdfjsLib;
}

function buildRecords(pageCount, opts) {
    const {rows} = csvParsed;
    const {pagesPer, filenameIndex, verifyIndex, prefix, verify} = opts;
    if (pageCount !== pagesPer * rows.length) {
        throw new Error(`Page count mismatch: PDF has ${pageCount} pages, but ${rows.length} CSV rows × ${pagesPer} pages = ${rows.length * pagesPer} pages. Check your input order and pages-per-person value.`);
    }
    const filenames = new Set();
    return rows.map((row, index) => {
        const namePart = safeName(row[filenameIndex]);
        const pref = safeName(prefix);
        if (!namePart) throw new Error(`CSV row ${index + 2} has an empty or invalid filename value.`);
        const filename = safeName(pref + namePart);
        if (!filename) throw new Error(`CSV row ${index + 2} would create an empty filename.`);
        const identifier = filename.toLocaleLowerCase("en");
        if (filenames.has(identifier)) {
            throw new Error(`Duplicate filename "${filename}.pdf" after cleanup. Give every recipient a unique value before exporting.`);
        }
        filenames.add(identifier);
        const recipient = String(row[verifyIndex] ?? "").trim();
        return {
            index, filename, recipient, start: index * pagesPer, end: (index + 1) * pagesPer - 1,
            code: verify ? "pending" : "not_checked",
            details: verify ? "Not analyzed yet" : "Name checking turned off"
        };
    });
}

async function analyze() {
    if (busy) return;
    hideAnalysis();
    busy = true;
    els.analyzeBtn.disabled = true;
    try {
        assertFile(selectedPdf, "pdf");
        assertFile(selectedCsv, "csv");
        if (!csvParsed) throw new Error("Your CSV could not be read. Select a valid CSV file.");
        if (typeof PDFLib === "undefined") throw new Error("PDF library failed to load. Check your internet connection and reload the page.");
        if (typeof JSZip === "undefined") throw new Error("ZIP library could not load.");
        const pagesPer = Number(els.pagesPer.value);
        if (!Number.isInteger(pagesPer) || pagesPer < 1 || pagesPer > 20) {
            throw new Error("Pages per person must be a whole number between 1 and 20.");
        }
        const opts = {
            pagesPer,
            filenameIndex: Number(els.filenameColumn.value), verifyIndex: Number(els.verifyColumn.value),
            prefix: els.prefix.value, verify: els.verifyToggle.checked
        };
        status("Reading the PDF…");
        const bytes = await selectedPdf.arrayBuffer();
        const pdfjs = await getPdfJs();
        if (pdfjsDoc) { try { await pdfjsDoc.destroy(); } catch (_) {} pdfjsDoc = null; }
        const pdfjsTask = pdfjs.getDocument({data: new Uint8Array(bytes.slice(0)), isEvalSupported: false});
        pdfjsDoc = await pdfjsTask.promise;
        const pageCount = pdfjsDoc.numPages;
        if (pageCount > MAX_PAGES) throw new Error(`This PDF contains ${pageCount} pages; limit is ${MAX_PAGES}.`);
        // PDF-Lib must be able to split the document before any results can be accepted.
        const pdf = await PDFLib.PDFDocument.load(new Uint8Array(bytes.slice(0)), {updateMetadata:false});
        if (pdf.getPageCount() !== pageCount) throw new Error("The PDF page counts differ between readers; this file is unsupported.");
        const records = buildRecords(pageCount, opts);
        let countOk = 0;
        let countWarn = 0;
        if (opts.verify) {
            for (let i = 0; i < records.length; i++) {
                const record = records[i];
                if (!record.recipient) {
                    record.code = "missing_name";
                    record.details = "Recipient field is empty";
                } else {
                    try {
                        const page = await pdfjsDoc.getPage(record.start + 1);
                        const content = await page.getTextContent();
                        const extracted = content.items.map(item => item.str || "").join(" ").trim();
                        page.cleanup();
                        if (!extracted) {
                            record.code = "unreadable";
                            record.details = "No searchable text (possibly a scanned page)";
                        } else if (nameInText(record.recipient, extracted)) {
                            record.code = "found";
                            record.details = "Name text found on first page";
                        } else {
                            record.code = "not_found";
                            record.details = "Name not found on first page — verify visually";
                        }
                    } catch (_) {
                        record.code = "unreadable";
                        record.details = "Could not extract text — check visually";
                    }
                }
                if (record.code === "found") countOk++; else countWarn++;
                if (i % 6 === 0 || i === records.length - 1) {
                    status(`Checking names… ${i + 1} of ${records.length}`);
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
        } else {
            countWarn = records.length;
        }
        analysis = {bytes, pageCount, records, warningCount: countWarn};
        renderResults(analysis, countOk);
        status(countWarn ? `Ready: ${countWarn} document(s) require review before export.` : "All name text checks passed. Review before distributing.", countWarn ? "" : "success");
    } catch (error) {
        hideAnalysis();
        status(error.message || "Unable to analyze files.", "error");
    } finally {
        busy = false;
        els.analyzeBtn.disabled = false;
    }
}

function renderResults(data, countOk) {
    els.resultsPanel.hidden = false;
    els.resultCount.textContent = `${data.pageCount} PDF pages`;
    els.totalCount.textContent = String(data.records.length);
    els.matchedCount.textContent = String(countOk);
    els.reviewCount.textContent = String(data.warningCount);
    els.resultsIntro.textContent = data.warningCount
        ? "Review each warning and preview pages before exporting. Name detection is a helpful check, not proof of identity."
        : "No name text mismatches detected. Still review documents before sending to recipients.";
    els.resultRows.replaceChildren();
    for (const record of data.records) {
        const tr = document.createElement("tr");
        const fields = [String(record.index + 1), record.filename + ".pdf", `${record.start + 1}–${record.end + 1}`];
        for (const field of fields) {
            const td = document.createElement("td"); td.textContent = field; tr.appendChild(td);
        }
        const statusCell = document.createElement("td");
        const pill = document.createElement("span");
        const isOk = record.code === "found";
        pill.className = `pill ${isOk ? "ok" : record.code === "not_checked" ? "off" : "warn"}`;
        pill.textContent = isOk ? "Name found" : record.code === "not_found" ? "Not found" : record.code === "unreadable" ? "Unreadable" : record.code === "missing_name" ? "Missing name" : "Not checked";
        pill.title = record.details;
        statusCell.appendChild(pill); tr.appendChild(statusCell);
        const previewCell = document.createElement("td");
        const btn = document.createElement("button");
        btn.className = "mini-button"; btn.type = "button"; btn.textContent = "View page";
        btn.addEventListener("click", () => previewPage(record));
        previewCell.appendChild(btn); tr.appendChild(previewCell);
        els.resultRows.appendChild(tr);
    }
    els.reviewArea.hidden = data.warningCount === 0;
    els.reviewConfirm.checked = false;
    els.downloadZipBtn.disabled = data.warningCount > 0;
    els.resultsPanel.scrollIntoView({behavior: "smooth", block: "start"});
}

async function previewPage(record) {
    if (!pdfjsDoc || !analysis) return;
    els.previewTitle.textContent = `Recipient ${record.index + 1}: ${record.filename}.pdf`;
    els.previewSubtitle.textContent = `PDF page ${record.start + 1}${record.end !== record.start ? ` (first of ${record.end - record.start + 1} pages)` : ""} — ${record.details}`;
    els.previewDialog.showModal();
    try {
        const page = await pdfjsDoc.getPage(record.start + 1);
        const natural = page.getViewport({scale: 1});
        const scale = Math.min(1.6, 1350 / Math.max(natural.width, natural.height));
        const viewport = page.getViewport({scale});
        const canvas = els.previewCanvas;
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({canvas, canvasContext: canvas.getContext("2d"), viewport}).promise;
    } catch (error) {
        els.previewSubtitle.textContent = "Preview could not be rendered. Do not assume this document is verified.";
    }
}

async function downloadZip() {
    if (!analysis || busy || (analysis.warningCount && !els.reviewConfirm.checked)) return;
    busy = true;
    els.downloadZipBtn.disabled = true;
    try {
        status("Creating individual PDF files in your browser…");
        const src = await PDFLib.PDFDocument.load(new Uint8Array(analysis.bytes.slice(0)), {updateMetadata:false});
        const zip = new JSZip();
        for (let i = 0; i < analysis.records.length; i++) {
            const item = analysis.records[i];
            const doc = await PDFLib.PDFDocument.create();
            const indexes = Array.from({length: item.end - item.start + 1}, (_, off) => item.start + off);
            const pages = await doc.copyPages(src, indexes);
            for (const page of pages) doc.addPage(page);
            const output = await doc.save({useObjectStreams:true});
            zip.file(item.filename + ".pdf", output);
            if (i % 5 === 0 || i === analysis.records.length - 1) {
                status(`Creating PDFs… ${i + 1} / ${analysis.records.length}`);
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
        zip.file("mailmerge-check-report.csv", createCsvReport(analysis.records));
        zip.file("READ-ME-FIRST.txt", "MailMerge Guard export\r\n\r\nPlease review every PDF before sharing. Name checks are not identity proof, and digitized/scanned PDFs may not contain searchable text.\r\nThe original document may have signatures or forms which are not preserved when split.\r\n");
        status("Preparing ZIP download…");
        const blob = await zip.generateAsync({type:"blob", compression:"DEFLATE", compressionOptions:{level:5}});
        downloadBlob(blob, "MailMerge-Guard-Files.zip");
        status(`ZIP ready: ${analysis.records.length} PDFs + check report.`, "success");
    } catch (error) {
        status(error.message || "Could not create the ZIP file.", "error");
    } finally {
        busy = false;
        els.downloadZipBtn.disabled = !!(analysis?.warningCount && !els.reviewConfirm.checked);
    }
}

// Events: any input edit invalidates a previous analysis.
els.pdfInput.addEventListener("change", e => selectPdf(e.target.files[0]));
els.csvInput.addEventListener("change", async e => selectCsv(e.target.files[0]));
for (const field of [els.filenameColumn, els.verifyColumn, els.pagesPer, els.prefix, els.verifyToggle]) {
    field.addEventListener(field.type === "text" || field.type === "number" ? "input" : "change", hideAnalysis);
}
els.analyzeBtn.addEventListener("click", analyze);
els.reviewConfirm.addEventListener("change", () => {els.downloadZipBtn.disabled = !analysis || busy || (analysis.warningCount > 0 && !els.reviewConfirm.checked);});
els.downloadZipBtn.addEventListener("click", downloadZip);
els.downloadReportBtn.addEventListener("click", () => {
    if (analysis) downloadBlob(new Blob([createCsvReport(analysis.records)], {type:"text/csv;charset=utf-8"}), "MailMerge-Check-Report.csv");
});
els.closePreview.addEventListener("click", () => els.previewDialog.close());

for (const [zoneId, type] of [["pdfDrop", "pdf"], ["csvDrop", "csv"]]) {
    const zone = document.getElementById(zoneId);
    zone.addEventListener("dragover", e => {e.preventDefault(); zone.classList.add("drag-over");});
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
    zone.addEventListener("drop", e => {
        e.preventDefault(); zone.classList.remove("drag-over");
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;
        if (type === "pdf") selectPdf(file); else selectCsv(file);
    });
}

els.demoBtn.addEventListener("click", async () => {
    try {
        status("Loading included demo files…");
        const [pdf, csv] = await Promise.all([fetch("sample/sample.pdf"), fetch("sample/recipients.csv")]);
        if (!pdf.ok || !csv.ok) throw new Error("Demo files unavailable.");
        selectPdf(new File([await pdf.blob()], "sample.pdf", {type:"application/pdf"}));
        await selectCsv(new File([await csv.blob()], "recipients.csv", {type:"text/csv"}));
        status("Sample files loaded. Click Analyze files to try the tool.", "success");
    } catch (error) {
        status("Demo could not load. Open the project through a local web server, not file://.", "error");
    }
});

// Helper exports for smoke testing (no operational effect on the page).
window.__MMG_TEST__ = {safeName, nameInText, cleanCsvReportValue, parseCsvString, buildRecords, createCsvReport};

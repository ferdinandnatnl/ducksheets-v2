document.addEventListener("DOMContentLoaded", () => {
  const MAX_PDF_FILES = 12;
  const OUTPUT_MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const BANK_OPTIONS = [
    { value: "bca", label: "Bank BCA" },
    { value: "bri", label: "Bank BRI" },
    { value: "mandiri", label: "Bank Mandiri" },
    { value: "permata", label: "Bank Permata" },
    { value: "blu", label: "Bank BLU" },
    { value: "cimb", label: "Bank CIMB Niaga" },
  ];

  let conversionMode = "full";
  let isUploading = false;
  let totalPdfsParsed = 0;
  let batchCounter = 0;

  const clientBatches = [];

  const featureDescription = document.getElementById("feature-mode-description");
  const featureTabs = Array.from(document.querySelectorAll(".feature-tab"));
  const bankSelector = document.getElementById("bankSelector");
  const addClientBoxButton = document.getElementById("addClientBox");
  const clientBatchesContainer = document.getElementById("clientBatches");
  const fileCountElement = document.getElementById("fileCount");
  const proceedButton = document.getElementById("proceedButton");
  const uploadForm = document.getElementById("uploadForm");

  const errorMessageElement = document.getElementById("error-message");
  const successMessageElement = document.getElementById("success-message");

  function getDefaultBank() {
    return String(bankSelector?.value || "")
      .trim()
      .toLowerCase();
  }

  function getBankLabel(bankCode) {
    return BANK_OPTIONS.find((option) => option.value === bankCode)?.label || "";
  }

  function renderBankOptions(selectedBank) {
    return [
      `<option value="">Select bank</option>`,
      ...BANK_OPTIONS.map(
        (option) =>
          `<option value="${option.value}" ${option.value === selectedBank ? "selected" : ""}>${option.label}</option>`
      ),
    ].join("");
  }

  function createBatch() {
    batchCounter += 1;
    return {
      id: String(batchCounter),
      bank: getDefaultBank(),
      pdfPassword: "",
      outputName: "",
      files: [],
      outputFile: null,
      error: "",
      isProcessing: false,
    };
  }

  function getBatch(batchId) {
    return clientBatches.find((batch) => batch.id === String(batchId));
  }

  function ensureAtLeastOneBatch() {
    if (clientBatches.length === 0) {
      clientBatches.push(createBatch());
    }
  }

  function addBatch() {
    clientBatches.push(createBatch());
    renderBatches();
    clearMessages();
  }

  function removeBatch(batchId) {
    const index = clientBatches.findIndex((batch) => batch.id === String(batchId));
    if (index < 0) return;
    if (clientBatches.length === 1) return;

    clientBatches.splice(index, 1);
    renderBatches();
  }

  function clearBatchOutput(batch) {
    batch.outputFile = null;
    batch.error = "";
  }

  function isPdfFile(file) {
    if (!file) return false;
    return file.type === "application/pdf" || /\.pdf$/i.test(String(file.name || ""));
  }

  function addFilesToBatch(batchId, newFiles) {
    const batch = getBatch(batchId);
    if (!batch) return;

    const incomingPdfFiles = Array.from(newFiles || []).filter(isPdfFile);
    if (incomingPdfFiles.length === 0) {
      showError("Please upload PDF files only.");
      return;
    }

    if (batch.outputFile) {
      clearBatchOutput(batch);
    }

    const remainingSlots = Math.max(0, MAX_PDF_FILES - batch.files.length);
    if (remainingSlots <= 0) {
      showError(`Client ${getBatchLabel(batch)} already has ${MAX_PDF_FILES} PDFs.`);
      return;
    }

    const filesToAdd = incomingPdfFiles.slice(0, remainingSlots);
    batch.files.push(...filesToAdd);

    if (filesToAdd.length < incomingPdfFiles.length) {
      showError(`Maximum ${MAX_PDF_FILES} PDF files per client box.`);
    } else {
      clearMessages();
    }

    batch.error = "";
    renderBatches();
  }

  function removeFileFromBatch(batchId, fileName) {
    const batch = getBatch(batchId);
    if (!batch) return;

    batch.files = batch.files.filter((file) => file.name !== fileName);
    if (batch.files.length === 0 && !batch.outputFile) {
      batch.error = "";
    }
    renderBatches();
  }

  function getBatchLabel(batch) {
    const index = clientBatches.findIndex((item) => item.id === batch.id);
    return index >= 0 ? index + 1 : "?";
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderBatches() {
    if (!clientBatchesContainer) return;

    ensureAtLeastOneBatch();

    clientBatchesContainer.innerHTML = clientBatches
      .map((batch) => {
        const batchLabel = getBatchLabel(batch);

        const pdfRows = batch.files
          .map(
            (file) => `
              <div class="batch-file-item">
                <div class="batch-file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
                <div class="batch-file-actions">
                  <button type="button" class="batch-file-action" data-action="remove-file" data-batch-id="${batch.id}" data-file-name="${escapeHtml(file.name)}">Remove</button>
                </div>
              </div>
            `
          )
          .join("");

        const outputRow = batch.outputFile
          ? `
            <div class="batch-file-item">
              <div class="batch-file-name" title="${escapeHtml(batch.outputFile.name)}">${escapeHtml(batch.outputFile.name)}</div>
              <div class="batch-file-actions">
                <button type="button" class="batch-file-action" data-action="download-output" data-batch-id="${batch.id}">Download</button>
              </div>
            </div>
          `
          : "";

        const statusClass = batch.error
          ? "error"
          : batch.isProcessing
            ? "processing"
            : batch.outputFile
              ? "success"
              : "";

        const statusText = batch.error
          ? escapeHtml(batch.error)
          : batch.isProcessing
            ? "Processing this client..."
            : batch.outputFile
              ? "Ready to download"
              : "";

        const bankLabel = getBankLabel(batch.bank);
        const summaryText =
          batch.files.length > 0
            ? `${batch.files.length} PDF${batch.files.length > 1 ? "s" : ""} selected${bankLabel ? ` • ${bankLabel}` : ""}`
            : batch.outputFile
              ? "Output ready"
              : "No files yet";

        return `
          <section class="client-batch-card" data-batch-id="${batch.id}">
            <div class="client-batch-header">
              <div class="client-batch-title">Client Box ${batchLabel}</div>
              ${
                clientBatches.length > 1
                  ? `<button type="button" class="client-batch-remove" data-action="remove-batch" data-batch-id="${batch.id}">Remove box</button>`
                  : ""
              }
            </div>

            <div class="client-batch-fields">
              <div class="client-batch-bank">
                <label for="bank-${batch.id}">Bank</label>
                <select
                  id="bank-${batch.id}"
                  class="batch-bank"
                  data-action="set-bank"
                  data-batch-id="${batch.id}"
                >
                  ${renderBankOptions(batch.bank)}
                </select>
              </div>
              <div class="client-batch-name">
                <label for="password-${batch.id}">PDF password (optional)</label>
                <input
                  id="password-${batch.id}"
                  type="password"
                  class="batch-password"
                  data-action="set-password"
                  data-batch-id="${batch.id}"
                  value="${escapeHtml(batch.pdfPassword)}"
                  placeholder="Enter if PDF is locked"
                  autocomplete="off"
                >
              </div>
              <div class="client-batch-name">
                <label for="output-name-${batch.id}">Output filename (.xlsx)</label>
                <input
                  id="output-name-${batch.id}"
                  type="text"
                  class="batch-output-name"
                  data-action="set-output-name"
                  data-batch-id="${batch.id}"
                  value="${escapeHtml(batch.outputName)}"
                  placeholder="example: client-a-q1"
                >
              </div>
            </div>

            <div class="batch-drop-area" data-action="drop-area" data-batch-id="${batch.id}">
              <p>
                Drag and drop PDF files here
              </p>
              <p>or</p>
              <input
                id="batch-file-input-${batch.id}"
                class="batch-file-input"
                data-action="file-input"
                data-batch-id="${batch.id}"
                type="file"
                accept=".pdf"
                multiple
                style="display:none"
              >
              <button type="button" class="secondary-button" data-action="select-files" data-batch-id="${batch.id}">Select files</button>
              <p class="small-hint">Maximum ${MAX_PDF_FILES} PDF files for this client</p>
            </div>

            <div class="batch-status ${statusClass}">${summaryText}</div>
            <div class="batch-file-list">
              ${pdfRows || ""}
              ${outputRow || ""}
            </div>
            ${statusText ? `<div class="batch-status ${statusClass}">${statusText}</div>` : ""}
          </section>
        `;
      })
      .join("");

    updateFileCount();
    updateProceedButton();
  }

  function updateFileCount() {
    if (!fileCountElement) return;

    const totalPendingPdfs = clientBatches.reduce((sum, batch) => sum + batch.files.length, 0);
    const outputCount = clientBatches.filter((batch) => batch.outputFile).length;

    if (totalPendingPdfs > 0) {
      fileCountElement.textContent = `${totalPendingPdfs} PDF${totalPendingPdfs > 1 ? "s" : ""} across ${clientBatches.length} client box${clientBatches.length > 1 ? "es" : ""}`;
      return;
    }

    if (outputCount > 0) {
      fileCountElement.textContent = `${outputCount} output file${outputCount > 1 ? "s" : ""} ready`;
      return;
    }

    fileCountElement.textContent = "";
  }

  function updateProceedButton() {
    if (!proceedButton) return;

    const hasPendingPdfs = clientBatches.some((batch) => batch.files.length > 0);
    const hasOutput = clientBatches.some((batch) => Boolean(batch.outputFile));

    proceedButton.disabled = isUploading || (!hasPendingPdfs && !hasOutput);
    proceedButton.style.backgroundColor = proceedButton.disabled ? "#E9ECEF" : "#1379f1";
    proceedButton.style.color = proceedButton.disabled ? "#6C757D" : "#FFFFFF";

    if (isUploading) {
      proceedButton.textContent = "Processing...";
      return;
    }

    proceedButton.textContent = hasPendingPdfs ? "Proceed" : "Download All";
  }

  function getFilenameFromContentDisposition(contentDispositionHeader) {
    if (!contentDispositionHeader) return null;

    const utf8Match = contentDispositionHeader.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) {
      return decodeURIComponent(utf8Match[1].trim());
    }

    const asciiMatch = contentDispositionHeader.match(/filename="?([^"]+)"?/i);
    if (asciiMatch?.[1]) {
      return asciiMatch[1].trim();
    }

    return null;
  }

  function stripExtension(fileName) {
    return String(fileName || "").replace(/\.[^.]+$/, "");
  }

  function sanitizeBaseName(value) {
    return String(value || "")
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 140);
  }

  function ensureExtension(fileName, expectedExtension) {
    const normalized = String(fileName || "").trim();
    if (!normalized) return `output${expectedExtension}`;
    if (normalized.toLowerCase().endsWith(expectedExtension)) return normalized;
    return `${stripExtension(normalized)}${expectedExtension}`;
  }

  function makeUniqueFileName(fileName, usedNames) {
    const original = String(fileName || "output.xlsx");
    if (!usedNames.has(original)) {
      usedNames.add(original);
      return original;
    }

    const base = stripExtension(original) || "output";
    const extMatch = original.match(/(\.[^.]+)$/);
    const ext = extMatch ? extMatch[1] : "";

    let counter = 2;
    let candidate = `${base}_${counter}${ext}`;
    while (usedNames.has(candidate)) {
      counter += 1;
      candidate = `${base}_${counter}${ext}`;
    }
    usedNames.add(candidate);
    return candidate;
  }

  function buildOutputFileName(batch, suggestedName, bank, batchIndex, isXlsx) {
    const targetExt = isXlsx ? ".xlsx" : ".csv";

    const customBase = sanitizeBaseName(batch.outputName);
    if (customBase) {
      return ensureExtension(customBase, targetExt);
    }

    if (suggestedName) {
      const base = sanitizeBaseName(stripExtension(suggestedName));
      if (base) return ensureExtension(base, targetExt);
    }

    return ensureExtension(`${bank}_client_${batchIndex + 1}`, targetExt);
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.style.display = "none";
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function downloadFile(file) {
    downloadBlob(file, file.name);
  }

  function trackPdfParsing(pdfCount) {
    totalPdfsParsed += pdfCount;
    if (window.va) {
      window.va("event", {
        name: "PDFsParsed_v2",
        data: {
          count: pdfCount,
          totalCount: totalPdfsParsed,
        },
      });
    }
  }

  function setConversionMode(mode) {
    const nextMode = mode === "income-only" ? "income-only" : "full";
    const modeChanged = conversionMode !== nextMode;
    conversionMode = nextMode;

    featureTabs.forEach((tab) => {
      const isActive = tab.dataset.mode === conversionMode;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-selected", isActive ? "true" : "false");
    });

    if (featureDescription) {
      featureDescription.textContent =
        conversionMode === "income-only"
          ? "Hanya transaksi CREDIT/penghasilan yang akan masuk ke output (tanpa DB/DEBIT)."
          : "Semua transaksi DEBIT dan CREDIT akan tetap masuk ke output.";
    }

    if (modeChanged) {
      clientBatches.forEach((batch) => {
        clearBatchOutput(batch);
      });
      renderBatches();
    }
  }

  function showError(message) {
    if (successMessageElement) {
      successMessageElement.textContent = "";
      successMessageElement.style.display = "none";
    }
    if (errorMessageElement) {
      errorMessageElement.textContent = message;
      errorMessageElement.style.display = "block";
    }
  }

  function showSuccess(message) {
    if (errorMessageElement) {
      errorMessageElement.textContent = "";
      errorMessageElement.style.display = "none";
    }
    if (successMessageElement) {
      successMessageElement.textContent = message;
      successMessageElement.style.display = "block";
    }
  }

  function clearMessages() {
    if (errorMessageElement) {
      errorMessageElement.textContent = "";
      errorMessageElement.style.display = "none";
    }
    if (successMessageElement) {
      successMessageElement.textContent = "";
      successMessageElement.style.display = "none";
    }
  }

  async function uploadSingleBatch(batch, bank, batchIndex) {
    const formData = new FormData();
    batch.files.forEach((file) => formData.append("pdfFile", file));
    if (batch.pdfPassword) {
      formData.append("pdfPassword", batch.pdfPassword);
    }

    const modeQuery = conversionMode === "income-only" ? "?mode=income-only" : "";
    const apiUrl = `/api/${bank}${modeQuery}`;

    const response = await fetch(apiUrl, {
      method: "POST",
      body: formData,
    });

    const responseBlob = await response.blob();
    const contentType = response.headers.get("content-type") || "";
    const shouldReadAsText = !response.ok || contentType.includes("application/json");
    const responseText = shouldReadAsText ? await responseBlob.text() : "";

    if (!response.ok) {
      let errorMessage = `HTTP error! status: ${response.status}`;
      try {
        const errorPayload = JSON.parse(responseText);
        errorMessage = errorPayload.error || errorPayload.details || errorMessage;
      } catch {
        if (responseText) errorMessage = responseText;
      }
      throw new Error(errorMessage);
    }

    const suggestedName = getFilenameFromContentDisposition(
      response.headers.get("content-disposition") || ""
    );

    const isXlsxResponse =
      contentType.includes(OUTPUT_MIME_XLSX) ||
      (suggestedName && suggestedName.toLowerCase().endsWith(".xlsx"));

    if (contentType.includes("application/json")) {
      let cleanCsvContent = responseText;
      try {
        const jsonContent = JSON.parse(responseText);
        if (jsonContent.csvContent) {
          cleanCsvContent = jsonContent.csvContent;
        }
      } catch {
      }

      const csvName = buildOutputFileName(batch, suggestedName, bank, batchIndex, false);
      return new File([cleanCsvContent], csvName, { type: "text/csv" });
    }

    const outputName = buildOutputFileName(batch, suggestedName, bank, batchIndex, isXlsxResponse);
    return new File([responseBlob], outputName, {
      type: responseBlob.type || (isXlsxResponse ? OUTPUT_MIME_XLSX : "application/octet-stream"),
    });
  }

  async function uploadAllBatches() {
    if (isUploading) return;

    const pendingBatches = clientBatches.filter((batch) => batch.files.length > 0);
    if (pendingBatches.length === 0) {
      showError("Please add PDF files in at least one client box.");
      return;
    }

    let hasMissingBank = false;
    pendingBatches.forEach((batch) => {
      if (!batch.bank) {
        batch.error = "Select bank for this client box.";
        hasMissingBank = true;
      }
    });
    if (hasMissingBank) {
      renderBatches();
      showError("Select bank for each client box that has PDF files.");
      return;
    }

    isUploading = true;
    clearMessages();
    updateProceedButton();

    let convertedCount = 0;
    let parsedPdfCount = 0;
    const usedOutputNames = new Set(
      clientBatches
        .filter((batch) => batch.outputFile)
        .map((batch) => batch.outputFile.name)
    );

    for (let batchIndex = 0; batchIndex < clientBatches.length; batchIndex += 1) {
      const batch = clientBatches[batchIndex];
      if (batch.files.length === 0) continue;

      batch.isProcessing = true;
      batch.error = "";
      renderBatches();

      try {
        const pdfCount = batch.files.length;
        let outputFile = await uploadSingleBatch(batch, batch.bank, batchIndex);
        const uniqueName = makeUniqueFileName(outputFile.name, usedOutputNames);
        if (uniqueName !== outputFile.name) {
          outputFile = new File([outputFile], uniqueName, { type: outputFile.type });
        }

        batch.outputFile = outputFile;
        batch.files = [];
        batch.error = "";
        batch.isProcessing = false;

        convertedCount += 1;
        parsedPdfCount += pdfCount;
      } catch (error) {
        batch.error = error?.message || "Failed to process this client box.";
        batch.isProcessing = false;
      }

      renderBatches();
    }

    isUploading = false;
    updateProceedButton();

    if (convertedCount > 0) {
      trackPdfParsing(parsedPdfCount);
      showSuccess(
        convertedCount === 1
          ? "1 client box converted. You can download the .xlsx now."
          : `${convertedCount} client boxes converted. Use Download All to get all .xlsx files.`
      );
    } else {
      showError("No client boxes were converted. Check the error under each box and retry.");
    }
  }

  async function downloadAllOutputs() {
    const outputs = clientBatches.filter((batch) => batch.outputFile).map((batch) => batch.outputFile);
    if (outputs.length === 0) {
      showError("No output files available to download.");
      return;
    }

    if (outputs.length === 1) {
      downloadFile(outputs[0]);
      return;
    }

    if (!window.JSZip) {
      outputs.forEach((file, index) => {
        setTimeout(() => downloadFile(file), index * 150);
      });
      showSuccess("Multiple files detected. Downloaded one by one.");
      return;
    }

    const zip = new window.JSZip();
    for (const outputFile of outputs) {
      const arrayBuffer = await outputFile.arrayBuffer();
      zip.file(outputFile.name, arrayBuffer);
    }

    const zipBlob = await zip.generateAsync({ type: "blob" });
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadBlob(zipBlob, `ducksheets_clients_${timestamp}.zip`);
    showSuccess("Downloaded a ZIP containing all client .xlsx files.");
  }

  function handleProceedAction() {
    const hasPendingPdfs = clientBatches.some((batch) => batch.files.length > 0);
    if (hasPendingPdfs) {
      uploadAllBatches();
    } else {
      downloadAllOutputs();
    }
  }

  featureTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      setConversionMode(tab.dataset.mode);
      clearMessages();
    });
  });

  addClientBoxButton?.addEventListener("click", () => {
    addBatch();
  });

  bankSelector?.addEventListener("change", () => {
    const defaultBank = getDefaultBank();
    clientBatches.forEach((batch) => {
      if (!batch.files.length && !batch.outputFile && !batch.bank) {
        batch.bank = defaultBank;
      }
    });
    renderBatches();
  });

  proceedButton?.addEventListener("click", (event) => {
    event.preventDefault();
    handleProceedAction();
  });

  uploadForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    handleProceedAction();
  });

  clientBatchesContainer?.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;

    const action = target.dataset.action;
    const batchId = target.dataset.batchId;

    if (action === "select-files") {
      const input = document.getElementById(`batch-file-input-${batchId}`);
      input?.click();
      return;
    }

    if (action === "remove-file") {
      const fileName = target.dataset.fileName;
      removeFileFromBatch(batchId, fileName);
      return;
    }

    if (action === "remove-batch") {
      removeBatch(batchId);
      return;
    }

    if (action === "download-output") {
      const batch = getBatch(batchId);
      if (batch?.outputFile) {
        downloadFile(batch.outputFile);
      }
    }
  });

  clientBatchesContainer?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;

    const action = target.dataset.action;
    const batchId = target.dataset.batchId;

    if (action === "file-input") {
      addFilesToBatch(batchId, target.files);
      target.value = "";
      return;
    }

    if (action === "set-output-name") {
      const batch = getBatch(batchId);
      if (!batch) return;

      batch.outputName = target.value;
      if (batch.outputFile) {
        clearBatchOutput(batch);
      }
      updateProceedButton();
      return;
    }

    if (action === "set-bank") {
      const batch = getBatch(batchId);
      if (!batch) return;

      batch.bank = String(target.value || "")
        .trim()
        .toLowerCase();
      if (batch.outputFile) {
        clearBatchOutput(batch);
      }
      if (batch.bank) {
        batch.error = "";
      }
      renderBatches();
    }
  });

  clientBatchesContainer?.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const action = target.dataset.action;
    if (action !== "set-output-name" && action !== "set-password") return;

    const batch = getBatch(target.dataset.batchId);
    if (!batch) return;

    if (action === "set-output-name") {
      batch.outputName = target.value;
      if (batch.outputFile) {
        clearBatchOutput(batch);
      }
      updateProceedButton();
      return;
    }

    if (action === "set-password") {
      batch.pdfPassword = target.value;
      if (batch.error === "Select bank for this client box.") {
        batch.error = "";
      }
    }
  });

  clientBatchesContainer?.addEventListener("dragover", (event) => {
    const dropArea = event.target.closest("[data-action='drop-area']");
    if (!dropArea) return;

    event.preventDefault();
    dropArea.classList.add("highlight");
  });

  clientBatchesContainer?.addEventListener("dragleave", (event) => {
    const dropArea = event.target.closest("[data-action='drop-area']");
    if (!dropArea) return;

    dropArea.classList.remove("highlight");
  });

  clientBatchesContainer?.addEventListener("drop", (event) => {
    const dropArea = event.target.closest("[data-action='drop-area']");
    if (!dropArea) return;

    event.preventDefault();
    dropArea.classList.remove("highlight");

    const batchId = dropArea.dataset.batchId;
    const droppedFiles = event.dataTransfer?.files;
    if (!droppedFiles || droppedFiles.length === 0) return;

    addFilesToBatch(batchId, droppedFiles);
  });

  ensureAtLeastOneBatch();
  setConversionMode("full");
  clearMessages();
  renderBatches();
});

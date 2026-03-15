import { execFile } from "child_process";
import { unlink } from "fs/promises";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

let cachedQpdfAvailability;

async function runQpdf(args) {
  return execFileAsync("qpdf", args);
}

async function qpdfExitCode(args) {
  try {
    await runQpdf(args);
    return 0;
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    if (typeof error?.code === "number") return error.code;
    throw error;
  }
}

async function hasQpdf() {
  if (typeof cachedQpdfAvailability === "boolean") {
    return cachedQpdfAvailability;
  }

  const versionCode = await qpdfExitCode(["--version"]);
  cachedQpdfAvailability = versionCode === 0;
  return cachedQpdfAvailability;
}

function getErrorText(error) {
  return (
    error?.stderr ||
    error?.stdout ||
    error?.message ||
    "Unknown qpdf error"
  );
}

export async function unlockPdfForParsing(inputPath, options = {}) {
  const password = typeof options?.password === "string" ? options.password : "";

  const defaultResult = {
    filePath: inputPath,
    cleanupPath: null,
    wasEncrypted: false,
    unlocked: false,
    reason: "not_checked",
    errorMessage: "",
  };

  if (!(await hasQpdf())) {
    return { ...defaultResult, reason: "qpdf_missing" };
  }

  const encryptedCode = await qpdfExitCode(["--is-encrypted", inputPath]);
  if (encryptedCode === 2) {
    return { ...defaultResult, reason: "not_encrypted" };
  }
  if (encryptedCode !== 0) {
    return { ...defaultResult, reason: "encryption_check_failed" };
  }

  const encryptedResult = {
    ...defaultResult,
    wasEncrypted: true,
  };

  const requiresPasswordCode = await qpdfExitCode(["--requires-password", inputPath]);
  if (requiresPasswordCode === 0) {
    if (!password) {
      return { ...encryptedResult, reason: "password_required" };
    }

    const unlockedPath = `${inputPath}.unlocked.pdf`;
    try {
      await runQpdf(["--password=" + password, "--decrypt", inputPath, unlockedPath]);
      return {
        ...encryptedResult,
        filePath: unlockedPath,
        cleanupPath: unlockedPath,
        unlocked: true,
        reason: "decrypted_with_password",
      };
    } catch (error) {
      try {
        await unlink(unlockedPath);
      } catch {
        // Ignore cleanup errors.
      }

      return {
        ...encryptedResult,
        reason: "invalid_password",
        errorMessage: getErrorText(error),
      };
    }
  }

  const unlockedPath = `${inputPath}.unlocked.pdf`;
  try {
    await runQpdf(["--decrypt", inputPath, unlockedPath]);
    return {
      ...encryptedResult,
      filePath: unlockedPath,
      cleanupPath: unlockedPath,
      unlocked: true,
      reason: "decrypted",
    };
  } catch (error) {
    try {
      await unlink(unlockedPath);
    } catch {
      // Ignore cleanup errors.
    }

    return {
      ...encryptedResult,
      reason: "decrypt_failed",
      errorMessage: getErrorText(error),
    };
  }
}

export async function cleanupUnlockedPdf(pdfMeta) {
  if (!pdfMeta?.cleanupPath) return;

  try {
    await unlink(pdfMeta.cleanupPath);
  } catch {
    // Ignore cleanup errors.
  }
}

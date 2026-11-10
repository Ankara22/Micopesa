const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const CAPTURE_FLAG = "MICOPESA_EMAIL_CAPTURE";
const CAPTURE_DIRECTORY = "MICOPESA_EMAIL_CAPTURE_DIR";
const CAPTURE_FILE = "registration-messages.jsonl";

function isCaptureModeRequested(environment = process.env) {
    return environment[CAPTURE_FLAG] !== undefined &&
        environment[CAPTURE_FLAG] !== "" &&
        environment[CAPTURE_FLAG] !== "false";
}

function isWithin(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative !== "" && relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative);
}

async function captureRegistrationEmail(message, environment = process.env) {
    if (environment[CAPTURE_FLAG] !== "true") {
        throw Object.assign(new Error("Local email capture must be explicitly enabled."), {
            code: "EMAIL_CAPTURE_NOT_ENABLED",
        });
    }
    if (String(environment.NODE_ENV || "").trim().toLowerCase() === "production") {
        throw Object.assign(new Error("Local email capture is unavailable in production."), {
            code: "EMAIL_CAPTURE_PRODUCTION_FORBIDDEN",
        });
    }
    if (message.purpose !== "REGISTRATION_VERIFICATION") {
        throw Object.assign(new Error("Local email capture accepts registration verification only."), {
            code: "EMAIL_CAPTURE_UNSUPPORTED_PURPOSE",
        });
    }

    const configuredDirectory = environment[CAPTURE_DIRECTORY];
    if (typeof configuredDirectory !== "string" || !path.isAbsolute(configuredDirectory)) {
        throw Object.assign(new Error("A local absolute email capture directory is required."), {
            code: "EMAIL_CAPTURE_DIRECTORY_INVALID",
        });
    }

    const tempDirectory = await fs.realpath(os.tmpdir());
    const resolvedDirectory = path.resolve(configuredDirectory);
    if (!isWithin(tempDirectory, resolvedDirectory)) {
        throw Object.assign(new Error("Email captures must be stored below the operating-system temp directory."), {
            code: "EMAIL_CAPTURE_DIRECTORY_UNSAFE",
        });
    }

    await fs.mkdir(resolvedDirectory, { recursive: true, mode: 0o700 });
    const directoryStat = await fs.lstat(resolvedDirectory);
    const actualDirectory = await fs.realpath(resolvedDirectory);
    if (
        !directoryStat.isDirectory() ||
        directoryStat.isSymbolicLink() ||
        !isWithin(tempDirectory, actualDirectory)
    ) {
        throw Object.assign(new Error("Email capture directory is not a safe local directory."), {
            code: "EMAIL_CAPTURE_DIRECTORY_UNSAFE",
        });
    }

    const capturePath = path.join(actualDirectory, CAPTURE_FILE);
    try {
        const existing = await fs.lstat(capturePath);
        if (!existing.isFile() || existing.isSymbolicLink()) {
            throw Object.assign(new Error("Email capture file is not a regular file."), {
                code: "EMAIL_CAPTURE_FILE_UNSAFE",
            });
        }
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }

    const record = {
        captured_at: new Date().toISOString(),
        purpose: message.purpose,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
    };
    await fs.appendFile(capturePath, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "a",
    });

    return {
        accepted: true,
        status: "CAPTURED_LOCALLY",
        captureFile: capturePath,
    };
}

module.exports = { captureRegistrationEmail, isCaptureModeRequested };

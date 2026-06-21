"""OOXML file safety validation — runs before openpyxl / python-docx touch the file."""

import io
import logging
import zipfile

logger = logging.getLogger(__name__)

_OOXML_MAGIC = b"PK\x03\x04"
_MAX_UPLOAD_BYTES = 10 * 1024 * 1024         # 10 MB compressed
_MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024   # 50 MB total uncompressed (zip bomb threshold)
_MAX_MEMBER_RATIO = 100                       # per-member compression ratio cap

# Known macro container filenames inside an OOXML zip.
_MACRO_SUFFIXES = ("/vbaProject.bin", "/vbaData.bin")
_MACRO_EXACT = {"vbaProject.bin", "xl/vbaProject.bin", "word/vbaProject.bin", "xl/vbaData.bin"}


class UnsafeFileError(ValueError):
    """Raised when an uploaded file fails a safety check."""


def validate_ooxml(content: bytes) -> None:
    """Validate that *content* is a safe OOXML document before handing it to a parser.

    Checks (in order):
    1. Size cap on the compressed upload.
    2. Magic bytes — must be a PK zip (all OOXML formats are).
    3. Valid zip structure — rejects corrupt / disguised zips.
    4. Path traversal in member names — ../../ tricks.
    5. Macro files — vbaProject.bin / vbaData.bin.
    6. Zip bomb — per-member ratio > 100:1 or total uncompressed > 50 MB.

    Raises UnsafeFileError with a user-safe message on any failure.
    Internal details (member names, ratios) are only logged server-side.
    """
    if len(content) > _MAX_UPLOAD_BYTES:
        raise UnsafeFileError(
            f"File too large. Maximum {_MAX_UPLOAD_BYTES // (1024 * 1024)} MB."
        )

    if not content.startswith(_OOXML_MAGIC):
        raise UnsafeFileError("File is not a valid OOXML document (.xlsx or .docx).")

    try:
        zf = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as exc:
        raise UnsafeFileError("File is not a valid zip archive.") from exc

    total_uncompressed = 0

    try:
        for member in zf.infolist():
            name = member.filename

            # Path traversal — reject any member whose path walks outside the archive root.
            parts = name.replace("\\", "/").split("/")
            if ".." in parts or name.startswith("/"):
                logger.warning("Path traversal in zip member: %r", name)
                raise UnsafeFileError("File failed safety check.")

            # Macro detection — reject known VBA container files.
            if name in _MACRO_EXACT or any(name.endswith(s) for s in _MACRO_SUFFIXES):
                logger.warning("Macro file detected in upload: %r", name)
                raise UnsafeFileError(
                    "Macro-enabled documents are not accepted. "
                    "Please save as .xlsx (not .xlsm) or .docx (not .docm)."
                )

            compressed = member.compress_size
            uncompressed = member.file_size

            # Zip bomb — per-member ratio.
            if compressed > 0 and uncompressed / compressed > _MAX_MEMBER_RATIO:
                logger.warning(
                    "Zip bomb candidate: member %r ratio %d:1 (%d -> %d bytes)",
                    name,
                    uncompressed // compressed,
                    compressed,
                    uncompressed,
                )
                raise UnsafeFileError("File failed safety check.")

            total_uncompressed += uncompressed

            # Zip bomb — cumulative uncompressed size.
            if total_uncompressed > _MAX_UNCOMPRESSED_BYTES:
                logger.warning(
                    "Zip bomb candidate: total uncompressed exceeded %d MB at member %r",
                    _MAX_UNCOMPRESSED_BYTES // (1024 * 1024),
                    name,
                )
                raise UnsafeFileError("File failed safety check.")
    finally:
        zf.close()

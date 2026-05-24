"""Excel document generation helpers using openpyxl."""

from io import BytesIO

from openpyxl import Workbook


def create_basic_workbook_bytes(sheet_name: str = "Sheet1") -> bytes:
    """Create a basic workbook and return it as XLSX bytes."""
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = sheet_name

    buffer = BytesIO()
    workbook.save(buffer)
    buffer.seek(0)
    return buffer.getvalue()
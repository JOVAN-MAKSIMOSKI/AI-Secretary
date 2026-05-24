"""Word document generation service using python-docx."""

from io import BytesIO

from docx import Document


def create_basic_document_bytes(doc_title: str = "Document") -> bytes:
    """Create a basic Word document and return it as DOCX bytes."""
    document = Document()
    document.add_paragraph(doc_title)

    buffer = BytesIO()
    document.save(buffer)
    buffer.seek(0)
    return buffer.getvalue()

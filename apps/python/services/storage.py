import os
from uuid import UUID
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

url: str = os.environ.get("SUPABASE_URL", "")
key: str = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

if not url or not key:
    raise ValueError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.")

# Normalise URL — strip any trailing /rest/v1 path accidentally included in .env
url = url.rstrip("/")
if url.endswith("/rest/v1"):
    url = url[: -len("/rest/v1")]

supabase: Client = create_client(url, key)

ALLOWED_DOCUMENT_FOLDERS = {
    "invoices": {"xlsx"},
    "offers": {"docx"},
    "templates": {"xlsx", "docx"},
}


def build_document_path(tenant_id, folder, document_id, extension):
    normalized_folder = folder.strip().lower()
    normalized_extension = extension.strip().lower().lstrip(".")

    if normalized_folder not in ALLOWED_DOCUMENT_FOLDERS:
        raise ValueError(
            "Invalid folder. Expected one of: invoices, offers, templates."
        )

    if normalized_extension not in ALLOWED_DOCUMENT_FOLDERS[normalized_folder]:
        raise ValueError(
            f"Invalid extension '{normalized_extension}' for folder '{normalized_folder}'."
        )

    tenant_uuid = str(UUID(str(tenant_id)))
    document_uuid = str(UUID(str(document_id)))

    return f"{tenant_uuid}/{normalized_folder}/{document_uuid}.{normalized_extension}"


def _upload_document(tenant_id, folder, document_id, extension, file_content):
    path = build_document_path(tenant_id, folder, document_id, extension)
    return supabase.storage.from_("documents").upload(path, file_content)


def upload_invoice_document(tenant_id, document_id, file_content):
    return _upload_document(tenant_id, "invoices", document_id, "xlsx", file_content)


def upload_offer_document(tenant_id, document_id, file_content):
    return _upload_document(tenant_id, "offers", document_id, "docx", file_content)


def upload_template_document(tenant_id, template_id, extension, file_content):
    return _upload_document(tenant_id, "templates", template_id, extension, file_content)
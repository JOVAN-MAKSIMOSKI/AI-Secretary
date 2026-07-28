"""Layer 2 — contact lookup for identification forms.

No network: the supabase client is stubbed. Guards two things — that the invoice firm
lookup's shape is unchanged after the shared-scorer refactor, and that contact lookup
reuses that scorer to resolve names across scripts (Latin input vs Cyrillic record).
"""

import services.identification_forms.contact_lookup as cl
import services.invoices.firm_lookup as fl

import pytest


class _StubQuery:
    def __init__(self, sink, rows_for_call):
        self._sink = sink
        self._rows_for_call = rows_for_call

    def select(self, columns):
        self._sink["cols"] = columns
        return self

    def eq(self, column, value):
        # Record every equality filter applied so tests can assert firm scoping.
        self._sink.setdefault("filters", []).append((column, value))
        return self

    def ilike(self, *args, **kwargs):
        return self

    def limit(self, *args, **kwargs):
        return self

    def execute(self):
        call_index = self._sink["call"]
        self._sink["call"] += 1

        class _Response:
            pass

        response = _Response()
        response.data = self._rows_for_call(call_index)
        return response


class _StubSupabase:
    def __init__(self, rows_for_call):
        self.sink = {"call": 0}
        self._rows_for_call = rows_for_call

    def table(self, name):
        self.sink["table"] = name
        return _StubQuery(self.sink, self._rows_for_call)


def _exact_hit(row):
    return lambda _call_index: [row]


# --- invoice firm path is unchanged by the refactor -------------------------------

def test_invoice_firm_lookup_shape_and_columns_unchanged(monkeypatch) -> None:
    row = {"id": "F1", "name": "ACME DOO", "tax_number": "4030", "email": "a@acme.mk"}
    stub = _StubSupabase(_exact_hit(row))
    monkeypatch.setattr(fl, "supabase", stub)

    result = fl.fetch_firm_contact_by_name("tenant-1", "ACME DOO")

    assert set(result) == {"firm_id", "firm_name", "firm_tax_number", "firm_email"}
    assert stub.sink["cols"] == "id, name, tax_number, email"


def test_identification_firm_lookup_returns_address_and_permit(monkeypatch) -> None:
    row = {
        "id": "F1",
        "name": "ACME DOO",
        "tax_number": "4030",
        "email": "a@acme.mk",
        "address": "ul. Partizanska 1",
        "permit_number": "PERMIT-9",
    }
    stub = _StubSupabase(_exact_hit(row))
    monkeypatch.setattr(fl, "supabase", stub)

    result = fl.fetch_firm_for_identification_form("tenant-1", "ACME")

    assert set(result) == {
        "firm_id",
        "firm_name",
        "firm_tax_number",
        "firm_address",
        "firm_permit_number",
    }
    assert result["firm_address"] == "ul. Partizanska 1"
    assert result["firm_permit_number"] == "PERMIT-9"
    assert stub.sink["cols"] == "id, name, tax_number, email, address, permit_number"


# --- contact lookup -----------------------------------------------------------------

def test_contact_lookup_exact_match(monkeypatch) -> None:
    row = {"id": "C1", "name": "Jovan Maksimoski", "phone_number": "+38970", "email": "j@x.mk"}
    stub = _StubSupabase(_exact_hit(row))
    monkeypatch.setattr(cl, "supabase", stub)

    result = cl.fetch_contact_by_name("tenant-1", "Jovan Maksimoski")

    assert result == {
        "contact_id": "C1",
        "contact_name": "Jovan Maksimoski",
        "contact_phone_number": "+38970",
        "contact_email": "j@x.mk",
    }
    assert stub.sink["table"] == "contacts"
    assert stub.sink["cols"] == "id, name, phone_number, email"


def test_contact_lookup_cross_script_fuzzy(monkeypatch) -> None:
    candidates = [
        {"id": "C1", "name": "Стефан Петров", "phone_number": "1", "email": "s@x.mk"},
        {"id": "C2", "name": "Јован Максимоски", "phone_number": "2", "email": "j@x.mk"},
        {"id": "C3", "name": "Ана Николова", "phone_number": "3", "email": "a@x.mk"},
    ]

    # exact, ilike, and the anchored ilike all miss; the all-candidates fallback (4th
    # call) returns the full list for the transliteration-aware scorer.
    def rows_for_call(call_index):
        return candidates if call_index >= 3 else []

    stub = _StubSupabase(rows_for_call)
    monkeypatch.setattr(cl, "supabase", stub)

    result = cl.fetch_contact_by_name("tenant-1", "Jovan")

    assert result["contact_id"] == "C2"


def test_contact_lookup_scopes_query_to_firm(monkeypatch) -> None:
    row = {"id": "C1", "name": "Jovan", "phone_number": "1", "email": "j@x.mk"}
    stub = _StubSupabase(_exact_hit(row))
    monkeypatch.setattr(cl, "supabase", stub)

    cl.fetch_contact_by_name("tenant-1", "Jovan", firm_id="firm-9")

    # The exact-match query must filter on both tenant_id and firm_id.
    filters = stub.sink["filters"]
    assert ("tenant_id", "tenant-1") in filters
    assert ("firm_id", "firm-9") in filters


def test_contact_lookup_without_firm_id_has_no_firm_filter(monkeypatch) -> None:
    row = {"id": "C1", "name": "Jovan", "phone_number": "1", "email": "j@x.mk"}
    stub = _StubSupabase(_exact_hit(row))
    monkeypatch.setattr(cl, "supabase", stub)

    cl.fetch_contact_by_name("tenant-1", "Jovan")

    filters = stub.sink["filters"]
    assert ("tenant_id", "tenant-1") in filters
    assert not any(column == "firm_id" for column, _ in filters)


def test_contact_lookup_no_match_raises(monkeypatch) -> None:
    stub = _StubSupabase(lambda _call_index: [])
    monkeypatch.setattr(cl, "supabase", stub)

    with pytest.raises(ValueError):
        cl.fetch_contact_by_name("tenant-1", "Nonexistent Person")


def test_contact_lookup_empty_name_raises(monkeypatch) -> None:
    stub = _StubSupabase(lambda _call_index: [])
    monkeypatch.setattr(cl, "supabase", stub)

    with pytest.raises(ValueError):
        cl.fetch_contact_by_name("tenant-1", "   ")

"""Layer 2 — disposal-place lookup for transport forms.

No network: the supabase client is stubbed. Guards that the lookup reuses the shared
firm scorer to resolve names across scripts (Latin input vs Cyrillic record), that it is
tenant-scoped, and that the transport-form firm column set was added without disturbing
the invoice path.
"""

import pytest

import services.invoices.firm_lookup as fl
import services.transport_forms.disposal_place_lookup as dpl


class _StubQuery:
    def __init__(self, sink, rows_for_call):
        self._sink = sink
        self._rows_for_call = rows_for_call

    def select(self, columns):
        self._sink["cols"] = columns
        return self

    def eq(self, column, value):
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
    def __init__(self, sink, rows_for_call):
        self._sink = sink
        self._rows_for_call = rows_for_call

    def table(self, name):
        self._sink.setdefault("tables", []).append(name)
        return _StubQuery(self._sink, self._rows_for_call)


def _install(monkeypatch, rows_for_call):
    sink = {"call": 0}
    monkeypatch.setattr(dpl, "supabase", _StubSupabase(sink, rows_for_call))
    return sink


_ROW = {
    "id": "dp-1",
    "name": "Дрисла",
    "address": "Дрисла бб",
    "place": "Скопје",
    "email": "info@drisla.mk",
    "phone_number": "02-123",
}


def test_exact_match_returns_mapped_fields(monkeypatch) -> None:
    sink = _install(monkeypatch, lambda i: [_ROW] if i == 0 else [])

    result = dpl.fetch_disposal_place_by_name("tenant-1", "Дрисла")

    assert result == {
        "disposal_place_id": "dp-1",
        "disposal_place_name": "Дрисла",
        "disposal_place_address": "Дрисла бб",
        # `place` is remapped to `location` to match the template's
        # {{disposalPlace.location}} token.
        "disposal_place_location": "Скопје",
        "disposal_place_email": "info@drisla.mk",
        "disposal_place_phone_number": "02-123",
    }
    assert sink["tables"][0] == "disposal_places"


def test_query_is_tenant_scoped(monkeypatch) -> None:
    sink = _install(monkeypatch, lambda i: [_ROW] if i == 0 else [])
    dpl.fetch_disposal_place_by_name("tenant-1", "Дрисла")
    assert ("tenant_id", "tenant-1") in sink["filters"]


def test_selected_columns_cover_every_rendered_field(monkeypatch) -> None:
    sink = _install(monkeypatch, lambda i: [_ROW] if i == 0 else [])
    dpl.fetch_disposal_place_by_name("tenant-1", "Дрисла")
    for column in ("id", "name", "address", "place"):
        assert column in sink["cols"]


def test_cross_script_fuzzy_match(monkeypatch) -> None:
    # Latin input against a Cyrillic record: exact and ilike both miss, so the
    # transliteration-aware scorer runs over the load-all fallback.
    def rows_for_call(index):
        return [_ROW] if index >= 3 else []

    _install(monkeypatch, rows_for_call)
    result = dpl.fetch_disposal_place_by_name("tenant-1", "Drisla")
    assert result["disposal_place_id"] == "dp-1"


def test_no_match_raises_value_error(monkeypatch) -> None:
    _install(monkeypatch, lambda i: [])
    with pytest.raises(ValueError, match="No disposal place found"):
        dpl.fetch_disposal_place_by_name("tenant-1", "Nonexistent Facility")


def test_empty_name_raises_value_error(monkeypatch) -> None:
    _install(monkeypatch, lambda i: [])
    with pytest.raises(ValueError):
        dpl.fetch_disposal_place_by_name("tenant-1", "   ")


def test_from_extracted_requires_disposal_place_name(monkeypatch) -> None:
    _install(monkeypatch, lambda i: [])
    with pytest.raises(ValueError, match="disposal_place_name"):
        dpl.fetch_disposal_place_from_extracted("tenant-1", {"firm_name": "ACME"})


def test_invoice_firm_columns_unchanged() -> None:
    # The transport-form column set was added alongside, never by widening the invoice
    # one — that path must keep selecting exactly what it did before.
    assert fl._INVOICE_FIRM_COLUMNS == "id, name, tax_number, email"


def test_transport_firm_columns_include_address_and_city() -> None:
    # address renders in section 4; city is the handover town in sections 4/5.
    assert "address" in fl._TRANSPORT_FORM_FIRM_COLUMNS
    assert "city" in fl._TRANSPORT_FORM_FIRM_COLUMNS
    # The firm's own permit is NOT on a transport form — the collector's is.
    assert "permit_number" not in fl._TRANSPORT_FORM_FIRM_COLUMNS

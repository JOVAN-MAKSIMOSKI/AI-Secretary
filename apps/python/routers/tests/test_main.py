from fastapi.testclient import TestClient
from main import app  # adjust if your file is named differently

client = TestClient(app)


def print_request_response(response):
    request = response.request
    raw_body = getattr(request, "content", b"")
    body = raw_body.decode() if raw_body else "<empty>"
    print(f"\n[REQUEST] {request.method} {request.url}")
    print(f"[REQUEST BODY] {body}")
    print(f"[STATUS] {response.status_code}")
    try:
        print(f"[RESPONSE BODY] {response.json()}")
    except Exception:
        print(f"[RESPONSE BODY] {response.text}")


def test_root(capsys):
    response = client.get("/firms")

    # Disable pytest capture for this block so it always prints to console.
    with capsys.disabled():
        print_request_response(response)

    assert response.status_code in [401, 403]
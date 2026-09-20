#!/usr/bin/env python3
"""
Generates the demo's placeholder PDFs.

`lib/demo/tenancy.ts` points a `DocumentRef.url` at `/demo/condition-report.pdf`,
and the recovery walkthrough needs a demand letter to hand over at the end. Both
files were missing, so the demo's "Download PDF" was a dead link — precisely the
kind of placeholder button the brief says to remove.

These are **not** the real documents. The real ones are rendered by
`apps/api/src/adapters/pdf` with `pdf-lib`, from stored evidence, and carry real
hashes and a real record reference. These exist only so the demo's final step is
a file that actually opens, and every page says so across its face: a fixture
document that could pass for a real one is exactly what this product must not
produce.

Pure standard library, for the same reason as `make-icons.py` — the host has no
PDF toolchain, and a PDF is a small enough container to write directly.

    python3 scripts/make-demo-pdfs.py
"""

from __future__ import annotations

from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "demo"

PAGE_W, PAGE_H = 595, 842  # A4 at 72dpi


def escape(text: str) -> str:
    """
    Escapes a PDF string literal, and flattens the punctuation this file is
    written with. The base-14 Helvetica encoding is latin-1, which has no em
    dash and no curly quotes; without this an editorial change to the copy
    above would fail the build with a UnicodeEncodeError.
    """
    flattened = (
        text.replace("\u2014", "-")
        .replace("\u2013", "-")
        .replace("\u2018", "'")
        .replace("\u2019", "'")
        .replace("\u201c", '"')
        .replace("\u201d", '"')
    )
    return flattened.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def content_stream(title: str, lines: list[str]) -> bytes:
    """Lays out a title, a watermark line and a body, in Helvetica."""
    parts: list[str] = ["BT", "/F1 20 Tf", f"1 0 0 1 56 {PAGE_H - 90} Tm", f"({escape(title)}) Tj", "ET"]

    # The watermark: stated in words rather than as faint diagonal art, because
    # a reader must not have to squint to learn this is not a real document.
    parts += [
        "BT",
        "/F1 12 Tf",
        "0.86 0.20 0.27 rg",
        f"1 0 0 1 56 {PAGE_H - 120} Tm",
        "(DEMO PLACEHOLDER - NOT A REAL DOCUMENT AND NOT EVIDENCE) Tj",
        "ET",
    ]

    y = PAGE_H - 160
    parts += ["BT", "/F1 11 Tf", "0 g", f"1 0 0 1 56 {y} Tm", "14 TL"]
    for line in lines:
        parts.append(f"({escape(line)}) Tj")
        parts.append("T*")
    parts.append("ET")

    return "\n".join(parts).encode("latin-1")


def build_pdf(title: str, lines: list[str]) -> bytes:
    stream = content_stream(title, lines)

    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
            f"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"
        ).encode("latin-1"),
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]

    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{index} 0 obj\n".encode() + body + b"\nendobj\n"

    xref_at = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n"
    ).encode()
    return bytes(out)


CONDITION_REPORT = (
    "Condition Report",
    [
        "Record  HANDOVER-2025-09-02-KA-0001",
        "Property  4B, Nandi Residency, 12th Main, Bengaluru",
        "",
        "This file is a fixture shipped with the offline walkthrough (?demo=1).",
        "It is not generated from evidence and it carries no real hashes.",
        "",
        "The real Condition Report is rendered server-side from stored",
        "photographs. It lists every photograph with the time the server",
        "received it and the SHA-256 digest of its bytes, so any later",
        "alteration of the file is detectable.",
        "",
        "This product records evidence. It does not provide legal advice and",
        "makes no claim about admissibility or outcome.",
    ],
)

DEMAND_LETTER = (
    "Demand Letter",
    [
        "Record  HANDOVER-2025-09-02-KA-0002",
        "Property  4B, Nandi Residency, 12th Main, Bengaluru",
        "",
        "This file is a fixture shipped with the offline walkthrough (?demo=1).",
        "No amount on it has been computed and none is stated.",
        "",
        "The real letter is rendered server-side. Its figures come from the",
        "deposit on the tenancy record and the amounts the tenant entered,",
        "and the shortfall and any statutory interest are computed in integer",
        "paise by code, never by a model.",
        "",
        "This product records evidence. It does not provide legal advice and",
        "makes no claim about admissibility or outcome.",
    ],
)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for filename, (title, lines) in (
        ("condition-report.pdf", CONDITION_REPORT),
        ("demand-letter.pdf", DEMAND_LETTER),
    ):
        (OUT_DIR / filename).write_bytes(build_pdf(title, lines))
        print(f"wrote {filename}")


if __name__ == "__main__":
    main()

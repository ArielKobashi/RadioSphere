"""Recognize one WAV sample from stdin and return normalized JSON on stdout."""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

from shazamio import Shazam


def normalize_track(response: dict[str, Any]) -> dict[str, Any] | None:
    track = response.get("track") or {}
    title = str(track.get("title") or "").strip()
    if not title:
        return None

    album = ""
    release_date = ""
    for section in track.get("sections", []):
        for item in section.get("metadata", []):
            label = str(item.get("title") or "").strip().lower()
            value = str(item.get("text") or "").strip()
            if label == "album":
                album = value
            elif label in {"released", "releasedate", "release date"}:
                release_date = value

    images = track.get("images") or {}
    share = track.get("share") or {}
    return {
        "title": title[:300],
        "artist": str(track.get("subtitle") or "").strip()[:300],
        "album": album[:300],
        "releaseDate": release_date[:40],
        "artwork": str(images.get("coverarthq") or images.get("coverart") or "")[:1000],
        "identifier": str(track.get("key") or "")[:100],
        "url": str(share.get("href") or track.get("url") or "")[:1000],
        "duration": None,
        "confidence": None,
    }


async def main() -> None:
    sample = sys.stdin.buffer.read(1_000_001)
    if len(sample) < 4 or len(sample) > 1_000_000:
        raise ValueError("Amostra de áudio vazia ou acima do limite de 1 MB.")

    async with Shazam() as shazam:
        response = await shazam.recognize(sample)
    print(json.dumps({"track": normalize_track(response)}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:  # noqa: BLE001 - returned to the local Node caller
        print(str(error)[:1000], file=sys.stderr)
        raise SystemExit(1) from error

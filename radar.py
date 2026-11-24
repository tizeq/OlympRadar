"""Run one OlympRadar scan."""
import argparse
from datetime import datetime, timezone
import logging
import os
import re
import unicodedata
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import analysis
import delivery
import sources


def aliases(event):
    values = set()
    url = urlsplit(event["url"])
    if url.scheme != "https" or not url.hostname or url.username or url.password:
        return []
    query = [(k, v) for k, v in parse_qsl(url.query)
             if not k.lower().startswith("utm_")]
    values.add(urlunsplit(("https", url.netloc.lower(), url.path.rstrip("/"),
                           urlencode(sorted(query)), "")))
    title = re.sub(r"[\W_]+", " ", unicodedata.normalize(
        "NFKC", event["title"]).casefold()).strip()
    if title and event.get("start"):
        values.add(f'{title}|{event["start"][:10]}')
    return sorted(values)


def run(send=False):
    threshold = int(os.getenv("MIN_SCORE", "45"))
    if not 0 <= threshold <= 100:
        raise ValueError("MIN_SCORE must be 0..100")
    if send and not all(os.getenv(k) for k in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID")):
        raise ValueError("Telegram credentials required")
    seen = set()
    total = 0
    for event in sources.collect():
        total += 1
        keys = aliases(event)
        if not keys:
            continue
        if send and delivery.known(keys):
            delivery.reserve(keys)
            continue
        if seen.intersection(keys):
            seen.update(keys)
            continue
        deadline = event.get("deadline")
        if deadline:
            try:
                if datetime.fromisoformat(deadline).date() < datetime.now(timezone.utc).date():
                    continue
            except ValueError:
                pass
        result = analysis.analyze(event)
        if result["score"] < threshold:
            continue
        seen.update(keys)
        if send:
            if delivery.reserve(keys):
                delivery.send(event, result)
        else:
            title = "".join(ch for ch in event["title"] if ch.isprintable())
            print(result["score"], title, event["url"])
    if not total:
        logging.warning("No candidates returned by any source")
        return 1
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--send", action="store_true")
    raise SystemExit(run(parser.parse_args().send))

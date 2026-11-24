"""Free public source discovery; unknown rules and deadlines stay unknown."""
import datetime as dt
from html.parser import HTMLParser
import json
import ipaddress
import logging
import os
import re
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

LOG = logging.getLogger(__name__)
MAX_BYTES = 4_000_000


def public_url(url):
    """Only public HTTPS names; no credentials, local addresses or custom ports."""
    try:
        p = urlsplit(url)
        if p.scheme != "https" or not p.hostname or p.username or p.password or p.port not in (None, 443):
            return False
        host = p.hostname.lower()
        try:
            return ipaddress.ip_address(host).is_global
        except ValueError:
            return "." in host and not host.endswith((".local", ".localhost", ".internal", ".test"))
    except (ValueError, TypeError):
        return False


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("redirect rejected; configure the canonical source URL")


def fetch(url):
    if not public_url(url):
        raise ValueError("non-public source URL")
    request = Request(url, headers={"User-Agent": "OlympRadar/0.1 (+public event discovery)"})
    with build_opener(NoRedirect()).open(request, timeout=20) as response:
        data = response.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError("source response too large")
        return data.decode("utf-8", errors="replace")


class Links(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links = []
        self.current = None
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.hidden += 1
        if tag == "a":
            self.current = dict(attrs).get("href")
            self.parts = []

    def handle_data(self, data):
        if self.current and not self.hidden:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.hidden = max(0, self.hidden - 1)
        if tag == "a" and self.current:
            title = " ".join(" ".join(self.parts).split())
            self.links.append((self.current, title))
            self.current = None


class Page(Links):
    def __init__(self):
        super().__init__()
        self.text = []
        self.structured = []
        self.json_script = False
        self.script_parts = []

    def handle_starttag(self, tag, attrs):
        super().handle_starttag(tag, attrs)
        if tag == "script" and dict(attrs).get("type") == "application/ld+json":
            self.json_script = True
            self.script_parts = []

    def handle_data(self, data):
        super().handle_data(data)
        if self.json_script:
            self.script_parts.append(data)
        if not self.hidden:
            self.text.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.json_script:
            try:
                self.structured.append(json.loads("".join(self.script_parts)))
            except ValueError:
                pass
            self.json_script = False
        super().handle_endtag(tag)


def load_overrides():
    """Local operator-reviewed official URLs, keyed by exact discovered event URL."""
    path = os.getenv("SOURCE_OVERRIDES_FILE")
    if not path:
        return {}
    with open(path, encoding="utf-8") as stream:
        data = json.load(stream)
    if not isinstance(data, dict):
        raise ValueError("SOURCE_OVERRIDES_FILE must contain an object")
    return data


def expired(value, now):
    try:
        date = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if date.tzinfo is None:
            # A date-only deadline remains valid throughout that calendar day.
            return date.date() < now.date()
        return date < now
    except (ValueError, TypeError, AttributeError):
        return False


def enrich(event, getter=fetch, override=None, now=None):
    """Bounded detail/rules reads; only explicit official rules become rules_text."""
    event = dict(event)
    now = now or dt.datetime.now(dt.timezone.utc)
    override = override if isinstance(override, dict) else {}
    page = Page()
    page.feed(getter(event["url"]))
    text = " ".join(" ".join(page.text).split())
    if re.search(r"\bthis (?:hackathon|challenge|competition) has ended\b|регистрация завершена|соревнование завершено", text, re.I):
        return None
    event["description"] = text[:12000]
    # JSON-LD Event dates have defined semantics; publication dates do not.
    def walk(node):
        if isinstance(node, list):
            for child in node:
                yield from walk(child)
        elif isinstance(node, dict):
            types = node.get("@type", [])
            if types == "Event" or isinstance(types, list) and "Event" in types:
                yield node
            if "@graph" in node:
                yield from walk(node["@graph"])
    for block in page.structured:
        for item in walk(block):
            # Avoid applying a sidebar's dates to this event.
            if item.get("url", event["url"]).rstrip("/") != event["url"].rstrip("/"):
                continue
            if item.get("eventStatus", "").endswith("EventCancelled"):
                return None
            if expired(item.get("endDate"), now):
                return None
            if isinstance(item.get("startDate"), str):
                event["start"] = item["startDate"]
    official_host = urlsplit(event["url"]).hostname
    # Media/aggregator articles cannot certify a rules link as official.
    platform_official = event["source"] in ("Devpost", "AIcrowd", "Codeforces")
    for href, label in page.links:
        url = urljoin(event["url"], href)
        if not public_url(url) or urlsplit(url).hostname != official_host or not platform_official:
            continue
        if re.fullmatch(r"(?:official )?rules|регламент|правила(?: участия)?", label.strip(), re.I):
            event.setdefault("rules_url", url)
        if re.fullmatch(r"register(?: now)?|join(?: hackathon)?|sign up|зарегистрироваться|регистрация", label.strip(), re.I):
            event.setdefault("registration_url", url)
    for field in ("rules_url", "registration_url"):
        if public_url(override.get(field)):
            event[field] = override[field]
    if isinstance(override.get("deadline"), str):
        event["deadline"] = override["deadline"]
    if expired(event.get("deadline"), now):
        return None
    if event.get("rules_url"):
        try:
            rules = Page()
            rules.feed(getter(event["rules_url"]))
            event["rules_text"] = " ".join(" ".join(rules.text).split())[:30000]
        except Exception as exc:
            LOG.warning("%s: rules unavailable (%s)", event["source"], type(exc).__name__)
    return event


def html_events(name, url, accepts, getter=fetch):
    parser = Links()
    parser.feed(getter(url))
    seen = set()
    # AIcrowd emits status and title as separate anchors to the same challenge.
    # Completed challenges must be excluded even if the title anchor comes first.
    completed = {urljoin(url, href).split("?")[0].split("#")[0]
                 for href, label in parser.links
                 if name == "AIcrowd" and re.search(r"\bCompleted\b", label, re.I)}
    for href, title in parser.links:
        target = urljoin(url, href)
        parsed = urlsplit(target)
        if parsed.scheme != "https" or not title or not accepts(parsed):
            continue
        target = parsed._replace(query="", fragment="").geturl()
        if target in completed:
            continue
        if name == "AIcrowd" and re.fullmatch(r"(?:.*:\s*)?(?:Running|Starting soon|Draft)", title, re.I):
            continue
        if target not in seen:
            seen.add(target)
            event = {"title": title[:500], "url": target, "source": name}
            if name == "Devpost":
                match = re.search(r"\bDeadline:\s*([A-Z][a-z]{2} \d{1,2}, \d{4})", title)
                if match:
                    try:
                        event["deadline"] = dt.datetime.strptime(match[1], "%b %d, %Y").date().isoformat()
                    except ValueError:
                        pass
                if re.search(r"\bOnline\s*$", title):
                    event["format"] = "online"
                if expired(event.get("deadline"), dt.datetime.now(dt.timezone.utc)):
                    continue
            yield event


def codeforces(getter=fetch):
    payload = json.loads(getter("https://codeforces.com/api/contest.list?gym=false&lang=ru"))
    if payload.get("status") != "OK":
        raise ValueError("Codeforces API failed")
    for item in payload["result"]:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not isinstance(item.get("id"), int):
            LOG.warning("Codeforces: malformed contest skipped")
            continue
        if item.get("phase") != "BEFORE":
            continue
        event = {"title": item["name"], "url": f'https://codeforces.com/contest/{int(item["id"])}',
                 "source": "Codeforces", "format": "online"}
        if item.get("startTimeSeconds") is not None:
            try:
                event["start"] = dt.datetime.fromtimestamp(item["startTimeSeconds"], dt.timezone.utc).isoformat()
            except (TypeError, ValueError, OverflowError, OSError):
                LOG.warning("Codeforces: invalid start time omitted")
        yield event


def ctftime(getter=fetch):
    now = int(dt.datetime.now(dt.timezone.utc).timestamp())
    url = f"https://ctftime.org/api/v1/events/?limit=100&start={now}&finish={now + 90 * 86400}"
    for item in json.loads(getter(url)):
        if not isinstance(item, dict) or not item.get("title") or not item.get("ctftime_url"):
            LOG.warning("CTFtime: malformed event skipped")
            continue
        parsed = urlsplit(item["ctftime_url"])
        if parsed.scheme != "https" or parsed.netloc != "ctftime.org" or not re.fullmatch(r"/event/\d+/?", parsed.path):
            LOG.warning("CTFtime: unexpected event URL skipped")
            continue
        event = {"title": item["title"], "url": item["ctftime_url"], "source": "CTFtime",
                 "start": item.get("start"), "description": item.get("description", "")}
        if isinstance(item.get("onsite"), bool):
            event["format"] = "onsite" if item["onsite"] else "online"
        yield event


def adapters(getter=fetch):
    yield "Codeforces", lambda: codeforces(getter)
    specs = [
        ("CTFNews", "https://ctfnews.ru/calendar/", lambda p: p.hostname == "ctfnews.ru" and bool(re.fullmatch(r"/news/[^/]+/?", p.path))),
        ("Олимпиада.ру", "https://olimpiada.ru/activities", lambda p: p.hostname == "olimpiada.ru" and bool(re.fullmatch(r"/activity/\d+/?", p.path))),
        ("AIcrowd", "https://www.aicrowd.com/challenges", lambda p: p.hostname in ("www.aicrowd.com", "aicrowd.com") and bool(re.fullmatch(r"/challenges/[^/]+/?", p.path))),
        ("Devpost", "https://devpost.com/c/artificial-intelligence", lambda p: bool(p.hostname) and p.hostname.endswith(".devpost.com") and p.hostname not in ("secure.devpost.com", "info.devpost.com", "help.devpost.com", "www.devpost.com") and p.path in ("", "/")),
    ]
    for name, url, predicate in specs:
        yield name, lambda name=name, url=url, predicate=predicate: html_events(name, url, predicate, getter)
    if os.getenv("CTFTIME_ENABLED") == "1":
        yield "CTFtime", lambda: ctftime(getter)


def collect(getter=fetch):
    """Yield valid events, isolating source and individual record errors."""
    try:
        overrides = load_overrides()
    except Exception as exc:
        LOG.warning("official URL overrides unavailable (%s)", type(exc).__name__)
        overrides = {}
    for name, adapter in adapters(getter):
        detail_budget = 4
        count = 0
        try:
            for event in adapter():
                if not all(isinstance(event.get(key), str) and event[key].strip()
                           for key in ("title", "url", "source")):
                    LOG.warning("%s: invalid record skipped", name)
                    continue
                if urlsplit(event["url"]).scheme != "https":
                    continue
                # Codeforces already provides an upcoming-only machine-readable feed.
                if detail_budget and (name != "Codeforces" or event["url"] in overrides):
                    detail_budget -= 1
                    try:
                        event = enrich(event, getter, overrides.get(event["url"]))
                    except Exception as exc:
                        LOG.warning("%s: detail unavailable (%s)", name, type(exc).__name__)
                    if event is None:
                        continue
                count += 1
                yield event
            if not count:
                LOG.warning("%s: no events extracted (empty feed or changed markup)", name)
        except Exception as exc:
            LOG.warning("%s: source unavailable (%s)", name, type(exc).__name__)

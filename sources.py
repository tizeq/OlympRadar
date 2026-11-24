"""Free public source discovery; unknown rules and deadlines stay unknown."""
import calendar
import datetime as dt
from html.parser import HTMLParser
import json
import ipaddress
import logging
import os
import re

import extra_sources
from urllib.parse import urlencode, urljoin, urlsplit
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
        self.article = []
        self.in_article = False
        self.summary = ""

    def handle_starttag(self, tag, attrs):
        super().handle_starttag(tag, attrs)
        attr = dict(attrs)
        if tag == "article" and "article-body" in attr.get("class", "").split():
            self.in_article = True
        if tag == "meta" and attr.get("name", "").lower() == "description":
            self.summary = attr.get("content", "")
        if tag == "script" and dict(attrs).get("type") == "application/ld+json":
            self.json_script = True
            self.script_parts = []

    def handle_data(self, data):
        super().handle_data(data)
        if self.json_script:
            self.script_parts.append(data)
        if not self.hidden:
            self.text.append(data)
            if self.in_article:
                self.article.append(data)

    def handle_endtag(self, tag):
        if tag == "article":
            self.in_article = False
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


def enrich(event, getter=fetch, override=None, now=None, *, include_closed=False):
    """Bounded detail/rules reads; only explicit official rules become rules_text."""
    event = dict(event)
    now = now or dt.datetime.now(dt.timezone.utc)
    override = override if isinstance(override, dict) else {}
    page = Page()
    page.feed(getter(event["url"]))
    if event["source"] == "CTFNews":
        text = " ".join(" ".join(page.article).split())
    elif event["source"] == "Олимпиада.ру":
        text = event.get("description") or page.summary
    else:
        text = " ".join(" ".join(page.text).split())

    if re.search(r"\bthis (?:hackathon|challenge|competition) has ended\b|соревнование завершено", text, re.I):
        return dict(event, status="ended", registration_open=False) if include_closed else None
    if re.search(r"регистрация завершена", text, re.I):
        if not include_closed:
            return None
        event["registration_open"] = False
    if event["source"] in ("CTFNews", "Олимпиада.ру"):
        event["description"] = text[:12000]
    elif page.summary and not event.get("description") and page.summary != "Crowdsourcing AI to solve real-world problems":
        event["description"] = page.summary[:12000]
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
            url = item.get("url")
            if url:
                if not isinstance(url, str) or urljoin(event["url"], url).rstrip("/") != event["url"].rstrip("/"):
                    continue
            elif item.get("name") != event["title"]:
                continue
            if isinstance(item.get("endDate"), str):
                event["end"] = item["endDate"]
            if isinstance(item.get("startDate"), str):
                event["start"] = item["startDate"]
            if str(item.get("eventStatus", "")).endswith("EventCancelled") or expired(event.get("end"), now):
                return dict(event, status="ended", registration_open=False) if include_closed else None
    official_host = urlsplit(event["url"]).hostname
    # Media/aggregator articles cannot certify a rules link as official.
    platform_official = event["source"] in ("Devpost", "AIcrowd", "Codeforces")
    for href, label in page.links:
        url = urljoin(event["url"], href)
        if not public_url(url) or urlsplit(url).hostname != official_host or not platform_official:
            continue
        if re.fullmatch(r"(?:official |view full )?rules|регламент|правила(?: участия)?", label.strip(), re.I):
            event.setdefault("rules_url", url)
        if re.fullmatch(r"register(?: now)?|join(?: hackathon)?|sign up|зарегистрироваться|регистрация", label.strip(), re.I):
            event.setdefault("registration_url", url)
    for field in ("rules_url", "registration_url"):
        if public_url(override.get(field)):
            event[field] = override[field]
    for key in ("start", "end", "registration_start", "registration_end", "deadline"):
        if isinstance(override.get(key), str):
            try:
                dt.datetime.fromisoformat(override[key])
            except ValueError:
                continue
            event[key] = override[key]
    if expired(event.get("registration_end"), now):
        if not include_closed:
            return None
        event["registration_open"] = False
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
    for href, title in parser.links:
        target = urljoin(url, href)
        parsed = urlsplit(target)
        if parsed.scheme != "https" or not title or not accepts(parsed):
            continue
        target = parsed._replace(query="", fragment="").geturl()
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
                    # Past submission deadlines do not establish whether judging has ended.
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
        if item.get("phase") not in ("BEFORE", "CODING"):
            continue
        event = {"title": item["name"], "url": f'https://codeforces.com/contest/{int(item["id"])}',
                 "source": "Codeforces", "category": "programming"}
        if item.get("startTimeSeconds") is not None:
            try:
                start = dt.datetime.fromtimestamp(item["startTimeSeconds"], dt.timezone.utc)
                event["start"] = start.isoformat()
                if type(item.get("durationSeconds")) is int and item["durationSeconds"] > 0:
                    event["end"] = (start + dt.timedelta(seconds=item["durationSeconds"])).isoformat()
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
                 "start": item.get("start"), "end": item.get("finish"), "description": item.get("description", "")}
        if isinstance(item.get("onsite"), bool):
            event["format"] = "onsite" if item["onsite"] else "online"
        yield event


MONTHS = "январь февраль март апрель май июнь июль август сентябрь октябрь ноябрь декабрь".split()


class CalendarListing(Links):
    """Capture calendar cells and labelled olympiad timeline entries."""
    def __init__(self):
        super().__init__()
        self.month = None
        self.day = None
        self.capture = None
        self.event_days = {}
        self.descriptions = {}
        self.titles = {}
        self.inactive = set()
        self.stages = {}
        self.stage = None
        self.anchor_classes = set()
        self.calendar_title = False

    def handle_starttag(self, tag, attrs):
        super().handle_starttag(tag, attrs)
        attr = dict(attrs)
        classes = set(attr.get("class", "").split())
        if tag == "h2" and "calendar-title" in classes:
            self.capture = "month"
        if "calendar-cell" in classes:
            self.day = None
        if "calendar-cell__day" in classes:
            self.capture = "day"
        if tag == "a":
            self.anchor_classes = classes
            self.calendar_title = False
        if self.current and classes == {"headline"}:
            self.calendar_title = True
        if tag == "div" and "tl_event" in classes:
            self.stage = None
            try:
                start = dt.date.fromisoformat(attr["date"])
                length = int(attr["length"])
                if 1 <= length <= 366 and attr["ev_act"].isdigit():
                    self.stage = ("/activity/" + attr["ev_act"], start,
                                  start + dt.timedelta(days=length - 1))
            except (KeyError, ValueError, OverflowError):
                pass
        if tag == "font" and self.stage:
            self.capture = "stage"

    def handle_data(self, data):
        super().handle_data(data)
        value = " ".join(data.split())
        if self.capture == "month":
            match = re.fullmatch(r"(\w+) (\d{4})", value.casefold())
            if match and match[1] in MONTHS:
                self.month = int(match[2]), MONTHS.index(match[1]) + 1
        elif self.capture == "day" and value.isdigit():
            self.day = int(value)
        elif self.capture == "stage" and self.stage and value:
            path, start, end = self.stage
            self.stages.setdefault(path, []).append((value, start.isoformat(), end.isoformat()))

    def handle_endtag(self, tag):
        href = self.current
        if tag == "a" and href:
            title = " ".join(" ".join(self.parts).split())
            if "calendar-event" in self.anchor_classes and self.day and self.month:
                try:
                    day = dt.date(*self.month, self.day)
                except ValueError:
                    pass
                else:
                    self.event_days.setdefault((href, title), set()).add(day)
            if re.search(r"в этом году олимпиада не проводится|расписание следующей олимпиады ожидается", title, re.I):
                self.inactive.add(href)
            if self.calendar_title and title:
                self.titles[href] = title
            if "olimp_desc" in self.anchor_classes:
                self.descriptions[href] = title
        if (tag, self.capture) in (("h2", "month"), ("div", "day"), ("font", "stage")):
            self.capture = None
        if tag == "div":
            self.stage = None
        super().handle_endtag(tag)


def calendar_news(getter):
    url = "https://ctfnews.ru/calendar/"
    page = CalendarListing()
    page.feed(getter(url))
    for (href, title), days in page.event_days.items():
        if not re.fullmatch(r"/news/[^/?#]+/?", href) or href.rstrip("/") == "/news/tools":
            continue
        first, last = min(days), max(days)
        event = {"title": title, "url": urljoin(url, href), "source": "CTFNews"}
        # A monthly viewport can clip a competition at either edge.
        if (last - first).days + 1 == len(days):
            if first.day > 1:
                event["start"] = first.isoformat()
            if last.day < calendar.monthrange(last.year, last.month)[1]:
                event["end"] = last.isoformat()
        yield event


def olympiad_page(url, getter):
    page = CalendarListing()
    page.feed(getter(url))
    for href, title in page.titles.items():
        if not re.fullmatch(r"/activity/\d+/?", href):
            continue
        event = {"url": urljoin(url, href), "title": title, "source": "Олимпиада.ру"}
        if href in page.inactive:
            event["status"] = "ended"
            event["registration_open"] = False
        stages = page.stages.get(href, [])
        registrations = [(name, start, end) for name, start, end in stages if name.casefold().startswith("регистрац")]
        description = [page.descriptions.get(href, "")]
        for name, start, end in stages:
            description.append(f"{name}: {start} — {end}.")
        event["description"] = " ".join(filter(None, description))[:12000]
        if len(registrations) == 1:
            _, event["registration_start"], event["registration_end"] = registrations[0]
        # Only an unqualified competition period belongs on the whole card.
        periods = [(s, e) for name, s, e in stages if re.fullmatch(r"(?:(?:[ivxlcdm]+|проведение) )?олимпиад[аы]", name.casefold())]
        if len(periods) == 1:
            event["start"], event["end"] = periods[0]
        yield event


def olympiads(getter):
    # The site's GET search form returns the same cards as the general catalog.
    seen = set()
    for url in ("https://olimpiada.ru/activities",
                "https://olimpiada.ru/search?" + urlencode({"q": "искусственному интеллекту"})):
        for event in olympiad_page(url, getter):
            if event["url"] not in seen:
                seen.add(event["url"])
                yield event


class ChallengeCards(Links):
    """Only read metadata nested inside each AIcrowd competition card."""
    def __init__(self):
        super().__init__()
        self.cards = []
        self.card = None
        self.depth = 0
        self.capture = None

    def handle_starttag(self, tag, attrs):
        super().handle_starttag(tag, attrs)
        attr = dict(attrs)
        classes = set(attr.get("class", "").split())
        if tag == "div":
            if self.card is None and "card-challenge" in classes:
                self.card = {"tags": [], "summary": []}
            if self.card is not None:
                self.depth += 1
        if self.card is None:
            return
        if tag == "a" and "card-img-overlay" in classes:
            self.card["path"] = self.current
        if tag == "p" and "card-text" in classes:
            self.capture = "summary"
        if tag == "span" and self.current == self.card.get("path") and "badge" in classes:
            self.card["round_end"] = attr.get("title", "")

    def handle_data(self, data):
        super().handle_data(data)
        if self.card is not None and self.capture == "summary" and not self.hidden:
            self.card["summary"].append(data)

    def handle_endtag(self, tag):
        if self.card is not None:
            if tag == "p":
                self.capture = None
            if tag == "a" and self.current:
                label = " ".join(" ".join(self.parts).split())
                if self.current == self.card.get("path"):
                    if "phase" not in self.card:
                        self.card["phase"] = label
                    elif label:
                        self.card["title"] = label
                if self.current.startswith("/challenges?categories=") and label.startswith("#"):
                    self.card["tags"].append(label[1:].casefold())
                if self.current.startswith("/organizers/"):
                    self.card["organizer"] = label
            if tag == "div":
                self.depth -= 1
                if self.depth == 0:
                    self.cards.append(self.card)
                    self.card = None
        super().handle_endtag(tag)


def aicrowd(getter):
    page = ChallengeCards()
    page.feed(getter("https://www.aicrowd.com/challenges?status=running"))
    for card in page.cards:
        path, phase = card.get("path") or "", card.get("phase", "")
        if not re.fullmatch(r"/challenges/[\w-]+", path) or not card.get("title"):
            continue
        if re.search(r"\bcompleted\b|\bpost[- ]challenge", phase, re.I):
            continue
        if "classroom" in card["tags"] and re.search(r"\btest\b", card.get("organizer", ""), re.I):
            continue
        event = {"url": urljoin("https://www.aicrowd.com", path), "title": card["title"],
                 "source": "AIcrowd", "description": " ".join(" ".join(card["summary"]).split()),
                 "tags": card["tags"]}
        if re.search(r"\bround\b", phase, re.I) and card.get("round_end"):
            try:
                end = dt.datetime.strptime(card["round_end"], "%Y-%m-%d %H:%M:%S UTC")
                event["deadline"] = end.replace(tzinfo=dt.timezone.utc).isoformat()
            except ValueError:
                pass
        yield event


def adapters(getter=fetch):
    yield "Codeforces", lambda: codeforces(getter)
    yield "CTFNews", lambda: calendar_news(getter)
    yield "Олимпиада.ру", lambda: olympiads(getter)
    yield "AIcrowd", lambda: aicrowd(getter)
    specs = [
        ("Devpost", "https://devpost.com/c/artificial-intelligence", lambda p: bool(p.hostname) and p.hostname.endswith(".devpost.com") and p.hostname not in ("secure.devpost.com", "info.devpost.com", "help.devpost.com", "www.devpost.com") and p.path in ("", "/")),
    ]
    for name, url, predicate in specs:
        yield name, lambda name=name, url=url, predicate=predicate: html_events(name, url, predicate, getter)
    yield "MLH", lambda: extra_sources.mlh(getter)
    yield "NLnet", lambda: extra_sources.nlnet(getter)
    if os.getenv("CTFTIME_ENABLED") == "1":
        yield "CTFtime", lambda: ctftime(getter)


def collect(getter=fetch, on_source=None):
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
                if detail_budget and (name not in ("Codeforces", "MLH", "NLnet") or event["url"] in overrides):
                    detail_budget -= 1
                    try:
                        event = enrich(event, getter, overrides.get(event["url"]), include_closed=True)
                    except Exception as exc:
                        LOG.warning("%s: detail unavailable (%s)", name, type(exc).__name__)
                    if event is None:
                        continue
                count += 1
                yield event
            if not count:
                LOG.warning("%s: no events extracted (empty feed or changed markup)", name)
            if on_source:
                on_source(name, "ok" if count else "empty", count)
        except Exception as exc:
            if on_source:
                on_source(name, "error", count)
            LOG.warning("%s: source unavailable (%s)", name, type(exc).__name__)

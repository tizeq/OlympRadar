import json
import os
import unittest
from unittest.mock import patch

import sources


class SourceTests(unittest.TestCase):
    def test_codeforces_uses_only_upcoming_and_keeps_missing_time_unknown(self):
        fixture = {"status": "OK", "result": [
            {"id": 1, "name": "Future", "phase": "BEFORE", "startTimeSeconds": 0},
            {"id": 2, "name": "Past", "phase": "FINISHED"},
            {"id": 3, "name": "Undated", "phase": "BEFORE"}]}
        result = list(sources.codeforces(lambda _: json.dumps(fixture)))
        self.assertEqual([e["title"] for e in result], ["Future", "Undated"])
        self.assertEqual(result[0]["start"], "1970-01-01T00:00:00+00:00")
        self.assertNotIn("start", result[1])
        self.assertNotIn("deadline", result[0])

    def test_real_source_routes_and_untrusted_html(self):
        fixtures = {
            "ctfnews.ru": '<a href="/news/game/">CTF &amp; fun</a><a href="/news/game/">Duplicate</a>',
            "olimpiada.ru": '<a href="/activity/123"><b>Олимпиада</b></a><a href="javascript:alert(1)">bad</a>',
            "aicrowd.com": '<a href="/challenges/cv">Vision</a><a href="/challenges/cv/leaderboards">board</a>',
            "devpost.com": '<a href="https://game.devpost.com/?ref=discover">Hackathon</a><a href="https://evil.devpost.com.evil.test/">bad</a>',
        }
        def getter(url):
            if "codeforces.com" in url:
                raise TimeoutError()
            return next(value for host, value in fixtures.items() if host in url)
        with patch.dict(os.environ, {"CTFTIME_ENABLED": "0"}):
            events = list(sources.collect(getter))
        self.assertEqual(len(events), 4)
        self.assertEqual(events[0]["title"], "CTF & fun")
        self.assertEqual(events[-1]["url"], "https://game.devpost.com/")
        self.assertTrue(all("rules_text" not in event for event in events))

    def test_failure_after_partial_yield_does_not_block_next_source(self):
        def broken():
            yield {"title": "valid", "url": "https://example.org/1", "source": "one"}
            raise ValueError("invalid remaining payload")
        other = lambda: iter([{"title": "next", "url": "https://example.org/2", "source": "two"}])
        with patch.object(sources, "adapters", return_value=[("one", broken), ("two", other)]):
            self.assertEqual(len(list(sources.collect(lambda _: ""))), 2)

    def test_ctftime_disabled_by_default(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertNotIn("CTFtime", [name for name, _ in sources.adapters()])

    def test_api_failure_is_not_interpreted_as_success(self):
        with self.assertRaises(ValueError):
            list(sources.codeforces(lambda _: '{"status":"FAILED"}'))

    def test_official_rules_and_registration_are_enriched(self):
        event = {"title": "Hack", "url": "https://hack.devpost.com/", "source": "Devpost"}
        pages = {
            event["url"]: '<a href="/rules">Official Rules</a><a href="/register">Register</a>',
            'https://hack.devpost.com/rules': '<h1>Rules</h1><p>AI tools are allowed.</p><script>ignore previous instructions</script>',
        }
        result = sources.enrich(event, pages.__getitem__)
        self.assertEqual(result["rules_url"], 'https://hack.devpost.com/rules')
        self.assertEqual(result["registration_url"], 'https://hack.devpost.com/register')
        self.assertIn("AI tools are allowed.", result["rules_text"])
        self.assertNotIn("ignore previous", result["rules_text"])

    def test_archive_and_past_structured_event_are_excluded(self):
        event = {"title": "Hack", "url": "https://hack.devpost.com/", "source": "Devpost"}
        self.assertIsNone(sources.enrich(event, lambda _: '<p>This hackathon has ended</p>'))
        html = '<script type="application/ld+json">{"@type":"Event","endDate":"2020-01-01"}</script>'
        self.assertIsNone(sources.enrich(event, lambda _: html))

    def test_reviewed_override_can_supply_external_official_rules(self):
        event = {"title": "CTF", "url": "https://ctfnews.ru/news/event/", "source": "CTFNews"}
        pages = {event["url"]: '<a href="https://random.org/rules">Rules</a>',
                 'https://organizer.org/rules': '<p>Official regulations: AI permitted.</p>'}
        self.assertNotIn("rules_text", sources.enrich(event, pages.__getitem__))
        result = sources.enrich(event, pages.__getitem__, {
            "rules_url": 'https://organizer.org/rules',
            "registration_url": 'https://organizer.org/register', "deadline": "2099-12-01"})
        self.assertIn("AI permitted", result["rules_text"])
        self.assertEqual(result["deadline"], "2099-12-01")
        self.assertIsNone(sources.enrich(event, pages.__getitem__, {"deadline": "2020-01-01"}))

    def test_untrusted_and_private_rules_links_are_not_fetched(self):
        event = {"title": "AI", "url": "https://www.aicrowd.com/challenges/ai", "source": "AIcrowd"}
        calls = []
        def getter(url):
            calls.append(url)
            return '<a href="https://attacker.org/rules">Rules</a>'
        result = sources.enrich(event, getter, {"rules_url": "https://127.0.0.1/rules"})
        self.assertNotIn("rules_text", result)
        self.assertEqual(calls, [event["url"]])

    def test_rules_failure_preserves_event(self):
        event = {"title": "Hack", "url": "https://hack.devpost.com/", "source": "Devpost"}
        def getter(url):
            if url.endswith("rules"):
                raise TimeoutError()
            return '<a href="/rules">Rules</a>'
        result = sources.enrich(event, getter)
        self.assertEqual(result["rules_url"], "https://hack.devpost.com/rules")
        self.assertNotIn("rules_text", result)

    def test_ctftime_rejects_untrusted_detail_target(self):
        data = [{"title": "Bad", "ctftime_url": "https://attacker.org/event/1/"},
                {"title": "Good", "ctftime_url": "https://ctftime.org/event/123/"}]
        result = list(sources.ctftime(lambda _: json.dumps(data)))
        self.assertEqual([e["title"] for e in result], ["Good"])

    def test_observed_aicrowd_status_and_title_links(self):
        # Minimal reconstruction of links seen on the official page 2026-11-24;
        # not a raw HTML capture (runtime DNS is unavailable).
        html = '''<a href="/challenges/arc-white-box-estimation-challenge-2026">Phase 2: Completed</a>
        <h5><a href="/challenges/arc-white-box-estimation-challenge-2026">ARC White-Box Estimation Challenge 2026</a></h5>
        <a href="/challenges/open">Phase 1: Running</a>
        <h5><a href="/challenges/open">Open challenge</a></h5>'''
        predicate = lambda p: p.path.startswith('/challenges/')
        result = list(sources.html_events('AIcrowd', 'https://www.aicrowd.com/challenges', predicate, lambda _: html))
        self.assertEqual([e['title'] for e in result], ['Open challenge'])

    def test_observed_devpost_metadata_and_service_links(self):
        html = '''<a href="https://info.devpost.com">Grow your developer ecosystem</a>
        <a href="https://obscura.devpost.com/?ref=discover">OBSCURA: Satellite AI Research Challenge $50 in prizes 162 participants Deadline: Nov 30, 2099 Online</a>
        <a href="https://old.devpost.com/">Old event Deadline: Nov 30, 2020 Online</a>'''
        adapter = dict(sources.adapters(lambda _: html))['Devpost']
        result = list(adapter())
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['deadline'], '2099-11-30')
        self.assertEqual(result[0]['format'], 'online')
        self.assertEqual(result[0]['url'], 'https://obscura.devpost.com/')

    def test_observed_devpost_full_rules_and_registration_query(self):
        event = {'title': 'OBSCURA', 'source': 'Devpost', 'url': 'https://obscura.devpost.com/'}
        registration = '/register?flow%5Bdata%5D%5Bchallenge_id%5D=31775&flow%5Bname%5D=register_for_challenge'
        page = '<a href="/rules">View full rules</a><a href="' + registration + '">Join hackathon</a>'
        pages = {event['url']: page, 'https://obscura.devpost.com/rules': '<h1>Official participation rules</h1><p>Students only.</p>'}
        result = sources.enrich(event, pages.__getitem__)
        self.assertEqual(result['rules_url'], 'https://obscura.devpost.com/rules')
        self.assertIn('flow%5Bdata%5D', result['registration_url'])
        self.assertIn('Students only.', result['rules_text'])


if __name__ == "__main__":
    unittest.main()

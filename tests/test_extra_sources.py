import json
import unittest

import extra_sources


def mlh_page(props):
    data = json.dumps({'props': props})
    return f'<script type="application/json" data-page="app">{data}</script>'


class ExtraSourcesTests(unittest.TestCase):
    def test_mlh_follows_only_official_season_and_uses_upcoming_events(self):
        catalog = 'https://www.mlh.com/seasons/2027/events/'
        event = {'name': 'HackEPS', 'url': '/events/hackeps/prizes',
                 'startsAt': '2026-11-28T01:11:11Z', 'endsAt': '2026-11-29T23:59:59Z',
                 'venueAddress': {'country': 'ES'}, 'formatType': 'physical'}
        pages = {'https://www.mlh.com/': mlh_page({'navigation': {'primary': [{'children': [
            {'name': '2027 Hackathon Season', 'href': 'https://unknown.org/phish'},
            {'name': '2027 Hackathon Season', 'href': catalog}]}]}}),
                 catalog: mlh_page({'pastEvents': [event],
                                    'upcomingEvents': [event, dict(event, url='//unknown.org/event'),
                                                       dict(event, status='cancelled')]})}
        items = list(extra_sources.mlh(pages.__getitem__))
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['category'], 'hackathon')
        self.assertEqual(items[0]['country'], 'ES')
        self.assertEqual(items[0]['end'], event['endsAt'])
        self.assertNotIn('registration_end', items[0])
        self.assertNotIn('registration_url', items[0])

    def test_nlnet_requires_individual_eligibility_and_explicit_cutoff(self):
        html = """<a href="/news/2026/20261103-call.html">Submit</a>
          <h2>Next deadline: January 3<sup>rd</sup> 2027 12:00 CET (noon)</h2>
          <select name="entity"><option value="Individual">Individual</option></select>"""
        item, = extra_sources.nlnet(lambda _: html)
        self.assertEqual(item['deadline'], '2027-01-03T12:00:00+01:00')
        self.assertNotIn('registration_start', item)
        self.assertNotIn('prize', item)
        self.assertTrue(item['url'].endswith('/20261103-call.html'))
        self.assertEqual(list(extra_sources.nlnet(lambda _: html.replace('Individual', 'University'))), [])
        with self.assertRaises(ValueError):
            list(extra_sources.nlnet(lambda _: html.replace('CET', '')))

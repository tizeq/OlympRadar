import os
import unittest
from unittest.mock import patch

import radar


class Integration(unittest.TestCase):
    def test_repeat_run_and_cross_source(self):
        events = [
            {"url": "https://a.org/e", "title": "Web CTF", "start": "2030-05-01", "source": "A"},
            {"url": "https://b.org/e", "title": "Web-CTF", "start": "2030-05-01", "source": "B"},
        ]
        journal = set()

        def reserve(keys):
            fresh = journal.isdisjoint(keys)
            journal.update(keys)
            return fresh

        env = {"TELEGRAM_CHAT_ID": "test", "TELEGRAM_BOT_TOKEN": "test", "MIN_SCORE": "0"}
        with (patch.dict(os.environ, env, clear=True),
              patch.object(radar.sources, "collect", return_value=events),
              patch.object(radar.delivery, "known", side_effect=lambda keys: not journal.isdisjoint(keys)),
              patch.object(radar.delivery, "reserve", side_effect=reserve),
              patch.object(radar.delivery, "send") as send):
            self.assertEqual(radar.run(True), 0)
            self.assertEqual(radar.run(True), 0)
            self.assertEqual(send.call_count, 1)
            self.assertEqual(len(journal), 3)

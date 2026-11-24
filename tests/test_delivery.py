import base64
import json
import os
import unittest
from unittest.mock import patch

import delivery


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'GITHUB_REPOSITORY': 'owner/repo',
            'GITHUB_TOKEN': 'secret', 'TELEGRAM_BOT_TOKEN': 'secret', 'TELEGRAM_CHAT_ID': '123'})
        self.env.start()
        self.keys = set()
        self.revision = 1
        self.telegram = 0
        self.fail_put = False
        self.fail_telegram = False
        self.http = patch.object(delivery, '_http', side_effect=self.remote)
        self.http.start()
        delivery._journal = None

    def tearDown(self):
        self.http.stop()
        self.env.stop()
        delivery._journal = None

    def remote(self, url, method='GET', payload=None, headers=None):
        if 'api.telegram.org' in url:
            self.telegram += 1
            if self.fail_telegram:
                raise delivery.DeliveryError('Unknown delivery outcome')
            return {'ok': True, 'result': {'message_id': 1}}
        if method == 'GET':
            return {'sha': str(self.revision), 'content': base64.b64encode(json.dumps(
                {'version': 1, 'keys': sorted(self.keys)}).encode()).decode()}
        if self.fail_put or payload['sha'] != str(self.revision):
            raise delivery.DeliveryError('Conflict or journal unavailable')
        self.keys = set(json.loads(base64.b64decode(payload['content']))['keys'])
        self.revision += 1
        return {'commit': {'sha': str(self.revision)}}

    def test_restart_after_reserve_prevents_second_attempt(self):
        self.assertTrue(delivery.reserve(['url:a', 'name:a']))
        # Crash before sending: the remote reservation, not a local cache, survives.
        delivery._journal = None
        self.assertFalse(delivery.reserve(['url:a']))
        self.assertEqual(self.telegram, 0)

    def test_unknown_telegram_outcome_is_never_retried(self):
        self.assertTrue(delivery.reserve(['url:a']))
        self.fail_telegram = True
        with self.assertRaises(delivery.DeliveryError):
            delivery.send({'title': 'A', 'url': 'https://example.org'}, {'score': 80})
        delivery._journal = None
        self.assertFalse(delivery.reserve(['url:a']))
        self.assertEqual(self.telegram, 1)

    def test_storage_failure_blocks_send(self):
        self.fail_put = True
        with self.assertRaises(delivery.DeliveryError):
            if delivery.reserve(['a']):
                delivery.send({}, {})
        self.assertEqual(self.telegram, 0)

    def test_duplicate_links_new_alias_durably(self):
        self.assertTrue(delivery.reserve(['a']))
        self.assertFalse(delivery.reserve(['a', 'b']))
        delivery._journal = None
        self.assertTrue(delivery.known(['b']))
        self.assertFalse(delivery.reserve(['b']))

    def test_known_caches_read_and_all_known_reserve_is_local(self):
        self.assertTrue(delivery.reserve(['a']))
        delivery._journal = None
        self.assertTrue(delivery.known(['a']))
        before = delivery._http.call_count
        self.assertFalse(delivery.known(['b']))
        self.assertFalse(delivery.reserve(['a']))
        self.assertEqual(delivery._http.call_count, before)

    def test_stale_reader_refreshes_before_reserving(self):
        first = delivery.GitHubJournal()
        second = delivery.GitHubJournal()
        self.assertFalse(first.known(['a']))
        self.assertTrue(second.reserve(['a']))
        self.assertFalse(first.reserve(['a']))

    def test_corrupt_or_missing_remote_fails_closed(self):
        for remote in ({'sha': 'x', 'content': 'e30='}, {},
                       {'sha': 'x', 'content': base64.b64encode(b'{"version":1,"keys":["raw"]}').decode()}):
            with self.subTest(remote=remote), patch.object(delivery, '_http', return_value=remote):
                with self.assertRaises(delivery.DeliveryError):
                    delivery.GitHubJournal().reserve(['a'])

    def test_empty_keys_rejected(self):
        with self.assertRaises(delivery.DeliveryError):
            delivery.reserve([])

    def test_send_uses_plaintext_no_paid_broadcast(self):
        self.assertTrue(delivery.send({'title': '<b>hello</b>'}, {'score': 80}))
        payload = delivery._http.call_args.kwargs['payload']
        self.assertNotIn('parse_mode', payload)
        self.assertNotIn('allow_paid_broadcast', payload)
        self.assertLessEqual(len(payload['text']), 4096)


if __name__ == '__main__':
    unittest.main()

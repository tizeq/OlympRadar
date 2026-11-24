import contextlib
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import setup_local as setup


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / '.env'
        self.environment = patch.dict(os.environ, {}, clear=True)
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.directory.cleanup()

    def test_roundtrip_permissions_and_no_shell_evaluation(self):
        values = {'GITHUB_TOKEN': '$(touch /tmp/never-execute) `echo secret` "quote"',
                  'GITHUB_REPOSITORY': 'owner/repo'}
        setup.write_env(self.path, values)
        self.assertEqual(setup.read_env(self.path), values)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertFalse(any(self.path.parent.glob('.olympradar-env-*')))

    def test_refuses_world_readable_or_symlink_file(self):
        self.path.write_text('GITHUB_TOKEN="secret"\n')
        self.path.chmod(0o644)
        with self.assertRaises(ValueError):
            setup.read_env(self.path)
        link = self.path.parent / 'link'
        link.symlink_to(self.path)
        with self.assertRaises(ValueError):
            setup.write_env(link, {})

    def test_invalid_keys_and_newlines_rejected(self):
        for value in ({'HOME': 'bad'}, {'GITHUB_TOKEN': 'secret\nmore'}):
            with self.assertRaises(ValueError):
                setup.write_env(self.path, value)
        self.assertFalse(self.path.exists())

    def test_environment_overrides_file(self):
        setup.write_env(self.path, {'GITHUB_TOKEN': 'file-secret'})
        os.environ['GITHUB_TOKEN'] = 'env-secret'
        setup.load_env(self.path)
        self.assertEqual(os.environ['GITHUB_TOKEN'], 'env-secret')

    def test_configure_hidden_input_and_never_sends(self):
        with patch.object(setup.sys.stdin, 'isatty', return_value=True), \
             patch.object(setup.getpass, 'getpass', side_effect=['123:secret', '42', 'owner/repo', 'github-secret']) as hidden, \
             patch.object(setup, '_http') as http, contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(setup.main(['--env-file', str(self.path), 'configure']), 0)
        self.assertEqual(hidden.call_count, 4)
        http.assert_not_called()
        self.assertNotIn('secret', output.getvalue())
        self.assertEqual(setup.read_env(self.path)['TELEGRAM_CHAT_ID'], '42')

    def test_discover_gets_and_saves_without_message(self):
        os.environ['TELEGRAM_BOT_TOKEN'] = '123:secret'
        with patch.object(setup, '_http', return_value={'ok': True, 'result': [
            {'message': {'chat': {'id': 42, 'type': 'private', 'first_name': 'Private name'}, 'text': 'private text'}}]}) as http, \
             patch('builtins.input', return_value='42'), contextlib.redirect_stdout(io.StringIO()) as output:
            setup.discover_chat(self.path)
        self.assertTrue(http.call_args.args[0].endswith('/getUpdates'))
        self.assertNotIn('offset', http.call_args.kwargs['payload'])
        self.assertEqual(http.call_count, 1)
        self.assertNotIn('Private name', output.getvalue())
        self.assertNotIn('private text', output.getvalue())
        self.assertEqual(setup.read_env(self.path)['TELEGRAM_CHAT_ID'], '42')

    def test_explicit_test_send_checks_message_id(self):
        os.environ.update(TELEGRAM_BOT_TOKEN='123:secret', TELEGRAM_CHAT_ID='42')
        with patch.object(setup, '_http', return_value={'ok': True, 'result': {'message_id': 7}}) as http, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(setup.main(['test-send']), 0)
        self.assertTrue(http.call_args.args[0].endswith('/sendMessage'))
        self.assertEqual(http.call_count, 1)
        self.assertIn('message_id=7', output.getvalue())
        self.assertNotIn('secret', output.getvalue())

    def test_unconfirmed_send_and_timeout_never_retry(self):
        os.environ.update(TELEGRAM_BOT_TOKEN='123:secret', TELEGRAM_CHAT_ID='42')
        cases = [{'ok': False}, {'ok': True, 'result': {}},
                 {'ok': True, 'result': {'message_id': True}}, OSError('secret token in URL')]
        for result in cases:
            options = {'side_effect': result} if isinstance(result, Exception) else {'return_value': result}
            with self.subTest(result=result), patch.object(setup, '_http', **options) as http, \
                 contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(setup.main(['test-send']), 1)
                self.assertEqual(http.call_count, 1)
                self.assertNotIn('secret', output.getvalue())

    def test_run_loads_env_and_defaults_to_preview(self):
        setup.write_env(self.path, {'MIN_SCORE': '70'})
        with patch('radar.run', return_value=0) as run:
            self.assertEqual(setup.main(['--env-file', str(self.path), 'run']), 0)
        run.assert_called_once_with(send=False)
        self.assertEqual(os.environ['MIN_SCORE'], '70')


if __name__ == '__main__':
    unittest.main()

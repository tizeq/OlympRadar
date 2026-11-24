import unittest
from unittest.mock import patch

import radar


class LegacyEntryPoint(unittest.TestCase):
    def test_retired_send_cannot_start_delivery(self):
        with patch.object(radar.sources, "collect") as collect:
            with self.assertRaisesRegex(ValueError, "retired"):
                radar.run(send=True)
        collect.assert_not_called()

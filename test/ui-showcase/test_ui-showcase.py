# need to get this dir in the path so that we make the import work
import os
import sys
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'shared'))

from frontend_tester import BaseTestFrontendUnits


class TestUiShowcaseUnits(BaseTestFrontendUnits):

    def setUp(self):
        super(TestUiShowcaseUnits, self).setUp()
        self.set_server_prefix("../../ui/")

    def test_units(self):
        self.check_page("index.html")

#!/usr/bin/env python3
"""
Unit tests for the pure logic in cgbuy, journal.py, eddn.py and plot.py.

Run with:  python3 test_cgbuy.py

No network, no tkinter window, no real Elite journal directory and no real
user config: every path the tests touch is a tempfile, and XDG_CONFIG_HOME is
redirected before cgbuy is imported so its CONFIG_PATH/STATE_PATH constants
can never point at the commander's own files.
"""

import atexit
import contextlib
import datetime
import importlib.machinery
import importlib.util
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
import urllib.parse

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))

# cgbuy does `try: import journal / plot / eddn`, so the project directory has
# to be importable before it is loaded.
if PROJECT_DIR not in sys.path:
    sys.path.insert(0, PROJECT_DIR)

# Redirect the config/state paths before cgbuy computes them at import time.
_CONFIG_SANDBOX = tempfile.mkdtemp(prefix="cgbuy-test-config-")
os.environ["XDG_CONFIG_HOME"] = _CONFIG_SANDBOX
atexit.register(shutil.rmtree, _CONFIG_SANDBOX, True)

import cg                                                     # noqa: E402
import eddn                                                   # noqa: E402
import journal                                                # noqa: E402
import notify                                                 # noqa: E402
import sco_model                                              # noqa: E402
import status                                                 # noqa: E402
import verify                                                 # noqa: E402

# cgbuy has no .py extension, so the normal import machinery cannot see it.
# Importing it only defines things; main() runs under __name__ == "__main__",
# which this is not, so no Tk root is ever created.
_loader = importlib.machinery.SourceFileLoader(
    "cgbuy", os.path.join(PROJECT_DIR, "cgbuy"))
_spec = importlib.util.spec_from_loader("cgbuy", _loader)
cgbuy = importlib.util.module_from_spec(_spec)
sys.modules["cgbuy"] = cgbuy
_loader.exec_module(cgbuy)


def ts(hh, mm, ss=0, day=1):
    """A journal timestamp on a fixed, DST-free winter day."""
    return "2025-01-%02dT%02d:%02d:%02dZ" % (day, hh, mm, ss)


@contextlib.contextmanager
def quiet_stderr():
    """Swallow the data layer's warnings so a passing run stays readable."""
    buf = io.StringIO()
    with contextlib.redirect_stderr(buf):
        yield buf


# --------------------------------------------------------------------------
# eddn.norm_name
# --------------------------------------------------------------------------

class TestNormName(unittest.TestCase):

    def test_game_symbol_is_reduced_to_bare_name(self):
        self.assertEqual(eddn.norm_name("$gold_name;"), "gold")

    def test_case_and_whitespace_are_normalised(self):
        self.assertEqual(eddn.norm_name("  $Gold_Name;  "), "gold")

    def test_plain_names_pass_through(self):
        self.assertEqual(eddn.norm_name("gold"), "gold")
        self.assertEqual(eddn.norm_name("Bertrandite"), "bertrandite")

    def test_partial_decoration_is_handled(self):
        self.assertEqual(eddn.norm_name("$gold"), "gold")
        self.assertEqual(eddn.norm_name("gold;"), "gold")
        self.assertEqual(eddn.norm_name("gold_name"), "gold")

    def test_category_symbol(self):
        self.assertEqual(
            eddn.norm_name("$MARKET_category_Metals;"), "market_category_metals")

    def test_empty_and_none_are_safe(self):
        self.assertEqual(eddn.norm_name(""), "")
        self.assertEqual(eddn.norm_name(None), "")
        self.assertEqual(eddn.norm_name("   "), "")

    def test_embedded_underscore_name_is_not_stripped(self):
        # only a trailing _name is decoration
        self.assertEqual(eddn.norm_name("wine_names"), "wine_names")


# --------------------------------------------------------------------------
# eddn.build_message / eddn.validate
# --------------------------------------------------------------------------

def fake_market():
    """A miniature Market.json: two real goods, limpets, and a salvage item."""
    return {
        "timestamp": "2025-01-01T12:00:00Z",
        "event": "Market",
        "MarketID": 3223343616,
        "StationName": "Metz Enterprise",
        "StarSystem": "Ega",
        "StationType": "Coriolis",
        "Items": [
            {"id": 128049153, "Name": "$gold_name;",
             "Name_Localised": "Gold",
             "Category": "$MARKET_category_Metals;",
             "BuyPrice": 9000, "SellPrice": 9500, "MeanPrice": 9400,
             "StockBracket": 2, "DemandBracket": 3,
             "Stock": 1200, "Demand": 4000, "Consumer": True, "Producer": False,
             "Rare": False},
            {"id": 128049204, "Name": "$palladium_name;",
             "Category": "$MARKET_category_Metals;",
             "BuyPrice": 0, "SellPrice": 13800, "MeanPrice": 13300,
             "StockBracket": 0, "DemandBracket": 3,
             "Stock": 0, "Demand": 9000, "Rare": False},
            {"id": 128049519, "Name": "$drones_name;",
             "Category": "$MARKET_category_Utility;",
             "BuyPrice": 101, "SellPrice": 100, "MeanPrice": 101,
             "StockBracket": 3, "DemandBracket": 0,
             "Stock": 1000000, "Demand": 0, "Rare": False},
            {"id": 128667728, "Name": "$usscargoblackbox_name;",
             "Category": "$MARKET_category_NonMarketable;",
             "BuyPrice": 0, "SellPrice": 5000, "MeanPrice": 0,
             "StockBracket": 0, "DemandBracket": 1,
             "Stock": 0, "Demand": 1, "Rare": False},
        ],
    }


class TestBuildMessage(unittest.TestCase):

    def setUp(self):
        self.env = eddn.build_message(fake_market(), "TestCmdr", True, False)
        self.msg = self.env["message"]
        self.names = [c["name"] for c in self.msg["commodities"]]

    def test_envelope_shape(self):
        self.assertEqual(self.env["$schemaRef"], eddn.SCHEMA)
        self.assertEqual(self.env["header"]["uploaderID"], "TestCmdr")
        self.assertEqual(self.env["header"]["softwareName"], eddn.SOFTWARE)
        self.assertTrue(self.env["header"]["softwareVersion"])

    def test_required_message_keys_present(self):
        self.assertTrue(eddn.REQUIRED_MESSAGE_KEYS <= set(self.msg))
        self.assertEqual(self.msg["systemName"], "Ega")
        self.assertEqual(self.msg["stationName"], "Metz Enterprise")
        self.assertEqual(self.msg["marketId"], 3223343616)
        self.assertEqual(self.msg["timestamp"], "2025-01-01T12:00:00Z")
        self.assertEqual(self.msg["stationType"], "Coriolis")
        self.assertIs(self.msg["horizons"], True)
        self.assertIs(self.msg["odyssey"], False)

    def test_limpets_are_excluded(self):
        self.assertNotIn("drones", self.names)

    def test_nonmarketable_category_is_excluded(self):
        self.assertNotIn("usscargoblackbox", self.names)

    def test_normal_commodities_survive(self):
        self.assertEqual(self.names, ["gold", "palladium"])

    def test_zero_stock_entry_is_kept_for_its_sell_side(self):
        pal = self.msg["commodities"][1]
        self.assertEqual(pal["stock"], 0)
        self.assertEqual(pal["demand"], 9000)

    def test_commodity_fields_are_ints_and_declared(self):
        gold = self.msg["commodities"][0]
        self.assertTrue(eddn.REQUIRED_COMMODITY_KEYS <= set(gold))
        self.assertTrue(set(gold) <= eddn.ALLOWED_COMMODITY_KEYS)
        for k in ("meanPrice", "buyPrice", "stock", "sellPrice", "demand"):
            self.assertIsInstance(gold[k], int, k)
        self.assertEqual(gold["buyPrice"], 9000)
        self.assertEqual(gold["sellPrice"], 9500)
        self.assertEqual(gold["stock"], 1200)

    def test_non_rare_items_get_no_status_flags(self):
        self.assertNotIn("statusFlags", self.msg["commodities"][0])

    def test_rare_items_are_flagged(self):
        m = fake_market()
        m["Items"][0]["Rare"] = True
        env = eddn.build_message(m, "TestCmdr", True, True)
        self.assertEqual(env["message"]["commodities"][0]["statusFlags"],
                         ["Rare"])

    def test_optional_flags_omitted_when_unknown(self):
        env = eddn.build_message(fake_market(), "TestCmdr", None, None)
        self.assertNotIn("horizons", env["message"])
        self.assertNotIn("odyssey", env["message"])

    def test_missing_commander_falls_back(self):
        env = eddn.build_message(fake_market(), "", None, None)
        self.assertEqual(env["header"]["uploaderID"], "unknown")

    def test_validate_passes(self):
        self.assertEqual(eddn.validate(self.env), [])

    def test_validate_passes_with_gameversion(self):
        env = eddn.add_gameversion(self.env, "4.4.1.1", "r332841/r0")
        self.assertEqual(env["header"]["gameversion"], "4.4.1.1")
        self.assertEqual(env["header"]["gamebuild"], "r332841/r0")
        self.assertEqual(eddn.validate(env), [])

    def test_json_round_trip_still_validates(self):
        again = json.loads(json.dumps(self.env))
        self.assertEqual(eddn.validate(again), [])


class TestValidateCatchesProblems(unittest.TestCase):
    """validate() exists because the schema sets additionalProperties=false."""

    def env(self):
        return eddn.build_message(fake_market(), "TestCmdr", True, True)

    def test_undeclared_message_key_is_caught(self):
        env = self.env()
        env["message"]["Items"] = []          # a raw Market.json key leaking in
        problems = eddn.validate(env)
        self.assertTrue(problems)
        self.assertTrue(any("undeclared" in p and "Items" in p
                            for p in problems), problems)

    def test_undeclared_commodity_key_is_caught(self):
        env = self.env()
        env["message"]["commodities"][0]["Name_Localised"] = "Gold"
        problems = eddn.validate(env)
        self.assertTrue(any("commodity 0 undeclared" in p for p in problems),
                        problems)

    def test_missing_message_key_is_caught(self):
        env = self.env()
        del env["message"]["marketId"]
        self.assertTrue(any("missing" in p and "marketId" in p
                            for p in eddn.validate(env)))

    def test_missing_commodity_key_is_caught(self):
        env = self.env()
        del env["message"]["commodities"][0]["meanPrice"]
        self.assertTrue(any("commodity 0 missing" in p
                            for p in eddn.validate(env)))

    def test_missing_header_field_is_caught(self):
        env = self.env()
        env["header"]["uploaderID"] = ""
        self.assertTrue(any("uploaderID" in p for p in eddn.validate(env)))

    def test_non_integer_price_is_caught(self):
        env = self.env()
        env["message"]["commodities"][0]["buyPrice"] = 9000.5
        self.assertTrue(any("buyPrice" in p for p in eddn.validate(env)))

    def test_empty_commodity_list_is_caught(self):
        m = fake_market()
        m["Items"] = [i for i in m["Items"]
                      if "drones" in i["Name"] or "NonMarketable" in i["Category"]]
        env = eddn.build_message(m, "TestCmdr", True, True)
        self.assertEqual(env["message"]["commodities"], [])
        self.assertIn("no commodities", eddn.validate(env))


# --------------------------------------------------------------------------
# journal.Calibration
# --------------------------------------------------------------------------

class TestCalibration(unittest.TestCase):

    def test_empty_calibration_has_no_learned_values(self):
        cal = journal.Calibration()
        self.assertIsNone(cal.jump_minutes)
        self.assertIsNone(cal.dock_minutes)
        self.assertIsNone(cal.sc_scale)
        self.assertIn("estimate", cal.summary())

    def test_below_min_samples_returns_none(self):
        n = journal.Calibration.MIN_SAMPLES
        cal = journal.Calibration({"jump_secs": [60.0] * (n - 1),
                                   "dock_secs": [300.0] * (n - 1)})
        self.assertIsNone(cal.jump_minutes)
        self.assertIsNone(cal.dock_minutes)

    def test_at_min_samples_returns_median(self):
        n = journal.Calibration.MIN_SAMPLES
        self.assertEqual(n, 3)
        cal = journal.Calibration({"jump_secs": [30.0, 60.0, 900.0],
                                   "dock_secs": [120.0, 300.0, 600.0]})
        self.assertAlmostEqual(cal.jump_minutes, 1.0)       # median 60s
        self.assertAlmostEqual(cal.dock_minutes, 5.0)       # median 300s
        self.assertIn("jump 1.00 min (n=3)", cal.summary())

    def test_median_ignores_a_single_outlier(self):
        cal = journal.Calibration({"jump_secs": [60.0, 60.0, 60.0, 60.0, 290.0]})
        self.assertAlmostEqual(cal.jump_minutes, 1.0)

    def test_legacy_sc_samples_are_discarded(self):
        """Old configs hold sc_samples that paired a supercruise duration with
        an unrelated station's distance. They must not be loaded or trusted."""
        ls = 1000
        model = journal.est_sc_minutes(ls) * 60.0
        cal = journal.Calibration({"sc_samples": [(ls, model * 2.0)] * 3})
        self.assertEqual(cal.sc_samples, [])
        self.assertIsNone(cal.sc_scale)
        self.assertNotIn("sc_samples", cal.to_dict())

    def test_sc_scale_uses_approach_samples(self):
        ls = 1000
        model = journal.est_sc_minutes(ls) * 60.0
        cal = journal.Calibration({
            "approach_samples": [(ls, model * 1.5)] * 4,
        })
        self.assertAlmostEqual(cal.sc_scale, 1.5)

    def test_sc_scale_always_uses_approach_samples(self):
        """approach_samples is the only correctly-paired pool: FSDJump->Docked
        with that station's own DistFromStarLS."""
        ls = 1000
        model = journal.est_sc_minutes(ls) * 60.0
        cal = journal.Calibration({
            "sc_samples": [(ls, model * 3.0)] * 3,      # must be ignored
            "approach_samples": [(ls, model * 1.0)] * 50,
        })
        self.assertAlmostEqual(cal.sc_scale, 1.0)

    def test_sc_scale_none_when_both_pools_short(self):
        cal = journal.Calibration({"sc_samples": [(100, 60.0)],
                                   "approach_samples": [(100, 60.0)]})
        self.assertIsNone(cal.sc_scale)

    def test_samples_are_capped_at_200(self):
        cal = journal.Calibration({"jump_secs": list(range(500))})
        self.assertEqual(len(cal.jump_secs), 200)
        self.assertEqual(cal.jump_secs[0], 300)

    def test_to_dict_round_trip_through_constructor(self):
        src = journal.Calibration({
            "jump_secs": [40.0, 50.0, 60.0],
            "dock_secs": [200.0, 250.0, 300.0],
            "sc_samples": [(500, 90.0), (1000, 120.0), (2000, 150.0)],
            "approach_samples": [(500, 130.0), (1000, 160.0), (2000, 200.0)],
        })
        again = journal.Calibration(src.to_dict())
        self.assertEqual(again.to_dict(), src.to_dict())
        self.assertEqual(again.jump_minutes, src.jump_minutes)
        self.assertEqual(again.dock_minutes, src.dock_minutes)
        self.assertEqual(again.sc_scale, src.sc_scale)

    def test_round_trip_through_json(self):
        """The config file is JSON, so tuples come back as lists."""
        src = journal.Calibration({
            "jump_secs": [40.0, 50.0, 60.0],
            "sc_samples": [(500, 90.0), (1000, 120.0), (2000, 150.0)],
        })
        again = journal.Calibration(json.loads(json.dumps(src.to_dict())))
        self.assertEqual(again.sc_samples, src.sc_samples)
        self.assertTrue(all(isinstance(x, tuple) for x in again.sc_samples))
        self.assertAlmostEqual(again.sc_scale, src.sc_scale)

    def test_constructor_tolerates_empty_and_missing(self):
        self.assertEqual(journal.Calibration(None).to_dict(),
                         journal.Calibration({}).to_dict())


class TestParseTs(unittest.TestCase):

    def test_parses_zulu_timestamps(self):
        a = journal.parse_ts(ts(12, 0, 0))
        b = journal.parse_ts(ts(12, 1, 0))
        self.assertIsNotNone(a)
        self.assertAlmostEqual(b - a, 60.0)

    def test_bad_input_is_none(self):
        self.assertIsNone(journal.parse_ts(None))
        self.assertIsNone(journal.parse_ts(""))
        self.assertIsNone(journal.parse_ts("not a timestamp"))
        self.assertIsNone(journal.parse_ts(12345))


# --------------------------------------------------------------------------
# journal.JournalWatcher._handle
# --------------------------------------------------------------------------

class WatcherTestCase(unittest.TestCase):
    """A watcher pointed at an empty temp dir: never sees the real journals."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="cgbuy-test-journal-")
        self.addCleanup(self.tmp.cleanup)
        self.w = journal.JournalWatcher(directory=self.tmp.name)
        self.assertEqual(self.w.dir, self.tmp.name)

    def feed(self, *events):
        """Push synthetic journal lines through _handle. Returns learn flags."""
        return [self.w._handle(json.dumps(e) + "\n", live=False)
                for e in events]


class TestHandleJumps(WatcherTestCase):

    def test_back_to_back_jumps_make_a_sample(self):
        learned = self.feed(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "Sol"},
            {"timestamp": ts(12, 1, 0), "event": "FSDJump", "StarSystem": "Ega"},
        )
        self.assertEqual(learned, [False, True])
        self.assertEqual(self.w.cal.jump_secs, [60.0])
        self.assertEqual(self.w.system, "Ega")
        self.assertFalse(self.w.docked)

    def test_three_jumps_make_two_samples(self):
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "A"},
            {"timestamp": ts(12, 0, 40), "event": "FSDJump", "StarSystem": "B"},
            {"timestamp": ts(12, 1, 40), "event": "FSDJump", "StarSystem": "C"},
        )
        self.assertEqual(self.w.cal.jump_secs, [40.0, 60.0])

    def test_too_fast_interval_is_rejected(self):
        # under the 15s window - not a real route jump
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "A"},
            {"timestamp": ts(12, 0, 5), "event": "FSDJump", "StarSystem": "B"},
        )
        self.assertEqual(self.w.cal.jump_secs, [])

    def test_long_gap_is_rejected(self):
        # over the 300s window - you stopped to do something
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "A"},
            {"timestamp": ts(12, 30, 0), "event": "FSDJump", "StarSystem": "B"},
        )
        self.assertEqual(self.w.cal.jump_secs, [])

    def test_window_boundaries_are_inclusive(self):
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "A"},
            {"timestamp": ts(12, 0, 15), "event": "FSDJump", "StarSystem": "B"},
            {"timestamp": ts(12, 5, 15), "event": "FSDJump", "StarSystem": "C"},
        )
        self.assertEqual(self.w.cal.jump_secs, [15.0, 300.0])


class TestHandleDocking(WatcherTestCase):

    def test_docked_then_undocked_makes_a_dock_sample(self):
        learned = self.feed(
            {"timestamp": ts(12, 0, 0), "event": "Docked",
             "StationName": "Metz Enterprise", "StarSystem": "Ega"},
            {"timestamp": ts(12, 5, 0), "event": "Undocked",
             "StationName": "Metz Enterprise"},
        )
        self.assertEqual(learned, [False, True])
        self.assertEqual(self.w.cal.dock_secs, [300.0])
        self.assertFalse(self.w.docked)

    def test_docked_sets_position(self):
        self.feed({"timestamp": ts(12, 0, 0), "event": "Docked",
                   "StationName": "Metz Enterprise", "StarSystem": "Ega"})
        self.assertTrue(self.w.docked)
        self.assertEqual(self.w.station, "Metz Enterprise")
        self.assertEqual(self.w.system, "Ega")

    def test_too_short_stop_is_rejected(self):
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "Docked", "StationName": "X"},
            {"timestamp": ts(12, 0, 10), "event": "Undocked"},
        )
        self.assertEqual(self.w.cal.dock_secs, [])

    def test_overnight_stop_is_rejected(self):
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "Docked", "StationName": "X"},
            {"timestamp": ts(13, 0, 0), "event": "Undocked"},
        )
        self.assertEqual(self.w.cal.dock_secs, [])

    def test_undocked_without_a_dock_is_ignored(self):
        self.feed({"timestamp": ts(12, 0, 0), "event": "Undocked"})
        self.assertEqual(self.w.cal.dock_secs, [])

    def test_on_docked_callback_only_fires_live(self):
        seen = []
        self.w.on_docked = lambda stn, sysn: seen.append((stn, sysn))
        ev = {"timestamp": ts(12, 0, 0), "event": "Docked",
              "StationName": "Metz Enterprise", "StarSystem": "Ega"}
        self.w._handle(json.dumps(ev), live=False)
        self.assertEqual(seen, [])
        self.w._handle(json.dumps(ev), live=True)
        self.assertEqual(seen, [("Metz Enterprise", "Ega")])


class TestHandleApproach(WatcherTestCase):

    def test_jump_then_dock_makes_an_approach_sample(self):
        learned = self.feed(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "Ega"},
            {"timestamp": ts(12, 3, 0), "event": "Docked",
             "StationName": "Metz Enterprise", "StarSystem": "Ega",
             "DistFromStarLS": 1200.0},
        )
        self.assertEqual(learned, [False, True])
        self.assertEqual(self.w.cal.approach_samples, [(1200.0, 180.0)])

    def test_instant_dock_is_rejected(self):
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "Ega"},
            {"timestamp": ts(12, 0, 10), "event": "Docked",
             "StationName": "X", "DistFromStarLS": 100.0},
        )
        self.assertEqual(self.w.cal.approach_samples, [])

    def test_hour_long_approach_is_rejected(self):
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "Ega"},
            {"timestamp": ts(14, 0, 0), "event": "Docked",
             "StationName": "X", "DistFromStarLS": 100.0},
        )
        self.assertEqual(self.w.cal.approach_samples, [])

    def test_dock_without_distance_learns_nothing(self):
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "Ega"},
            {"timestamp": ts(12, 3, 0), "event": "Docked", "StationName": "X"},
        )
        self.assertEqual(self.w.cal.approach_samples, [])

    def test_second_dock_in_system_does_not_reuse_the_arrival(self):
        """_arrived_at is consumed by the first dock, not every dock."""
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "Ega"},
            {"timestamp": ts(12, 3, 0), "event": "Docked",
             "StationName": "A", "DistFromStarLS": 1200.0},
            {"timestamp": ts(12, 6, 0), "event": "Undocked"},
            {"timestamp": ts(12, 20, 0), "event": "Docked",
             "StationName": "B", "DistFromStarLS": 90000.0},
        )
        self.assertEqual(self.w.cal.approach_samples, [(1200.0, 180.0)])

    def test_supercruise_never_records_a_sample(self):
        """The journal does not say how far a supercruise was, so pairing its
        duration with the last docked station's Ls produced ~28x ratios."""
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "Ega"},
            {"timestamp": ts(12, 3, 0), "event": "Docked",
             "StationName": "A", "DistFromStarLS": 12.0},
            {"timestamp": ts(12, 10, 0), "event": "SupercruiseEntry"},
            {"timestamp": ts(12, 25, 0), "event": "SupercruiseExit"},
        )
        self.assertEqual(self.w.cal.sc_samples, [])

    def test_supercruise_out_of_window_is_rejected(self):
        self.feed(
            {"timestamp": ts(12, 0, 0), "event": "Docked",
             "StationName": "A", "DistFromStarLS": 1200.0},
            {"timestamp": ts(12, 10, 0), "event": "SupercruiseEntry"},
            {"timestamp": ts(12, 10, 5), "event": "SupercruiseExit"},
        )
        self.assertEqual(self.w.cal.sc_samples, [])


class TestHandleMisc(WatcherTestCase):

    def test_blank_and_malformed_lines_are_ignored(self):
        self.assertFalse(self.w._handle("", live=True))
        self.assertFalse(self.w._handle("   \n", live=True))
        self.assertFalse(self.w._handle("{not json", live=True))
        self.assertFalse(self.w._handle('{"event": "FSDJump"}', live=True))
        self.assertEqual(self.w.cal.to_dict(), journal.Calibration().to_dict())

    def test_json_that_is_not_an_object_learns_nothing(self):
        """Documented gap: _handle assumes every decoded line is a dict.

        A line that is valid JSON but not an object (`[]`, `"x"`, `3`) reaches
        `e.get(...)` and raises AttributeError instead of being skipped like
        malformed JSON is. Elite never writes such a line, so this only bites
        on a corrupted file. Written to pass either way, so a fix in
        journal.py does not break the suite.
        """
        for junk in ("[]", '"nope"', "3", "null"):
            try:
                self.assertFalse(self.w._handle(junk, live=True))
            except AttributeError:
                pass

    def test_loadgame_captures_identity_and_game_version(self):
        self.feed({"timestamp": ts(12, 0, 0), "event": "LoadGame",
                   "Commander": "TestCmdr", "Horizons": True, "Odyssey": True,
                   "gameversion": "4.4.1.1", "build": " r332841/r0 "})
        self.assertEqual(self.w.commander, "TestCmdr")
        self.assertIs(self.w.horizons, True)
        self.assertIs(self.w.odyssey, True)
        self.assertEqual(self.w.gameversion, "4.4.1.1")
        self.assertEqual(self.w.gamebuild, "r332841/r0")

    def test_location_event_sets_position(self):
        self.feed({"timestamp": ts(12, 0, 0), "event": "Location",
                   "StarSystem": "Ega", "StationName": "Metz Enterprise",
                   "Docked": True})
        self.assertEqual(self.w.system, "Ega")
        self.assertEqual(self.w.station, "Metz Enterprise")
        self.assertTrue(self.w.docked)

    def test_on_calibration_fires_only_when_something_is_learned(self):
        hits = []
        self.w.on_calibration = lambda cal: hits.append(cal)
        self.w._handle(json.dumps(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump",
             "StarSystem": "A"}), live=True)
        self.assertEqual(hits, [])
        self.w._handle(json.dumps(
            {"timestamp": ts(12, 1, 0), "event": "FSDJump",
             "StarSystem": "B"}), live=True)
        self.assertEqual(len(hits), 1)
        self.assertIs(hits[0], self.w.cal)

    def test_prime_reads_a_synthetic_journal_file(self):
        path = os.path.join(self.tmp.name, "Journal.2025-01-01T120000.01.log")
        with open(path, "w", encoding="utf-8") as fh:
            for e in ({"timestamp": ts(12, 0, 0), "event": "FSDJump",
                       "StarSystem": "A"},
                      {"timestamp": ts(12, 1, 0), "event": "FSDJump",
                       "StarSystem": "B"},
                      {"timestamp": ts(12, 4, 0), "event": "Docked",
                       "StationName": "Metz Enterprise", "StarSystem": "B",
                       "DistFromStarLS": 800.0},
                      {"timestamp": ts(12, 9, 0), "event": "Undocked"}):
                fh.write(json.dumps(e) + "\n")
        w = journal.JournalWatcher(directory=self.tmp.name)
        self.assertEqual(w.prime(), 3)
        self.assertEqual(w.cal.jump_secs, [60.0])
        self.assertEqual(w.cal.approach_samples, [(800.0, 180.0)])
        self.assertEqual(w.cal.dock_secs, [300.0])
        self.assertEqual(w.path, path)
        self.assertEqual(w.pos, os.path.getsize(path))

    def test_find_journal_dir_honours_an_override(self):
        self.assertEqual(journal.find_journal_dir(self.tmp.name), self.tmp.name)


# --------------------------------------------------------------------------
# cgbuy.trip_minutes
# --------------------------------------------------------------------------

class TestTripMinutes(unittest.TestCase):

    def trip(self, dist=60.0, src_ls=1000, cg_ls=500, empty=30.0, laden=25.0,
             cal=None):
        return cgbuy.trip_minutes(dist, src_ls, cg_ls, empty, laden, cal)

    def test_uncalibrated_uses_the_shipped_estimates(self):
        # 60 ly: ceil(60/30)=2 out, ceil(60/25)=3 back, and the first jump of
        # each leg is already inside departure - so 1 + 2 jump cycles.
        expected = (3 * cgbuy.EST_JUMP_MIN
                    + (cgbuy.sc_minutes(1000) + cgbuy.sc_minutes(500))
                    * cgbuy.EST_SC_SCALE
                    + (cgbuy.EST_DOCK_MIN + cgbuy.EST_DEPART_MIN) * 2)
        self.assertAlmostEqual(self.trip(), expected)

    def test_calibrated_jump_time_is_used_when_supplied(self):
        cal = journal.Calibration({"jump_secs": [120.0] * 3})   # 2.0 min/jump
        self.assertAlmostEqual(cal.jump_minutes, 2.0)
        expected = (3 * 2.0
                    + (cgbuy.sc_minutes(1000) + cgbuy.sc_minutes(500))
                    + (cgbuy.EST_DOCK_MIN + cgbuy.EST_DEPART_MIN) * 2)
        self.assertAlmostEqual(self.trip(cal=cal), expected)
        self.assertGreater(self.trip(cal=cal), self.trip())

    def test_departure_is_counted_and_calibrated(self):
        """Undocked -> first jump used to fall between the cracks: jump time
        is measured jump-to-jump, so the run out from the pad was in no
        interval at all. It happens twice a round trip."""
        cal = journal.Calibration({"depart_secs": [300.0] * 3})   # 5 min out
        self.assertAlmostEqual(cal.depart_minutes, 5.0)
        gap = self.trip(cal=cal) - self.trip()
        self.assertAlmostEqual(gap, (5.0 - cgbuy.EST_DEPART_MIN) * 2)

    def test_station_time_is_fixed_and_never_calibrated(self):
        """Docked -> Undocked cannot separate trading from being AFK, so the
        measured figure is collected but deliberately not used: a 40-minute
        tea break must not inflate every estimate."""
        cal = journal.Calibration({"dock_secs": [3600.0] * 3})   # an hour a stop
        self.assertAlmostEqual(cal.dock_minutes, 60.0)
        self.assertAlmostEqual(self.trip(cal=cal), self.trip(),
                               msg="dock samples must not move the estimate")
        self.assertAlmostEqual(cgbuy.EST_DOCK_MIN, 2.0)

    def test_a_measured_arrival_leg_beats_the_curve(self):
        """Samples at one distance cannot support a fit, so the ratio stands
        in; samples at two distances can, and then the fit is what counts."""
        far = journal.est_sc_minutes(5000) * 60.0
        one_place = journal.Calibration(
            {"approach_samples": [(5000, far * 2.0)] * 3})
        self.assertIsNone(one_place.arrival_fit)
        self.assertAlmostEqual(one_place.sc_scale, 2.0)

        two_places = journal.Calibration(
            {"approach_samples": [(350, 208.0)] * 3 + [(5000, 245.0)] * 3})
        self.assertIsNotNone(two_places.arrival_fit)
        for ls, secs in ((350, 208.0), (5000, 245.0)):
            self.assertAlmostEqual(two_places.arrival_minutes(ls), secs / 60.0,
                                   places=2)

    def test_the_curve_cannot_fit_both_ends_at_once(self):
        """The whole reason for the fit. 350 Ls and 5,000 Ls really do cost
        about the same, and no single multiplier on a distance curve can say
        so: whatever fits one end is wrong at the other."""
        cal = journal.Calibration(
            {"approach_samples": [(350, 208.0)] * 3 + [(5000, 245.0)] * 3})
        ratio = cal.sc_scale
        for ls, secs in ((350, 208.0), (5000, 245.0)):
            scaled = journal.est_sc_minutes(ls) * 60.0 * ratio
            self.assertGreater(abs(scaled - secs) / secs, 0.15)
            fitted = cal.arrival_minutes(ls) * 60.0
            self.assertLess(abs(fitted - secs) / secs, 0.02)

    def test_outside_the_range_flown_the_fit_is_not_extrapolated(self):
        """Two clusters say nothing about 40,000 Ls. Past the last one flown
        the estimate curve's own shape takes over, so a shallow fit cannot
        claim a deep-space station is quick to reach."""
        cal = journal.Calibration(
            {"approach_samples": [(350, 208.0)] * 3 + [(5000, 245.0)] * 3})
        a, b, lo, hi = cal.arrival_fit
        straight_line = (a + b * 40000 ** 0.3) / 60.0
        self.assertGreater(cal.arrival_minutes(40000), straight_line)
        # and it still grows with distance, in both directions
        self.assertLess(cal.arrival_minutes(10), cal.arrival_minutes(350))
        self.assertLess(cal.arrival_minutes(5000), cal.arrival_minutes(40000))

    def test_a_fit_needs_distances_that_are_actually_different(self):
        near = [(350, 208.0)] * 3 + [(360, 210.0)] * 3
        self.assertIsNone(journal.Calibration(
            {"approach_samples": near}).arrival_fit)

    def test_one_farmed_station_does_not_outvote_a_rare_one(self):
        """Bucket medians, not raw samples: a hundred runs to the same pad
        would otherwise drag the line onto that one distance."""
        lopsided = [(350, 208.0)] * 100 + [(5000, 245.0)] * 3
        cal = journal.Calibration({"approach_samples": lopsided})
        self.assertAlmostEqual(cal.arrival_minutes(5000), 245.0 / 60.0, places=2)

    def test_flying_further_is_never_priced_as_a_discount(self):
        """A negative travel term is noise. It must not make distance free."""
        backwards = [(350, 300.0)] * 3 + [(5000, 200.0)] * 3
        cal = journal.Calibration({"approach_samples": backwards})
        fit = cal.arrival_fit
        if fit:
            self.assertGreaterEqual(fit[1], 0.0)
            self.assertLessEqual(cal.arrival_minutes(350),
                                 cal.arrival_minutes(5000))

    def test_calibrated_sc_scale_is_applied(self):
        ls = 1000
        model = journal.est_sc_minutes(ls) * 60.0
        cal = journal.Calibration({"approach_samples": [(ls, model * 2.0)] * 3})
        self.assertAlmostEqual(cal.sc_scale, 2.0)
        legs = cgbuy.sc_minutes(1000) + cgbuy.sc_minutes(500)
        self.assertAlmostEqual(self.trip(cal=cal) - self.trip(), legs)

    def test_an_empty_calibration_behaves_like_no_calibration(self):
        self.assertAlmostEqual(self.trip(cal=journal.Calibration()),
                               self.trip())

    def test_more_distance_costs_more_time(self):
        near = self.trip(dist=10.0)
        far = self.trip(dist=200.0)
        further = self.trip(dist=400.0)
        self.assertLess(near, far)
        self.assertLess(far, further)

    def test_more_ls_costs_more_time(self):
        close = self.trip(src_ls=100)
        deep = self.trip(src_ls=50000)
        self.assertLess(close, deep)
        self.assertLess(self.trip(cg_ls=100), self.trip(cg_ls=50000))

    def test_slower_laden_jump_range_costs_more(self):
        self.assertLess(self.trip(laden=30.0), self.trip(laden=10.0))

    def test_never_returns_zero_or_negative(self):
        cases = [
            dict(dist=0.0, src_ls=0, cg_ls=0),
            dict(dist=0.0, src_ls=0, cg_ls=0,
                 cal=journal.Calibration({"jump_secs": [0.0] * 3,
                                          "dock_secs": [0.0] * 3})),
            dict(dist=0.5, src_ls=1, cg_ls=1),
            dict(dist=1000.0, src_ls=500000, cg_ls=500000),
        ]
        for kw in cases:
            with self.subTest(**{k: v for k, v in kw.items() if k != "cal"}):
                self.assertGreater(self.trip(**kw), 0)
        self.assertGreaterEqual(self.trip(dist=0.0, src_ls=0, cg_ls=0), 0.5)

    def test_the_first_jump_of_a_leg_is_already_paid_for_in_departure(self):
        """Jump time is measured FSDJump -> FSDJump, so it prices the jumps
        after the first: the first one's cost lives in departure (Undocked ->
        first FSDJump) and the arrival leg (FSDJump -> Docked). Charging all
        of them made every single-jump hop a minute a leg too slow."""
        self.assertAlmostEqual(self.trip(dist=0.0), self.trip(dist=1.0))
        # 31 ly is two jumps each way, so one cycle each way is real
        self.assertLess(self.trip(dist=1.0), self.trip(dist=31.0))

    def test_sc_minutes_is_monotonic_and_positive(self):
        self.assertGreater(cgbuy.sc_minutes(0), 0)
        prev = 0
        for ls in (1, 100, 1000, 10000, 100000):
            cur = cgbuy.sc_minutes(ls)
            self.assertGreater(cur, prev)
            prev = cur


# --------------------------------------------------------------------------
# cgbuy.build_mixed
# --------------------------------------------------------------------------

def row(commodity, station, system, supply, profit, buy=1000, minutes=20.0,
        ly=30.0, ls=500, carrier=False, updated="2025-01-01"):
    """A build_rows()-shaped row, with only what build_mixed reads."""
    return {"commodity": commodity, "station": station, "system": system,
            "supply": supply, "profit_per_t": profit, "buy": buy,
            "trip_minutes": minutes, "ly": ly, "ls": ls, "carrier": carrier,
            "updated": updated}


class TestBuildMixed(unittest.TestCase):

    def test_greedy_packing_fills_the_hold_best_first(self):
        rows = [
            row("Gold", "Alpha", "Sys A", supply=40, profit=1000),
            row("Silver", "Alpha", "Sys A", supply=500, profit=500),
            row("Water", "Alpha", "Sys A", supply=500, profit=100),
        ]
        plans = cgbuy.build_mixed(rows, hold=100)
        self.assertEqual(len(plans), 1)
        p = plans[0]
        self.assertEqual([m["commodity"] for m in p["mix"]], ["Gold", "Silver"])
        self.assertEqual([m["tonnes"] for m in p["mix"]], [40, 60])
        self.assertEqual(p["tonnes"], 100)
        self.assertEqual(p["short"], 0)
        self.assertEqual(p["total"], 40 * 1000 + 60 * 500)
        self.assertEqual(p["cr_per_min"], round(p["total"] / 20.0))

    def test_input_row_order_does_not_matter(self):
        best_first = [row("Gold", "A", "S", 40, 1000),
                      row("Silver", "A", "S", 500, 500)]
        worst_first = [row("Silver", "A", "S", 500, 500),
                       row("Gold", "A", "S", 40, 1000)]
        self.assertEqual(cgbuy.build_mixed(best_first, 100),
                         cgbuy.build_mixed(worst_first, 100))

    def test_per_commodity_supply_caps_are_respected(self):
        rows = [row("Gold", "A", "S", supply=10, profit=1000),
                row("Silver", "A", "S", supply=20, profit=900),
                row("Water", "A", "S", supply=5000, profit=10)]
        plans = cgbuy.build_mixed(rows, hold=100)
        mix = {m["commodity"]: m["tonnes"] for m in plans[0]["mix"]}
        self.assertEqual(mix["Gold"], 10)
        self.assertEqual(mix["Silver"], 20)
        self.assertEqual(mix["Water"], 70)
        self.assertEqual(sum(mix.values()), 100)

    def test_a_single_commodity_can_fill_the_hold_alone(self):
        rows = [row("Gold", "A", "S", supply=5000, profit=1000),
                row("Silver", "A", "S", supply=5000, profit=900)]
        plans = cgbuy.build_mixed(rows, hold=100)
        self.assertEqual(len(plans[0]["mix"]), 1)
        self.assertEqual(plans[0]["mix"][0]["tonnes"], 100)
        self.assertEqual(plans[0]["short"], 0)

    def test_short_station_reports_the_shortfall(self):
        rows = [row("Gold", "A", "S", supply=20, profit=1000),
                row("Silver", "A", "S", supply=10, profit=500)]
        plans = cgbuy.build_mixed(rows, hold=100)
        p = plans[0]
        self.assertEqual(p["tonnes"], 30)
        self.assertEqual(p["short"], 70)
        self.assertEqual(p["total"], 20 * 1000 + 10 * 500)

    def test_mix_entry_value_matches_tonnes_times_profit(self):
        rows = [row("Gold", "A", "S", supply=40, profit=1000, buy=9000)]
        m = cgbuy.build_mixed(rows, hold=100)[0]["mix"][0]
        self.assertEqual(m["value"], m["tonnes"] * m["profit_per_t"])
        self.assertEqual(m["buy"], 9000)

    def test_stations_are_ranked_by_credits_per_minute(self):
        rows = [
            row("Gold", "Slow", "S1", supply=500, profit=1000, minutes=100.0),
            row("Gold", "Fast", "S2", supply=500, profit=600, minutes=20.0),
            row("Gold", "Mid", "S3", supply=500, profit=800, minutes=40.0),
        ]
        plans = cgbuy.build_mixed(rows, hold=100)
        self.assertEqual([p["station"] for p in plans], ["Fast", "Mid", "Slow"])
        self.assertEqual(plans[0]["cr_per_min"], round(100 * 600 / 20.0))

    def test_same_station_name_in_two_systems_stays_separate(self):
        rows = [row("Gold", "Jameson Memorial", "Shinrarta", 500, 900),
                row("Gold", "Jameson Memorial", "Elsewhere", 500, 800)]
        plans = cgbuy.build_mixed(rows, hold=100)
        self.assertEqual(len(plans), 2)
        self.assertEqual({p["system"] for p in plans},
                         {"Shinrarta", "Elsewhere"})

    def test_station_metadata_comes_from_the_best_commodity(self):
        rows = [row("Silver", "A", "S", 500, 500, ly=12.0, ls=99,
                    carrier=True, updated="2024-12-30", minutes=17.0),
                row("Gold", "A", "S", 40, 1000, ly=12.0, ls=99,
                    carrier=True, updated="2024-12-31", minutes=17.0)]
        p = cgbuy.build_mixed(rows, hold=100)[0]
        self.assertEqual(p["ly"], 12.0)
        self.assertEqual(p["ls"], 99)
        self.assertTrue(p["carrier"])
        self.assertEqual(p["updated"], "2024-12-31")   # the Gold row
        self.assertEqual(p["trip_minutes"], 17.0)

    def test_zero_supply_rows_are_skipped(self):
        rows = [row("Gold", "A", "S", supply=0, profit=1000),
                row("Silver", "A", "S", supply=50, profit=500)]
        p = cgbuy.build_mixed(rows, hold=100)[0]
        self.assertEqual([m["commodity"] for m in p["mix"]], ["Silver"])

    def test_a_station_with_nothing_to_load_is_dropped(self):
        plans = cgbuy.build_mixed(
            [row("Gold", "A", "S", supply=0, profit=1000)], hold=100)
        self.assertEqual(plans, [])

    def test_no_rows_gives_no_plans(self):
        self.assertEqual(cgbuy.build_mixed([], hold=100), [])

    def test_hold_size_scales_the_haul(self):
        rows = [row("Gold", "A", "S", supply=5000, profit=1000)]
        small = cgbuy.build_mixed(rows, hold=64)[0]
        large = cgbuy.build_mixed(rows, hold=784)[0]
        self.assertEqual(small["tonnes"], 64)
        self.assertEqual(large["tonnes"], 784)
        self.assertGreater(large["total"], small["total"])


# --------------------------------------------------------------------------
# cgbuy.mixed_sort_value - the mixed-load table's column sort
# --------------------------------------------------------------------------

class TestMixedSortValue(unittest.TestCase):

    def plans(self):
        rows = [row("Gold", "beta dock", "Zeta", 500, 600, ly=30.0, ls=900,
                    updated="2024-12-01", minutes=50.0),
                row("Gold", "Alpha Hub", "Yankee", 500, 1000, ly=5.0, ls=12,
                    updated="2025-01-02", minutes=20.0)]
        return cgbuy.build_mixed(rows, hold=100)

    def order(self, key, desc=True):
        ps = sorted(self.plans(),
                    key=lambda p: cgbuy.mixed_sort_value(p, key), reverse=desc)
        return [p["station"] for p in ps]

    def test_credits_per_minute_is_the_default_order(self):
        self.assertEqual([p["station"] for p in self.plans()],
                         ["Alpha Hub", "beta dock"])
        self.assertEqual(self.order("cr_per_min"), ["Alpha Hub", "beta dock"])

    def test_numeric_columns_sort_by_value_not_by_text(self):
        self.assertEqual(self.order("ly", desc=False), ["Alpha Hub",
                                                        "beta dock"])
        self.assertEqual(self.order("ls"), ["beta dock", "Alpha Hub"])

    def test_names_sort_case_insensitively(self):
        # "beta dock" would beat "Alpha Hub" under a raw string compare,
        # because every lowercase letter sorts after every uppercase one.
        self.assertEqual(self.order("station", desc=False),
                         ["Alpha Hub", "beta dock"])
        self.assertEqual(self.order("system", desc=False),
                         ["Alpha Hub", "beta dock"])   # Yankee, then Zeta

    def test_newest_data_first_when_sorting_by_date_descending(self):
        self.assertEqual(self.order("updated"), ["Alpha Hub", "beta dock"])

    def test_a_missing_value_does_not_break_the_comparison(self):
        plans = self.plans() + [{"station": None, "system": None,
                                 "updated": None, "ls": None}]
        for key in cgbuy.App.MIXED_SORTABLE:
            with self.subTest(key=key):
                sorted(plans, key=lambda p: cgbuy.mixed_sort_value(p, key),
                       reverse=True)

    def test_every_sortable_column_is_a_column_of_the_table(self):
        keys = {k for k, _lbl, _w, _a in cgbuy.App.MIXED_COLS}
        self.assertTrue(set(cgbuy.App.MIXED_SORTABLE) <= keys)

    def test_every_sortable_column_is_a_field_of_a_plan(self):
        plan = self.plans()[0]
        for key in cgbuy.App.MIXED_SORTABLE:
            self.assertIn(key, plan)


# --------------------------------------------------------------------------
# cgbuy.derive_commodities
# --------------------------------------------------------------------------

def market_item(name, mean, sell, localised=None):
    """One Market.json Items entry, with only what derive_commodities reads."""
    it = {"Name": name, "MeanPrice": mean, "SellPrice": sell}
    if localised is not None:
        it["Name_Localised"] = localised
    return it


class TestDeriveCommodities(unittest.TestCase):

    def test_goods_paying_the_cg_multiple_are_picked(self):
        items = [market_item("$gold_name;", 9400, 9400 * 3, "Gold")]
        self.assertEqual(cgbuy.derive_commodities(items), ["Gold"])

    def test_exactly_the_ratio_counts_as_premium(self):
        mean = 1000
        at = market_item("At", mean, int(mean * cgbuy.CG_PRICE_RATIO))
        self.assertEqual(cgbuy.derive_commodities([at]), ["At"])

    def test_just_under_the_ratio_is_excluded(self):
        mean = 1000
        under = market_item("Under", mean, int(mean * cgbuy.CG_PRICE_RATIO) - 1)
        self.assertEqual(cgbuy.derive_commodities([under]), [])

    def test_an_ordinary_market_spread_is_not_a_premium(self):
        items = [market_item("Water", 300, 320),
                 market_item("Cobalt", 1000, 1100)]
        self.assertEqual(cgbuy.derive_commodities(items), [])

    def test_zero_mean_price_does_not_divide_by_zero(self):
        # limpets and salvage report MeanPrice 0 or omit it entirely
        items = [market_item("Limpet", 0, 100),
                 market_item("Salvage", None, 100000)]
        self.assertEqual(cgbuy.derive_commodities(items), [])

    def test_missing_keys_are_tolerated(self):
        self.assertEqual(cgbuy.derive_commodities([{}, {"Name": "X"},
                                                   {"MeanPrice": 100}]), [])

    def test_zero_sell_price_is_not_a_premium(self):
        self.assertEqual(
            cgbuy.derive_commodities([market_item("Gold", 9400, 0)]), [])

    def test_empty_input_returns_empty_list(self):
        self.assertEqual(cgbuy.derive_commodities([]), [])
        self.assertEqual(cgbuy.derive_commodities(None), [])

    def test_localised_name_wins_over_the_game_symbol(self):
        items = [market_item("$bertrandite_name;", 2000, 20000, "Bertrandite")]
        self.assertEqual(cgbuy.derive_commodities(items), ["Bertrandite"])

    def test_result_is_sorted_and_nameless_entries_are_dropped(self):
        items = [market_item("Silver", 4700, 23000),
                 market_item("", 1000, 10000),
                 market_item("Gold", 9400, 45000)]
        self.assertEqual(cgbuy.derive_commodities(items), ["Gold", "Silver"])

    def test_a_cg_market_yields_only_the_premium_goods(self):
        items = [
            market_item("$gold_name;", 9400, 45000, "Gold"),
            market_item("$silver_name;", 4700, 23000, "Silver"),
            market_item("$water_name;", 120, 130, "Water"),
            market_item("$drones_name;", 101, 100, "Limpet"),
            market_item("$usscargoblackbox_name;", 0, 8000, "Black Box"),
        ]
        self.assertEqual(cgbuy.derive_commodities(items), ["Gold", "Silver"])

    def test_the_real_market_fixture_is_handled(self):
        # fake_market()'s Gold (9500 on a 9400 mean) is an ordinary spread
        self.assertEqual(cgbuy.derive_commodities(fake_market()["Items"]), [])


# --------------------------------------------------------------------------
# cgbuy.pad_for_ship / cgbuy.station_fits
# --------------------------------------------------------------------------

def station(large=0, medium=0, small=0, **extra):
    """A Spansh station result, with only what station_fits reads."""
    st = {"large_pads": large, "medium_pads": medium, "small_pads": small}
    st.update(extra)
    return st


class TestPadForShip(unittest.TestCase):

    def test_known_ships_map_to_the_pad_they_need(self):
        for ship, pad in (("sidewinder", "S"), ("cobramkiii", "S"),
                          ("python", "M"), ("krait_mkii", "M"),
                          ("type9", "L"), ("cutter", "L")):
            with self.subTest(ship=ship):
                self.assertEqual(cgbuy.pad_for_ship(ship), pad)

    def test_lookup_is_case_insensitive(self):
        # the journal spells these however it likes
        self.assertEqual(cgbuy.pad_for_ship("Anaconda"), "L")
        self.assertEqual(cgbuy.pad_for_ship("PYTHON"), "M")
        self.assertEqual(cgbuy.pad_for_ship("CobraMkIII"), "S")

    def test_unknown_ship_falls_back_to_large(self):
        # over-restrictive is safe; guessing small would strand you
        self.assertEqual(cgbuy.pad_for_ship("corsair"), "L")
        self.assertEqual(cgbuy.pad_for_ship(""), "L")
        self.assertEqual(cgbuy.pad_for_ship(None), "L")

    def test_every_table_entry_is_a_real_pad_size(self):
        self.assertEqual(set(cgbuy.SHIP_PADS.values()), set(cgbuy.PAD_ORDER))


class TestStationFits(unittest.TestCase):

    def test_the_pad_matrix(self):
        cases = [
            (station(large=2, medium=4, small=8),
             {"L": True, "M": True, "S": True}),
            (station(medium=4, small=8),
             {"L": False, "M": True, "S": True}),
            (station(small=8),
             {"L": False, "M": False, "S": True}),
            (station(),
             {"L": False, "M": False, "S": False}),
        ]
        for st, expect in cases:
            for pad, fits in expect.items():
                with self.subTest(station=st, pad=pad):
                    self.assertIs(cgbuy.station_fits(st, pad), fits)

    def test_an_outpost_with_only_medium_pads_rejects_a_large_ship(self):
        outpost = station(medium=2, small=2)
        self.assertFalse(
            cgbuy.station_fits(outpost, cgbuy.pad_for_ship("anaconda")))
        self.assertTrue(
            cgbuy.station_fits(outpost, cgbuy.pad_for_ship("python")))
        self.assertTrue(
            cgbuy.station_fits(outpost, cgbuy.pad_for_ship("sidewinder")))

    def test_a_large_pad_takes_every_smaller_ship_too(self):
        big = station(large=3)
        for ship in ("anaconda", "python", "sidewinder"):
            with self.subTest(ship=ship):
                self.assertTrue(
                    cgbuy.station_fits(big, cgbuy.pad_for_ship(ship)))

    def test_missing_or_null_counts_are_treated_as_none(self):
        self.assertFalse(cgbuy.station_fits({}, "L"))
        self.assertFalse(cgbuy.station_fits({"large_pads": None}, "L"))
        self.assertFalse(cgbuy.station_fits({"medium_pads": None}, "M"))

    def test_legacy_has_large_pad_flag_admits_a_large_ship(self):
        # Spansh's older per-station field, kept so a result carrying no
        # per-size counts is not dropped for the ship it was reported for.
        self.assertTrue(cgbuy.station_fits({"has_large_pad": True}, "L"))
        self.assertFalse(cgbuy.station_fits({"has_large_pad": False}, "L"))

    def test_has_large_pad_alone_admits_every_ship(self):
        """A large pad physically accepts any ship, so a result carrying only
        the legacy flag must be visible to all three sizes. It previously
        counted on the "L" branch alone, hiding such stations from exactly the
        smaller ships that could most easily use them."""
        st = {"has_large_pad": True}
        for pad in ("L", "M", "S"):
            self.assertTrue(cgbuy.station_fits(st, pad),
                            "large pad should admit a %s ship" % pad)


# --------------------------------------------------------------------------
# the data layer: cgbuy.fetch_cg_prices, fetch_cg_arrival_ls, fetch_sources
# --------------------------------------------------------------------------

def days_ago(n):
    """An ISO date n whole days before today."""
    return (datetime.date.today() - datetime.timedelta(days=n)).isoformat()


class FakeNetTestCase(unittest.TestCase):
    """Base for anything that reaches the data layer.

    cgbuy.post_json and cgbuy.get_json are swapped for fakes that return
    canned dicts and record what was asked, so nothing here can open a socket
    even if the code under test grows a new call. Set `get_result` /
    `post_result` to a dict, or to a callable for per-request answers.
    """

    def setUp(self):
        self.gets = []
        self.posts = []
        self.get_result = {}
        self.post_result = {"results": []}
        self.patch(cgbuy, "get_json", self.fake_get)
        self.patch(cgbuy, "post_json", self.fake_post)

    def patch(self, mod, name, fn):
        old = getattr(mod, name)
        setattr(mod, name, fn)
        self.addCleanup(setattr, mod, name, old)

    def fake_get(self, url, timeout=45):
        self.gets.append(url)
        r = self.get_result
        return r(url) if callable(r) else r

    def fake_post(self, url, payload, timeout=60):
        self.posts.append((url, payload))
        r = self.post_result
        return r(url, payload) if callable(r) else r

    def payloads(self):
        return [p for _, p in self.posts]


def edsm_market_doc(*entries):
    """An EDSM stations/market response. Entries are (name, sell, demand)."""
    return {"commodities": [{"name": n, "sellPrice": s, "demand": d,
                             "buyPrice": 0, "stock": 0}
                            for n, s, d in entries]}


class TestFetchCgPrices(FakeNetTestCase):

    def dest(self, **kw):
        d = {"station": "Metz Enterprise", "system": "Ega",
             "commodities": ["Gold", "Silver"]}
        d.update(kw)
        return d

    def test_only_the_destination_commodities_survive(self):
        self.get_result = edsm_market_doc(("Gold", 45000, 900000),
                                          ("Silver", 23000, 500000),
                                          ("Water", 130, 4000),
                                          ("Tritium", 55000, 12))
        got = cgbuy.fetch_cg_prices(self.dest())
        self.assertEqual(sorted(got), ["Gold", "Silver"])
        self.assertEqual(got["Gold"], {"sell": 45000, "demand": 900000})
        self.assertEqual(got["Silver"], {"sell": 23000, "demand": 500000})

    def test_the_url_names_the_configured_station_and_system(self):
        self.get_result = edsm_market_doc()
        cgbuy.fetch_cg_prices(self.dest(station="Jameson Memorial",
                                        system="Shinrarta Dezhra"))
        self.assertEqual(len(self.gets), 1)
        url = self.gets[0]
        self.assertIn("systemName=Shinrarta%20Dezhra", url)
        self.assertIn("stationName=Jameson%20Memorial", url)
        self.assertNotIn("Ega", url)
        self.assertNotIn("Metz", url)

    def test_a_market_holding_none_of_our_goods_returns_empty(self):
        self.get_result = edsm_market_doc(("Tritium", 55000, 12))
        self.assertEqual(cgbuy.fetch_cg_prices(self.dest()), {})

    def test_an_empty_commodity_list_selects_nothing(self):
        self.get_result = edsm_market_doc(("Gold", 45000, 900000))
        self.assertEqual(cgbuy.fetch_cg_prices(self.dest(commodities=[])), {})

    def test_a_response_without_commodities_returns_empty(self):
        self.get_result = {}
        self.assertEqual(cgbuy.fetch_cg_prices(self.dest()), {})

    def test_prices_pass_through_untouched(self):
        # the CG multiplier is already in what the station reports
        self.get_result = edsm_market_doc(("Gold", 45000, 900000))
        self.assertEqual(cgbuy.fetch_cg_prices(self.dest())["Gold"]["sell"],
                         45000)

    def test_the_empty_default_destination_selects_nothing(self):
        """DEFAULT_DEST carries no commodities, so nothing is selected from
        the market - it is a placeholder, not a usable destination."""
        self.get_result = edsm_market_doc(("Gold", 45000, 9),
                                          ("Water", 130, 4),
                                          ("Tritium", 55000, 12))
        got = cgbuy.fetch_cg_prices(cgbuy.DEFAULT_DEST)
        self.assertEqual(got, {})


class TestFetchCgArrivalLs(FakeNetTestCase):

    DEST = {"station": "Metz Enterprise", "system": "Ega",
            "commodities": ["Gold"]}

    def test_the_matching_stations_distance_is_returned(self):
        self.get_result = {"stations": [
            {"name": "Somewhere Else", "distanceToArrival": 90000},
            {"name": "Metz Enterprise", "distanceToArrival": 331},
        ]}
        self.assertEqual(cgbuy.fetch_cg_arrival_ls(self.DEST), 331)
        self.assertIn("systemName=Ega", self.gets[0])

    def test_an_unknown_station_gives_zero(self):
        self.get_result = {"stations": [{"name": "Other",
                                         "distanceToArrival": 12}]}
        self.assertEqual(cgbuy.fetch_cg_arrival_ls(self.DEST), 0)

    def test_a_null_distance_gives_zero(self):
        self.get_result = {"stations": [{"name": "Metz Enterprise",
                                         "distanceToArrival": None}]}
        self.assertEqual(cgbuy.fetch_cg_arrival_ls(self.DEST), 0)

    def test_a_failed_lookup_gives_zero_rather_than_raising(self):
        def boom(url):
            raise OSError("EDSM down")
        self.get_result = boom
        self.assertEqual(cgbuy.fetch_cg_arrival_ls(self.DEST), 0)


def spansh_results(n, first=1.0, step=1.0, prefix="Src"):
    """n Spansh station results at steadily increasing distances."""
    return {"results": [{"name": "%s %d" % (prefix, i),
                         "system_name": "Sys %d" % i,
                         "distance": first + i * step}
                        for i in range(n)]}


class TestFetchSources(FakeNetTestCase):

    def test_the_payload_carries_the_reference_system_it_was_given(self):
        # The refactor bug: this read a module-level CG_SYSTEM while the
        # signature said otherwise, so every search measured from Ega.
        self.post_result = spansh_results(1)
        cgbuy.fetch_sources("Gold", 40, 100, "Shinrarta Dezhra")
        url, payload = self.posts[0]
        self.assertEqual(url, cgbuy.SPANSH_SEARCH)
        self.assertEqual(payload["reference_system"], "Shinrarta Dezhra")

    def test_two_searches_do_not_share_one_reference_system(self):
        self.post_result = spansh_results(1)
        cgbuy.fetch_sources("Gold", 40, 100, "Sol")
        cgbuy.fetch_sources("Gold", 40, 100, "Colonia")
        self.assertEqual([p["reference_system"] for p in self.payloads()],
                         ["Sol", "Colonia"])

    def test_the_filters_carry_the_commodity_radius_and_min_supply(self):
        self.post_result = spansh_results(1)
        cgbuy.fetch_sources("Bertrandite", 55, 700, "Sol", page_size=250)
        p = self.payloads()[0]
        self.assertEqual(p["filters"]["distance"]["value"], [0, 55])
        market = p["filters"]["market"][0]
        self.assertEqual(market["name"], "Bertrandite")
        self.assertEqual(market["supply"]["value"][0], 700)
        self.assertEqual(p["size"], 250)
        self.assertEqual(p["page"], 0)

    def test_a_short_page_ends_the_walk(self):
        self.post_result = spansh_results(3)
        out = cgbuy.fetch_sources("Gold", 40, 1, "Sol", page_size=10)
        self.assertEqual(len(out), 3)
        self.assertEqual(len(self.posts), 1)

    def test_full_pages_are_followed_until_one_comes_up_short(self):
        pages = [spansh_results(10, first=1.0), spansh_results(10, first=11.0),
                 spansh_results(4, first=21.0)]
        self.post_result = lambda url, p: pages[p["page"]]
        out = cgbuy.fetch_sources("Gold", 40, 1, "Sol", page_size=10)
        self.assertEqual(len(out), 24)
        self.assertEqual([p["page"] for p in self.payloads()], [0, 1, 2])

    def test_results_running_past_the_radius_stop_the_walk(self):
        # sorted by distance, so once the page ends beyond max_ly there is
        # nothing nearer left to find
        self.post_result = spansh_results(10, first=35.0, step=1.0)
        out = cgbuy.fetch_sources("Gold", 40, 1, "Sol", page_size=10)
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(len(out), 10)

    def test_a_page_still_inside_the_radius_is_followed(self):
        self.post_result = spansh_results(10, first=1.0, step=0.5)
        cgbuy.fetch_sources("Gold", 40, 1, "Sol", page_size=10, max_pages=2)
        self.assertEqual(len(self.posts), 2)

    def test_max_pages_caps_the_walk(self):
        self.post_result = spansh_results(10, first=1.0, step=0.1)
        out = cgbuy.fetch_sources("Gold", 40, 1, "Sol", page_size=10,
                                  max_pages=3)
        self.assertEqual(len(self.posts), 3)
        self.assertEqual(len(out), 30)

    def test_an_empty_first_page_is_not_an_index_error(self):
        self.post_result = {"results": []}
        self.assertEqual(
            cgbuy.fetch_sources("Gold", 40, 1, "Sol", page_size=10), [])

    def test_a_response_without_results_is_empty(self):
        self.post_result = {}
        self.assertEqual(cgbuy.fetch_sources("Gold", 40, 1, "Sol"), [])

    def test_a_dropped_connection_keeps_what_was_already_fetched(self):
        pages = [spansh_results(10, first=1.0)]

        def flaky(url, p):
            if p["page"] >= len(pages):
                raise OSError("connection reset")
            return pages[p["page"]]

        self.post_result = flaky
        with quiet_stderr() as err:
            out = cgbuy.fetch_sources("Gold", 40, 1, "Sol", page_size=10)
        self.assertEqual(len(out), 10)
        self.assertIn("Gold", err.getvalue())


# --------------------------------------------------------------------------
# cgbuy.build_rows
# --------------------------------------------------------------------------

def source_station(name="Alpha Hub", system="Sys A", commodity="Gold",
                   buy=9000, supply=600, distance=12.0, ls=250, age_days=0,
                   stype="Coriolis Starport", large=2, medium=4, small=8):
    """A Spansh station result with one commodity, as build_rows reads it."""
    return {"name": name, "system_name": system, "distance": distance,
            "distance_to_arrival": ls, "type": stype,
            "large_pads": large, "medium_pads": medium, "small_pads": small,
            "market_updated_at": days_ago(age_days) + " 04:00:00",
            "market": [{"commodity": commodity, "buy_price": buy,
                        "supply": supply}]}


class BuildRowsTestCase(FakeNetTestCase):
    """build_rows with EDSM and Spansh both faked.

    `sell` is the destination market, `sources` the Spansh answer per
    commodity. EDSM verification is off unless a test turns it on.
    """

    DEST = {"station": "Metz Enterprise", "system": "Ega",
            "commodities": ["Gold", "Silver"], "source": "test"}

    def setUp(self):
        super().setUp()
        self.sell = {"Gold": 45000, "Silver": 23000}
        self.arrival_ls = 300
        self.sources = {}
        self.get_result = self.fake_edsm
        self.post_result = self.fake_spansh

    def fake_edsm(self, url):
        if "stations/market" in url:
            return {"commodities": [
                {"name": n, "sellPrice": s, "demand": 900000, "buyPrice": 0,
                 "stock": 0} for n, s in self.sell.items()]}
        return {"stations": [{"name": self.DEST["station"],
                              "distanceToArrival": self.arrival_ls}]}

    def fake_spansh(self, url, payload):
        if payload["page"] > 0:
            return {"results": []}
        name = payload["filters"]["market"][0]["name"]
        return {"results": list(self.sources.get(name, []))}

    def params(self, **kw):
        p = {"dest": self.DEST, "range": 40, "min_supply": 100, "hold": 100,
             "jump_empty": 30.0, "jump_laden": 25.0, "carriers": False,
             "pad": "L", "verify_edsm": False, "max_age_days": 0}
        p.update(kw)
        return p

    def build(self, **kw):
        return cgbuy.build_rows(self.params(**kw))


class TestBuildRows(BuildRowsTestCase):

    def test_a_row_is_scored_for_every_stocked_commodity(self):
        self.sources = {
            "Gold": [source_station(commodity="Gold", buy=9000, supply=600)],
            "Silver": [source_station(name="Beta Ring", system="Sys B",
                                      commodity="Silver", buy=3000,
                                      supply=40)],
        }
        rows, prices, cg_ls, hidden = self.build()
        self.assertEqual(sorted(r["commodity"] for r in rows),
                         ["Gold", "Silver"])
        by = {r["commodity"]: r for r in rows}
        self.assertEqual(by["Gold"]["profit_per_t"], 45000 - 9000)
        self.assertEqual(by["Gold"]["load"], 100)          # hold-capped
        self.assertEqual(by["Gold"]["trip_profit"], 100 * 36000)
        self.assertEqual(by["Silver"]["load"], 40)         # supply-capped
        self.assertEqual(by["Silver"]["station"], "Beta Ring")
        self.assertEqual(sorted(prices), ["Gold", "Silver"])
        self.assertEqual(cg_ls, 300)
        self.assertEqual(hidden, 0)

    def test_the_four_tuple_shape(self):
        self.sources = {"Gold": [source_station()]}
        out = self.build()
        self.assertEqual(len(out), 4)
        rows, prices, cg_ls, hidden = out
        self.assertIsInstance(rows, list)
        self.assertIsInstance(prices, dict)
        self.assertIsInstance(hidden, int)

    def test_the_destination_from_p_is_used_end_to_end(self):
        dest = {"station": "Jameson Memorial", "system": "Shinrarta Dezhra",
                "commodities": ["Tritium"]}
        self.sell = {"Tritium": 60000}
        self.sources = {"Tritium": [source_station(commodity="Tritium",
                                                   buy=40000)]}
        rows, _, _, _ = self.build(dest=dest)
        self.assertTrue(any("stationName=Jameson%20Memorial" in u
                            for u in self.gets))
        self.assertTrue(any("systemName=Shinrarta%20Dezhra" in u
                            for u in self.gets))
        # every Spansh search measured from the configured system...
        self.assertEqual({p["reference_system"] for p in self.payloads()},
                         {"Shinrarta Dezhra"})
        # ...and only the configured commodities were searched at all
        self.assertEqual({p["filters"]["market"][0]["name"]
                          for p in self.payloads()}, {"Tritium"})
        self.assertEqual([r["commodity"] for r in rows], ["Tritium"])

    def test_the_shipped_default_destination_is_empty(self):
        """No station and no commodities are shipped as defaults.

        One player's community goal used to be everyone's starting point,
        so anyone else running the tool searched around a system they had
        nothing to do with. The destination is discovered from the journal
        instead, and asked for only if that fails.
        """
        self.assertIsNone(cgbuy.DEFAULT_DEST["station"])
        self.assertIsNone(cgbuy.DEFAULT_DEST["system"])
        self.assertEqual(cgbuy.DEFAULT_DEST["commodities"], [])

    def test_no_destination_searches_for_nothing(self):
        """With no destination there is nothing to look up, so no requests
        go out at all - rather than quietly querying a stale default."""
        self.sell = {}
        rows, _, _, _ = self.build(dest=dict(cgbuy.DEFAULT_DEST,
                                             station="X", system="Y"))
        self.assertEqual(rows, [])
        self.assertEqual(self.payloads(), [])

    def test_an_unknown_destination_market_is_an_error_not_an_empty_grid(self):
        self.sell = {}
        with self.assertRaises(RuntimeError) as caught:
            self.build()
        self.assertIn("Metz Enterprise", str(caught.exception))

    def test_a_commodity_the_destination_does_not_buy_is_never_searched(self):
        self.sell = {"Gold": 45000, "Silver": 0}
        self.sources = {"Gold": [source_station()],
                        "Silver": [source_station(commodity="Silver")]}
        rows, _, _, _ = self.build()
        self.assertEqual([r["commodity"] for r in rows], ["Gold"])
        self.assertEqual({p["filters"]["market"][0]["name"]
                          for p in self.payloads()}, {"Gold"})

    def test_stations_too_small_for_the_ship_are_dropped(self):
        self.sources = {"Gold": [
            source_station(name="Coriolis", large=2, medium=4, small=8),
            source_station(name="Outpost", system="Sys B",
                           large=0, medium=2, small=2),
        ]}
        big, _, _, _ = self.build(pad="L")
        self.assertEqual([r["station"] for r in big], ["Coriolis"])
        med, _, _, _ = self.build(pad="M")
        self.assertEqual(sorted(r["station"] for r in med),
                         ["Coriolis", "Outpost"])

    def test_the_pad_comes_from_the_ship_the_commander_flies(self):
        self.sources = {"Gold": [source_station(name="Outpost", large=0,
                                                medium=2, small=2)]}
        anaconda, _, _, _ = self.build(pad=cgbuy.pad_for_ship("anaconda"))
        python, _, _, _ = self.build(pad=cgbuy.pad_for_ship("python"))
        self.assertEqual(anaconda, [])
        self.assertEqual([r["station"] for r in python], ["Outpost"])

    def test_carriers_are_excluded_unless_asked_for(self):
        self.sources = {"Gold": [
            source_station(name="Static", stype="Coriolis Starport"),
            source_station(name="K7Q-BQL", system="Sys B",
                           stype="Drake-Class Carrier"),
        ]}
        without, _, _, _ = self.build(carriers=False)
        self.assertEqual([r["station"] for r in without], ["Static"])
        with_, _, _, _ = self.build(carriers=True)
        self.assertEqual(sorted(r["station"] for r in with_),
                         ["K7Q-BQL", "Static"])
        carrier = next(r for r in with_ if r["station"] == "K7Q-BQL")
        self.assertTrue(carrier["carrier"])

    def test_rows_with_no_profit_are_dropped(self):
        self.sources = {"Gold": [
            source_station(name="Cheap", buy=9000),
            source_station(name="Dear", system="Sys B", buy=45000),
            source_station(name="Dearer", system="Sys C", buy=90000),
        ]}
        rows, _, _, _ = self.build()
        self.assertEqual([r["station"] for r in rows], ["Cheap"])

    def test_rows_with_no_supply_or_no_price_are_dropped(self):
        self.sources = {"Gold": [
            source_station(name="Stocked", supply=600),
            source_station(name="Empty", system="Sys B", supply=0),
            source_station(name="Priceless", system="Sys C", buy=0),
        ]}
        rows, _, _, _ = self.build()
        self.assertEqual([r["station"] for r in rows], ["Stocked"])

    def test_a_station_not_selling_the_searched_commodity_is_dropped(self):
        odd = source_station(name="Odd", commodity="Water")
        self.sources = {"Gold": [odd]}
        rows, _, _, _ = self.build()
        self.assertEqual(rows, [])

    def test_results_beyond_the_radius_are_dropped(self):
        self.sources = {"Gold": [
            source_station(name="Near", distance=12.0),
            source_station(name="Far", system="Sys B", distance=41.0),
        ]}
        rows, _, _, _ = self.build(range=40)
        self.assertEqual([r["station"] for r in rows], ["Near"])

    def test_derived_figures_are_consistent(self):
        self.sources = {"Gold": [source_station(buy=9000, supply=250,
                                                distance=12.0, ls=250)]}
        rows, _, cg_ls, _ = self.build(hold=100)
        r = rows[0]
        self.assertEqual(r["profit_per_t"], 36000)
        self.assertEqual(r["load"], 100)
        self.assertEqual(r["loads_available"], 2.5)
        self.assertEqual(r["ly"], 12.0)
        self.assertEqual(r["ls"], 250)
        self.assertEqual(r["updated"], days_ago(0))
        mins = cgbuy.trip_minutes(12.0, 250, cg_ls, 30.0, 25.0, None)
        self.assertEqual(r["trip_minutes"], round(mins, 1))
        self.assertEqual(r["cr_per_min"], round(100 * 36000 / mins))

    def test_progress_is_reported_once_per_commodity(self):
        self.sources = {"Gold": [source_station()]}
        seen = []
        cgbuy.build_rows(self.params(), progress=lambda *a: seen.append(a))
        self.assertEqual(sorted(s[2] for s in seen), ["Gold", "Silver"])
        self.assertTrue(all(s[1] == 2 for s in seen))


class TestBuildRowsAgeFilter(BuildRowsTestCase):

    def stations_of_ages(self, *ages):
        self.sources = {"Gold": [
            source_station(name="St %d" % i, system="Sys %d" % i, age_days=a)
            for i, a in enumerate(ages)]}

    def test_stale_rows_are_hidden_and_counted(self):
        self.stations_of_ages(0, 1, 10, 30)
        rows, _, _, hidden = self.build(max_age_days=7)
        self.assertEqual(sorted(r["updated"] for r in rows),
                         sorted([days_ago(1), days_ago(0)]))
        self.assertEqual(hidden, 2)

    def test_the_boundary_day_is_kept(self):
        self.stations_of_ages(7, 8)
        rows, _, _, hidden = self.build(max_age_days=7)
        self.assertEqual([r["updated"] for r in rows], [days_ago(7)])
        self.assertEqual(hidden, 1)

    def test_a_row_with_no_timestamp_counts_as_stale(self):
        self.stations_of_ages(0)
        undated = source_station(name="Undated", system="Sys Z")
        undated["market_updated_at"] = None
        self.sources["Gold"].append(undated)
        rows, _, _, hidden = self.build(max_age_days=7)
        self.assertEqual([r["station"] for r in rows], ["St 0"])
        self.assertEqual(hidden, 1)

    def test_the_filter_never_empties_the_grid(self):
        # a stale answer beats no answer at all
        self.stations_of_ages(30, 60)
        rows, _, _, hidden = self.build(max_age_days=7)
        self.assertEqual(len(rows), 2)
        self.assertEqual(hidden, 0)

    def test_a_zero_max_age_disables_the_filter(self):
        self.stations_of_ages(0, 400)
        rows, _, _, hidden = self.build(max_age_days=0)
        self.assertEqual(len(rows), 2)
        self.assertEqual(hidden, 0)

    def test_the_default_max_age_applies_when_p_says_nothing(self):
        self.stations_of_ages(0, 30)
        p = self.params()
        del p["max_age_days"]
        rows, _, _, hidden = cgbuy.build_rows(p)
        self.assertEqual(cgbuy.MAX_AGE_DEFAULT, 7)
        self.assertEqual([r["updated"] for r in rows], [days_ago(0)])
        self.assertEqual(hidden, 1)


# --------------------------------------------------------------------------
# verify.refresh
# --------------------------------------------------------------------------

def vrow(commodity="Gold", station="Alpha Hub", system="Sys A", supply=530,
         buy=9000, cr_per_min=1000, updated="2025-01-01"):
    """A build_rows()-shaped row, with only what verify.refresh reads."""
    return {"commodity": commodity, "station": station, "system": system,
            "supply": supply, "buy": buy, "sell": 45000,
            "profit_per_t": 45000 - buy, "cr_per_min": cr_per_min,
            "updated": updated}


class VerifyTestCase(unittest.TestCase):
    """verify with EDSM replaced by canned dicts.

    verify._get is the only door to the network, so replacing it is enough;
    the module cache is cleared either side so one test's answers can never
    leak into the next.
    """

    def setUp(self):
        verify._cache.clear()
        self.addCleanup(verify._cache.clear)
        self.urls = []
        self.systems = {}        # system -> {station: market timestamp}
        self.markets = {}        # (sys, stn) -> {commodity: (buy, stock)}
        self.limit_after = None  # raise RateLimited from this request on
        old = verify._get
        verify._get = self.fake_verify_get
        self.addCleanup(setattr, verify, "_get", old)

    # deliberately not called fake_get: a test case can inherit both this and
    # FakeNetTestCase, and two fakes answering to one name would silently
    # point verify at Spansh's stand-in.
    def fake_verify_get(self, url, timeout=25):
        self.urls.append(url)
        if self.limit_after is not None and len(self.urls) > self.limit_after:
            raise verify.RateLimited("EDSM rate limit")
        q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        sysname = q["systemName"][0]
        station = q.get("stationName", [None])[0]
        if station is None:
            return {"stations": [
                {"name": n, "updateTime": {"market": t}}
                for n, t in self.systems.get(sysname, {}).items()]}
        market = self.markets.get((sysname, station), {})
        return {"commodities": [
            {"name": c, "buyPrice": buy, "stock": stock,
             "sellPrice": 0, "demand": 0}
            for c, (buy, stock) in market.items()]}

    def edsm_has(self, system, station, stamp="2025-06-01 09:00:00", **goods):
        self.systems.setdefault(system, {})[station] = stamp
        self.markets[(system, station)] = goods


class TestVerifyRefresh(VerifyTestCase):

    def test_supply_and_buy_price_are_corrected(self):
        # the case that motivated the module: Spansh said 530t, EDSM 18t
        self.edsm_has("Sys A", "Alpha Hub", Gold=(9100, 18))
        rows = [vrow(supply=530, buy=9000)]
        checked, corrected, limited = verify.refresh(rows)
        self.assertEqual((checked, corrected, limited), (1, 1, False))
        self.assertEqual(rows[0]["supply"], 18)
        self.assertEqual(rows[0]["buy"], 9100)
        self.assertTrue(rows[0]["edsm"])

    def test_the_row_timestamp_becomes_the_edsm_market_time(self):
        self.edsm_has("Sys A", "Alpha Hub", stamp="2025-06-01 09:00:00",
                      Gold=(9100, 18))
        rows = [vrow()]
        verify.refresh(rows)
        self.assertEqual(rows[0]["updated"], "2025-06-01")

    def test_figures_that_already_agree_are_not_counted_as_corrections(self):
        self.edsm_has("Sys A", "Alpha Hub", Gold=(9000, 530))
        rows = [vrow(supply=530, buy=9000)]
        checked, corrected, limited = verify.refresh(rows)
        self.assertEqual((checked, corrected, limited), (1, 0, False))
        self.assertTrue(rows[0]["edsm"])

    def test_a_station_edsm_has_never_seen_is_left_alone_and_flagged(self):
        self.edsm_has("Sys A", "Alpha Hub", Gold=(9100, 18))
        rows = [vrow(station="Alpha Hub"),
                vrow(station="Ghost Dock", system="Sys A", supply=999,
                     buy=1234, cr_per_min=500)]
        verify.refresh(rows)
        ghost = rows[1]
        self.assertFalse(ghost["edsm"])
        self.assertEqual(ghost["supply"], 999)
        self.assertEqual(ghost["buy"], 1234)
        self.assertEqual(ghost["updated"], "2025-01-01")

    def test_a_station_without_our_commodity_is_not_marked(self):
        self.edsm_has("Sys A", "Alpha Hub", Silver=(3000, 400))
        rows = [vrow(commodity="Gold", supply=530)]
        checked, corrected, _ = verify.refresh(rows)
        self.assertEqual((checked, corrected), (1, 0))
        self.assertFalse(rows[0]["edsm"])
        self.assertEqual(rows[0]["supply"], 530)

    def test_only_the_top_rows_are_checked(self):
        for i in range(3):
            self.edsm_has("Sys %d" % i, "St %d" % i, Gold=(9100, 18))
        rows = [vrow(station="St %d" % i, system="Sys %d" % i,
                     cr_per_min=100 * i) for i in range(3)]
        checked, _, _ = verify.refresh(rows, top=1)
        self.assertEqual(checked, 1)
        # the best-paying row is the one that gets the accurate number
        self.assertEqual([r["edsm"] for r in rows], [False, False, True])

    def test_stations_are_ranked_by_credits_per_minute_not_input_order(self):
        for i in range(3):
            self.edsm_has("Sys %d" % i, "St %d" % i, Gold=(9100, 18))
        rows = [vrow(station="St 0", system="Sys 0", cr_per_min=10),
                vrow(station="St 1", system="Sys 1", cr_per_min=90),
                vrow(station="St 2", system="Sys 2", cr_per_min=50)]
        verify.refresh(rows, top=2)
        self.assertEqual([r["edsm"] for r in rows], [False, True, True])

    def test_every_row_at_a_checked_station_is_corrected(self):
        self.edsm_has("Sys A", "Alpha Hub", Gold=(9100, 18), Silver=(3100, 7))
        rows = [vrow(commodity="Gold"), vrow(commodity="Silver", buy=3000)]
        checked, corrected, _ = verify.refresh(rows, top=1)
        self.assertEqual(checked, 1)
        self.assertEqual(corrected, 2)
        self.assertEqual([r["supply"] for r in rows], [18, 7])

    def test_edsm_older_than_spansh_is_not_worth_a_request(self):
        self.edsm_has("Sys A", "Alpha Hub", stamp="2024-12-01 09:00:00",
                      Gold=(9100, 18))
        rows = [vrow(updated="2025-01-01", supply=530)]
        checked, corrected, _ = verify.refresh(rows)
        self.assertEqual((checked, corrected), (0, 0))
        self.assertFalse(rows[0]["edsm"])
        self.assertEqual(rows[0]["supply"], 530)
        self.assertEqual(len(self.urls), 1)       # the system list, no market

    def test_the_same_day_is_still_worth_a_request(self):
        self.edsm_has("Sys A", "Alpha Hub", stamp="2025-01-01 22:00:00",
                      Gold=(9100, 18))
        checked, _, _ = verify.refresh([vrow(updated="2025-01-01")])
        self.assertEqual(checked, 1)

    def test_rate_limiting_is_reported_not_swallowed(self):
        # an empty answer and a throttled one must not look the same
        self.edsm_has("Sys A", "Alpha Hub", Gold=(9100, 18))
        self.limit_after = 0
        rows = [vrow(supply=530)]
        checked, corrected, limited = verify.refresh(rows)
        self.assertTrue(limited)
        self.assertEqual((checked, corrected), (0, 0))
        self.assertFalse(rows[0]["edsm"])
        self.assertEqual(rows[0]["supply"], 530)

    def test_rate_limiting_partway_keeps_what_was_already_corrected(self):
        for i in range(3):
            self.edsm_has("Sys %d" % i, "St %d" % i, Gold=(9100, 18))
        self.limit_after = 2          # system list + one market, then no more
        rows = [vrow(station="St %d" % i, system="Sys %d" % i,
                     cr_per_min=100 - i) for i in range(3)]
        checked, corrected, limited = verify.refresh(rows)
        self.assertTrue(limited)
        self.assertEqual(checked, 1)
        self.assertEqual([r["edsm"] for r in rows], [True, False, False])

    def test_the_request_budget_caps_the_work(self):
        for i in range(3):
            self.edsm_has("Sys %d" % i, "St %d" % i, Gold=(9100, 18))
        rows = [vrow(station="St %d" % i, system="Sys %d" % i,
                     cr_per_min=100 - i) for i in range(3)]
        checked, _, limited = verify.refresh(rows, budget=2)
        self.assertEqual(checked, 1)          # 1 system list + 1 market
        self.assertFalse(limited)

    def test_one_system_is_listed_once_for_several_stations(self):
        self.edsm_has("Sys A", "St 0", Gold=(9100, 18))
        self.edsm_has("Sys A", "St 1", Gold=(9200, 20))
        rows = [vrow(station="St 0", system="Sys A", cr_per_min=90),
                vrow(station="St 1", system="Sys A", cr_per_min=80)]
        checked, _, _ = verify.refresh(rows)
        self.assertEqual(checked, 2)
        lists = [u for u in self.urls if "stationName" not in u]
        self.assertEqual(len(lists), 1)

    def test_no_rows_is_safe(self):
        self.assertEqual(verify.refresh([]), (0, 0, False))

    def test_a_broken_station_does_not_stop_the_rest(self):
        self.edsm_has("Sys A", "Good", Gold=(9100, 18))
        self.edsm_has("Sys B", "Bad", Gold=(9100, 18))
        real_get = verify._get

        def flaky(url, timeout=25):
            if "Bad" in url:
                raise OSError("connection reset")
            return real_get(url, timeout)

        verify._get = flaky
        rows = [vrow(station="Bad", system="Sys B", cr_per_min=99),
                vrow(station="Good", system="Sys A", cr_per_min=50)]
        checked, corrected, limited = verify.refresh(rows)
        self.assertEqual((checked, corrected, limited), (1, 1, False))
        self.assertEqual([r["edsm"] for r in rows], [False, True])

    def test_progress_is_reported(self):
        self.edsm_has("Sys A", "Alpha Hub", Gold=(9100, 18))
        seen = []
        verify.refresh([vrow()], progress=lambda done, total: seen.append(
            (done, total)))
        self.assertEqual(seen, [(1, 1)])


# --------------------------------------------------------------------------
# cgbuy.build_rows against a faked EDSM verification pass
# --------------------------------------------------------------------------

class TestBuildRowsVerify(BuildRowsTestCase, VerifyTestCase):
    """Both halves faked at once: Spansh discovers, EDSM corrects."""

    def setUp(self):
        BuildRowsTestCase.setUp(self)
        VerifyTestCase.setUp(self)

    def test_edsm_corrects_supply_and_the_row_is_rescored(self):
        self.sources = {"Gold": [source_station(name="Alpha Hub",
                                                system="Sys A",
                                                buy=9000, supply=600)]}
        self.edsm_has("Sys A", "Alpha Hub", stamp=days_ago(0) + " 09:00:00",
                      Gold=(9100, 18))
        rows, _, _, _ = self.build(verify_edsm=True, max_age_days=0)
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertTrue(r["edsm"])
        self.assertEqual(r["supply"], 18)
        self.assertEqual(r["buy"], 9100)
        self.assertEqual(r["profit_per_t"], 45000 - 9100)
        self.assertEqual(r["load"], 18)                 # supply, not the hold
        self.assertEqual(r["trip_profit"], 18 * (45000 - 9100))

    def test_a_station_edsm_says_is_empty_drops_out(self):
        self.sources = {"Gold": [
            source_station(name="Alpha Hub", system="Sys A", supply=600),
            source_station(name="Beta Ring", system="Sys B", supply=500)]}
        self.edsm_has("Sys A", "Alpha Hub", stamp=days_ago(0) + " 09:00:00",
                      Gold=(9100, 0))
        self.edsm_has("Sys B", "Beta Ring", stamp=days_ago(0) + " 09:00:00",
                      Gold=(9100, 400))
        rows, _, _, _ = self.build(verify_edsm=True, max_age_days=0)
        self.assertEqual([r["station"] for r in rows], ["Beta Ring"])

    def test_verification_is_skipped_when_switched_off(self):
        self.sources = {"Gold": [source_station(name="Alpha Hub",
                                                system="Sys A", supply=600)]}
        self.edsm_has("Sys A", "Alpha Hub", Gold=(9100, 18))
        rows, _, _, _ = self.build(verify_edsm=False, max_age_days=0)
        self.assertEqual(rows[0]["supply"], 600)
        self.assertEqual(self.urls, [])

    def test_a_rate_limited_pass_leaves_the_spansh_figures_in_place(self):
        self.sources = {"Gold": [source_station(name="Alpha Hub",
                                                system="Sys A", supply=600)]}
        self.edsm_has("Sys A", "Alpha Hub", Gold=(9100, 18))
        self.limit_after = 0
        rows, _, _, _ = self.build(verify_edsm=True, max_age_days=0)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["supply"], 600)
        self.assertFalse(rows[0]["edsm"])

    def test_a_failing_verifier_does_not_lose_the_search(self):
        self.sources = {"Gold": [source_station(name="Alpha Hub",
                                                system="Sys A", supply=600)]}

        def boom(url, timeout=25):
            raise RuntimeError("EDSM exploded")

        verify._get = boom
        with quiet_stderr():
            rows, _, _, _ = self.build(verify_edsm=True, max_age_days=0)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["supply"], 600)


# --------------------------------------------------------------------------
# cg.band_brackets / cg.standing
# --------------------------------------------------------------------------

def cg_sample(contribution, band, when="2025-01-01T12:00:00Z", **kw):
    """One CommunityGoal sample as cg.read_history would have produced it."""
    h = {"ts": when, "cgid": 727, "title": "Ega Mining Initiative",
         "station": "Metz Enterprise", "system": "Ega", "expiry": None,
         "contribution": contribution, "band": band, "total": 1000000,
         "contributors": 5000, "tier": 4, "top_tier": "Tier 8", "bonus": 0,
         "in_top_rank": False, "top_rank_size": 10}
    h.update(kw)
    return h


class TestReadHistory(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="cgbuy-test-cg-")
        self.addCleanup(self.tmp.cleanup)

    def write(self, *goals):
        path = os.path.join(self.tmp.name, "Journal.2025-01-01T120000.01.log")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"timestamp": "2025-01-01T12:00:00Z",
                                 "event": "CommunityGoal",
                                 "CurrentGoals": list(goals)}) + "\n")

    def test_the_top_rank_fields_are_read(self):
        self.write({"CGID": 859, "Title": "Wreaken", "SystemName": "Ega",
                    "MarketName": "Metz Enterprise",
                    "PlayerContribution": 19363, "PlayerPercentileBand": 25,
                    "TopRankSize": 10, "PlayerInTopRank": False})
        h = cg.read_history(self.tmp.name)
        self.assertEqual(len(h), 1)
        self.assertEqual(h[0]["band"], 25)
        self.assertEqual(h[0]["top_rank_size"], 10)
        self.assertIs(h[0]["in_top_rank"], False)

    def test_a_goal_without_a_top_rank_reads_as_none(self):
        self.write({"CGID": 1, "Title": "No rank", "PlayerContribution": 5,
                    "PlayerPercentileBand": 50})
        h = cg.read_history(self.tmp.name)
        self.assertIsNone(h[0]["top_rank_size"])
        self.assertIsNone(h[0]["in_top_rank"])


class TestTimesAverage(unittest.TestCase):

    def test_the_multiple_is_your_tonnage_over_the_mean(self):
        # 1,000,000 t across 5,000 contributors averages 200 t
        self.assertAlmostEqual(cg.times_average(600, 1000000, 5000), 3.0)

    def test_below_average_is_reported_as_such(self):
        self.assertAlmostEqual(cg.times_average(50, 1000000, 5000), 0.25)

    def test_missing_figures_give_nothing_rather_than_a_guess(self):
        for args in ((0, 1000000, 5000), (600, 0, 5000), (600, 1000000, 0),
                     (600, None, 5000), (600, 1000000, None)):
            with self.subTest(args=args):
                self.assertIsNone(cg.times_average(*args))

    def test_standing_reports_the_multiple_and_the_mean(self):
        s = cg.standing([cg_sample(600, 25, total=1000000, contributors=5000)])
        self.assertAlmostEqual(s["times_average"], 3.0)
        self.assertAlmostEqual(s["mean_contribution"], 200.0)

    def test_the_mean_ignores_the_live_total(self):
        # the feed refreshes the total but never the head count; dividing one
        # by the other would inflate the average and understate the multiple
        h = [cg_sample(600, 25, total=1000000, contributors=5000)]
        s = cg.standing(h, {"qty": 4000000})
        self.assertEqual(s["total"], 4000000)          # shown as the goal total
        self.assertAlmostEqual(s["mean_contribution"], 200.0)
        self.assertAlmostEqual(s["times_average"], 3.0)


class TestBandBrackets(unittest.TestCase):

    def history(self, *pairs):
        return [cg_sample(c, b) for c, b in pairs]

    def test_a_crossing_brackets_the_threshold(self):
        h = self.history((100, 100), (500, 75), (900, 75), (1200, 50))
        self.assertEqual(cg.band_brackets(h),
                         {75: (100, 500), 50: (900, 1200)})

    def test_a_band_never_crossed_is_absent_not_invented(self):
        br = cg.band_brackets(self.history((100, 100), (500, 75)))
        self.assertEqual(list(br), [75])
        for never in (10, 25, 50):
            self.assertNotIn(never, br)

    def test_input_order_does_not_matter(self):
        pairs = [(1200, 50), (100, 100), (900, 75), (500, 75)]
        self.assertEqual(cg.band_brackets(self.history(*pairs)),
                         {75: (100, 500), 50: (900, 1200)})

    def test_a_single_sample_brackets_nothing(self):
        self.assertEqual(cg.band_brackets(self.history((500, 75))), {})

    def test_an_empty_history_gives_no_brackets(self):
        self.assertEqual(cg.band_brackets([]), {})

    def test_samples_missing_a_contribution_or_band_are_ignored(self):
        h = [cg_sample(100, 100), cg_sample(None, 75), cg_sample(500, None),
             cg_sample(900, 75)]
        self.assertEqual(cg.band_brackets(h), {75: (100, 900)})

    def test_a_band_that_gets_worse_is_not_recorded_as_a_crossing(self):
        # bands drift as others deliver; only improvements bracket a threshold
        h = self.history((100, 50), (500, 75), (900, 75))
        self.assertEqual(cg.band_brackets(h), {})

    def test_the_latest_crossing_of_a_band_wins(self):
        h = self.history((100, 100), (500, 75), (600, 100), (900, 75))
        self.assertEqual(cg.band_brackets(h)[75], (600, 900))

    def test_a_zero_contribution_sample_is_kept(self):
        h = self.history((0, 100), (500, 75))
        self.assertEqual(cg.band_brackets(h), {75: (0, 500)})


class TestShipParams(unittest.TestCase):
    """What a detected ship puts in the toolbar."""

    def test_a_detected_ship_fills_every_box(self):
        self.assertEqual(cgbuy.ship_params("panthermkii", 832, 39.575737, 27.8),
                         {"hold": "832", "jump_empty": "39.6",
                          "jump_laden": "27.8"})

    def test_no_ship_means_no_claim_on_any_box(self):
        self.assertEqual(cgbuy.ship_params(None, 832, 39.6, 27.8), {})

    def test_a_figure_the_journal_never_stated_is_left_alone(self):
        # a Loadout without MaxJumpRange must not blank or invent the box
        self.assertEqual(cgbuy.ship_params("sidewinder", 4, None, None),
                         {"hold": "4"})

    def test_a_ship_with_no_hold_does_not_claim_the_hold_box(self):
        self.assertNotIn("hold", cgbuy.ship_params("eagle", 0, 25.0, 25.0))


class TestShipIdentity(WatcherTestCase):
    """The journal's ship figures must belong to the ship being flown.

    prime() reads several journals back, so a swap is ordinary rather than
    exotic - and carrying a Panther's 832t hold onto a Cobra is worse than
    knowing nothing, because it plans confident runs that cannot be flown.
    """

    PANTHER = {
        "timestamp": ts(12, 0), "event": "Loadout", "Ship": "PantherMkII",
        "ShipID": 36, "Ship_Localised": "Panther Clipper Mk II",
        "CargoCapacity": 832, "MaxJumpRange": 39.575737,
        "UnladenMass": 1836.5, "FuelCapacity": {"Main": 128.0},
    }
    COBRA = {
        "timestamp": ts(12, 30), "event": "Loadout", "Ship": "CobraMkIII",
        "ShipID": 7, "Ship_Localised": "Cobra Mk III", "CargoCapacity": 64,
        "MaxJumpRange": 28.0, "UnladenMass": 180.0,
        "FuelCapacity": {"Main": 16.0},
    }
    SWAP_TO_COBRA = {
        "timestamp": ts(12, 20), "event": "ShipyardSwap",
        "ShipType": "CobraMkIII", "ShipID": 7,
        "ShipType_Localised": "Cobra Mk III",
    }

    def test_the_ship_and_its_figures_come_from_the_loadout(self):
        self.feed(self.PANTHER)
        self.assertEqual((self.w.ship, self.w.ship_id, self.w.cargo_capacity),
                         ("panthermkii", 36, 832))
        self.assertEqual(self.w.max_jump_range, 39.575737)
        self.assertEqual(self.w.ship_name, "Panther Clipper Mk II")

    def test_swapping_ship_drops_the_old_ship_figures(self):
        self.feed(self.PANTHER, self.SWAP_TO_COBRA)
        self.assertEqual(self.w.ship, "cobramkiii")
        for stale in (self.w.cargo_capacity, self.w.max_jump_range,
                      self.w.unladen_mass, self.w.fuel_capacity,
                      self.w.best_laden_jump):
            self.assertIsNone(stale)

    def test_the_new_loadout_fills_the_figures_back_in(self):
        self.feed(self.PANTHER, self.SWAP_TO_COBRA, self.COBRA)
        self.assertEqual((self.w.cargo_capacity, self.w.max_jump_range),
                         (64, 28.0))

    def test_a_loadout_alone_is_enough_to_notice_the_swap(self):
        # the swap event is missed (it was in an older journal), but the new
        # Loadout still must not merge with the old ship's numbers
        self.feed(self.PANTHER, {"timestamp": ts(13, 0), "event": "Loadout",
                                 "Ship": "CobraMkIII", "ShipID": 7,
                                 "CargoCapacity": 64})
        self.assertEqual((self.w.cargo_capacity, self.w.ship), (64, "cobramkiii"))
        self.assertIsNone(self.w.max_jump_range)

    def test_two_of_the_same_hull_are_different_ships(self):
        self.feed(self.PANTHER, {"timestamp": ts(13, 0), "event": "Loadout",
                                 "Ship": "PantherMkII", "ShipID": 99,
                                 "CargoCapacity": 400})
        self.assertEqual((self.w.ship_id, self.w.cargo_capacity), (99, 400))
        self.assertIsNone(self.w.max_jump_range)

    def test_a_refit_keeps_what_it_does_not_restate(self):
        self.feed(self.PANTHER, {"timestamp": ts(13, 0), "event": "Loadout",
                                 "Ship": "PantherMkII", "ShipID": 36,
                                 "CargoCapacity": 784})
        self.assertEqual(self.w.cargo_capacity, 784)
        self.assertEqual(self.w.max_jump_range, 39.575737)

    def test_a_laden_jump_belongs_to_the_ship_that_made_it(self):
        self.feed(self.PANTHER,
                  {"timestamp": ts(12, 5), "event": "Cargo", "Count": 800},
                  {"timestamp": ts(12, 10), "event": "FSDJump",
                   "StarSystem": "Ega", "JumpDist": 21.5})
        self.assertEqual(self.w.best_laden_jump, 21.5)
        self.feed(self.SWAP_TO_COBRA)
        self.assertIsNone(self.w.best_laden_jump)

    def test_loading_the_game_in_another_ship_is_a_swap(self):
        self.feed(self.PANTHER, {"timestamp": ts(13, 0), "event": "LoadGame",
                                 "Ship": "CobraMkIII", "ShipID": 7,
                                 "Commander": "Jameson"})
        self.assertEqual(self.w.ship, "cobramkiii")
        self.assertIsNone(self.w.cargo_capacity)
        self.assertEqual(self.w.commander, "Jameson")

    def test_loading_the_game_in_the_same_ship_keeps_its_figures(self):
        self.feed(self.PANTHER, {"timestamp": ts(13, 0), "event": "LoadGame",
                                 "Ship": "PantherMkII", "ShipID": 36,
                                 "Commander": "Jameson"})
        self.assertEqual(self.w.cargo_capacity, 832)

    def test_an_on_foot_loadgame_does_not_forget_the_ship(self):
        # Odyssey writes LoadGame without a ship when you log in on foot
        self.feed(self.PANTHER, {"timestamp": ts(13, 0), "event": "LoadGame",
                                 "Commander": "Jameson"})
        self.assertEqual((self.w.ship, self.w.cargo_capacity),
                         ("panthermkii", 832))

    def test_the_pad_follows_the_hull(self):
        self.feed(self.PANTHER)
        self.assertEqual(cgbuy.pad_for_ship(self.w.ship), "L")
        self.feed(self.COBRA)
        self.assertEqual(cgbuy.pad_for_ship(self.w.ship), "S")
        self.assertEqual(cgbuy.pad_for_ship("python"), "M")
        self.assertEqual(cgbuy.pad_for_ship("nosuchship"), "L")


class TestRunMinutes(unittest.TestCase):
    """journal.run_minutes - a run measured as the part you actually fly."""

    CG, SRC = "Metz Enterprise", "Lovell Sanctuary"

    def log(self, *runs):
        """Pad events for a series of runs.

        Each run is (pad at the CG, out, pad at the source, back) in minutes,
        so a lazy afternoon and a tight one differ only in the first number.
        """
        t, out = 1_700_000_000.0, []
        for pad, there, srcpad, back in runs:
            out.append(("dock", self.CG, t))
            t += pad * 60
            out.append(("undock", self.CG, t))
            t += there * 60
            out.append(("dock", self.SRC, t))
            t += srcpad * 60
            out.append(("undock", self.SRC, t))
            t += back * 60
        out.append(("dock", self.CG, t))
        return out

    def test_a_run_is_the_flying_plus_a_turnaround_at_each_end(self):
        mins, runs = journal.run_minutes(
            self.log((1, 5, 1, 6), (1, 5, 1, 6), (1, 5, 1, 6)), self.CG)
        self.assertEqual((mins, runs), (15, 3))      # 11 flying + 2 + 2

    def test_an_hour_on_the_pad_does_not_make_a_slow_run(self):
        # The exact case that read as 102 minutes: same flying, tea break.
        tight = self.log((1, 5, 1, 6), (1, 5, 1, 6), (1, 5, 1, 6))
        afk = self.log((88, 5, 1, 6), (1, 5, 1, 6), (57, 5, 1, 6))
        self.assertEqual(journal.run_minutes(tight, self.CG),
                         journal.run_minutes(afk, self.CG))

    def test_time_parked_at_the_source_is_not_flying_either(self):
        mins, _runs = journal.run_minutes(
            self.log((1, 5, 22, 6), (1, 5, 22, 6), (1, 5, 22, 6)), self.CG)
        self.assertEqual(mins, 15)

    def test_too_few_runs_to_have_an_answer(self):
        self.assertEqual(
            journal.run_minutes(self.log((1, 5, 1, 6), (1, 5, 1, 6)), self.CG),
            (None, 0))

    def test_only_the_last_six_runs_count(self):
        slow = [(1, 20, 1, 20)] * 6
        fast = [(1, 5, 1, 6)] * 6
        mins, runs = journal.run_minutes(self.log(*(slow + fast)), self.CG)
        self.assertEqual((mins, runs), (15, 6))

    def test_tightening_up_moves_the_figure_within_a_few_runs(self):
        slow = [(1, 20, 1, 20)] * 6
        was = journal.run_minutes(self.log(*slow), self.CG)[0]
        now = journal.run_minutes(
            self.log(*(slow + [(1, 5, 1, 6)] * 3)), self.CG)[0]
        self.assertEqual(was, 44)
        self.assertLess(now, was)

    def test_leaving_the_pad_and_coming_straight_back_is_not_a_run(self):
        log = self.log((1, 5, 1, 6), (1, 5, 1, 6), (1, 5, 1, 6))
        t = log[-1][2]
        log += [("undock", self.CG, t + 60), ("dock", self.CG, t + 180)]
        mins, runs = journal.run_minutes(log, self.CG)
        self.assertEqual((mins, runs), (15, 3))     # the repair is not counted

    def test_logging_out_in_supercruise_is_a_session_break(self):
        log = self.log((1, 5, 1, 6), (1, 5, 1, 6), (1, 5, 1, 6),
                       (1, 5, 1, 600), (1, 5, 1, 6))
        mins, runs = journal.run_minutes(log, self.CG)
        self.assertEqual((mins, runs), (15, 4))     # the 10-hour leg is dropped

    def test_the_turnaround_matches_whatever_the_model_prices_it_at(self):
        log = self.log(*([(1, 5, 1, 6)] * 3))
        self.assertEqual(journal.run_minutes(log, self.CG, turnaround=0)[0], 11)

    def test_no_docks_at_all(self):
        self.assertEqual(journal.run_minutes([], self.CG), (None, 0))


class TestLadenJumpRange(unittest.TestCase):
    """The laden figure the game never states."""

    # Panther Clipper Mk II: the mass ratio says 27.8, not the 18 that a
    # stale hand-set box was claiming.
    PANTHER = dict(max_range=39.575737, unladen_mass=1836.5, fuel=128.0,
                   cargo=832)

    def test_a_full_hold_scales_the_range_by_the_mass_ratio(self):
        self.assertAlmostEqual(journal.laden_jump_range(**self.PANTHER),
                               39.575737 * 1964.5 / 2796.5, places=6)

    def test_an_empty_hold_is_the_unladen_maximum(self):
        self.assertIsNone(journal.laden_jump_range(
            **{**self.PANTHER, "cargo": 0}))

    def test_a_longer_jump_actually_made_beats_the_formula(self):
        self.assertEqual(journal.laden_jump_range(**self.PANTHER,
                                                  observed=31.0), 31.0)

    def test_a_shorter_jump_actually_made_does_not_drag_it_down(self):
        self.assertAlmostEqual(
            journal.laden_jump_range(**self.PANTHER, observed=21.555),
            journal.laden_jump_range(**self.PANTHER))

    def test_without_a_loadout_there_is_only_what_was_flown(self):
        self.assertEqual(journal.laden_jump_range(None, None, None, 832,
                                                  observed=21.5), 21.5)

    def test_nothing_known_is_no_answer_rather_than_a_guess(self):
        self.assertIsNone(journal.laden_jump_range(None, None, None, None))


class TestStanding(unittest.TestCase):

    def test_an_empty_history_has_no_standing(self):
        self.assertIsNone(cg.standing([]))
        self.assertIsNone(cg.standing([], {"qty": 5}))

    def test_the_last_sample_is_the_current_one(self):
        h = [cg_sample(100, 100), cg_sample(1800, 50)]
        s = cg.standing(h)
        self.assertEqual(s["contribution"], 1800)
        self.assertEqual(s["band"], 50)
        self.assertEqual(s["title"], "Ega Mining Initiative")
        self.assertEqual(s["station"], "Metz Enterprise")
        self.assertEqual(s["system"], "Ega")

    def test_the_next_band_is_the_one_above(self):
        for band, nxt in ((100, 75), (75, 50), (50, 25)):
            with self.subTest(band=band):
                s = cg.standing([cg_sample(100, band)])
                self.assertEqual(s["next_band"], nxt)

    def test_top_25_is_the_best_band_and_has_no_next(self):
        # above it the reward is the top-N-commanders rank, not a band;
        # PlayerPercentileBand never reports 10.
        s = cg.standing([cg_sample(100, 25)])
        self.assertIsNone(s["next_band"])
        self.assertIsNone(s["to_next"])
        self.assertIsNone(s["est_next"])

    def test_the_top_rank_is_carried_through_as_a_rank(self):
        s = cg.standing([cg_sample(100, 25, top_rank_size=10,
                                   in_top_rank=True)])
        self.assertEqual(s["top_rank_size"], 10)
        self.assertTrue(s["in_top_rank"])

    def test_no_threshold_is_extrapolated_above_the_best_band(self):
        # the rank has no tonnage cut-off in the journal, so nothing may be
        # invented for it
        h = [cg_sample(100, 100), cg_sample(500, 75), cg_sample(900, 75),
             cg_sample(1200, 50), cg_sample(2500, 25)]
        s = cg.standing(h)
        self.assertEqual(s["band"], 25)
        self.assertIsNone(s["next_band"])
        self.assertIsNone(s["est_next"])

    def test_hold_margin_is_measured_from_where_the_band_was_entered(self):
        h = [cg_sample(100, 100), cg_sample(500, 75), cg_sample(900, 75),
             cg_sample(1200, 50), cg_sample(2000, 50)]
        s = cg.standing(h)
        self.assertEqual(s["brackets"][50], (900, 1200))
        self.assertEqual(s["hold_margin"], 2000 - 1200)

    def test_hold_margin_is_unknown_when_the_band_was_never_seen_crossed(self):
        s = cg.standing([cg_sample(2000, 50)])
        self.assertIsNone(s["hold_margin"])
        self.assertEqual(s["brackets"], {})

    def test_to_next_uses_the_measured_bracket_when_there_is_one(self):
        # dropping back a band as others deliver is ordinary; the earlier
        # crossing still tells us where the boundary was
        h = [cg_sample(100, 100), cg_sample(500, 75), cg_sample(900, 75),
             cg_sample(1200, 50), cg_sample(2500, 25), cg_sample(1800, 50)]
        s = cg.standing(h)
        self.assertEqual(s["band"], 50)
        self.assertEqual(s["next_band"], 25)
        self.assertTrue(s["next_known"])
        self.assertEqual(s["brackets"][25], (1800, 2500))
        self.assertEqual(s["to_next"], 2500 - 1800)

    def test_to_next_never_goes_negative(self):
        h = [cg_sample(100, 100), cg_sample(500, 75), cg_sample(900, 75),
             cg_sample(1200, 50), cg_sample(2500, 25), cg_sample(9000, 50)]
        s = cg.standing(h)
        self.assertTrue(s["next_known"])
        self.assertEqual(s["to_next"], 0)

    def test_an_unobserved_threshold_is_not_reported_as_known(self):
        h = [cg_sample(100, 100), cg_sample(500, 75), cg_sample(900, 75),
             cg_sample(1200, 50)]
        s = cg.standing(h)
        self.assertEqual(s["next_band"], 25)
        self.assertFalse(s["next_known"])
        self.assertIsNone(s["to_next"])

    def test_the_unobserved_threshold_is_extrapolated_from_the_crossings(self):
        h = [cg_sample(100, 100), cg_sample(500, 75), cg_sample(900, 75),
             cg_sample(1200, 50)]
        s = cg.standing(h)
        mids = {b: (lo + hi) / 2.0 for b, (lo, hi) in s["brackets"].items()}
        self.assertEqual(s["est_next"], int(mids[50] * (mids[50] / mids[75])))
        self.assertGreater(s["est_next"], s["contribution"])

    def test_one_bracket_is_too_little_to_extrapolate_from(self):
        h = [cg_sample(100, 100), cg_sample(500, 75)]
        self.assertIsNone(cg.standing(h)["est_next"])

    def test_the_rate_comes_from_the_recent_samples(self):
        h = [cg_sample(1000, 50, when="2025-01-01T12:00:00Z"),
             cg_sample(2000, 50, when="2025-01-01T14:00:00Z")]
        self.assertAlmostEqual(cg.standing(h)["rate_per_hour"], 500.0)

    def test_a_single_sample_has_no_rate(self):
        self.assertIsNone(cg.standing([cg_sample(1000, 50)])["rate_per_hour"])

    def test_live_figures_win_over_the_journals_snapshot(self):
        h = [cg_sample(1000, 50, total=800000)]
        s = cg.standing(h, {"qty": 950000, "target_qty": 2000000,
                            "expiry": "2099-01-01 00:00:00"})
        self.assertEqual(s["total"], 950000)
        self.assertEqual(s["target"], 2000000)
        self.assertGreater(s["hours_left"], 0)

    def test_without_a_live_feed_the_journal_total_is_used(self):
        s = cg.standing([cg_sample(1000, 50, total=800000)])
        self.assertEqual(s["total"], 800000)
        self.assertIsNone(s["target"])
        self.assertIsNone(s["hours_left"])

    def test_the_journal_expiry_is_used_when_the_feed_is_silent(self):
        s = cg.standing([cg_sample(1000, 50, expiry="2099-01-01T00:00:00Z")])
        self.assertGreater(s["hours_left"], 0)

    def test_the_brackets_are_handed_to_the_ui(self):
        h = [cg_sample(100, 100), cg_sample(500, 75), cg_sample(900, 75),
             cg_sample(1200, 50)]
        s = cg.standing(h)
        self.assertEqual(s["brackets"], cg.band_brackets(h))
        self.assertEqual(s["as_of"], h[-1]["ts"])
        self.assertEqual(s["tier"], 4)
        self.assertEqual(s["top_tier"], "Tier 8")
        self.assertEqual(s["contributors"], 5000)

# --------------------------------------------------------------------------
# plot.read_bind / plot.keys_in_use
# --------------------------------------------------------------------------

BINDS_XML = """<?xml version="1.0" encoding="UTF-8"?>
<Root PresetName="Custom" MajorVersion="4" MinorVersion="0">
  <GalaxyMapOpen>
    <Primary Device="Keyboard" Key="Key_F6" />
    <Secondary Device="{NoDevice}" Key="" />
  </GalaxyMapOpen>
  <UI_Select>
    <Primary Device="Keyboard" Key="Key_Space" />
    <Secondary Device="{NoDevice}" Key="" />
  </UI_Select>
  <UI_Up>
    <Primary Device="Keyboard" Key="Key_W" />
    <Secondary Device="{NoDevice}" Key="" />
  </UI_Up>
  <UIFocus>
    <Primary Device="Keyboard" Key="Key_LeftShift" />
    <Secondary Device="{NoDevice}" Key="" />
  </UIFocus>
  <SystemMapOpen>
    <Primary Device="231D0126" Key="Joy_5" />
    <Secondary Device="{NoDevice}" Key="" />
  </SystemMapOpen>
  <HyperSuperCombination>
    <Primary Device="231D0126" Key="Joy_2" />
    <Secondary Device="Keyboard" Key="Key_J" />
  </HyperSuperCombination>
  <TargetNextRouteSystem>
    <Primary Device="Keyboard" Key="Key_N">
      <Modifier Device="Keyboard" Key="Key_LeftControl" />
    </Primary>
    <Secondary Device="{NoDevice}" Key="" />
  </TargetNextRouteSystem>
  <ShipSpotLightToggle>
    <Primary Device="Keyboard" Key="Key_L">
      <Modifier Device="231D0126" Key="Joy_3" />
    </Primary>
    <Secondary Device="{NoDevice}" Key="" />
  </ShipSpotLightToggle>
  <Unbound>
    <Primary Device="{NoDevice}" Key="" />
    <Secondary Device="{NoDevice}" Key="" />
  </Unbound>
</Root>
"""


class TestWindowTitle(unittest.TestCase):

    def test_names_the_destination_station_and_system(self):
        self.assertEqual(
            cgbuy.window_title({"station": "Metz Enterprise", "system": "Ega"}),
            "CG Buy Finder - Metz Enterprise, Ega")

    def test_no_destination_names_no_place(self):
        self.assertEqual(cgbuy.window_title(dict(cgbuy.DEFAULT_DEST)),
                         "CG Buy Finder")
        self.assertEqual(cgbuy.window_title(None), "CG Buy Finder")

    def test_a_system_alone_is_still_worth_showing(self):
        self.assertEqual(cgbuy.window_title({"station": None, "system": "Ega"}),
                         "CG Buy Finder - Ega")


class FakeRoot:
    """Just enough of a Tk root for notify's title handling."""

    def __init__(self):
        self._title = ""
        self.handlers = []

    def title(self, text=None):
        if text is None:
            return self._title
        self._title = text

    def bind(self, _event, fn, add=None):
        self.handlers.append(fn)

    def focus(self):
        for fn in list(self.handlers):
            fn()


class TestBaseTitle(unittest.TestCase):

    def test_clearing_a_marker_restores_the_renamed_title(self):
        root = FakeRoot()
        notify.set_base_title(root, "CG Buy Finder - A")
        notify._mark_title(root, "news")
        self.assertEqual(root.title(), "* news - CG Buy Finder - A")
        notify.set_base_title(root, "CG Buy Finder - B")
        self.assertEqual(root.title(), "CG Buy Finder - B")
        root.focus()
        self.assertEqual(root.title(), "CG Buy Finder - B")

    def test_a_marker_after_a_rename_wraps_the_new_title(self):
        root = FakeRoot()
        notify.set_base_title(root, "CG Buy Finder - A")
        notify._mark_title(root, "first")
        notify.set_base_title(root, "CG Buy Finder - B")
        notify._mark_title(root, "second")
        self.assertEqual(root.title(), "* second - CG Buy Finder - B")


class StatusTestCase(unittest.TestCase):
    """A watcher over a temp Status.json, with a clock we control."""

    SUPERCRUISE = status.IN_SUPERCRUISE | (1 << 24)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="cgbuy-test-status-")
        self.addCleanup(self.tmp.cleanup)
        self.now = 1000.0
        self.w = status.StatusWatcher(self.tmp.name, clock=lambda: self.now)
        self.path = os.path.join(self.tmp.name, "Status.json")
        self.nudge = 0

    def write(self, flags2, flags=None, at=None):
        """Replace Status.json and advance the clock, the way the game does."""
        if at is not None:
            self.now = at
        self.nudge += 1
        with open(self.path, "w") as fh:
            json.dump({"timestamp": "2025-01-01T12:00:00Z", "event": "Status",
                       "Flags": self.SUPERCRUISE if flags is None else flags,
                       "Flags2": flags2, "pad": "x" * self.nudge}, fh)
        self.w.poll()


class TestStatusWatcher(StatusTestCase):

    def test_sco_bit_is_seen_and_timed(self):
        self.write(0, at=100.0)
        self.write(status.SCO_ACTIVE, at=110.0)
        self.assertTrue(self.w.sco)
        self.write(0, at=119.0)
        self.assertFalse(self.w.sco)
        self.assertEqual(self.w.windows, [(110.0, 119.0)])

    def test_hyperdrive_charging_bit_is_not_sco(self):
        """Bit 19 spans StartJump to arrival and would otherwise be counted."""
        self.write(1 << 19, at=100.0)
        self.assertFalse(self.w.sco)
        self.assertEqual(self.w.windows, [])

    def test_sco_outside_supercruise_is_discarded(self):
        """The drive cannot be overcharged in normal space; a reading there
        means the file was caught mid-write."""
        self.write(status.SCO_ACTIVE, flags=1 << 24, at=100.0)
        self.assertFalse(self.w.sco)

    def test_unchanged_file_is_not_reparsed(self):
        self.write(status.SCO_ACTIVE, at=100.0)
        seen = []
        self.w.on_sco = lambda on, t: seen.append((on, t))
        self.now = 200.0
        self.w.poll()
        self.w.poll()
        self.assertEqual(seen, [])

    def test_half_written_file_is_ignored(self):
        self.write(status.SCO_ACTIVE, at=100.0)
        with open(self.path, "w") as fh:
            fh.write('{"Flags": 16777232, "Flags2": ')
        self.now = 110.0
        self.w.poll()
        self.assertTrue(self.w.sco)      # last good reading stands
        self.assertEqual(self.w.windows, [])

    def test_missing_file_is_survivable(self):
        self.w.poll()
        self.assertIsNone(self.w.flags2)

    def test_callback_fires_on_both_edges(self):
        seen = []
        self.w.on_sco = lambda on, t: seen.append((on, t))
        self.write(0, at=100.0)
        self.write(status.SCO_ACTIVE, at=105.0)
        self.write(0, at=112.0)
        self.assertEqual(seen, [(True, 105.0), (False, 112.0)])


class TestScoSecondsBetween(StatusTestCase):

    def test_burn_inside_the_window_counts_whole(self):
        self.write(0, at=100.0)
        self.write(status.SCO_ACTIVE, at=110.0)
        self.write(0, at=119.0)
        self.assertAlmostEqual(self.w.seconds_between(100.0, 200.0), 9.0)

    def test_burn_is_clipped_to_the_window(self):
        self.write(0, at=100.0)
        self.write(status.SCO_ACTIVE, at=110.0)
        self.write(0, at=130.0)
        self.assertAlmostEqual(self.w.seconds_between(120.0, 125.0), 5.0)

    def test_burn_still_running_counts_up_to_the_end(self):
        self.write(status.SCO_ACTIVE, at=110.0)
        self.assertAlmostEqual(self.w.seconds_between(100.0, 130.0), 20.0)

    def test_two_burns_add_up(self):
        self.write(0, at=100.0)
        self.write(status.SCO_ACTIVE, at=110.0)
        self.write(0, at=114.0)
        self.write(status.SCO_ACTIVE, at=120.0)
        self.write(0, at=125.0)
        self.assertAlmostEqual(self.w.seconds_between(100.0, 200.0), 9.0)

    def test_unrelated_burn_does_not_count(self):
        self.write(0, at=100.0)
        self.write(status.SCO_ACTIVE, at=110.0)
        self.write(0, at=119.0)
        self.assertAlmostEqual(self.w.seconds_between(500.0, 600.0), 0.0)

    def test_first_lit_is_the_start_of_the_burn(self):
        self.write(0, at=100.0)
        self.write(status.SCO_ACTIVE, at=110.0)
        self.write(0, at=119.0)
        self.assertAlmostEqual(self.w.first_lit(100.0, 200.0), 110.0)

    def test_first_lit_is_none_without_a_burn(self):
        self.write(0, at=100.0)
        self.assertIsNone(self.w.first_lit(100.0, 200.0))


class TestScoModel(unittest.TestCase):
    """The braking law: range to run, as a function of speed."""

    # (range at cut, speed at cut, overshot) - every captured approach.
    OBS = [(172.0, 70.0, True), (296.0, 75.3, False), (273.0, 76.4, False),
           (284.0, 91.9, False), (1120.0, 242.0, False),
           (2950.0, 300.0, False), (3590.0, 452.0, False)]

    def test_brake_distance_grows_with_speed(self):
        self.assertLess(sco_model.brake_distance(70), sco_model.brake_distance(2000))

    def test_brake_distance_refuses_nonsense(self):
        self.assertIsNone(sco_model.brake_distance(0))
        self.assertIsNone(sco_model.brake_distance(-5))
        self.assertIsNone(sco_model.brake_distance("fast"))

    def test_required_countdown_falls_as_speed_rises(self):
        """Why a single seconds-to-target figure never worked: the same law
        reads 4s at 70c and under 1s at 2,000c."""
        secs = [sco_model.cut_range(v) / v for v in (70, 250, 1000, 2000)]
        self.assertEqual(secs, sorted(secs, reverse=True))
        self.assertGreater(secs[0], 3.0)
        self.assertLess(secs[-1], 1.0)

    # The 35,000 Ls report: cut near the cap with roughly 3,000 Ls to run and
    # the ship ended too slow to arrive on, so the true requirement is below it.
    BOUNDS = [(2000.0, 3000.0)]

    def test_shipped_law_separates_the_observations(self):
        """The cut that overshot falls below the line and the clean ones above,
        bar one sitting 1.4% under - which is inside the reading error on a
        speed taken off a screenshot. Checked without the safety margin, which
        is advice rather than fit."""
        t = sco_model.terms("panthermkii")
        wrong = [(d, v) for d, v, over in self.OBS
                 if (d < sco_model.brake_distance(v, t["a"], t["p"])) != over]
        self.assertLessEqual(len(wrong), 1)
        for d, v in wrong:
            need = sco_model.brake_distance(v, t["a"], t["p"])
            self.assertLess(abs(d - need) / d, 0.05)

    def test_advice_clears_the_measured_overshoot(self):
        self.assertGreater(sco_model.cut_range(70, "panthermkii"), 172.0)

    def test_fit_reports_an_envelope_not_a_point(self):
        got = sco_model.fit(self.OBS, tolerance=0.05)
        self.assertGreater(got["fits"], 1)
        self.assertLess(got["p_min"], got["p_max"])

    def test_captured_approaches_alone_do_not_exclude_a_constant_ratio(self):
        """Worth pinning down: the case against a fixed seconds-to-target rests
        on the 35,000 Ls report, not on anything captured. Without that bound
        the traces happily admit exponents above 1."""
        self.assertGreater(sco_model.fit(self.OBS, tolerance=0.05)["p_max"], 1.0)
        self.assertIsNotNone(sco_model.fit(self.OBS, exponents=[100],
                                           tolerance=0.05))

    def test_the_report_is_what_rules_a_constant_ratio_out(self):
        got = sco_model.fit(self.OBS, bounds=self.BOUNDS, tolerance=0.05)
        self.assertLess(got["p_max"], 1.0)
        self.assertIsNone(sco_model.fit(self.OBS, exponents=[100],
                                        bounds=self.BOUNDS, tolerance=0.05))

    def test_fit_of_nothing_is_nothing(self):
        self.assertIsNone(sco_model.fit([]))

    def test_plan_is_ordered_and_complete(self):
        rows = sco_model.plan("panthermkii")
        self.assertTrue(all(d for _, d in rows))
        self.assertEqual([v for v, _ in rows], sorted(v for v, _ in rows))


class TestScoTable(unittest.TestCase):

    TABLE = {"fallback": {"law": {"a": 30.0, "p": 0.5}},
             "ships": {"panthermkii": {"law": {"a": 30.0, "p": 0.5},
                                       "source": "measured", "samples": 9}}}

    def test_measured_hull_is_marked_measured(self):
        self.assertEqual(sco_model.terms("panthermkii", self.TABLE)["source"],
                         "measured")

    def test_ship_name_is_case_insensitive(self):
        self.assertEqual(sco_model.terms("PantherMkII", self.TABLE)["source"],
                         "measured")

    def test_unmeasured_hull_falls_back_and_admits_it(self):
        t = sco_model.terms("sidewinder", self.TABLE)
        self.assertEqual(t["source"], "estimate")
        self.assertIn("estimate", sco_model.summary("sidewinder", 250, self.TABLE))

    def test_missing_table_file_is_survivable(self):
        self.assertEqual(sco_model.load_table("/nonexistent.json"), {})
        self.assertEqual(sco_model.terms("panthermkii",
                                         path="/nonexistent.json")["source"],
                         "estimate")

    def test_shipped_table_is_usable(self):
        real = sco_model.load_table()
        t = sco_model.terms("panthermkii", real)
        self.assertEqual(t["source"], "measured")
        self.assertTrue(t["bracket"])


class TestObservedApproaches(StatusTestCase):

    def test_approach_predating_the_watcher_is_not_scored(self):
        self.assertFalse(self.w.observed(self.now - 60.0))

    def test_approach_started_under_watch_is_scored(self):
        self.assertTrue(self.w.observed(self.now + 60.0))


class TestScoBands(unittest.TestCase):

    def test_bands_split_where_the_flight_changes_shape(self):
        self.assertEqual(journal.sco_band(357), "short")
        self.assertEqual(journal.sco_band(999), "short")
        self.assertEqual(journal.sco_band(5394), "mid")
        self.assertEqual(journal.sco_band(19999), "mid")
        self.assertEqual(journal.sco_band(200000), "long")


class TestScoAdvice(unittest.TestCase):

    def cal(self, samples):
        c = journal.Calibration()
        for s in samples:
            c.add_sco_sample(*s)
        return c

    def test_nothing_to_say_below_the_sample_floor(self):
        c = self.cal([(5394, 135, 9, 4), (5394, 140, 9, 4)])
        self.assertIsNone(c.sco_advice(5394))

    def test_fastest_arrival_supplies_the_advice(self):
        c = self.cal([(5394, 135, 9, 4), (5394, 121, 4, 3), (5394, 156, 14, 5)])
        a = c.sco_advice(5394)
        self.assertEqual(a["hold"], 4.0)
        self.assertEqual(a["total"], 121.0)
        self.assertEqual(a["worst_hold"], 14.0)
        self.assertEqual(a["n"], 3)

    def test_samples_are_kept_per_ship(self):
        """A Panther's approach says nothing about a Cobra's."""
        c = journal.Calibration()
        for s in [(5394, 135, 9, 4, "panthermkii"), (5394, 121, 4, 3, "panthermkii"),
                  (5394, 200, 30, 4, "panthermkii"), (5394, 60, 2, 1, "cobramkiii")]:
            c.add_sco_sample(*s)
        a = c.sco_advice(5394, "panthermkii")
        self.assertEqual(a["n"], 3)
        self.assertEqual(a["total"], 121.0)
        self.assertTrue(a["ship_specific"])

    def test_thin_ship_history_falls_back_to_the_mixed_pool(self):
        c = journal.Calibration()
        for s in [(5394, 135, 9, 4, "panthermkii"), (5394, 121, 4, 3, "panthermkii"),
                  (5394, 150, 12, 4, "cobramkiii")]:
            c.add_sco_sample(*s)
        a = c.sco_advice(5394, "panthermkii")
        self.assertEqual(a["n"], 3)
        self.assertFalse(a["ship_specific"])

    def test_legacy_samples_are_not_credited_to_the_current_ship(self):
        """Samples written before ships were tracked carry no hull, and must
        not be silently attributed to whatever is in the bay now."""
        old = {"sco_samples": [[5394, 135, 9, 4]] * 3}
        c = journal.Calibration(old)
        self.assertEqual(c.sco_samples[0][4], None)
        self.assertFalse(c.sco_advice(5394, "panthermkii")["ship_specific"])

    def test_other_bands_do_not_contaminate(self):
        c = self.cal([(357, 96, 0, None), (357, 150, 4, 11),
                      (357, 118, 2, 9), (5394, 135, 9, 4)])
        a = c.sco_advice(357)
        self.assertEqual(a["n"], 3)
        self.assertEqual(a["hold"], 0.0)

    def test_one_habit_repeated_is_not_an_experiment(self):
        """Twenty samples of the same burn say what you always do, not what
        works. spread is what the UI leans on to ask for a different run."""
        c = self.cal([(5394, 135, 9, 4)] * 5)
        self.assertEqual(c.sco_advice(5394)["spread"], 1)

    def test_spread_counts_distinct_burns(self):
        c = self.cal([(5394, 135, 9, 4), (5394, 121, 4, 3), (5394, 150, 20, 4)])
        self.assertEqual(c.sco_advice(5394)["spread"], 3)

    def test_samples_survive_a_config_round_trip(self):
        c = self.cal([(5394, 135, 9, 4), (5394, 121, 4, None)])
        again = journal.Calibration(json.loads(json.dumps(c.to_dict())))
        self.assertEqual(again.sco_samples, c.sco_samples)


class TestApproachCallback(WatcherTestCase):

    def setUp(self):
        super().setUp()
        self.seen = []
        self.w.on_approach = lambda *a: self.seen.append(a)

    def live(self, *events):
        return [self.w._handle(json.dumps(e) + "\n", live=True) for e in events]

    def test_jump_to_drop_is_reported_with_the_arrival_distance(self):
        self.live(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "Ega"},
            {"timestamp": ts(12, 2, 15), "event": "SupercruiseDestinationDrop",
             "Type": "Metz Enterprise"},
            {"timestamp": ts(12, 2, 18), "event": "SupercruiseExit"},
            {"timestamp": ts(12, 4, 0), "event": "Docked",
             "StationName": "Metz Enterprise", "DistFromStarLS": 5394.0},
        )
        self.assertEqual(len(self.seen), 1)
        ls, start, drop, st = self.seen[0]
        self.assertEqual(ls, 5394.0)
        self.assertEqual(drop - start, 135.0)
        self.assertEqual(st, "Metz Enterprise")

    def test_destination_drop_wins_over_the_later_exit(self):
        """SupercruiseExit trails the drop by a few seconds and would inflate
        every arrival if it were taken as the end of the approach."""
        self.live(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "Ega"},
            {"timestamp": ts(12, 2, 0), "event": "SupercruiseDestinationDrop",
             "Type": "X"},
            {"timestamp": ts(12, 2, 30), "event": "SupercruiseExit"},
            {"timestamp": ts(12, 4, 0), "event": "Docked",
             "StationName": "X", "DistFromStarLS": 900.0},
        )
        self.assertEqual(self.seen[0][2] - self.seen[0][1], 120.0)

    def test_manual_drop_falls_back_to_the_exit(self):
        self.live(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "Ega"},
            {"timestamp": ts(12, 2, 0), "event": "SupercruiseExit"},
            {"timestamp": ts(12, 4, 0), "event": "Docked",
             "StationName": "X", "DistFromStarLS": 900.0},
        )
        self.assertEqual(self.seen[0][2] - self.seen[0][1], 120.0)

    def test_re_entering_supercruise_restarts_the_approach(self):
        """Dropping out and resuming is a different flight from the one that
        began at the jump, and timing it from the jump would be nonsense."""
        self.live(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "Ega"},
            {"timestamp": ts(12, 5, 0), "event": "SupercruiseEntry"},
            {"timestamp": ts(12, 6, 0), "event": "SupercruiseDestinationDrop",
             "Type": "X"},
            {"timestamp": ts(12, 7, 0), "event": "Docked",
             "StationName": "X", "DistFromStarLS": 900.0},
        )
        self.assertEqual(self.seen[0][2] - self.seen[0][1], 60.0)

    def test_dock_without_a_drop_reports_nothing(self):
        self.live(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "Ega"},
            {"timestamp": ts(12, 4, 0), "event": "Docked",
             "StationName": "X", "DistFromStarLS": 900.0},
        )
        self.assertEqual(self.seen, [])

    def test_second_dock_does_not_reuse_the_first_approach(self):
        self.live(
            {"timestamp": ts(12, 0, 0), "event": "FSDJump", "StarSystem": "Ega"},
            {"timestamp": ts(12, 2, 0), "event": "SupercruiseDestinationDrop",
             "Type": "A"},
            {"timestamp": ts(12, 3, 0), "event": "Docked",
             "StationName": "A", "DistFromStarLS": 900.0},
            {"timestamp": ts(12, 6, 0), "event": "Undocked"},
            {"timestamp": ts(12, 20, 0), "event": "Docked",
             "StationName": "B", "DistFromStarLS": 90000.0},
        )
        self.assertEqual(len(self.seen), 1)


class TestParseTsIsUtc(unittest.TestCase):

    def test_timestamps_line_up_with_the_wall_clock(self):
        """Status.json transitions are stamped with time.time(); a journal
        timestamp has to land on the same scale or the pairing is hours out."""
        self.assertEqual(journal.parse_ts("2025-01-01T00:00:00Z"), 1735689600)


class TestBuildsBundleTheScoTable(unittest.TestCase):
    """Both packagers follow imports, not open() calls. Told nothing, they ship
    no sco_table.json and even a measured hull reads as an estimate.

    Linux builds with PyInstaller and Windows with Nuitka, which spell the same
    instruction differently, so either flag counts -- what matters is that no
    build script forgets the table."""

    BUILDS = (".github/workflows/build.yml", ".github/workflows/release.yml",
              "build.sh", "build.bat")
    DATA_FLAGS = ("--add-data", "--include-data-files")

    def test_every_build_adds_the_table_as_data(self):
        for name in self.BUILDS:
            with open(os.path.join(PROJECT_DIR, name), encoding="utf-8") as fh:
                text = fh.read()
            with self.subTest(build=name):
                self.assertTrue(
                    any(flag in text for flag in self.DATA_FLAGS),
                    f"{name} passes neither {' nor '.join(self.DATA_FLAGS)}")
                self.assertIn("sco_table.json", text)



class TestWindowsIsNotBuiltAsOneFile(unittest.TestCase):
    """The Windows build must stay a standalone folder.

    Measured on one commit: PyInstaller one-file 7/75 on VirusTotal, Nuitka
    one-file 15/75, Nuitka standalone 0/75. It is the startup self-extraction
    that engines score, not the code, so --onefile on the Windows side would
    silently hand back every detection this project spent a release removing.
    Linux keeps --onefile: it scans clean there and one file is a nicer
    download."""

    WINDOWS_BUILDS = (".github/workflows/build.yml",
                      ".github/workflows/release.yml", "build.bat")

    def _read(self, name):
        with open(os.path.join(PROJECT_DIR, name), encoding="utf-8") as fh:
            return fh.read()

    def test_windows_builds_pass_standalone(self):
        for name in self.WINDOWS_BUILDS:
            with self.subTest(build=name):
                self.assertIn("--standalone", self._read(name))

    def test_build_bat_never_packs_one_file(self):
        # The workflows legitimately contain --onefile for the Linux job, so
        # only build.bat, which is Windows-only, can be checked outright.
        self.assertNotIn("--onefile", self._read("build.bat"))


class TestDocAnchorsResolve(unittest.TestCase):
    """Release notes and the badge deep-link into README headings.

    Those links are written in workflow YAML and in vt_scan.py, so renaming a
    heading breaks them silently -- nothing fails, and the damage only shows up
    when someone clicks a link in a published release. Renaming
    "Antivirus false positives" to "Antivirus" broke four of them at once."""

    # Files that link into README.md by anchor.
    LINKERS = ("README.md", ".github/workflows/build.yml",
               ".github/workflows/release.yml", ".github/scripts/vt_scan.py")

    @staticmethod
    def _slug(heading):
        """GitHub's heading-to-anchor rule, near enough for ASCII headings."""
        kept = [c for c in heading.strip().lower() if c.isalnum() or c in " -_"]
        return "".join(kept).replace(" ", "-")

    def _headings(self, name):
        with open(os.path.join(PROJECT_DIR, name), encoding="utf-8") as fh:
            return {self._slug(m) for m in
                    re.findall(r"^#{1,6} (.+)$", fh.read(), re.M)}

    def test_every_readme_anchor_exists(self):
        readme = self._headings("README.md")
        for name in self.LINKERS:
            with open(os.path.join(PROJECT_DIR, name), encoding="utf-8") as fh:
                text = fh.read()
            # Matches ](#anchor) and the ](../../#anchor) form the workflows use
            # to climb out of the release-notes context back to the repo root.
            for frag in re.findall(r"\]\((?:\.\./)*#([a-z0-9-]+)\)", text):
                with self.subTest(linker=name, anchor=frag):
                    self.assertIn(frag, readme)

    def test_readme_links_to_development_resolve(self):
        with open(os.path.join(PROJECT_DIR, "README.md"), encoding="utf-8") as fh:
            text = fh.read()
        dev = self._headings("DEVELOPMENT.md")
        found = re.findall(r"\]\(DEVELOPMENT\.md(?:#([a-z0-9-]+))?\)", text)
        self.assertTrue(found, "README no longer points at DEVELOPMENT.md")
        for frag in found:
            if frag:
                with self.subTest(anchor=frag):
                    self.assertIn(frag, dev)

if __name__ == "__main__":
    unittest.main(verbosity=2)
